import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type BlueprintMode = 'playground' | 'studio';

export type BlueprintStep =
  | { step: 'importWxr'; file: WxrFileRef }
  | { step: 'installPlugin'; pluginData: { resource: string; slug: string } }
  | { step: 'wp-cli'; command: string }
  | { step: 'writeFile'; path: string; data: string };

type WxrFileRef =
  | { resource: 'vfs'; path: string }
  | { resource: 'literal'; name: string; contents: string };

export interface Blueprint {
  landingPage: string;
  preferredVersions: { php: string; wp: string };
  login: boolean;
  steps: BlueprintStep[];
}

export const VFS_MOUNT_DIR = '/wordpress/wp-content/uploads/liberation';
export const IMPORT_COMPLETE_MARKER = '.import-complete';

/** Absolute path to the vendored product-importer PHP script on the host. */
const PRODUCT_IMPORT_SCRIPT_HOST = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'scripts',
  'import-products.php',
);

/** Where the script lands inside Playground's VFS before wp-cli eval-files it. */
const PRODUCT_IMPORT_SCRIPT_VFS = `${VFS_MOUNT_DIR}/import-products.php`;

export interface BuildBlueprintOpts {
  outputDir: string;
  mode?: BlueprintMode;
}

export function buildBlueprint({ outputDir, mode = 'playground' }: BuildBlueprintOpts): Blueprint {
  const abs = resolve(outputDir);
  const hasProducts = existsSync(join(abs, 'products.csv'));

  const steps: BlueprintStep[] = [];

  if (mode === 'studio') {
    // Studio's blueprint runs INSIDE the `start-server` IPC window (120s
    // no-activity). Playground's `importWxr` step hardcodes FETCH_ATTACHMENTS
    // = true, so for sites with many media items it blows the window fetching
    // from the origin CDN.
    //
    // Instead we only install plugins in the blueprint and stage the WXR +
    // media files post-create. startStudioPreview then rewrites the WXR's
    // attachment URLs to `http://localhost:<port>/wp-content/uploads/liberation/<filename>`
    // (served by the local WP) and invokes `wp import --fetch-attachments`
    // out-of-band — localhost fetches are fast so we comfortably stay inside
    // the wp-cli-command IPC window too.
    steps.push({
      step: 'installPlugin',
      pluginData: { resource: 'wordpress.org/plugins', slug: 'wordpress-importer' },
    });
    if (hasProducts) {
      steps.push({
        step: 'installPlugin',
        pluginData: { resource: 'wordpress.org/plugins', slug: 'woocommerce' },
      });
      // Product CSV import happens out-of-band via `wp eval-file` in
      // startStudioPreview — WC core has no CLI CSV-import subcommand, and the
      // blueprint schema has no native wc_product_importer step.
    }
  } else {
    steps.push({
      step: 'importWxr',
      file: { resource: 'vfs', path: `${VFS_MOUNT_DIR}/output.wxr` },
    });
    if (hasProducts) {
      steps.push({
        step: 'installPlugin',
        pluginData: { resource: 'wordpress.org/plugins', slug: 'woocommerce' },
      });
      // WC core has no CLI CSV-import subcommand, so we writeFile our vendored
      // import-products.php into the mount dir and invoke it via wp eval-file
      // with the CSV path as a positional arg.
      steps.push({
        step: 'writeFile',
        path: PRODUCT_IMPORT_SCRIPT_VFS,
        data: readFileSync(PRODUCT_IMPORT_SCRIPT_HOST, 'utf8'),
      });
      steps.push({
        step: 'wp-cli',
        command: `wp eval-file ${PRODUCT_IMPORT_SCRIPT_VFS} ${VFS_MOUNT_DIR}/products.csv --user=admin`,
      });
    }
    // Playground-only: sentinel the host filesystem via the mount so the
    // readiness probe can detect blueprint completion. Studio doesn't need
    // this — `studio site create` blocks until the blueprint finishes.
    steps.push({
      step: 'writeFile',
      path: `${VFS_MOUNT_DIR}/${IMPORT_COMPLETE_MARKER}`,
      data: new Date().toISOString(),
    });
  }

  return {
    landingPage: '/',
    preferredVersions: {
      php: '8.2',
      wp: process.env.DLA_PREVIEW_WP_VERSION ?? 'latest',
    },
    login: true,
    steps,
  };
}

export function persistBlueprint(outputDir: string, mode: BlueprintMode = 'playground'): string {
  const bp = buildBlueprint({ outputDir, mode });
  const dir = join(resolve(outputDir), 'playground');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, mode === 'studio' ? 'blueprint.studio.json' : 'blueprint.json');
  writeFileSync(filePath, JSON.stringify(bp, null, 2));
  return filePath;
}
