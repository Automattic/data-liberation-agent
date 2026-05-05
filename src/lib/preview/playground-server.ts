import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PreviewPidRecord } from './types.js';
import { closeSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { acquireLock } from './lockfile.js';
import { pickFreePort, DEFAULT_PORT_RANGE } from './port-picker.js';
import { persistBlueprint, VFS_MOUNT_DIR, IMPORT_COMPLETE_MARKER } from './blueprint-builder.js';
import { isStudioAvailable, startStudioPreview } from './studio.js';
import type { PreviewPhase, StartPreviewOpts, StartPreviewResult } from './types.js';

export function playgroundDir(outputDir: string): string {
  return join(resolve(outputDir), 'playground');
}

/**
 * Per-project on-disk WP install location. Mounted into Playground's VFS at
 * `/wordpress/wp-content` so the SQLite DB + themes + plugins + uploads
 * survive across `liberate_preview` start/stop cycles.
 *
 * Layout:
 *   <outputDir>/playground-site/
 *     wp-content/
 *       database/.ht.sqlite       — SQLite DB (posts, options, etc)
 *       themes/<slug>-replica/    — replica theme (overwritten on each run)
 *       plugins/                  — installed plugins (woocommerce, etc)
 *       uploads/                  — media uploads imported from extraction
 */
export function playgroundSitePath(outputDir: string): string {
  return join(resolve(outputDir), 'playground-site');
}

export function playgroundWpContentPath(outputDir: string): string {
  return join(playgroundSitePath(outputDir), 'wp-content');
}

/**
 * The SQLite DB file shipped by the WordPress SQLite integration plugin.
 * Its presence on disk is the marker that this Playground site has been
 * booted at least once and has imported content. Used to skip importWxr +
 * products import on subsequent starts.
 */
const SQLITE_MARKER_REL = 'wp-content/database/.ht.sqlite';

export function isPlaygroundPersisted(outputDir: string): boolean {
  return existsSync(join(playgroundSitePath(outputDir), SQLITE_MARKER_REL));
}

export function pidFilePath(outputDir: string): string {
  return join(playgroundDir(outputDir), 'preview.pid');
}

export function logFilePath(outputDir: string): string {
  return join(playgroundDir(outputDir), 'preview.log');
}

export function blueprintFilePath(outputDir: string): string {
  return join(playgroundDir(outputDir), 'blueprint.json');
}

export function lockFilePath(outputDir: string): string {
  return join(playgroundDir(outputDir), '.lock');
}

export function ensurePlaygroundDir(outputDir: string): void {
  mkdirSync(playgroundDir(outputDir), { recursive: true });
}

export function writePidFile(outputDir: string, rec: PreviewPidRecord): void {
  ensurePlaygroundDir(outputDir);
  writeFileSync(pidFilePath(outputDir), JSON.stringify(rec, null, 2));
}

export function readPidFile(outputDir: string): PreviewPidRecord | null {
  const p = pidFilePath(outputDir);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as PreviewPidRecord;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.startedAt !== 'string'
    ) {
      try { unlinkSync(p); } catch { /* already gone */ }
      return null;
    }
    return parsed;
  } catch {
    try { unlinkSync(p); } catch { /* already gone */ }
    return null;
  }
}

