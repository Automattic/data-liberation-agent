import type { SectionSpec } from './section-extract.js';
import type { InternalLinkMap } from '../streaming/internal-link-rewrite.js';
import { splitRegions } from './split-regions.js';
import { splitRegionsDeep } from './split-regions-deep.js';
import { carryHtml } from './html-carry.js';
import { scopeCss } from './css-scope.js';
import { treeshakeCss } from './css-treeshake.js';
import { appendNavRevealUnfreeze } from './nav-reveal-unfreeze.js';

export interface ReconstructAltInput {
  slug: string;
  isHome?: boolean;
  bodyHtml: string;
  css: string;
  specs: SectionSpec[];
  mediaUrlMap: Map<string, string>;
  linkMap?: InternalLinkMap;
  /**
   * Classic/adaptive Wix mobile-DOM carry. Such sites serve a SEPARATE, JS-built
   * mobile DOM (~320px) keyed on user-agent — distinct from the desktop DOM the
   * carry froze (no static reflow path → renders 980px on mobile). When the mobile
   * DOM was captured (mobile emulation, scripts stripped) and written to a
   * site-local file at `docUrl`, the page emits a DUAL island: the desktop content
   * wrapped in `.lib-alt-vp-desktop` + a `.lib-alt-vp-mobile` IFRAME of the mobile
   * DOM. The iframe gets its OWN 320px viewport, so Wix's mobile `@media` fire
   * exactly as on the source (inline carrying can't — `@media` is viewport-driven
   * and the WP page is 390px device-width). The theme toggles desktop↔iframe below
   * 750px (`VP_TOGGLE_CSS`). `height` is the captured 320-layout scrollHeight
   * (iframes don't auto-size without JS). Absent → desktop-only (back-compat).
   */
  mobile?: { docUrl: string; height: number };
}

