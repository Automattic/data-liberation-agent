//
// Replica Install Helpers
// =======================
// Shared utilities for the Studio path (writes directly to
// <sitePath>/wordpress/wp-content/themes,plugins).
//
// Two responsibilities:
//   - Sanitize relativePath entries so they cannot escape the install root.
//   - Convert a (themeFiles, blockPlugins, themeSlug) tuple into a list of
//     concrete (vfsPath, content) writes the caller can apply.
//
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import type { ReplicaFile, ReplicaBlockPlugin } from './types.js';
import {
  containsCustomHtmlBlock,
  customHtmlBlockError,
} from '../wordpress/block-policy.js';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/;

/** Kebab-case, starts and ends with letter or digit, no consecutive or trailing dashes. */
export function validateSlug(slug: string, kind: 'theme' | 'plugin'): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid ${kind} slug: ${JSON.stringify(slug)}. Must be lowercase letters, digits, and single hyphens; cannot start/end with hyphen or contain --.`,
    );
  }
}

/**
 * Reject a relativePath that is absolute, contains traversal segments, or
 * normalizes outside the install root. The caller writes to
 * `<rootDir>/<relativePath>` — these checks ensure that resolves *inside*
 * rootDir.
 */
export function safeRelativePath(relativePath: string): string {
  if (!relativePath) throw new Error('relativePath is empty');
  if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
    throw new Error(`relativePath must not start with a slash: ${relativePath}`);
  }
  // Check the raw input for `..` segments before normalize() collapses them.
  for (const seg of relativePath.split(/[\\/]/)) {
    if (seg === '..') {
      throw new Error(`relativePath contains path traversal: ${relativePath}`);
    }
  }
  const norm = normalize(relativePath);
  if (norm.startsWith('/') || norm.startsWith('..')) {
    throw new Error(`relativePath normalized outside root: ${relativePath}`);
  }
  return norm;
}

function isThemeJsonPath(relativePath: string): boolean {
  return safeRelativePath(relativePath).replace(/\\/g, '/') === 'theme.json';
}

function pruneInvalidSpacingPresetOriginValues(themeJson: Record<string, unknown>): void {
  const settings = themeJson.settings;
  if (!settings || typeof settings !== 'object') return;
  const spacing = (settings as Record<string, unknown>).spacing;
  if (!spacing || typeof spacing !== 'object') return;
  const spacingRecord = spacing as Record<string, unknown>;

  for (const key of ['spacingScale', 'spacingSizes']) {
    const value = spacingRecord[key];
    if (value === false || value === null) {
      delete spacingRecord[key];
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;

    const record = value as Record<string, unknown>;
    for (const origin of ['default', 'theme', 'custom']) {
      if (origin in record && (record[origin] === false || record[origin] === null)) {
        delete record[origin];
      }
    }
    if (Object.keys(record).length === 0) {
      delete spacingRecord[key];
    }
  }
}

export function sanitizeReplicaFile(file: ReplicaFile): ReplicaFile {
  if (!isThemeJsonPath(file.relativePath)) return file;
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    return file;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return file;
  pruneInvalidSpacingPresetOriginValues(parsed as Record<string, unknown>);
  return {
    ...file,
    content: JSON.stringify(parsed, null, 2) + '\n',
  };
}

/** Throw if any file in the set fails validation. Run BEFORE writing anything. */
export function validateReplicaInputs(
  themeFiles: ReplicaFile[] | undefined,
  blockPlugins: ReplicaBlockPlugin[] | undefined,
  themeSlug: string | undefined,
): void {
  if (themeFiles && themeFiles.length > 0) {
    if (!themeSlug) throw new Error('themeSlug is required when themeFiles is non-empty');
    validateSlug(themeSlug, 'theme');
    for (const original of themeFiles) {
      const f = sanitizeReplicaFile(original);
      safeRelativePath(f.relativePath);
      if (containsCustomHtmlBlock(f.content)) {
        throw new Error(customHtmlBlockError(`Theme file ${f.relativePath}`));
      }
    }
  }
  for (const plugin of blockPlugins ?? []) {
    validateSlug(plugin.slug, 'plugin');
    for (const f of plugin.files) safeRelativePath(f.relativePath);
  }
}

/**
 * Write theme + plugin files into a host filesystem (Studio path). The
 * caller passes the WP install root — typically `<sitePath>/wordpress/`.
 *
 * After this returns successfully, theme lives at
 * `<wpRoot>/wp-content/themes/<themeSlug>/...` and each plugin lives at
 * `<wpRoot>/wp-content/plugins/<plugin.slug>/...`.
 */
export function writeReplicaFilesToHost(args: {
  wpRoot: string;
  themeSlug?: string;
  themeFiles?: ReplicaFile[];
  blockPlugins?: ReplicaBlockPlugin[];
  /**
   * On-disk theme dir (e.g. output/<site>/theme) whose `assets/` holds BINARY
   * files — self-hosted fonts (woff2), localized logo (png), icon SVGs — that
   * aren't carried as string `themeFiles[]`. When set, those binaries are copied
   * into the live theme so the install is self-contained (previously they had to
   * be bridged by hand and self-hosted fonts/logo were missing from the install).
   */
  assetSourceDir?: string;
}): { themeWritten: number; pluginsWritten: number; pluginSlugs: string[]; assetsCopied: number } {
  validateReplicaInputs(args.themeFiles, args.blockPlugins, args.themeSlug);

  let themeWritten = 0;
  const writtenRel = new Set<string>();
  if (args.themeFiles && args.themeFiles.length > 0 && args.themeSlug) {
    const themeRoot = join(args.wpRoot, 'wp-content', 'themes', args.themeSlug);
    for (const original of args.themeFiles) {
      const f = sanitizeReplicaFile(original);
      const rel = safeRelativePath(f.relativePath);
      writtenRel.add(rel);
      const dest = join(themeRoot, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.content);
      themeWritten++;
    }
  }

  // Copy on-disk binary assets (fonts/logo/icons) that string themeFiles[] can't
  // carry. Only files under assets/ are copied, only when not already written,
  // and each relative path is run through safeRelativePath (no traversal).
  let assetsCopied = 0;
  if (args.assetSourceDir && args.themeSlug && existsSync(join(args.assetSourceDir, 'assets'))) {
    const themeRoot = join(args.wpRoot, 'wp-content', 'themes', args.themeSlug);
    const assetsRoot = join(args.assetSourceDir, 'assets');
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) {
          walk(abs);
          continue;
        }
        const rel = safeRelativePath(join('assets', relative(assetsRoot, abs)));
        if (writtenRel.has(rel)) continue; // already written from themeFiles
        const dest = join(themeRoot, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(abs, dest);
        assetsCopied++;
      }
    };
    walk(assetsRoot);
  }

  const pluginSlugs: string[] = [];
  let pluginsWritten = 0;
  for (const plugin of args.blockPlugins ?? []) {
    validateSlug(plugin.slug, 'plugin');
    pluginSlugs.push(plugin.slug);
    const pluginRoot = join(args.wpRoot, 'wp-content', 'plugins', plugin.slug);
    for (const f of plugin.files) {
      const rel = safeRelativePath(f.relativePath);
      const dest = join(pluginRoot, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.content);
      pluginsWritten++;
    }
  }

  return { themeWritten, pluginsWritten, pluginSlugs, assetsCopied };
}

