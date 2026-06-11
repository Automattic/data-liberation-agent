// src/lib/replicate/local-theme/chrome-parts.ts
//
// Header/footer template parts for the local-site (owned-source) theme.
// Header = site-title + core/navigation built from the stage-1a nav graph
// (spec: "nav → core/navigation from navGraph", core-mapped interactivity —
// core/navigation carries its own responsive/overlay behavior, zero custom JS).
// Footer = the captured footer Section rendered through the stage-1a block
// emitter, falling back to a minimal credit line.
//
// FOOTER EMISSION (probe + review follow-up):
// emitSectionBlocks' root selector 'section, article, main, div' does NOT match
// a <footer> root — container falls back to $('body') and the WHOLE footer
// collapses into one catch-all paragraph (content blob-merged, hrefs lost).
// buildFooterPart therefore renames the root <footer> → <div> before emitting,
// so each direct child becomes its own block. Bare-<a> href loss inside
// emitChild remains a known limitation (tracked separately).
//
import * as cheerio from 'cheerio';
import { emitSectionBlocks, escapeHtml, attrJson } from '../normalize/emit-blocks.js';
import { slugFromRelPath } from '../local-site/ingest.js';
import type { NavLink, Section, StickyBehavior } from '../local-site/types.js';

/** "/": home; otherwise "/<slug>/" — matches the WP page permalinks created in page-plan. */
function slugToUrl(slug: string): string {
  return slug === 'home' ? '/' : `/${slug}/`;
}

/**
 * Pick the nav links to render: when the home page has edges marked inNav (from
 * a <nav> element), use ONLY those — a header brand anchor or body link must not
 * hijack a menu slot (walrus E2E regression: brand label replaced "Home"). Falls
 * back to all home edges when none are marked inNav, then to one link per
 * non-home page (label = title-cased slug) when home has no outgoing links.
 */
export function selectNavLinks(nav: NavLink[], pageSlugs: string[]): Array<{ label: string; url: string }> {
  const fromHome = nav.filter((l) => l.fromSlug === 'home');
  // Prefer real <nav> links — brand anchors and body links are excluded when inNav edges exist.
  const pool = fromHome.some((l) => l.inNav) ? fromHome.filter((l) => l.inNav) : fromHome;
  const seen = new Set<string>();
  const links: Array<{ label: string; url: string }> = [];
  for (const l of pool) {
    if (seen.has(l.toSlug)) continue;
    seen.add(l.toSlug);
    links.push({ label: l.label || l.toSlug, url: slugToUrl(l.toSlug) });
  }
  if (links.length > 0) return links;
  return pageSlugs.filter((s) => s !== 'home').map((s) => ({
    label: s.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    url: slugToUrl(s),
  }));
}

export interface HeaderPartOpts {
  /** Stage 1d carry mode: emit BARE site-title + navigation with no styled
   * wrapper — the template part's own <header> element carries the source
   * `header { … }` layout rules (flex/padding), so our decorative wrapper
   * would fight them. Default false (tokens path keeps the styled wrapper). */
  plain?: boolean;
  /** nativeBehaviors: append the dla/sticky state block after the nav (plain
   * carry mode only — the tokens path has no carried chrome to toggle). Zero
   * visual footprint: an empty marker div whose view.js climbs
   * closest('header'), so the toggled class lands on the template-part
   * <header> wrapper the carried `header.<class>` rules target. */
  sticky?: StickyBehavior;
}

/**
 * Empty marker block carrying the sticky scroll state (Interactivity API).
 * The JSON rides BOTH the comment attrs and the single-quoted data-wp-context
 * attribute: attrJson covers the kses '--' trap (toggleClass may legally
 * contain '--'); the ' escape keeps a pathological single quote from
 * breaking out of the attribute (detection constrains toggleClass to
 * [a-zA-Z0-9_-]+ — this is belt-and-braces).
 */
function stickyStateBlock(sticky: StickyBehavior): string {
  const json = `{"toggleClass":${attrJson(sticky.toggleClass)},"offset":${JSON.stringify(sticky.offset)}}`.replace(
    /'/g,
    '\\u0027',
  );
  return (
    `\n<!-- wp:dla/sticky ${json} -->\n` +
    `<div class="wp-block-dla-sticky" data-wp-interactive="dla/sticky"` +
    ` data-wp-context='${json}' data-wp-init="callbacks.init"></div>\n` +
    `<!-- /wp:dla/sticky -->`
  );
}

export function buildHeaderPart(
  siteTitle: string,
  nav: NavLink[],
  pageSlugs: string[],
  opts: HeaderPartOpts = {},
): string {
  const links = selectNavLinks(nav, pageSlugs)
    .map((l) => `<!-- wp:navigation-link {"label":${attrJson(l.label)},"url":${attrJson(l.url)}} /-->`)
    .join('\n');
  const siteTitleBlock = `<!-- wp:site-title {"level":0,"className":"brand"} /-->`;
  if (opts.plain) {
    // overlayMenu:never — mirror the source exactly (its nav has no JS menu;
    // links simply wrap on small screens under the carried source CSS).
    const plainNav = `<!-- wp:navigation {"overlayMenu":"never","layout":{"type":"flex"}} -->\n${links}\n<!-- /wp:navigation -->`;
    const sticky = opts.sticky ? stickyStateBlock(opts.sticky) : '';
    return `${siteTitleBlock}\n${plainNav}${sticky}`;
  }
  const navBlock = `<!-- wp:navigation {"overlayMenu":"mobile","layout":{"type":"flex"}} -->\n${links}\n<!-- /wp:navigation -->`;
  return (
    `<!-- wp:group {"align":"full","layout":{"type":"flex","justifyContent":"space-between"},"style":{"spacing":{"padding":{"top":"1rem","bottom":"1rem","left":"1.5rem","right":"1.5rem"}}}} -->\n` +
    `<div class="wp-block-group alignfull" style="padding-top:1rem;padding-right:1.5rem;padding-bottom:1rem;padding-left:1.5rem">` +
    `${siteTitleBlock}\n` +
    navBlock +
    `</div>\n` +
    `<!-- /wp:group -->`
  );
}