/** The mobile-island iframe: loads the captured mobile DOM at its own 320px viewport. */
function mobileFrame(m: { docUrl: string; height: number }): string {
  const src = m.docUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<iframe class="lib-alt-mobile-frame" src="${src}" width="320" height="${m.height}" scrolling="no" title="mobile"></iframe>`;
}

/** Combine the desktop content + the mobile iframe into one dual-viewport island. */
function dualIsland(desktopHtml: string, mobile: { docUrl: string; height: number }): string {
  return island(
    `<div class="lib-alt-vp-desktop">${desktopHtml}</div>` +
      `<div class="lib-alt-vp-mobile">${mobileFrame(mobile)}</div>`,
  );
}

/**
 * Raw wrapper-scaffold chunks that go in the TEMPLATE as core/html (not in
 * post_content). Concatenated with the chrome parts + post-content they rebuild
 * the exact source DOM, so the carried CSS holds while the post holds only the
 * editable content sections. Present only when chrome was located (`splitChrome`).
 */
export interface AltScaffold {
  openWrap: string;
  midBefore: string;
  midAfter: string;
  closeWrap: string;
}

export interface ReconstructAltResult {
  /** The page's post_content. When `splitChrome`, this is the content sections
   *  only (N core/html blocks); otherwise the whole carried body as one island. */
  mainIsland: string;
  /** Per-section core/html blocks (the content area). `[mainIsland]` when not split. */
  postContentBlocks: string[];
  headerIsland: string;
  footerIsland: string;
  /** True when deep chrome was found → the template carries the wrapper scaffold
   *  + chrome parts and post_content is content-only. False → legacy single island. */
  splitChrome: boolean;
  /** The wrapper chunks for the template. Present only when `splitChrome`. */
  scaffold?: AltScaffold;
  /** Source CSS scoped to `body.lib-alt-site` (site-wide), treeshaken against the
   *  header+footer DOM only — styles the shared chrome parts on EVERY page. */
  chromeCss: string;
  /** Source CSS scoped to `body.lib-alt-site.lib-alt-page-<slug>`, treeshaken
   *  against the main DOM only — styles this page's content. */
  mainCss: string;
}

function island(html: string): string {
  return html ? `<!-- wp:html -->\n${html}\n<!-- /wp:html -->` : '';
}

/**
 * Pure per-page emitter for the carry-and-scope parity path.
 *
 * Orchestrates the pure modules in order:
 *   1. splitRegions  — splits body into header / main / footer
 *   2. carryHtml     — sanitizes each region, extracts inline <style> blocks
 *   3. scopeCss      — prepends the page-scoped or site-scoped wrapper selector
 *   4. treeshakeCss  — drops rules that match nothing in the target DOM
 *
 * Returns three `core/html` block strings and two scoped+treeshaken CSS strings:
 *   - chromeCss: site-wide scoped, treeshaken against header+footer DOM (shared chrome)
 *   - mainCss:   per-page scoped, treeshaken against the main DOM (page content only)
 *
 * No IO: callers are responsible for persisting outputs.
 */
export function reconstructPageAlt(input: ReconstructAltInput): ReconstructAltResult {
  const carryOpts = { mediaUrlMap: input.mediaUrlMap, linkMap: input.linkMap };
  const SITE_SCOPE = 'body.lib-alt-site';
  const pageScope = `body.lib-alt-site.lib-alt-page-${input.slug}`;
  const rewriteUrl = (u: string): string | null => input.mediaUrlMap.get(u) ?? null;

  // Carry the WHOLE body ONCE (sanitize, strip scripts, rewrite media/link URLs,
  // extract inline <style>). Splitting the already-carried string with byte ops
  // keeps the chunks lossless — running cheerio on an unbalanced wrapper fragment
  // would auto-close it and break the concatenation.
  const carried = carryHtml(input.bodyHtml, carryOpts);
  const split = splitRegionsDeep(carried.html);

  if (split.found) {
    // Deep chrome path: chrome → parts, wrapper chunks → template, sections → post.
    const chromeDom = `${split.headerHtml}${split.footerHtml}`;
    const allCss = [input.css, carried.styleText].filter(Boolean).join('\n');
    const chromeCss = chromeDom
      ? appendNavRevealUnfreeze(
          treeshakeCss(scopeCss(allCss, { scope: SITE_SCOPE, scopeId: 'site', rewriteUrl }), chromeDom),
          chromeDom,
          SITE_SCOPE,
        )
      : '';
    // Page sheet treeshakes against the NON-chrome DOM so chrome rules live only
    // in the site-wide sheet, not duplicated per page.
    const mainDom =
      split.openWrap + split.midBefore + split.sectionsHtml.join('') + split.midAfter + split.closeWrap;
    const mainCss = appendNavRevealUnfreeze(
      treeshakeCss(scopeCss(allCss, { scope: pageScope, scopeId: input.slug, rewriteUrl }), mainDom),
      mainDom,
      pageScope,
    );
    const postContentBlocks = split.sectionsHtml.map(island);
    return {
      mainIsland: input.mobile
        ? dualIsland(split.sectionsHtml.join(''), input.mobile)
        : postContentBlocks.join('\n'),
      postContentBlocks,
      headerIsland: island(split.headerHtml),
      footerIsland: island(split.footerHtml),
      splitChrome: true,
      scaffold: {
        openWrap: split.openWrap,
        midBefore: split.midBefore,
        midAfter: split.midAfter,
        closeWrap: split.closeWrap,
      },
      chromeCss,
      mainCss,
    };
  }

  // Legacy fallback: no deep chrome → try a top-level <header>/<footer> split and
  // emit the whole body as one island.
  const regions = splitRegions(input.bodyHtml, input.specs);
  const main = carryHtml(regions.mainHtml, carryOpts);
  const header = regions.headerHtml ? carryHtml(regions.headerHtml, carryOpts) : { html: '', styleText: '' };
  const footer = regions.footerHtml ? carryHtml(regions.footerHtml, carryOpts) : { html: '', styleText: '' };

  const chromeDom = `${header.html}${footer.html}`;
  const chromeCombined = [input.css, header.styleText, footer.styleText].filter(Boolean).join('\n');
  const chromeCss = chromeDom
    ? appendNavRevealUnfreeze(
        treeshakeCss(scopeCss(chromeCombined, { scope: SITE_SCOPE, scopeId: 'site', rewriteUrl }), chromeDom),
        chromeDom,
        SITE_SCOPE,
      )
    : '';
  const mainCombined = [input.css, main.styleText].filter(Boolean).join('\n');
  const mainCss = appendNavRevealUnfreeze(
    treeshakeCss(scopeCss(mainCombined, { scope: pageScope, scopeId: input.slug, rewriteUrl }), main.html),
    main.html,
    pageScope,
  );

  const mainIsland = input.mobile ? dualIsland(main.html, input.mobile) : island(main.html);
  return {
    mainIsland,
    postContentBlocks: mainIsland ? [mainIsland] : [],
    headerIsland: island(header.html),
    footerIsland: island(footer.html),
    splitChrome: false,
    chromeCss,
    mainCss,
  };
}
