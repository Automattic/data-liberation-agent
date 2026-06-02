//
// liberate_reconstruct_pages_alt
// ================================
// Carry-and-scope parity path handler. For each page it loads cached body HTML
// (or fetches live), collects CSS via collectCss, calls the pure reconstructPageAlt
// emitter, assembles theme files via buildAltThemeFiles, writes the theme under
// the Studio site, and returns per-page island content so the orchestrator skill
// can build output-alt.wxr.
//
// The pure helper `assembleAltTheme` is unit-tested; the IO handler is not.
//

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Handler } from '../handler-types.js';
import type { SectionSpec } from '../../lib/replicate/section-extract.js';
import { reconstructPageAlt } from '../../lib/replicate/page-reconstruct-alt.js';
import { buildAltThemeFiles, type ThemeFile, type AltPage } from '../../lib/replicate/theme-scaffold-alt.js';
import { collectCss } from '../../lib/replicate/css-collect.js';
import { deriveInstallThemeSlug } from './install-theme.js';

// ---------------------------------------------------------------------------
// Pure helper types + implementation (unit-tested)
// ---------------------------------------------------------------------------

export interface AltPageInput {
  slug: string;
  title: string;
  isHome?: boolean;
  bodyHtml: string;
  css: string;
  specs?: SectionSpec[];
}

export interface AssembleInput {
  themeName: string;
  pages: AltPageInput[];
  mediaUrlMap: Map<string, string>;
}

export interface WxrPage {
  slug: string;
  title: string;
  isHome?: boolean;
  postContent: string;
}

export interface AssembleOutput {
  themeFiles: ThemeFile[];
  wxrPages: WxrPage[];
}

/**
 * Pure helper: runs reconstructPageAlt for each page, collects header/footer islands
 * from the home page (or first page that yields one), assembles the alt theme files
 * via buildAltThemeFiles, and returns the full file set + per-page WXR content.
 *
 * No IO — callers (handler + tests) are responsible for reading inputs / writing outputs.
 */
export function assembleAltTheme(input: AssembleInput): AssembleOutput {
  let headerIsland = '';
  let footerIsland = '';
  const scaffoldPages: AltPage[] = [];
  const wxrPages: WxrPage[] = [];

  for (const p of input.pages) {
    const r = reconstructPageAlt({
      slug: p.slug,
      isHome: p.isHome,
      bodyHtml: p.bodyHtml,
      css: p.css,
      specs: p.specs ?? [],
      mediaUrlMap: input.mediaUrlMap,
    });

    // Prefer the home page's header/footer; fall back to the first page that
    // yields non-empty islands so the theme always has something to render.
    if (p.isHome || (!headerIsland && r.headerIsland)) {
      headerIsland = r.headerIsland;
      footerIsland = r.footerIsland;
    }

    scaffoldPages.push({ slug: p.slug, isHome: p.isHome, pageCss: r.pageCss });
    wxrPages.push({
      slug: p.slug,
      title: p.title,
      isHome: p.isHome,
      postContent: r.mainIsland,
    });
  }

  const themeFiles = buildAltThemeFiles({
    themeName: input.themeName,
    headerIsland,
    footerIsland,
    siteCss: '',
    pages: scaffoldPages,
  });

  return { themeFiles, wxrPages };
}

// ---------------------------------------------------------------------------
// IO handler (not unit-tested — verified by typecheck + smoke import)
// ---------------------------------------------------------------------------

interface PageArg {
  slug: string;
  sourceUrl: string;
  title: string;
  isHome?: boolean;
}

/** Resolve the WP root by probing for wp-content (flat vs nested Studio layout). */
function resolveWpRoot(studioSitePath: string): string | null {
  const sitePath = resolve(studioSitePath);
  if (existsSync(join(sitePath, 'wp-content'))) return sitePath;
  const nested = join(sitePath, 'wordpress');
  if (existsSync(join(nested, 'wp-content'))) return nested;
  return null;
}

