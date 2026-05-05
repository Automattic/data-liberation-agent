//
// liberate_theme_scaffold
// =======================
// Reads <outputDir>/design-foundation.json and emits a complete-and-
// activatable WordPress block theme bundle as in-memory ReplicaFile[].
// Pure deterministic mapping — no agent involvement, no vision, no
// reasoning. Used by:
//
//   1. The streaming watch loop after foundation-rev succeeds, to
//      install the bootstrap theme without waiting on an agent call.
//   2. The standalone `replicate` skill, which can call this for the
//      theme.json + style.css + functions.php skeleton and then layer
//      per-archetype templates + patterns on top.
//
// See src/lib/replicate/theme-scaffold.ts for the mapping logic.
//

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Handler } from '../handler-types.js';
import { buildThemeScaffold } from '../../lib/replicate/theme-scaffold.js';

interface ScaffoldArgs {
  outputDir?: string;
  themeSlug?: string;
  themeName?: string;
  siteTitle?: string;
  themeDescription?: string;
}

export const themeScaffoldHandler: Handler = async (args, ctx) => {
  const a = args as ScaffoldArgs;
  if (!a.outputDir) {
    return ctx.errorResult('liberate_theme_scaffold requires `outputDir`.');
  }
  if (!a.themeSlug) {
    return ctx.errorResult('liberate_theme_scaffold requires `themeSlug` (kebab-case, conventionally <siteSlug>-replica).');
  }

  const foundationPath = resolve(join(a.outputDir, 'design-foundation.json'));
  if (!existsSync(foundationPath)) {
    return ctx.errorResult(
      `design-foundation.json not found at ${foundationPath}. Run /data-liberation:design-foundations first.`,
    );
  }

  let foundation: unknown;
  try {
    foundation = JSON.parse(readFileSync(foundationPath, 'utf8'));
  } catch (err) {
    return ctx.errorResult(`Failed to parse design-foundation.json: ${(err as Error).message}`);
  }
  if (!foundation || typeof foundation !== 'object') {
    return ctx.errorResult('design-foundation.json did not parse to an object.');
  }

  const themeFiles = buildThemeScaffold({
    foundation: foundation as Parameters<typeof buildThemeScaffold>[0]['foundation'],
    themeSlug: a.themeSlug,
    themeName: a.themeName,
    siteTitle: a.siteTitle,
    themeDescription: a.themeDescription,
  });

  return ctx.textResult({
    ok: true,
    themeSlug: a.themeSlug,
    themeFiles,
    fileCount: themeFiles.length,
    relativePaths: themeFiles.map((f) => f.relativePath),
  });
};
