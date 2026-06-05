//
// Per-URL media install
// =====================
// Phase 1.5 of the streaming/incremental replicate pipeline. For each URL
// processed by the streaming loop, install pending media into the running
// Studio replica WP site so pages render with real images while streaming.
//
// Behavior:
//   - Reads MediaStubStore.list() for all stubs in `success` state with
//     `localPath` set and no `wpPostId` (i.e., not yet installed).
//   - Copies each file from <outputDir>/media/<filename> into
//     <wpRoot>/wp-content/uploads/<year>/<month>/<filename> based on the
//     local file's mtime (matches WP's default uploads layout).
//   - Invokes a vendored PHP script (install-media.php) via `studio wp
//     eval-file` that runs `wp_insert_attachment` for each entry.
//     The script is idempotent: it checks `_wp_attached_file` first and
//     re-uses an existing attachment ID when present.
//   - Records the resulting post ID back into MediaStubStore via
//     `recordWpPostId(url, postId)` so subsequent calls skip the URL.
//
// Scope:
//   - Per the contract, this installs ALL pending media each call. The
//     existing MediaStubStore doesn't track URL→media membership, so
//     scoping to one URL's media isn't possible without a schema change.
//     Idempotency keeps duplicate calls cheap.
//
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MediaStubStore, type MediaStub } from '../extraction/media-stubs.js';

const execFileAsync = promisify(execFile);

/** Vendored PHP installer that runs inside the running WP site via wp-cli. */
const INSTALL_MEDIA_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'preview',
  'scripts',
  'install-media.php',
);

/**
 * Studio mounts the host site directory at VFS path `/wordpress` (mirrors
 * studio.ts's STUDIO_VFS_ROOT constant). Re-declared here to avoid a
 * cross-module dependency for a path constant.
 */
const STUDIO_VFS_ROOT = '/wordpress';

const SCRIPTS_SUBDIR = '.dla-scripts';
const PAYLOADS_SUBDIR = '.dla-scripts/payloads';

export interface MediaInstallOpts {
  /** Liberation output directory containing media/ and media-stubs.json. */
  outputDir: string;
  /** Source URL whose media we're installing — kept for trace logging. */
  url: string;
  /** Running Studio WP install root (e.g. <sitePath>/wordpress or <sitePath> for flat sites). */
  wpRoot: string;
  /** Override the studio binary location (for tests). */
  _studioBin?: string;
  /** Inject an exec-file impl (for tests). */
  _execFile?: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
}

export interface MediaInstallResult {
  installed: Array<{ sourceUrl: string; postId: number; localUrl: string; localPath: string }>;
  skipped: Array<{ sourceUrl: string; reason: 'already-installed' | 'no-local-file' | 'no-stub' }>;
  errors: Array<{ sourceUrl: string; error: string }>;
}

interface PayloadEntry {
  filename: string;
  year: string;
  month: string;
  sourceUrl: string;
}

interface PhpResultEntry {
  sourceUrl: string;
  filename: string;
  postId: number;
  reused: boolean;
  localUrl: string;
}

interface PhpErrorEntry {
  sourceUrl: string;
  filename: string;
  error: string;
}

interface PhpResponse {
  results: PhpResultEntry[];
  errors: PhpErrorEntry[];
}

