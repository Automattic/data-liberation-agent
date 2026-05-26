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

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Handler } from '../handler-types.js';
import { buildThemeScaffold } from '../../lib/replicate/theme-scaffold.js';
import { extractThemeChromeFromHtml } from '../../lib/replicate/source-chrome.js';
import { parseFontFaces, consolidateFontFaces, matchCapturedFamily } from '../../lib/replicate/font-capture.js';
import { downloadFonts } from '../../lib/replicate/font-capture-download.js';
import { findFreeReplacement, fallbackReplacement, firstFamilyToken } from '../../lib/replicate/font-substitution.js';
import { downloadReplacementFont } from '../../lib/replicate/font-substitution-download.js';
import { safeFetch } from '../../lib/extraction/safe-fetch.js';

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

/**
 * Read redirect-map.json into a `{ sourcePath: localPermalink }` record for nav
 * href rewriting. Returns undefined when the file is missing/corrupt so the
 * scaffold falls back to passing nav hrefs through unchanged.
 */
function readRedirectMap(path: string): Record<string, string> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Array<{ from?: string; to?: string }>;
    if (!Array.isArray(raw)) return undefined;
    const map: Record<string, string> = {};
    for (const entry of raw) {
      if (typeof entry?.from === 'string' && typeof entry?.to === 'string') {
        map[entry.from] = entry.to;
      }
    }
    return Object.keys(map).length > 0 ? map : undefined;
  } catch {
    return undefined;
  }
}

/** Filesystem-safe basename for a logo URL (last path segment, ext preserved). */
function logoFilename(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.slice(u.pathname.lastIndexOf('/') + 1) || 'logo';
    const safe = seg.replace(/[^A-Za-z0-9._-]/g, '_');
    return /\.[a-z0-9]{2,4}$/i.test(safe) ? safe : `${safe}.png`;
  } catch {
    return 'logo.png';
  }
}

/**
 * Download the captured header logo from the source CDN into the theme's
 * `assets/` directory so the header references it locally instead of hot-linking
 * the source CDN. Returns the theme-relative path (e.g. "assets/SNOOZ-Logo.png")
 * or undefined when there's no logo / the download fails (header then falls back
 * to the captured CDN URL).
 */
async function downloadLogo(logoUrl: string | undefined, themeDir: string): Promise<string | undefined> {
  if (!logoUrl) return undefined;
  const filename = logoFilename(logoUrl);
  const relPath = `assets/${filename}`;
  const destPath = join(themeDir, relPath);
  if (existsSync(destPath)) return relPath;
  try {
    // SSRF-safe: the logo URL is parsed from arbitrary source HTML, so validate
    // it (and any redirect) against internal hosts and cap the body size.
    const res = await safeFetch(logoUrl, { timeoutMs: 30000 });
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    const buf = res.body;
    if (buf.length === 0) throw new Error('empty response body');
    mkdirSync(join(themeDir, 'assets'), { recursive: true });
    writeFileSync(destPath, buf);
    return relPath;
  } catch {
    return undefined;
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

  // ── Commercial / uncapturable → free font substitution ──────────────────────
  // When the observed BODY (or display) family has no self-hostable @font-face
  // among the captured fonts — e.g. getsnooz's body `quasimoda` is Adobe Typekit
  // (CSS-only on use.typekit.net, no reachable woff) — the replica would render
  // body copy in a bare `sans-serif` fallback. Map the unhostable family to the
  // closest FREE web font, self-host its woff2 into assets/fonts/, and bind the
  // body family to it. Headings (Larsseit) are usually captured, so the display
  // substitute only fires when the heading font is also unhostable.
  const fontSubstitutions: Array<{ from: string; to: string; rationale: string }> = [];

  async function substituteIfUnhostable(observedStack: string | undefined): Promise<string | undefined> {
    const first = firstFamilyToken(observedStack);
    if (!first) return undefined;
    // Already self-hostable from the captured set? Keep it.
    if (matchCapturedFamily(observedStack, capturedFonts)) return undefined;
    const replacement = findFreeReplacement(observedStack) ?? fallbackReplacement(observedStack);
    const result = await downloadReplacementFont(replacement, { themeDir });
    if (result.faces.length === 0) {
      for (const e of result.errors) fontErrors.push({ family: replacement.family, error: e.error });
      return undefined;
    }
    capturedFonts = [...capturedFonts, ...result.faces];
    fontSubstitutions.push({ from: first, to: replacement.family, rationale: replacement.rationale });
    return replacement.family;
  }

  const bodySubstituteFamily = await substituteIfUnhostable(observed.bodyFamily);
  const displaySubstituteFamily = await substituteIfUnhostable(observed.headingFamily);

  // ── Localize the header logo (download CDN logo → theme assets/) ─────────────
  const localLogoPath = await downloadLogo(sourceChrome?.header?.logoUrl, themeDir);

  // ── Source-path → local-permalink map (redirect-map.json) ────────────────────
  // Produced during extraction (src/adapters/shared.ts runExtractionLoop emits
  // `{ from: "/pages/about-us", to: "/about-us/" }`). Used to rewrite captured
  // nav hrefs to the local pages so the menu resolves instead of 404ing on the
  // raw source path.
  const navHrefMap = readRedirectMap(resolve(join(a.outputDir, 'redirect-map.json')));

  // Surface dropped (unmapped) same-site nav/footer links so a missing menu item
  // is visible in the result instead of silently vanishing during remap.
  const scaffoldStats: { droppedNavLinks?: number } = {};
  const themeFiles = buildThemeScaffold({
    foundation: foundation as Parameters<typeof buildThemeScaffold>[0]['foundation'],
    themeSlug: a.themeSlug,
    themeName: a.themeName,
    siteTitle: a.siteTitle,
    themeDescription: a.themeDescription,
    sourceChrome,
    capturedFonts,
    localLogoPath,
    headingLineHeights: observed.lineHeights,
    headingFamily: observed.headingFamily,
    bodyFamily: observed.bodyFamily,
    bodySubstituteFamily,
    displaySubstituteFamily,
    navHrefMap,
    stats: scaffoldStats,
  });

  return ctx.textResult({
    ok: true,
    themeSlug: a.themeSlug,
    themeFiles,
    fileCount: themeFiles.length,
    relativePaths: themeFiles.map((f) => f.relativePath),
    sourceChromeUsed: Boolean(sourceChrome?.header?.links?.length || sourceChrome?.header?.logoUrl),
    capturedFonts: capturedFonts.map((f) => ({ family: f.family, weight: f.weight, localPath: f.localPath })),
    fontSubstitutions,
    localLogoPath,
    fontErrors,
    droppedNavLinks: scaffoldStats.droppedNavLinks ?? 0,
  });
};
