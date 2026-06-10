// src/lib/replicate/local-theme/chrome-parts.ts
//
// Header/footer template parts for the local-site (owned-source) theme.
// Header = site-title + core/navigation built from the stage-1a nav graph
// (spec: "nav → core/navigation from navGraph", core-mapped interactivity —
// core/navigation carries its own responsive/overlay behavior, zero custom JS).
// Footer = the captured footer Section rendered through the stage-1a block
// emitter, falling back to a minimal credit line.
//
// PROBE RESULT (emitSectionBlocks footer-root behavior):
// When section.html has a <footer> root, the selector 'section, article, main, div'
// does NOT match it → container falls back to $('body') → <footer> element is
// iterated as a body child → emitChild downgrades it to a paragraph of its text
// (confidence=0, text preserved, output non-empty). Branch taken: NO wrapping —
// call emitSectionBlocks(footer) directly. The test's `toContain('All rights
// reserved')` passes because the downgraded paragraph preserves the text.
//
import { emitSectionBlocks, escapeHtml } from '../normalize/emit-blocks.js';
import type { NavLink, Section } from '../local-site/types.js';

/** "/": home; otherwise "/<slug>/" — matches the WP page permalinks created in page-plan. */
function slugToUrl(slug: string): string {
  return slug === 'home' ? '/' : `/${slug}/`;
}

/** JSON-string-escape for embedding label/url inside block attribute JSON. */
function attrJson(value: string): string {
  return JSON.stringify(value);
}

/**
 * Pick the nav links to render: the home page's outgoing internal links
 * (deduped by target, first label wins, self-link to home allowed), or —
 * when home has none — one link per non-home page (label = slug).
 */
export function selectNavLinks(nav: NavLink[], pageSlugs: string[]): Array<{ label: string; url: string }> {
  const fromHome = nav.filter((l) => l.fromSlug === 'home');
  const seen = new Set<string>();
  const links: Array<{ label: string; url: string }> = [];
  for (const l of fromHome) {
    if (seen.has(l.toSlug)) continue;
    seen.add(l.toSlug);
    links.push({ label: l.label || l.toSlug, url: slugToUrl(l.toSlug) });
  }
  if (links.length > 0) return links;
  return pageSlugs.filter((s) => s !== 'home').map((s) => ({ label: s.charAt(0).toUpperCase() + s.slice(1), url: slugToUrl(s) }));
}

export function buildHeaderPart(siteTitle: string, nav: NavLink[], pageSlugs: string[]): string {
  const links = selectNavLinks(nav, pageSlugs)
    .map((l) => `<!-- wp:navigation-link {"label":${attrJson(l.label)},"url":${attrJson(l.url)}} /-->`)
    .join('\n');
  return (
    `<!-- wp:group {"align":"full","layout":{"type":"flex","justifyContent":"space-between"},"style":{"spacing":{"padding":{"top":"1rem","bottom":"1rem","left":"1.5rem","right":"1.5rem"}}}} -->\n` +
    `<div class="wp-block-group alignfull" style="padding-top:1rem;padding-right:1.5rem;padding-bottom:1rem;padding-left:1.5rem">` +
    `<!-- wp:site-title {"level":0} /-->\n` +
    `<!-- wp:navigation {"overlayMenu":"mobile","layout":{"type":"flex"}} -->\n${links}\n<!-- /wp:navigation -->` +
    `</div>\n` +
    `<!-- /wp:group -->`
  );
}

export function buildFooterPart(footer: Section | null, siteTitle: string): string {
  if (footer) {
    // emitSectionBlocks with a <footer> root: the selector 'section, article, main, div'
    // does not match <footer>, so container falls back to $('body') and the footer
    // element is downgraded to a paragraph (text preserved). Acceptable — no wrapping.
    return emitSectionBlocks(footer).markup;
  }
  return (
    `<!-- wp:group {"align":"full","layout":{"type":"constrained"},"style":{"spacing":{"padding":{"top":"2rem","bottom":"2rem"}}}} -->\n` +
    `<div class="wp-block-group alignfull" style="padding-top:2rem;padding-bottom:2rem">` +
    `<!-- wp:paragraph {"align":"center"} -->\n<p class="has-text-align-center">${escapeHtml(siteTitle)}</p>\n<!-- /wp:paragraph -->` +
    `</div>\n` +
    `<!-- /wp:group -->`
  );
}