/** Single entry-point. Always opens MediaStubStore in-place. */
export async function installMediaForUrl(opts: MediaInstallOpts): Promise<MediaInstallResult> {
  const result: MediaInstallResult = { installed: [], skipped: [], errors: [] };
  const stubs = MediaStubStore.load(opts.outputDir);
  const mediaDir = join(resolve(opts.outputDir), 'media');

  // 1. Walk every stub and bucket it: ready-to-install, already-done,
  // not-locally-downloaded, etc.
  const pending: Array<{ url: string; stub: MediaStub; entry: PayloadEntry; absPath: string }> = [];
  for (const [url, stub] of stubs.list()) {
    if (stub.status !== 'success' || !stub.localPath) {
      result.skipped.push({ sourceUrl: url, reason: 'no-local-file' });
      continue;
    }
    if (typeof stub.wpPostId === 'number') {
      // Already-installed: surface the persisted localUrl in `installed`
      // so the run-wide rewrite map can be (re-)built from this call's
      // result alone, even on resume runs where the PHP script wouldn't
      // re-run for these entries. Falls back to `skipped` when the stub
      // pre-dates the localUrl persistence change.
      if (stub.localUrl) {
        result.installed.push({
          sourceUrl: url,
          postId: stub.wpPostId,
          localUrl: stub.localUrl,
          localPath: stub.localPath ?? '',
        });
      } else {
        result.skipped.push({ sourceUrl: url, reason: 'already-installed' });
      }
      continue;
    }
    // Resolve the canonical filename. localPath may be absolute (older
    // adapters) or just a basename — handle both. Source-of-truth is
    // <outputDir>/media/<basename>.
    const filename = basenameOf(stub.localPath);
    const absPath = join(mediaDir, filename);
    if (!existsSync(absPath)) {
      result.skipped.push({ sourceUrl: url, reason: 'no-local-file' });
      continue;
    }

    let mtime: Date;
    try {
      mtime = statSync(absPath).mtime;
    } catch {
      // Treat unstattable files as missing — should be rare; surfaces as
      // a skip rather than a hard failure.
      result.skipped.push({ sourceUrl: url, reason: 'no-local-file' });
      continue;
    }
    const year = String(mtime.getFullYear()).padStart(4, '0');
    const month = String(mtime.getMonth() + 1).padStart(2, '0');

    pending.push({ url, stub, entry: { filename, year, month, sourceUrl: url }, absPath });
  }

  if (pending.length === 0) {
    return result;
  }

  // 2. Copy each pending file into the running site's uploads dir.
  // This must happen BEFORE the PHP script runs — wp_insert_attachment
  // requires the file to exist on disk to compute metadata.
  const uploadsRoot = join(resolve(opts.wpRoot), 'wp-content', 'uploads');
  for (const item of pending) {
    const destDir = join(uploadsRoot, item.entry.year, item.entry.month);
    const destPath = join(destDir, item.entry.filename);
    try {
      mkdirSync(destDir, { recursive: true });
      // Idempotent: if the file is already in place, skip the copy.
      if (!existsSync(destPath)) {
        copyFileSync(item.absPath, destPath);
      }
    } catch (err) {
      result.errors.push({ sourceUrl: item.url, error: `copy: ${(err as Error).message}` });
    }
  }

  // Drop any items whose copy failed before invoking PHP.
  const installedFiles = pending.filter(
    (p) => !result.errors.find((e) => e.sourceUrl === p.url),
  );
  if (installedFiles.length === 0) {
    return result;
  }

  // 3. Stage payload + invoke wp eval-file.
  let scriptOut: { stdout: string; resultHostPath: string };
  try {
    scriptOut = await installViaStudio(opts, installedFiles.map((p) => p.entry));
  } catch (err) {
    // The shell-level failure means none of the entries got registered.
    // Each pending entry surfaces as an error so the caller can retry.
    for (const item of installedFiles) {
      result.errors.push({
        sourceUrl: item.url,
        error: `wp eval-file install-media.php failed: ${formatExecError(err)}`,
      });
    }
    return result;
  }

  // 4. Parse the script's response and reconcile with the stub store.
  const parsed = parsePhpResponse(scriptOut.stdout, scriptOut.resultHostPath);
  if (!parsed) {
    for (const item of installedFiles) {
      result.errors.push({
        sourceUrl: item.url,
        error: 'install-media.php produced no parseable JSON response',
      });
    }
    return result;
  }

  for (const ok of parsed.results) {
    if (typeof ok.postId === 'number' && ok.postId > 0) {
      stubs.recordWpPostId(ok.sourceUrl, ok.postId);
    }
    if (ok.localUrl) {
      // Persist the localUrl to the stub so resume runs can rebuild the
      // source→local rewrite map without re-running the PHP script.
      stubs.recordLocalUrl(ok.sourceUrl, ok.localUrl);
    }
    const stub = stubs.get(ok.sourceUrl);
    result.installed.push({
      sourceUrl: ok.sourceUrl,
      postId: ok.postId,
      // Prefer the store's normalized (root-relative) localUrl so the run-wide
      // rewrite map is port-independent; fall back to the raw upload URL.
      localUrl: stub?.localUrl ?? ok.localUrl,
      localPath: stub?.localPath ?? '',
    });
  }
  for (const fail of parsed.errors) {
    result.errors.push({ sourceUrl: fail.sourceUrl, error: fail.error });
  }

  return result;
}

