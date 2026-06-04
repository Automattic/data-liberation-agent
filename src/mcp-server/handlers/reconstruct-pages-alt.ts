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
import {
  buildAltThemeFiles,
  type ThemeFile,
  type AltPage,
  type ChromeVariant,
} from '../../lib/replicate/theme-scaffold-alt.js';
import { chromeSignature, stripActiveNavState } from '../../lib/replicate/chrome-canonicalize.js';
import { rewriteResponsiveImages } from '../../lib/replicate/responsive-image-rewrite.js';
import { appendGalleryMobileGrid } from '../../lib/replicate/gallery-mobile-grid.js';
import { collectCss } from '../../lib/replicate/css-collect.js';
import { buildPageLinkMap } from '../../lib/replicate/page-link-map.js';
import { installRunMediaMap } from '../../lib/replicate/run-media-map.js';
import type { InternalLinkMap } from '../../lib/streaming/internal-link-rewrite.js';
import { deriveInstallThemeSlug } from './install-theme.js';

// ---------------------------------------------------------------------------
// Pure helper types + implementation (unit-tested)
// ---------------------------------------------------------------------------

export interface AltPageInput {
  slug: string;
  title: string;
  isHome?: boolean;
  /** WP object type — 'post' scopes via is_single() + shared single.html. Default 'page'. */
  postType?: 'page' | 'post';
  bodyHtml: string;
  css: string;
  specs?: SectionSpec[];
  /** Classic/adaptive Wix mobile-DOM carry — emits a dual-viewport island
   *  (desktop content + a 320px iframe of the captured mobile DOM at `docUrl`).
   *  See reconstructPageAlt's `mobile` input. */
  mobile?: { docUrl: string; height: number };
}

export interface AssembleInput {
  themeName: string;
  pages: AltPageInput[];
  mediaUrlMap: Map<string, string>;
  /** Source-href → local-permalink map; rewrites carried nav + body links. */
  linkMap?: InternalLinkMap;
}

export interface WxrPage {
  slug: string;
  title: string;
  isHome?: boolean;
  postType?: 'page' | 'post';
  postContent: string;
}

export interface AssembleOutput {
  themeFiles: ThemeFile[];
  wxrPages: WxrPage[];
  /** Slugs of pages whose reconstruction threw (e.g. carryHtml's injection gate on
   *  un-strippable markup). Skipped so one bad page doesn't crash the whole build. */
  skipped: string[];
}

/**
 * Pure helper: runs reconstructPageAlt for each page, collects header/footer islands
 * from the home page (or first page that yields one), assembles the alt theme files
 * via buildAltThemeFiles, and returns the full file set + per-page WXR content.
 *
 * No IO — callers (handler + tests) are responsible for reading inputs / writing outputs.
 */
/** Parse the class tokens off the first `<body …>` tag in carried HTML. */
function extractBodyClasses(html: string): string[] {
  const m = /<body[^>]*\bclass\s*=\s*["']([^"']*)["']/i.exec(html);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}