export function deletePidFile(outputDir: string): void {
  try {
    unlinkSync(pidFilePath(outputDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Returns true if the PID corresponds to a process this user can signal.
 * EPERM means the process exists but is foreign — treat as alive for safety.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

const READY_TIMEOUT_MS = 60_000;
const PROBE_INTERVAL_MS = 500;

type ProbeFn = (port: number) => Promise<boolean>;

interface InternalOpts extends StartPreviewOpts {
  _probeFn?: ProbeFn;
  _spawn?: typeof spawn;
  _isPidAlive?: (pid: number) => boolean;
  _noStudio?: boolean;
}

/**
 * Readiness is detected via a sentinel file the blueprint's final step writes
 * into the mounted VFS path. Because <outputDir> is mounted as
 * /wordpress/wp-content/uploads/liberation, a blueprint `writeFile` step at
 * that VFS path materializes as `<outputDir>/.import-complete` on the host —
 * observable directly, no dependence on Playground stdout (which Node
 * block-buffers when piped to a file) and no dependence on HTTP (which the
 * CLI starts serving during blueprint execution, so HTTP 200 is not a
 * proof-of-completion signal).
 *
 * `port` is accepted for compatibility with the ProbeFn signature used by
 * test mocks but is not consulted here.
 */
function importCompletePath(outputDir: string): string {
  return join(resolve(outputDir), IMPORT_COMPLETE_MARKER);
}

function makeCompletionProbe(outputDir: string): (port: number) => Promise<boolean> {
  const marker = importCompletePath(outputDir);
  return async (_port: number) => existsSync(marker);
}

/** Remove any sentinel file left behind by a previous run. */
function clearImportCompleteMarker(outputDir: string): void {
  try {
    unlinkSync(importCompletePath(outputDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function validateOutputDir(outputDir: string, opts: { allowEmptyWxr?: boolean } = {}): void {
  const wxr = join(resolve(outputDir), 'output.wxr');
  if (!existsSync(resolve(outputDir))) {
    throw new Error(`outputDir not found: ${outputDir}`);
  }
  if (!existsSync(wxr) && !opts.allowEmptyWxr) {
    throw new Error(`No output.wxr in outputDir — run \`liberate <url>\` first: ${wxr}`);
  }
}

export async function startPreview(opts: InternalOpts): Promise<StartPreviewResult> {
  const spawnFn = opts._spawn ?? spawn;
  const onPhase: (p: PreviewPhase) => void = opts.onPhase ?? (() => {});
  const detached = opts.detached ?? false;

  try {
    validateOutputDir(opts.outputDir, { allowEmptyWxr: opts.allowEmptyWxr });
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }

  // forceReimport: nuke the persistent SQLite so the import-when-empty branch
  // re-runs against the current WXR. Used by the streaming watch loop on its
  // post-extraction call to import content into a site that was started with
  // an empty stub WXR.
  if (opts.forceReimport) {
    const sqlitePath = join(playgroundWpContentPath(opts.outputDir), 'database', '.ht.sqlite');
    if (existsSync(sqlitePath)) {
      try { unlinkSync(sqlitePath); } catch { /* ignore */ }
    }
  }

  // The lockfile serializes both Studio and Playground paths per outputDir.
  // Two concurrent starts would otherwise race: Studio into same-named site
  // creation; Playground into conflicting PID files and port picks.
  ensurePlaygroundDir(opts.outputDir);
  const release = await acquireLock(lockFilePath(opts.outputDir), { timeoutMs: 10_000 });

  try {
    // Prefer Studio when its CLI is installed — gives the user a persistent,
    // real WordPress site instead of an ephemeral WASM Playground. The same
    // blueprint is used for both paths. `opts._noStudio` lets tests force the
    // Playground branch without mocking the `studio` binary. Large WXRs are
    // handled via import chunking inside startStudioPreview — see studio.ts.
    if (!opts._noStudio && isStudioAvailable()) {
      onPhase('download');
      onPhase('spawn');
      onPhase('probe');
      onPhase('import');
      const result = await startStudioPreview({
        outputDir: opts.outputDir,
        themeFiles: opts.themeFiles,
        blockPlugins: opts.blockPlugins,
        themeSlug: opts.themeSlug,
      });
      return { ...result, source: 'studio' };
    }

    await reconcileExistingPid(opts.outputDir, opts._isPidAlive);
    const port = opts.port ?? (await pickFreePort(DEFAULT_PORT_RANGE));

    // Pre-create the persistent wp-content dir so Playground can mount it
    // before WP installs. First boot: dir is empty, WP populates it (SQLite,
    // themes, plugins). Subsequent boots: wp-content already on disk, skip
    // importWxr + products import.
    const wpContentHostPath = playgroundWpContentPath(opts.outputDir);
    mkdirSync(wpContentHostPath, { recursive: true });
    const persisted = isPlaygroundPersisted(opts.outputDir);

    const blueprintPath = persistBlueprint(opts.outputDir, 'playground', {
      themeFiles: opts.themeFiles,
      blockPlugins: opts.blockPlugins,
      themeSlug: opts.themeSlug,
      persisted,
    });
    const probeFn = opts._probeFn ?? makeCompletionProbe(opts.outputDir);
    clearImportCompleteMarker(opts.outputDir);

    onPhase('download');
    onPhase('spawn');

    // Always pipe stdio to preview.log (regardless of detached/foreground). The
    // log-tail probe needs the file, and CLI mode doesn't need Playground's raw
    // output — the Ink spinner is the UI. The fd is dup'd into the child by
    // spawn(); close the parent copy so the fd doesn't leak across repeated
    // preview cycles in a long-running MCP process.
    const logFd = openSync(logFilePath(opts.outputDir), 'w');
    const stdioConfig: any = ['ignore', logFd, logFd];
    const absOutputDir = resolve(opts.outputDir);
    const liberationMount = `${absOutputDir}:${VFS_MOUNT_DIR}`;
    const wpContentMount = `${wpContentHostPath}:/wordpress/wp-content`;
    const child = spawnFn(
      'npx',
      [
        'wp-playground-cli',
        'server',
        '--blueprint',
        blueprintPath,
        '--port',
        String(port),
        // install-from-existing-files-if-needed lets Playground reuse the
        // mounted wp-content (SQLite + themes + plugins) on subsequent boots
        // rather than re-running WP install. Detection is automatic — empty
        // wp-content triggers a fresh install; populated dir is reused.
        '--wordpress-install-mode=install-from-existing-files-if-needed',
        `--mount-before-install=${wpContentMount}`,
        `--mount-before-install=${liberationMount}`,
      ],
      {
        stdio: stdioConfig,
        detached,
      },
    );
    try { closeSync(logFd); } catch { /* already closed */ }
    if (detached) child.unref();

    writePidFile(opts.outputDir, {
      pid: child.pid ?? -1,
      port,
      startedAt: new Date().toISOString(),
    });

    onPhase('probe');
    const ready = await waitReady(port, probeFn);
    if (!ready) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      deletePidFile(opts.outputDir);
      return { status: 'failed', error: `Playground failed to boot within ${READY_TIMEOUT_MS}ms; see ${logFilePath(opts.outputDir)}` };
    }

    onPhase('import');

    const warnings = extractWarnings(logFilePath(opts.outputDir));
    return {
      status: 'ready',
      url: `http://127.0.0.1:${port}`,
      pid: child.pid ?? undefined,
      port,
      warnings,
      source: 'playground',
    };
  } finally {
    release();
  }
}

const STALE_WARN_MS = 24 * 60 * 60 * 1000;

async function reconcileExistingPid(
  outputDir: string,
  isAliveFn: ((pid: number) => boolean) | undefined,
): Promise<void> {
  const existing = readPidFile(outputDir);
  if (!existing) return;

  const alive = (isAliveFn ?? isPidAlive)(existing.pid);
  const ageMs = Date.now() - Date.parse(existing.startedAt);
  const isStaleByAge = Number.isFinite(ageMs) && ageMs > STALE_WARN_MS;

  if (!alive) {
    deletePidFile(outputDir);
    return;
  }

  // Process is alive. We wrote this PID file, so treat it as ours and kill it.
  // PID reuse is rare on modern kernels; the blast radius of misidentification
  // is one SIGTERM to a local user process.
  if (isStaleByAge) {
    console.error(`[preview] stale preview running for >24h at PID ${existing.pid}; stopping it`);
  } else {
    console.error(`[preview] stopping prior preview at PID ${existing.pid} on port ${existing.port}`);
  }
  try {
    process.kill(existing.pid, 'SIGTERM');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') {
      console.error(`[preview] cannot signal PID ${existing.pid} (EPERM) — leaving process alone, clearing PID file`);
      deletePidFile(outputDir);
      return;
    }
    // ESRCH means already gone.
  }
  // Give it up to 5s to exit, then SIGKILL.
  const killDeadline = Date.now() + 5000;
  while (Date.now() < killDeadline) {
    if (!(isAliveFn ?? isPidAlive)(existing.pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if ((isAliveFn ?? isPidAlive)(existing.pid)) {
    try { process.kill(existing.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  deletePidFile(outputDir);
}

async function waitReady(port: number, probe: ProbeFn): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe(port)) return true;
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  return false;
}

export async function stopPreview(
  opts: { outputDir: string; _isPidAlive?: (pid: number) => boolean },
): Promise<import('./types.js').StopPreviewResult> {
  const rec = readPidFile(opts.outputDir);
  if (!rec) return { status: 'not-running' };

  const aliveFn = opts._isPidAlive ?? isPidAlive;
  const alive = aliveFn(rec.pid);
  if (!alive) {
    deletePidFile(opts.outputDir);
    return { status: 'stopped' };
  }

  // Probe signal-ability: if SIGTERM fails with EPERM, the PID is foreign —
  // don't spin polling isPidAlive (which returns true for EPERM) waiting for
  // a signal we can't deliver. Drop the stale/foreign PID file and report.
  try {
    process.kill(rec.pid, 'SIGTERM');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') {
      console.error(`[preview] cannot signal PID ${rec.pid} (EPERM) — leaving process alone, clearing PID file`);
      deletePidFile(opts.outputDir);
      return { status: 'stopped' };
    }
    // ESRCH etc. — already gone, fall through to cleanup.
  }
  const killDeadline = Date.now() + 5000;
  while (Date.now() < killDeadline) {
    if (!aliveFn(rec.pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (aliveFn(rec.pid)) {
    try { process.kill(rec.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  deletePidFile(opts.outputDir);
  return { status: 'stopped' };
}

function extractWarnings(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  try {
    const content = readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    return lines.filter((l) => /ERROR|WARN|Fatal/.test(l)).slice(-50);
  } catch {
    return [];
  }
}