export const reconstructPagesAltHandler: Handler = async (args, ctx) => {
  const outputDir = args.outputDir as string | undefined;
  const studioSitePath = args.studioSitePath as string | undefined;
  const pages = args.pages as PageArg[] | undefined;

  if (!outputDir) {
    return ctx.errorResult('liberate_reconstruct_pages_alt requires `outputDir`.');
  }
  if (!studioSitePath) {
    return ctx.errorResult('liberate_reconstruct_pages_alt requires `studioSitePath`.');
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    return ctx.errorResult(
      'liberate_reconstruct_pages_alt requires a non-empty `pages` array ({slug, sourceUrl, title, isHome?}).',
    );
  }

  const wpRoot = resolveWpRoot(studioSitePath);
  if (!wpRoot) {
    return ctx.errorResult(`studioSitePath has no wp-content: ${studioSitePath}`);
  }

  // Derive alt theme slug from outputDir (parallel to block path, but suffixed -alt).
  const themeName = (args.themeName as string | undefined) ?? 'Liberated (Alt)';
  const baseSlug = deriveInstallThemeSlug(outputDir);
  // Strip the trailing "-replica" suffix the block path uses and append "-alt" so
  // the two themes can coexist in wp-content/themes/ simultaneously.
  const altSlug = baseSlug.replace(/-replica$/, '') + '-alt';
  const themeRoot = join(wpRoot, 'wp-content', 'themes', altSlug);

  // Collect HTML + CSS for each page.
  const altPages: AltPageInput[] = [];
  const fetchErrors: Array<{ slug: string; error: string }> = [];

  for (const p of pages) {
    // Prefer cached rendered HTML written by liberate_screenshot (html/<slug>.html).
    const htmlPath = join(resolve(outputDir), 'html', `${p.slug}.html`);
    let bodyHtml = '';
    if (existsSync(htmlPath)) {
      try {
        bodyHtml = readFileSync(htmlPath, 'utf8');
      } catch {
        /* fall through to live fetch */
      }
    }
    if (!bodyHtml) {
      try {
        const res = await fetch(p.sourceUrl);
        bodyHtml = await res.text();
      } catch (err) {
        fetchErrors.push({
          slug: p.slug,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    // Collect external stylesheets referenced in the HTML.
    let css = '';
    try {
      css = await collectCss({
        html: bodyHtml,
        inlineStyleText: '',
        baseUrl: p.sourceUrl,
        onError: () => {
          /* swallow individual sheet errors — best-effort */
        },
      });
    } catch {
      /* non-fatal: reconstruct with whatever CSS was collected */
    }

    // Cache the collected CSS alongside the HTML for debugging / re-runs.
    try {
      const cssCacheDir = join(resolve(outputDir), 'css');
      mkdirSync(cssCacheDir, { recursive: true });
      writeFileSync(join(cssCacheDir, `${p.slug}.css`), css);
    } catch {
      /* best-effort cache write */
    }

    altPages.push({
      slug: p.slug,
      title: p.title,
      isHome: p.isHome,
      bodyHtml,
      css,
    });
  }

  if (altPages.length === 0) {
    return ctx.errorResult(
      `liberate_reconstruct_pages_alt: no pages could be loaded. fetchErrors: ${JSON.stringify(fetchErrors)}`,
    );
  }

  // v1 gap: mediaUrlMap is empty — the orchestrator skill will need to populate
  // it from the run's media map once media install is wired into this path.
  const { themeFiles, wxrPages } = assembleAltTheme({
    themeName,
    pages: altPages,
    mediaUrlMap: new Map(),
  });

  // Write theme files to disk under wp-content/themes/<altSlug>.
  for (const f of themeFiles) {
    const full = join(themeRoot, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content);
  }

  return ctx.textResult({
    ok: fetchErrors.length === 0,
    themeRoot,
    themeSlug: altSlug,
    themeFilesWritten: themeFiles.length,
    fetchErrors,
    pages: wxrPages.map((w) => ({
      slug: w.slug,
      title: w.title,
      isHome: w.isHome,
      postContent: w.postContent,
    })),
  });
};
