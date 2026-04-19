import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, basename, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { persistBlueprint } from './blueprint-builder.js';
import { buildMediaUrlMap, rewriteWxrAttachmentUrls } from './media-url-map.js';
import type { StartPreviewResult } from './types.js';

const execFileAsync = promisify(execFile);

const UPLOADS_SUBDIR = 'wp-content/uploads/liberation';

/** Absolute path to the vendored product-importer PHP script. */
const PRODUCT_IMPORT_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'scripts',
  'import-products.php',
);

/**
 * Absolute path to the vendored WXR-importer PHP script. Installs a
 * `pre_http_request` filter that short-circuits attachment HTTP fetches by
 * basename-match against the source dir, then runs WP_Import::import().
 * Needed because Studio's bundled wp-cli predates `wp import --source-dir`.
 */
const WXR_IMPORT_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'scripts',
  'import-wxr.php',
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
 * Stage extraction artifacts (media files, the WXR, products.csv) AND the
 * vendored PHP importer scripts inside the Studio site's wp-content/uploads/
 * liberation/ directory. The scripts must live under the site path because
 * Studio's wp-cli runtime can't read arbitrary host paths — `wp eval-file
 * /Users/.../import-wxr.php` errors out with "does not exist" even when the
 * file is present on the host.
 */