export function assembleAltTheme(input: AssembleInput): AssembleOutput {
  // Reconstruct every page once, preserving input order for the emitted files.
  // A page whose markup trips reconstructPageAlt (e.g. carryHtml's injection gate on
  // un-strippable rawtext) is SKIPPED — one bad page must not crash the whole build.
  const skipped: string[] = [];
  const recos = input.pages.flatMap((p) => {
    try {
      return [{
        p,
        r: reconstructPageAlt({
          slug: p.slug,
          isHome: p.isHome,
          bodyHtml: p.bodyHtml,
          css: p.css,
          specs: p.specs ?? [],
          mediaUrlMap: input.mediaUrlMap,
          linkMap: input.linkMap,
          mobile: p.mobile,
        }),
      }];
    } catch {
      skipped.push(p.slug);
      return [];
    }
  });

  // Dedupe chrome so pages that render the SAME header/footer share one variant
  // + part pair (e.g. a transparent-overlay home header and a solid interior
  // header → two variants total, regardless of page count). Grouping is by
  // canonical signature, not raw bytes (see registerChrome). The home page's
  // chrome is registered FIRST so it becomes variant 0 — the canonical
  // `header`/`footer` parts + index.html chrome.
  // Group by canonical signature (instance ids + active-nav state normalized away)
  // so Wix's per-page header instances collapse to one variant. Each distinct
  // signature reserves a key + its representative (raw) islands and chrome CSS.
  const keyBySig = new Map<string, string>();
  const orderedKeys: string[] = [];
  const repByKey = new Map<string, { headerIsland: string; footerIsland: string; chromeCss: string }>();
  const ensureKey = (r: { headerIsland: string; footerIsland: string; chromeCss: string }): string => {
    const sig = chromeSignature(r.headerIsland, r.footerIsland);
    let key = keyBySig.get(sig);
    if (!key) {
      key = `c${orderedKeys.length}`;
      keyBySig.set(sig, key);
      orderedKeys.push(key);
      repByKey.set(key, { headerIsland: r.headerIsland, footerIsland: r.footerIsland, chromeCss: r.chromeCss });
    }
    return key;
  };
  // Reserve the home page's signature as variant 0 (the canonical `header`/`footer`
  // + index.html chrome) without counting it as a member yet.
  const homeReco = recos.find((x) => x.p.isHome) ?? recos[0];
  if (homeReco) ensureKey(homeReco.r);

  const countByKey = new Map<string, number>();
  const scaffoldPages: AltPage[] = [];
  const wxrPages: WxrPage[] = [];
  for (const { p, r } of recos) {
    const chromeKey = ensureKey(r);
    countByKey.set(chromeKey, (countByKey.get(chromeKey) ?? 0) + 1);
    scaffoldPages.push({
      slug: p.slug,
      isHome: p.isHome,
      postType: p.postType,
      pageCss: r.mainCss,
      scaffold: r.scaffold,
      chromeKey,
    });
    wxrPages.push({
      slug: p.slug,
      title: p.title,
      isHome: p.isHome,
      postType: p.postType,
      postContent: r.mainIsland,
    });
  }

  // Build the emitted variants. A variant used by ONE page keeps its active-nav
  // highlight (e.g. the home header underlining "HOME"); a SHARED variant strips
  // it, since one representative can't carry every member's "current" item.
  const variants: ChromeVariant[] = orderedKeys.map((key) => {
    const rep = repByKey.get(key)!;
    const shared = (countByKey.get(key) ?? 0) > 1;
    return {
      key,
      headerIsland: shared ? stripActiveNavState(rep.headerIsland) : rep.headerIsland,
      footerIsland: shared ? stripActiveNavState(rep.footerIsland) : rep.footerIsland,
    };
  });

  // site.css holds EVERY distinct variant's chrome CSS (variant order). Safe to
  // concatenate: each variant's rules key off the source's per-header comp-ids, so
  // a variant's rules match nothing on a page rendering a different variant.
  const siteCss = variants
    .map((v) => repByKey.get(v.key)?.chromeCss ?? '')
    .filter(Boolean)
    .join('\n');

  // Replicate the source <body> classes (e.g. Wix's `responsive`) onto the WP body
  // so body-state-gated carried rules — the whole mobile-reflow layout — behave like
  // the source. Taken from the home page's carried HTML.
  const bodyClasses = extractBodyClasses(homeReco?.p.bodyHtml ?? '');

  const themeFiles = buildAltThemeFiles({
    themeName: input.themeName,
    chromeVariants: variants,
    siteCss,
    bodyClasses,
    pages: scaffoldPages,
  });

  return { themeFiles, wxrPages, skipped };
}

// ---------------------------------------------------------------------------
// IO handler (not unit-tested — verified by typecheck + smoke import)
// ---------------------------------------------------------------------------

interface PageArg {
  slug: string;
  sourceUrl: string;
  title: string;
  isHome?: boolean;
  /** WP object type the slug resolves to. Default 'page'. Posts scope via is_single(). */
  postType?: 'page' | 'post';
  /**
   * Override the cached-HTML filename stem (`html/<htmlSlug>.html`) when it
   * differs from `slug` — e.g. posts captured as `post--<name>.html` but whose
   * WP post_name (and thus is_single() slug) is the bare `<name>`. Defaults to slug.
   */
  htmlSlug?: string;
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

  // Responsive-image map ({wix-media-id → mobile-variant URL}) captured at the
  // mobile viewport by liberate_screenshot. Used to wrap carried <img>s in a
  // <picture> so the browser serves the mobile crop at narrow widths (no JS).
  let responsiveImages: Record<string, string> = {};
  try {
    const riPath = join(resolve(outputDir), 'responsive-images.json');
    if (existsSync(riPath)) responsiveImages = JSON.parse(readFileSync(riPath, 'utf8'));
  } catch {
    /* best-effort — reconstruct without mobile variants on a missing/corrupt map */
  }

