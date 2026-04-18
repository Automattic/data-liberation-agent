import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { cpSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { persistBlueprint } from './blueprint-builder.js';
import type { StartPreviewResult } from './types.js';

const execFileAsync = promisify(execFile);

const UPLOADS_SUBDIR = 'wp-content/uploads/liberation';

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
 * `studio site remove` prompts interactively without --yes.
 */
async function removeStudioSite(name: string): Promise<void> {
  try {
    await execFileAsync('studio', ['site', 'remove', '--name', name, '--yes'], {
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    // Removal itself failed — log once and give up; the user can clean
    // manually via `studio site remove`.
    console.error(`[preview] could not auto-remove orphaned Studio site "${name}"; remove manually with: studio site remove --name ${name} --yes`);
  }
}

/**
 * Stage the extraction artifacts inside the Studio site so WP-CLI imports can
 * resolve them as normal uploads (WXR attachment URLs reference these paths).
 */
function stageArtifacts(outputDir: string, sitePath: string): {
  wxrRelPath: string;
  productsCsvRelPath: string | null;
  hasMedia: boolean;
} {
  const absOutput = resolve(outputDir);
  const stageDir = join(sitePath, UPLOADS_SUBDIR);
  mkdirSync(stageDir, { recursive: true });

  copyFileSync(join(absOutput, 'output.wxr'), join(stageDir, 'output.wxr'));

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
    wxrRelPath: `${UPLOADS_SUBDIR}/output.wxr`,
    productsCsvRelPath,
    hasMedia,
  };
}

export interface StartStudioOpts {
  outputDir: string;
}

/**
 * Full-fidelity Studio preview:
 *   1. Create a site with a minimal blueprint (plugins pre-installed:
 *      wordpress-importer, and WooCommerce if products.csv exists).
 *   2. Copy the WXR, media, and products.csv into the site's wp-content/
 *      uploads/liberation/ directory so attachment URLs resolve.
 *   3. Run `studio wp import` to bring in posts + pages + media.
 *   4. Run `studio wp wc product_importer import` for WooCommerce products.
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

  // From here on, the site exists. Any failure should trigger cleanup so
  // repeated failed runs don't pile up orphaned sites in `studio site list`.
  try {
    const staged = stageArtifacts(opts.outputDir, sitePath);
    await studioWp(sitePath, ['import', staged.wxrRelPath, '--authors=skip']);

    if (hasProducts && staged.productsCsvRelPath) {
      await studioWp(sitePath, [
        'wc', 'product_importer', 'import', staged.productsCsvRelPath,
        '--user=admin',
      ]);
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
      warnings: [],
      source: 'studio',
      siteName: site.name,
    };
  } catch (err) {
    await removeStudioSite(name);
    return {
      status: 'failed',
      error: `Studio preview setup failed (site removed): ${(err as Error).message}`,
    };
  }
}
