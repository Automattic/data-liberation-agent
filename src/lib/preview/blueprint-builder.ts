import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

export interface BuildBlueprintOpts {
  outputDir: string;
  mode?: BlueprintMode;
}

export function buildBlueprint({ outputDir, mode = 'playground' }: BuildBlueprintOpts): Blueprint {
  const abs = resolve(outputDir);
  const hasProducts = existsSync(join(abs, 'products.csv'));

  const steps: BlueprintStep[] = [];

  if (mode === 'studio') {
    // Studio has no --mount equivalent. We create the site with just the
    // plugins pre-installed (wordpress-importer for WXR, WooCommerce if the
    // extraction has products). The actual imports happen out-of-band via
    // `studio wp` after files are copied into the site's uploads dir — see
    // startStudioPreview. landingPage and importWxr are deliberately left out
    // because Studio rejects or can't resolve them without a mount.
    steps.push({
      step: 'installPlugin',
      pluginData: { resource: 'wordpress.org/plugins', slug: 'wordpress-importer' },
    });
    if (hasProducts) {
      steps.push({
        step: 'installPlugin',
        pluginData: { resource: 'wordpress.org/plugins', slug: 'woocommerce' },
      });
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
      steps.push({
        step: 'wp-cli',
        command: `wp wc product_importer import ${VFS_MOUNT_DIR}/products.csv --user=admin`,
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