  // Mobile-DOM carry (classic/adaptive Wix). liberate_screenshot's mobile pass
  // writes html-mobile/<slug>.html (the JS-built 320px mobile DOM, scripts stripped)
  // + heights.json. When present, each page emits a dual island whose mobile half is
  // an iframe of that document, served from the site's uploads/_alt-mobile/.
  let mobileHeights: Record<string, number> = {};
  try {
    const hPath = join(resolve(outputDir), 'html-mobile', 'heights.json');
    if (existsSync(hPath)) mobileHeights = JSON.parse(readFileSync(hPath, 'utf8'));
  } catch {
    /* best-effort — no mobile-DOM carry on a missing/corrupt heights map */
  }
  const altMobileDir = join(wpRoot, 'wp-content', 'uploads', '_alt-mobile');

  for (const p of pages) {
    // Prefer cached rendered HTML written by liberate_screenshot. The filename
    // stem is htmlSlug when given (posts: `post--<name>.html`), else the slug.
    const htmlPath = join(resolve(outputDir), 'html', `${p.htmlSlug ?? p.slug}.html`);
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

    // Mobile-DOM carry: if a mobile capture exists for this page, install it under
    // uploads/_alt-mobile/<slug>.html and emit a dual island referencing it.
    let mobile: { docUrl: string; height: number } | undefined;
    const mobileSrc = join(resolve(outputDir), 'html-mobile', `${p.htmlSlug ?? p.slug}.html`);
    if (existsSync(mobileSrc)) {
      try {
        mkdirSync(altMobileDir, { recursive: true });
        const mobileDoc = readFileSync(mobileSrc, 'utf8');
        writeFileSync(join(altMobileDir, `${p.slug}.html`), mobileDoc);
        mobile = {
          docUrl: `/wp-content/uploads/_alt-mobile/${p.slug}.html`,
          height: mobileHeights[p.htmlSlug ?? p.slug] ?? 6000,
        };
      } catch {
        /* best-effort — fall back to desktop-only for this page */
      }
    }

    altPages.push({
      slug: p.slug,
      title: p.title,
      isHome: p.isHome,
      postType: p.postType,
      bodyHtml,
      css,
      mobile,
    });
  }

  if (altPages.length === 0) {
    return ctx.errorResult(
      `liberate_reconstruct_pages_alt: no pages could be loaded. fetchErrors: ${JSON.stringify(fetchErrors)}`,
    );
  }

  // Internal-link rewrite map — same builder the block path uses (shared module),
  // so carried nav + body hrefs resolve to the imported permalinks, not the source.
  const linkMap = buildPageLinkMap(outputDir, pages.map((p) => p.sourceUrl));

  // Install the run's media into the alt site + build the CDN→local URL map via
  // the SAME installMediaForUrl the block path uses (installRunMediaMap). Carried
  // <img>/url() references then point at this site's media library, not the CDN.
  // Best-effort: media-install failure leaves the map empty (carried URLs survive).
  let mediaUrlMap = new Map<string, string>();
  const mediaErrors: Array<{ sourceUrl: string; error: string }> = [];
  try {
    const media = await installRunMediaMap({
      outputDir,
      url: pages[0].sourceUrl,
      wpRoot,
      useStudioCli: true,
    });
    mediaUrlMap = media.mediaUrlMap;
    mediaErrors.push(...media.result.errors);
  } catch (err) {
    mediaErrors.push({ sourceUrl: '*', error: err instanceof Error ? err.message : String(err) });
  }

  const { themeFiles, wxrPages, skipped } = assembleAltTheme({
    themeName,
    pages: altPages,
    mediaUrlMap,
    linkMap,
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
    skipped,
    mediaInstalled: mediaUrlMap.size,
    mediaErrors,
    pages: wxrPages.map((w) => ({
      slug: w.slug,
      title: w.title,
      isHome: w.isHome,
      postType: w.postType,
      // Wrap carried <img>s with a captured mobile variant in <picture> + a
      // `(max-width:750px)` <source>, AFTER media rewriting so the mobile CDN
      // URL isn't collapsed onto the single local desktop file (same media-id).
      // Then append an additive single-column mobile grid next to any Wix
      // pro-gallery (the frozen desktop grid only shows its left column on mobile);
      // the grid uses captured mobile crops and is toggled in by GALLERY_MOBILE_GRID_CSS.
      postContent: appendGalleryMobileGrid(
        rewriteResponsiveImages(w.postContent, responsiveImages),
        responsiveImages,
      ),
    })),
  });
};