export interface FooterPartOpts {
  /** Site page slugs — internal footer hrefs are rewritten to /slug/ permalinks. */
  pageSlugs?: string[];
  /** theme.json palette slug applied as the footer wrapper background (e.g. 'surface-inverse'). */
  bgToken?: string;
  /** theme.json palette slug applied as the footer wrapper text color (e.g. 'text-inverse'). */
  textToken?: string;
}

/**
 * Wrap footer markup in a token-styled full-width group. The theme scaffold's
 * own footerBgToken/footerTextToken opts are inert for the local path (we swap
 * parts/footer.html with OUR part unconditionally), so the band styling must
 * live on the part we build. No tokens → markup returned unchanged. Class
 * emission follows the @wordpress/blocks canonical serialized order
 * (has-<text>-color has-<bg>-background-color has-text-color has-background —
 * same shape as theme-scaffold's footer groups) so editor re-serialization
 * keeps the styling (block-fixer canonicalization constraint).
 */
function wrapFooterGroup(inner: string, opts: FooterPartOpts): string {
  if (!opts.bgToken && !opts.textToken) return inner;
  const attrs: string[] = ['"align":"full"'];
  if (opts.bgToken) attrs.push(`"backgroundColor":"${opts.bgToken}"`);
  if (opts.textToken) attrs.push(`"textColor":"${opts.textToken}"`);
  attrs.push('"layout":{"type":"constrained"}', '"style":{"spacing":{"padding":{"top":"2.5rem","bottom":"2.5rem"}}}');
  const classes = ['wp-block-group', 'alignfull'];
  if (opts.textToken) classes.push(`has-${opts.textToken}-color`);
  if (opts.bgToken) classes.push(`has-${opts.bgToken}-background-color`);
  if (opts.textToken) classes.push('has-text-color');
  if (opts.bgToken) classes.push('has-background');
  return (
    `<!-- wp:group {${attrs.join(',')}} -->\n` +
    `<div class="${classes.join(' ')}" style="padding-top:2.5rem;padding-bottom:2.5rem">${inner}</div>\n` +
    `<!-- /wp:group -->`
  );
}

/**
 * Rewrite internal hrefs in footer HTML to WP permalink form (/slug/).
 * External hrefs (protocol, //, #) are left untouched. Unknown slugs are
 * left untouched. Runs on the raw footer HTML (before <footer>→<div> rename).
 * Assumes a root-level footer page: ".." segments resolve via slugFromRelPath's
 * sanitize; nested-page footers would need nav-graph's resolveHrefToRelPath.
 */
function rewriteInternalHrefs(html: string, pageSlugs: string[]): string {
  const $ = cheerio.load(html);
  const known = new Set(pageSlugs);
  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href') ?? '';
    if (!raw || /^[a-z]+:/i.test(raw) || raw.startsWith('//') || raw.startsWith('#')) return;
    let cleaned = raw.split(/[?#]/)[0];
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {
      // Malformed escape sequence — keep raw value.
    }
    const slug = slugFromRelPath(cleaned.replace(/^\.\//, '').replace(/^\//, ''));
    if (!known.has(slug)) return;
    $(el).attr('href', slugToUrl(slug));
  });
  return $('body').html() ?? html;
}

export function buildFooterPart(footer: Section | null, siteTitle: string, opts: FooterPartOpts = {}): string {
  if (footer) {
    // <footer> root won't match emitSectionBlocks' 'section,article,main,div' selector
    // → container falls to $('body') and the whole footer collapses into one catch-all
    // paragraph (hrefs lost, content blob-merged). Renaming the root to <div> makes
    // each direct child emit as its own block. Bare-<a> href loss remains a known
    // emitChild limitation (tracked separately).
    let html = footer.html;
    if (opts.pageSlugs?.length) html = rewriteInternalHrefs(html, opts.pageSlugs);
    const normalized = {
      ...footer,
      html: html.replace(/^<footer(\b[^>]*>)/i, '<div$1').replace(/<\/footer>\s*$/i, '</div>'),
    };
    // wrapper:'div' — footer content is chrome, not a body section; the section
    // tag would attract the carried source's section margin rules (+88px).
    return wrapFooterGroup(emitSectionBlocks(normalized, { wrapper: 'div' }).markup, opts);
  }
  return wrapFooterGroup(
    `<!-- wp:group {"align":"full","layout":{"type":"constrained"},"style":{"spacing":{"padding":{"top":"2rem","bottom":"2rem"}}}} -->\n` +
      `<div class="wp-block-group alignfull" style="padding-top:2rem;padding-bottom:2rem">` +
      `<!-- wp:paragraph {"align":"center"} -->\n<p class="has-text-align-center">${escapeHtml(siteTitle)}</p>\n<!-- /wp:paragraph -->` +
      `</div>\n` +
      `<!-- /wp:group -->`,
    opts,
  );
}