async function installViaStudio(opts: MediaInstallOpts, entries: PayloadEntry[]): Promise<{ stdout: string; resultHostPath: string }> {
  // The PHP script must be readable inside Studio's VFS. Studio mounts the
  // *site* directory at /wordpress. Studio sites exist in two layouts:
  //   - flat:   <site>/wp-content
  //   - nested: <site>/wordpress/wp-content
  // The watch runner passes the WP root, so resolve it back to the Studio
  // site path before invoking `studio wp --path`.
  const sitePath = studioSitePathForWpRoot(opts.wpRoot);
  const scriptsDir = join(sitePath, SCRIPTS_SUBDIR);
  const payloadsDir = join(sitePath, PAYLOADS_SUBDIR);
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(payloadsDir, { recursive: true });

  const scriptHostPath = join(scriptsDir, 'install-media.php');
  copyFileSync(INSTALL_MEDIA_SCRIPT, scriptHostPath);

  const payloadFilename = `install-media-${Date.now()}-${process.pid}.json`;
  const payloadHostPath = join(payloadsDir, payloadFilename);
  writeFileSync(payloadHostPath, JSON.stringify(entries), 'utf8');

  const scriptVfsPath = `${STUDIO_VFS_ROOT}/${SCRIPTS_SUBDIR}/install-media.php`;
  const payloadVfsPath = `${STUDIO_VFS_ROOT}/${PAYLOADS_SUBDIR}/${payloadFilename}`;

  const studioBin = opts._studioBin ?? 'studio';
  const exec = opts._execFile ?? defaultExec;
  const out = await exec(studioBin, [
    'wp', '--path', sitePath,
    'eval-file', scriptVfsPath, payloadVfsPath,
  ]);
  // The script writes its full response to `<payload>.result.json` on the host
  // FS (Studio mounts the site dir), so we can read it directly and bypass the
  // 64KB stdout cap.
  return { stdout: out.stdout, resultHostPath: `${payloadHostPath}.result.json` };
}

function studioSitePathForWpRoot(wpRoot: string): string {
  const resolved = resolve(wpRoot);
  if (basenameOf(resolved) === 'wordpress') {
    return dirname(resolved);
  }
  return resolved;
}

function defaultExec(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args as string[], { timeout: 300_000, maxBuffer: 50 * 1024 * 1024 })
    .then(({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr) }));
}

function formatExecError(err: unknown): string {
  const e = err as Error & { stderr?: string; stdout?: string };
  const parts = [e?.message ? e.message.trim() : String(err)];
  if (e?.stderr?.trim()) parts.push(`stderr: ${e.stderr.trim().slice(-1000)}`);
  if (e?.stdout?.trim()) parts.push(`stdout: ${e.stdout.trim().slice(-1000)}`);
  return parts.join(' | ');
}

/**
 * Extract the JSON payload between the script's BEGIN/END sentinels. Returns
 * null when the sentinels are missing or the body fails to parse — the caller
 * surfaces a generic error in either case.
 *
 * Two body shapes are supported:
 *   1. A `{ resultFile: "<path>" }` pointer — the script wrote the full
 *      response to a sidecar file (default; bypasses Studio's 64KB stdout cap).
 *      We read that file off the host FS. `resultHostPath` is the host path the
 *      caller knows; we prefer it over the (VFS) path the script reports so the
 *      read works regardless of mount mapping.
 *   2. Inline JSON (backward-compatible fallback for small payloads or when the
 *      sidecar write failed).
 */
function parsePhpResponse(stdout: string, resultHostPath?: string): PhpResponse | null {
  const begin = 'DLA_INSTALL_MEDIA_JSON_BEGIN';
  const end = 'DLA_INSTALL_MEDIA_JSON_END';
  const start = stdout.indexOf(begin);
  const stop = stdout.indexOf(end);
  if (start < 0 || stop < 0 || stop <= start) return null;
  const body = stdout.slice(start + begin.length, stop).trim();

  let raw = body;
  try {
    const maybePointer = JSON.parse(body) as { resultFile?: string };
    if (maybePointer && typeof maybePointer.resultFile === 'string') {
      // Prefer the host path the caller computed; fall back to the path the
      // script reported (only valid when host FS === reported path).
      const path = resultHostPath ?? maybePointer.resultFile;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    }
  } catch {
    // Not JSON at all → fall through; the parse below will fail and return null.
  }

  try {
    const parsed = JSON.parse(raw) as PhpResponse;
    if (!parsed || !Array.isArray(parsed.results) || !Array.isArray(parsed.errors)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Cross-platform basename — avoids path.basename pitfalls on mixed separators. */
function basenameOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
