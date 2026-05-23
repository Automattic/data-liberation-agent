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
import { extractThemeChromeFromHtml } from '../../lib/replicate/source-chrome.js';
import { parseFontFaces, consolidateFontFaces } from '../../lib/replicate/font-capture.js';
import { downloadFonts } from '../../lib/replicate/font-capture-download.js';

interface ScaffoldArgs {
  outputDir?: string;
  themeSlug?: string;
  themeName?: string;
  siteTitle?: string;
  themeDescription?: string;
  /** Source homepage URL — used to absolutize captured header logo/nav hrefs. */
  sourceUrl?: string;
  /** Theme output dir for downloaded fonts. Defaults to <outputDir>/theme. */
  themeDir?: string;
}

interface TypographyObserved {
  lineHeights: Record<string, string>;
  headingFamily?: string;
  bodyFamily?: string;
}

/** Read per-heading line-heights + observed heading/body families from typography.json. */
function readObservedTypography(typographyPath: string): TypographyObserved {
  const out: TypographyObserved = { lineHeights: {} };
  try {
    if (!existsSync(typographyPath)) return out;
    const raw = JSON.parse(readFileSync(typographyPath, 'utf8')) as {
      bySelector?: Record<string, Array<{ lineHeight?: string; fontFamily?: string }>>;
    };
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      const lh = raw.bySelector?.[tag]?.[0]?.lineHeight;
      if (typeof lh === 'string') out.lineHeights[tag] = lh;
    }
    out.headingFamily =
      raw.bySelector?.h1?.[0]?.fontFamily ??
      raw.bySelector?.h2?.[0]?.fontFamily ??
      raw.bySelector?.h3?.[0]?.fontFamily;
    out.bodyFamily = raw.bySelector?.body?.[0]?.fontFamily;
    return out;
  } catch {
    return out;
  }
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

  // ── Source chrome (real header logo + primary nav) ──────────────────────────
  // The generic page-list header is a poor replica. When the captured homepage
  // HTML is available, extract the real logo + top-level nav so the scaffold
  // emits explicit navigation-links instead of an auto page-list.
  const sourceUrl = a.sourceUrl ?? 'https://example.com/';
  const htmlPath = resolve(join(a.outputDir, 'html', 'homepage.html'));
  let sourceChrome: ReturnType<typeof extractThemeChromeFromHtml> | undefined;
  let html = '';
  if (existsSync(htmlPath)) {
    try {
      html = readFileSync(htmlPath, 'utf8');
      sourceChrome = extractThemeChromeFromHtml(html, sourceUrl);
    } catch {
      sourceChrome = undefined;
    }
  }

  // ── Self-hosted fonts (capture @font-face → download → assets/fonts/) ────────
  const themeDir = resolve(a.themeDir ?? join(a.outputDir, 'theme'));
  let capturedFonts: Awaited<ReturnType<typeof downloadFonts>>['faces'] = [];
  const fontErrors: Array<{ family: string; error: string }> = [];
  if (html) {
    // Consolidate per-weight family aliases (e.g. Replo's duplicate Larsseit
    // declarations) BEFORE download so we fetch one file per real weight.
    const parsed = consolidateFontFaces(parseFontFaces(html));
    if (parsed.length > 0) {
      const result = await downloadFonts(parsed, { themeDir, baseUrl: sourceUrl });
      capturedFonts = result.faces;
      for (const e of result.errors) fontErrors.push({ family: e.face.family, error: e.error });
    }
  }

  const observed = readObservedTypography(resolve(join(a.outputDir, 'typography.json')));

  const themeFiles = buildThemeScaffold({
    foundation: foundation as Parameters<typeof buildThemeScaffold>[0]['foundation'],
    themeSlug: a.themeSlug,
    themeName: a.themeName,
    siteTitle: a.siteTitle,
    themeDescription: a.themeDescription,
    sourceChrome,
    capturedFonts,
    headingLineHeights: observed.lineHeights,
    headingFamily: observed.headingFamily,
    bodyFamily: observed.bodyFamily,
  });

  return ctx.textResult({
    ok: true,
    themeSlug: a.themeSlug,
    themeFiles,
    fileCount: themeFiles.length,
    relativePaths: themeFiles.map((f) => f.relativePath),
    sourceChromeUsed: Boolean(sourceChrome?.header?.links?.length || sourceChrome?.header?.logoUrl),
    capturedFonts: capturedFonts.map((f) => ({ family: f.family, weight: f.weight, localPath: f.localPath })),
    fontErrors,
  });
};
