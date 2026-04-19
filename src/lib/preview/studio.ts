import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, basename, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { persistBlueprint } from './blueprint-builder.js';
import type { StartPreviewResult } from './types.js';

const execFileAsync = promisify(execFile);

const UPLOADS_SUBDIR = 'wp-content/uploads/liberation';

/** Absolute path to the vendored product-importer PHP script. */
const PRODUCT_IMPORT_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'scripts',
  'import-products.php',
);

export interface StudioSite {
  id: string;
  name: string;
  path: string;
  port: number;
  url: string;
  running: boolean;
  adminUsername: string;
  adminPassword: string;
}

/**
 * Returns true if the `studio` CLI binary is reachable on PATH.
 * Fast-fails on any error so startPreview can fall through to Playground.
 */
export function isStudioAvailable(): boolean {
  try {
    execFileSync('studio', ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitize an outputDir basename (a domain-derived slug) into a Studio site
 * name. If the slug already matches an existing site, append `-2`, `-3`, etc.
 * until it's unique. Callers pass the current `studio site list` output so we
 * don't clobber user sites.
 */
export function makeStudioSiteName(outputDir: string, existingNames: string[] = []): string {
  const base = basename(resolve(outputDir))
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'site';
  const taken = new Set(existingNames);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function defaultStudioRoot(): string {
  return process.env.STUDIO_SITES_DIR || join(homedir(), 'Studio');
}

async function listStudioSites(): Promise<StudioSite[]> {
  const { stdout } = await execFileAsync('studio', ['site', 'list', '--format', 'json'], {
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const trimmed = stdout.slice(stdout.indexOf('['));
  return JSON.parse(trimmed) as StudioSite[];
}

async function studioWp(sitePath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'studio',
    ['wp', '--path', sitePath, ...args],
    { timeout: 300_000, maxBuffer: 50 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * Best-effort cleanup for a Studio site that `startStudioPreview` created but
 * then failed to finish setting up (staging, wp import, etc.). We'd rather
 * leak disk than leave half-imported sites cluttering `studio site list`.
 * Studio's `site delete` prompts interactively — we send 'y\n' on stdin.
 * Identified by `--path` (the CLI has no --name) so callers pass the on-disk
 * site path, not the site's display name.
 */
async function removeStudioSite(sitePath: string): Promise<void> {
  try {
    const child = execFile(
      'studio',
      ['site', 'delete', '--path', sitePath],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
    );
    child.stdin?.end('y\n');
    await new Promise<void>((resolve, reject) => {
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`studio site delete exited with ${code}`))));
      child.on('error', reject);
    });
  } catch {
    // Removal itself failed — log once and give up; the user can clean
    // manually via `studio site delete`.
    console.error(`[preview] could not auto-remove orphaned Studio site at "${sitePath}"; remove manually with: studio site delete --path ${sitePath}`);
  }
}

/**
 * Stage extraction artifacts that the blueprint can't inline (media files +
 * products.csv) inside the Studio site's wp-content/uploads/liberation/. The
 * WXR itself is inlined into the blueprint as a LiteralReference — see
 * blueprint-builder.ts for why (bypasses Studio's WP-CLI IPC 120s timeout).
 */
function stageArtifacts(outputDir: string, sitePath: string): {
  productsCsvRelPath: string | null;
  hasMedia: boolean;
} {
  const absOutput = resolve(outputDir);
  const stageDir = join(sitePath, UPLOADS_SUBDIR);
  mkdirSync(stageDir, { recursive: true });

  const mediaSrc = join(absOutput, 'media');
  let hasMedia = false;
  if (existsSync(mediaSrc)) {
    cpSync(mediaSrc, stageDir, { recursive: true });
    hasMedia = true;
  }

  const productsSrc = join(absOutput, 'products.csv');
  let productsCsvRelPath: string | null = null;
  if (existsSync(productsSrc)) {
    const productsDest = join(stageDir, 'products.csv');
    copyFileSync(productsSrc, productsDest);
    productsCsvRelPath = `${UPLOADS_SUBDIR}/products.csv`;
  }

  return {
    productsCsvRelPath,
    hasMedia,
  };
}

export interface StartStudioOpts {
  outputDir: string;
}

/**
 * Full-fidelity Studio preview:
 *   1. Create a site with a blueprint that pre-installs wordpress-importer +
 *      WooCommerce (if products.csv exists) AND inlines the WXR via importWxr
 *      so posts/pages/media import during `studio site create`.
 *   2. Copy media + products.csv into the site's wp-content/uploads/liberation/
 *      directory so attachment URLs resolve and the CSV is reachable from PHP.
 *   3. Run the vendored import-products.php via `wp eval-file` — WC core has
 *      no CLI CSV-import subcommand, so we invoke WC_Product_CSV_Importer
 *      directly. Failures here are non-fatal (the site + content are already
 *      live; user can re-run the importer or import via admin UI).
 *
 * Studio's `site create` blocks until the blueprint finishes, and studioWp
 * calls block until WP-CLI returns — so when we resolve, the full import is
 * actually done and it's safe to open the browser / prompt for the real
 * WordPress import.
 */
export async function startStudioPreview(opts: StartStudioOpts): Promise<StartPreviewResult> {
  const blueprintPath = persistBlueprint(opts.outputDir, 'studio');
  let existingNames: string[] = [];
  try {
    const sites = await listStudioSites();
    existingNames = sites.map((s) => s.name);
  } catch {
    // If we can't list sites, proceed with the base slug — `studio site create`
    // will error on true collision and we'll surface that to the user.
  }
  const name = makeStudioSiteName(opts.outputDir, existingNames);
  const sitePath = join(defaultStudioRoot(), name);
  const absOutput = resolve(opts.outputDir);
  const hasProducts = existsSync(join(absOutput, 'products.csv'));

  try {
    await execFileAsync(
      'studio',
      [
        'site', 'create',
        '--name', name,
        '--path', sitePath,
        '--blueprint', blueprintPath,
        '--skip-browser',
        '--skip-log-details',
        '--start',
      ],
      { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (err) {
    return {
      status: 'failed',
      error: `studio site create failed: ${(err as Error).message}`,
    };
  }

  // From here on, the site exists and has its WXR content imported. Infra
  // failures (listing sites, staging artifacts) trigger cleanup; product-CSV
  // failures are demoted to warnings so we don't nuke a working preview.
  const warnings: string[] = [];
  try {
    // WXR import happened DURING site creation via the blueprint's importWxr
    // step — see blueprint-builder.ts. We only stage media + products.csv for
    // the out-of-band WooCommerce product import below.
    const staged = stageArtifacts(opts.outputDir, sitePath);

    if (hasProducts && staged.productsCsvRelPath) {
      const csvAbsPath = join(sitePath, staged.productsCsvRelPath);
      try {
        await studioWp(sitePath, [
          'eval-file', PRODUCT_IMPORT_SCRIPT, csvAbsPath, '--user=admin',
        ]);
      } catch (err) {
        // Content is already in; losing the whole site over products is too
        // destructive. Surface as a warning so the user can retry the import
        // via `wp eval-file` or the admin UI.
        warnings.push(`Product import failed: ${(err as Error).message.trim()}`);
      }
    }

    const sites = await listStudioSites();
    const site = sites.find((s) => s.name === name);
    if (!site) {
      throw new Error(`Studio site "${name}" not found after creation`);
    }
    return {
      status: 'ready',
      url: site.url,
      port: site.port,
      warnings,
      source: 'studio',
      siteName: site.name,
    };
  } catch (err) {
    await removeStudioSite(sitePath);
    return {
      status: 'failed',
      error: `Studio preview setup failed (site removed): ${(err as Error).message}`,
    };
  }
}