function stageArtifacts(outputDir: string, sitePath: string): {
  wxrRelPath: string | null;
  productsCsvRelPath: string | null;
  wxrScriptRelPath: string;
  productScriptRelPath: string;
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

  const wxrSrc = join(absOutput, 'output.wxr');
  let wxrRelPath: string | null = null;
  if (existsSync(wxrSrc)) {
    const wxrDest = join(stageDir, 'output.wxr');
    copyFileSync(wxrSrc, wxrDest);
    wxrRelPath = `${UPLOADS_SUBDIR}/output.wxr`;
  }

  const productsSrc = join(absOutput, 'products.csv');
  let productsCsvRelPath: string | null = null;
  if (existsSync(productsSrc)) {
    const productsDest = join(stageDir, 'products.csv');
    copyFileSync(productsSrc, productsDest);
    productsCsvRelPath = `${UPLOADS_SUBDIR}/products.csv`;
  }

  // Vendored PHP scripts. Studio's wp-cli can't eval-file host paths, so copy
  // them under the site dir. They're idempotent / overwrite-safe across reruns.
  const scriptsDir = join(stageDir, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(WXR_IMPORT_SCRIPT, join(scriptsDir, 'import-wxr.php'));
  copyFileSync(PRODUCT_IMPORT_SCRIPT, join(scriptsDir, 'import-products.php'));
  const wxrScriptRelPath = `${UPLOADS_SUBDIR}/scripts/import-wxr.php`;
  const productScriptRelPath = `${UPLOADS_SUBDIR}/scripts/import-products.php`;

  return {
    wxrRelPath,
    productsCsvRelPath,
    wxrScriptRelPath,
    productScriptRelPath,
    hasMedia,
  };
}

export interface StartStudioOpts {
  outputDir: string;
}

/**
 * Full-fidelity Studio preview:
 *   1. Create a site with a blueprint that only pre-installs wordpress-importer
 *      + WooCommerce (if products.csv exists). We intentionally do NOT inline
 *      the WXR via `importWxr` — that step hardcodes FETCH_ATTACHMENTS=true,
 *      and fetching 100s of attachments from the origin CDN easily blows
 *      Studio's 120s `start-server` silence timeout.
 *   2. Stage media, the WXR, and products.csv into wp-content/uploads/liberation/.
 *   3. Rewrite `<wp:attachment_url>` entries so their basename matches the
 *      staged filename — collision suffixes (`foo-2.jpg`) would otherwise
 *      mismatch the original URL's basename.
 *   4. Run the vendored `import-wxr.php` via `wp eval-file`. It installs a
 *      `pre_http_request` filter that basename-matches attachment URLs
 *      against the staged source dir and short-circuits the fetch — no HTTP,
 *      no CDN round-trips, no deadlock with Studio's SinglePHPInstanceManager.
 *      (Studio's bundled wp-cli predates `wp import --source-dir`, so we
 *      replicate that behavior ourselves.)
 *   5. Run the vendored import-products.php via `wp eval-file` — WC core has
 *      no CLI CSV-import subcommand, so we invoke WC_Product_CSV_Importer
 *      directly. Product-import failures are non-fatal.
 *
 * Studio's `site create` blocks until the blueprint finishes, and studioWp
 * calls block until WP-CLI returns — so when we resolve, the full import is
 * actually done and it's safe to open the browser / prompt for the real
 * WordPress import.
 */
export async function startStudioPreview(opts: StartStudioOpts): Promise<StartPreviewResult> {
  const blueprintPath = persistBlueprint(opts.outputDir, 'studio');
  let existingSites: StudioSite[] = [];
  try {
    existingSites = await listStudioSites();
  } catch {
    // If we can't list sites, proceed with the base slug — `studio site create`
    // will error on true collision and we'll surface that to the user.
  }
  const existingNames = existingSites.map((s) => s.name);
  const existingPaths = new Set(existingSites.map((s) => resolve(s.path)));
  const name = makeStudioSiteName(opts.outputDir, existingNames);
  const sitePath = join(defaultStudioRoot(), name);
  const absOutput = resolve(opts.outputDir);
  const hasProducts = existsSync(join(absOutput, 'products.csv'));

  // If a directory exists at sitePath but the daemon has no matching site,
  // it's an orphan from a prior failed run. Studio reuses the dir silently
  // (skips "Creating site directory…") and then WP server crashes during
  // blueprint apply because SQLite/plugins/etc. collide with the reused
  // state. Clean it up before `site create` so we get a fresh install.
  //
  // Only delete dirs under the standard Studio root — never touch a user
  // directory that Studio actively owns.
  if (
    existsSync(sitePath) &&
    !existingPaths.has(resolve(sitePath)) &&
    resolve(sitePath).startsWith(resolve(defaultStudioRoot()) + '/')
  ) {
    rmSync(sitePath, { recursive: true, force: true });
  }

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

  // From here on, the site exists (with plugins installed by the blueprint)
  // but NO content is imported yet. Stage artifacts, then run `wp import`.
  // Infra failures (staging, site lookup) trigger cleanup; content-import
  // failures bubble up the same way. Product-CSV failure is demoted to a
  // warning since losing the whole site over products is too destructive.
  const warnings: string[] = [];
  try {
    const staged = stageArtifacts(opts.outputDir, sitePath);

    if (staged.wxrRelPath) {
      const wxrAbsPath = join(sitePath, staged.wxrRelPath);
      const mediaDir = join(sitePath, UPLOADS_SUBDIR);
      // Studio's bundled wp-cli lacks `wp import --source-dir` (newer flag),
      // so we drive the import from our own PHP script which installs a
      // `pre_http_request` filter to basename-match attachment URLs against
      // the local staged dir. Collision-suffixed filenames (`foo-2.jpg`)
      // would mismatch the origin URL's basename — rewrite those URLs so
      // basename matches the staged file. 127.0.0.1 is chosen as the
      // rewrite host because wp_http_validate_url accepts numeric IPs
      // unconditionally (it only does DNS lookups for named hosts) and the
      // PHP script whitelists it via http_request_host_is_external.
      const mediaMap = buildMediaUrlMap(opts.outputDir);
      rewriteWxrAttachmentUrls(wxrAbsPath, mediaMap, 'http://127.0.0.1');
      const wxrScriptAbs = join(sitePath, staged.wxrScriptRelPath);
      await studioWp(sitePath, [
        'eval-file', wxrScriptAbs, wxrAbsPath, mediaDir,
      ]);
    }

    if (hasProducts && staged.productsCsvRelPath) {
      const csvAbsPath = join(sitePath, staged.productsCsvRelPath);
      const productScriptAbs = join(sitePath, staged.productScriptRelPath);
      try {
        await studioWp(sitePath, [
          'eval-file', productScriptAbs, csvAbsPath, '--user=admin',
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
