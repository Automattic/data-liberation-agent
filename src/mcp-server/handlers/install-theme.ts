//
// liberate_install_theme
// ======================
// Streaming-friendly companion to liberate_preview. Installs replica theme
// files + block plugins into an *already-running* Studio site instead of
// creating one. Used by the streaming watch loop's theme-piece and
// archetype-template judgments — the pre-started Studio site already has
// streamed content, so we must not call liberate_preview (which routes
// through startStudioPreview and creates a `-2` duplicate site).
//
// Differences from liberate_preview:
//   - No site creation. Caller passes `studioSitePath` to the running site.
//   - No content import. Per-URL inserts already populated the DB.
//   - Just writes files into wp-content/{themes,plugins} and activates.
//
// Returns the warnings collected during plugin/theme activate so the agent
// can surface non-fatal failures (e.g. activate fails because
// register_block_type errored — file was written but plugin didn't load).
//

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  writeReplicaFilesToHost,
  validateReplicaInputs,
} from '../../lib/preview/replica-install.js';
import type { ReplicaFile, ReplicaBlockPlugin } from '../../lib/preview/types.js';
import type { Handler } from '../handler-types.js';

const execFileAsync = promisify(execFile);

interface InstallThemeArgs {
  outputDir?: string;
  studioSitePath?: string;
  themeFiles?: ReplicaFile[];
  blockPlugins?: ReplicaBlockPlugin[];
  themeSlug?: string;
}

export function deriveInstallThemeSlug(outputDir: string): string {
  const base = basename(outputDir).toLowerCase();
  const sanitized = base.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return sanitized ? `${sanitized}-replica` : 'site-replica';
}

export function resolveInstallThemeSlug(args: {
  outputDir: string;
  requestedThemeSlug?: string;
  wpRoot: string;
}): string {
  const shellThemeSlug = deriveInstallThemeSlug(args.outputDir);
  if (!args.requestedThemeSlug) return shellThemeSlug;
  if (args.requestedThemeSlug === shellThemeSlug) return args.requestedThemeSlug;

  const shellStylePath = join(
    args.wpRoot,
    'wp-content',
    'themes',
    shellThemeSlug,
    'style.css',
  );
  return existsSync(shellStylePath) ? shellThemeSlug : args.requestedThemeSlug;
}

export const installThemeHandler: Handler = async (args, ctx) => {
  const a = args as InstallThemeArgs;

  const outputDir = a.outputDir;
  const studioSitePath = a.studioSitePath;
  const themeFiles = a.themeFiles;
  const blockPlugins = a.blockPlugins;
  let themeSlug = a.themeSlug;

  if (!outputDir) {
    return ctx.errorResult('liberate_install_theme requires `outputDir`.');
  }
  if (!studioSitePath) {
    return ctx.errorResult(
      'liberate_install_theme requires `studioSitePath` — the on-disk path to the running Studio site (e.g. ~/Studio/example-com).',
    );
  }
  // Studio mounts the host site directory at VFS path `/wordpress`. In current
  // Studio versions the host site directory IS the wp-root (wp-content/ sits
  // directly inside it). Older layouts nested everything under a `wordpress/`
  // subdir on the host. Detect by probing for wp-content rather than assuming.
  const sitePathResolved = resolve(studioSitePath);
  let wpRoot = sitePathResolved;
  if (!existsSync(join(wpRoot, 'wp-content'))) {
    const nested = join(sitePathResolved, 'wordpress');
    if (existsSync(join(nested, 'wp-content'))) {
      wpRoot = nested;
    } else {
      return ctx.errorResult(
        `studioSitePath has no wp-content (looked at ${join(sitePathResolved, 'wp-content')} and ${join(nested, 'wp-content')}). Pass the running Studio site dir.`,
      );
    }
  }

  const hasTheme = !!themeFiles && themeFiles.length > 0;
  const hasPlugins = !!blockPlugins && blockPlugins.length > 0;
  if (!hasTheme && !hasPlugins) {
    return ctx.errorResult(
      'liberate_install_theme needs themeFiles[] or blockPlugins[] (or both). Got neither.',
    );
  }
  if (hasTheme) {
    themeSlug = resolveInstallThemeSlug({
      outputDir,
      requestedThemeSlug: themeSlug,
      wpRoot,
    });
  }

  // Up-front validation — slug shape, path traversal, etc. — before any
  // writes hit disk.
  try {
    validateReplicaInputs(themeFiles, blockPlugins, themeSlug);
  } catch (err) {
    return ctx.errorResult(`Replica input invalid: ${(err as Error).message}`);
  }

  let written: { themeWritten: number; pluginsWritten: number; pluginSlugs: string[] };
  try {
    written = writeReplicaFilesToHost({
      wpRoot,
      themeSlug,
      themeFiles,
      blockPlugins,
    });
  } catch (err) {
    return ctx.errorResult(`Failed to write replica files: ${(err as Error).message}`);
  }

  const warnings: string[] = [];
  for (const slug of written.pluginSlugs) {
    try {
      await studioWp(studioSitePath, ['plugin', 'activate', slug]);
    } catch (err) {
      warnings.push(`Plugin activate "${slug}" failed: ${(err as Error).message.trim()}`);
    }
  }
  if (hasTheme && themeSlug) {
    try {
      await studioWp(studioSitePath, ['theme', 'activate', themeSlug]);
    } catch (err) {
      warnings.push(`Theme activate "${themeSlug}" failed: ${(err as Error).message.trim()}`);
    }
  }

  return ctx.textResult({
    ok: true,
    studioSitePath,
    themeSlug: themeSlug ?? null,
    themeWritten: written.themeWritten,
    pluginsWritten: written.pluginsWritten,
    pluginSlugs: written.pluginSlugs,
    activated: {
      theme: hasTheme && themeSlug ? !warnings.some((w) => w.startsWith(`Theme activate "${themeSlug}"`)) : null,
      plugins: written.pluginSlugs.filter(
        (s) => !warnings.some((w) => w.startsWith(`Plugin activate "${s}"`)),
      ),
    },
    warnings,
  });
};

async function studioWp(sitePath: string, wpArgs: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'studio',
    ['wp', '--path', sitePath, ...wpArgs],
    { timeout: 300_000, maxBuffer: 50 * 1024 * 1024 },
  );
  return stdout;
}
