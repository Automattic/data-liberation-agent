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
  pageCss: string;
  headerIsland: string;
  footerIsland: string;
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
 *   3. scopeCss      — prepends the page-scoped wrapper selector
 *   4. treeshakeCss  — drops rules that match nothing in the combined carried DOM
 *
 * Returns three `core/html` block strings and one scoped+treeshaken CSS string.
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

  // Scope all CSS under the page-specific body class combination so islands on
  // different pages don't bleed into each other when the sheet is inlined.
  const scope = `body.lib-alt-site.lib-alt-page-${input.slug}`;

  // Merge source CSS with any inline <style> blocks extracted from the regions.
  const allInlineStyles = [main.styleText, header.styleText, footer.styleText]
    .filter(Boolean)
    .join('\n');
  const combined = [input.css, allInlineStyles].filter(Boolean).join('\n');

  const rewriteUrl = (u: string): string | null => input.mediaUrlMap.get(u) ?? null;

  const scoped = scopeCss(combined, { scope, scopeId: input.slug, rewriteUrl });

  // Treeshake against ALL three regions combined: a selector matched in any
  // region is kept, because all three islands share the one scoped sheet on
  // this page.
  const allCarriedHtml = `${header.html}${main.html}${footer.html}`;
  const pageCss = treeshakeCss(scoped, allCarriedHtml);

  return {
    mainIsland: island(main.html),
    headerIsland: island(header.html),
    footerIsland: island(footer.html),
    pageCss,
  };
}
