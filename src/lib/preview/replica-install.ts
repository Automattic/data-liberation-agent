//
// Replica Install Helpers
// =======================
// Shared utilities used by both the Studio path (writes directly to
// <sitePath>/wordpress/wp-content/themes,plugins) and the Playground path
// (emits blueprint writeFile + wp-cli steps).
//
// Two responsibilities:
//   - Sanitize relativePath entries so they cannot escape the install root.
//   - Convert a (themeFiles, blockPlugins, themeSlug) tuple into a list of
//     concrete (vfsPath, content) writes the caller can apply.
//
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
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
}): { themeWritten: number; pluginsWritten: number; pluginSlugs: string[] } {
  validateReplicaInputs(args.themeFiles, args.blockPlugins, args.themeSlug);

  let themeWritten = 0;
  if (args.themeFiles && args.themeFiles.length > 0 && args.themeSlug) {
    const themeRoot = join(args.wpRoot, 'wp-content', 'themes', args.themeSlug);
    for (const original of args.themeFiles) {
      const f = sanitizeReplicaFile(original);
      const rel = safeRelativePath(f.relativePath);
      const dest = join(themeRoot, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.content);
      themeWritten++;
    }
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

  return { themeWritten, pluginsWritten, pluginSlugs };
}

/**
 * One blueprint step. Local mirror of the type in blueprint-builder so this
 * helper doesn't import from there (and so blueprint-builder can import from
 * here without a cycle).
 */
export type ReplicaBlueprintStep =
  | { step: 'writeFile'; path: string; data: string }
  | { step: 'wp-cli'; command: string };

/**
 * Generate the blueprint steps that install + activate the replica theme
 * and any block plugins inside Playground. Order is:
 *   1. Theme files (writeFile per file)
 *   2. Plugin files (writeFile per file, per plugin)
 *   3. Plugin activations (wp-cli plugin activate per plugin)
 *   4. Theme activation (wp-cli theme activate)
 *
 * Activation must come AFTER all files are written — wp-cli theme/plugin
 * activate refuses to activate something whose root files don't exist yet.
 */
export function buildReplicaBlueprintSteps(args: {
  themeSlug?: string;
  themeFiles?: ReplicaFile[];
  blockPlugins?: ReplicaBlockPlugin[];
}): ReplicaBlueprintStep[] {
  validateReplicaInputs(args.themeFiles, args.blockPlugins, args.themeSlug);

  const steps: ReplicaBlueprintStep[] = [];

  if (args.themeFiles && args.themeFiles.length > 0 && args.themeSlug) {
    for (const original of args.themeFiles) {
      const f = sanitizeReplicaFile(original);
      const rel = safeRelativePath(f.relativePath);
      steps.push({
        step: 'writeFile',
        path: `/wordpress/wp-content/themes/${args.themeSlug}/${rel}`,
        data: f.content,
      });
    }
  }

  for (const plugin of args.blockPlugins ?? []) {
    for (const f of plugin.files) {
      const rel = safeRelativePath(f.relativePath);
      steps.push({
        step: 'writeFile',
        path: `/wordpress/wp-content/plugins/${plugin.slug}/${rel}`,
        data: f.content,
      });
    }
  }

  for (const plugin of args.blockPlugins ?? []) {
    steps.push({ step: 'wp-cli', command: `wp plugin activate ${plugin.slug}` });
  }

  if (args.themeFiles && args.themeFiles.length > 0 && args.themeSlug) {
    steps.push({ step: 'wp-cli', command: `wp theme activate ${args.themeSlug}` });
  }

  return steps;
}
