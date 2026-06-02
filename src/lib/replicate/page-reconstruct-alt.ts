import type { SectionSpec } from './section-extract.js';
import type { InternalLinkMap } from '../streaming/internal-link-rewrite.js';
import { splitRegions } from './split-regions.js';
import { carryHtml } from './html-carry.js';
import { scopeCss } from './css-scope.js';
import { treeshakeCss } from './css-treeshake.js';

export interface ReconstructAltInput {
  slug: string;
  isHome?: boolean;
  bodyHtml: string;
  css: string;
  specs: SectionSpec[];
  mediaUrlMap: Map<string, string>;
  linkMap?: InternalLinkMap;
}

export interface ReconstructAltResult {
  mainIsland: string;
  headerIsland: string;
  footerIsland: string;
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
  const regions = splitRegions(input.bodyHtml, input.specs);

  const carryOpts = { mediaUrlMap: input.mediaUrlMap, linkMap: input.linkMap };

  const main = carryHtml(regions.mainHtml, carryOpts);
  const header = regions.headerHtml
    ? carryHtml(regions.headerHtml, carryOpts)
    : { html: '', styleText: '' };
  const footer = regions.footerHtml
    ? carryHtml(regions.footerHtml, carryOpts)
    : { html: '', styleText: '' };

  const SITE_SCOPE = 'body.lib-alt-site';
  const pageScope = `body.lib-alt-site.lib-alt-page-${input.slug}`;
  const rewriteUrl = (u: string): string | null => input.mediaUrlMap.get(u) ?? null;

  // Chrome sheet: scope site-wide, keep only rules matching header/footer DOM.
  const chromeDom = `${header.html}${footer.html}`;
  const chromeCombined = [input.css, header.styleText, footer.styleText].filter(Boolean).join('\n');
  const chromeCss = chromeDom
    ? treeshakeCss(scopeCss(chromeCombined, { scope: SITE_SCOPE, scopeId: 'site', rewriteUrl }), chromeDom)
    : '';

  // Page sheet: scope per-page, keep only rules matching the main DOM.
  const mainCombined = [input.css, main.styleText].filter(Boolean).join('\n');
  const mainCss = treeshakeCss(
    scopeCss(mainCombined, { scope: pageScope, scopeId: input.slug, rewriteUrl }),
    main.html,
  );

  return {
    mainIsland: island(main.html),
    headerIsland: island(header.html),
    footerIsland: island(footer.html),
    chromeCss,
    mainCss,
  };
}
