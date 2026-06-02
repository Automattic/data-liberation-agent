//
// Carry-and-scope HTML sanitizer
// ================================
// Unlike `html-fallback.ts` (which strips ALL CSS and returns a bare
// `core/html` block), `carryHtml` preserves class names and structure so
// that scoped CSS generated from the source can still match selectors.
// It EXTRACTS inline `<style>` blocks (returned separately for scoping),
// removes scripts/event-handlers, allowlists only safe iframe embeds,
// and rewrites media/internal-link URLs through the same maps the rest of
// the reconstruction pipeline uses.
//
import * as cheerio from 'cheerio';
import { rewriteMediaUrls } from '../streaming/media-url-rewrite.js';
import { rewriteInternalLinks, type InternalLinkMap } from '../streaming/internal-link-rewrite.js';
import { scanForInjection } from './validate-artifacts.js';

/** Iframe src hostnames (and their subdomains) that are safe to preserve. */
const IFRAME_ALLOW: RegExp[] = [
  /(^|\.)youtube\.com$/i,
  /(^|\.)youtube-nocookie\.com$/i,
  /(^|\.)vimeo\.com$/i, // also covers player.vimeo.com
  /(^|\.)google\.com$/i, // Maps embeds
];

export interface CarryOpts {
  /** Source media URL -> local upload URL (same map the block path uses). */
  mediaUrlMap?: Map<string, string>;
  /** Source-path -> local-permalink map, for inline links in the region. */
  linkMap?: InternalLinkMap;
}

export interface CarryResult {
  /** Sanitized, URL-rewritten fragment HTML with classes/structure intact. */
  html: string;
  /**
   * Concatenated content of all `<style>` blocks extracted from the region.
   * Empty string when none were present. Returned separately so the caller
   * can scope the CSS before injecting it.
   */
  styleText: string;
}

function iframeAllowed(src: string): boolean {
  try {
    const { hostname } = new URL(src);
    return IFRAME_ALLOW.some((re) => re.test(hostname));
  } catch {
    return false;
  }
}

/**
 * Sanitize and URL-rewrite a verbatim region of source HTML.
 *
 * - Keeps class names and element structure intact.
 * - Strips `<script>`, `<noscript>`, `<base>`, and inline event handlers (`on*=`).
 * - Strips `javascript:`/`vbscript:` hrefs (keeps the element + text).
 * - Extracts `<style>` blocks into `styleText` (removes them from `html`).
 * - Removes non-allowlisted `<iframe>` elements.
 * - Rewrites media URLs and internal hrefs via the provided maps.
 * - Throws if the sanitized result still contains injection vectors.
 */
export function carryHtml(regionHtml: string, opts: CarryOpts): CarryResult {
  // URL rewrites run on the RAW string BEFORE cheerio. cheerio's serializer
  // re-encodes `&` to `&amp;` in attribute values, so a CDN URL like
  // `https://cdn/x?w=300&h=200` would no longer exist as a substring post-load
  // and the rewrite (which matches the source URL verbatim) would silently
  // no-op, shipping the source URL. Rewriting first sidesteps that entirely.
  let input = regionHtml;
  if (opts.mediaUrlMap && opts.mediaUrlMap.size > 0) {
    input = rewriteMediaUrls(input, opts.mediaUrlMap);
  }
  if (opts.linkMap && opts.linkMap.size > 0) {
    input = rewriteInternalLinks(input, opts.linkMap);
  }

  // Fragment mode (third arg = false) — no <html><head><body> wrapper injected.
  const $ = cheerio.load(input, null, false);

  // Extract and remove <style> blocks.
  const styles: string[] = [];
  $('style').each((_, el) => {
    styles.push($(el).html() ?? '');
    $(el).remove();
  });

  // Remove script, noscript, and base elements entirely. `<base href>` would
  // re-root every relative link/asset onto the source domain.
  $('script, noscript, base').remove();

  // Strip inline event handler attributes (onclick, onerror, onload, …).
  $('*').each((_, el) => {
    const attribs = (el as { attribs?: Record<string, string> }).attribs ?? {};
    for (const name of Object.keys(attribs)) {
      if (/^on/i.test(name)) $(el).removeAttr(name);
    }
  });

  // Strip javascript:/vbscript: hrefs (leading whitespace allowed) — the
  // element + its text are kept, only the dangerous navigation target is dropped.
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (/^\s*(?:javascript|vbscript):/i.test(href)) $(el).removeAttr('href');
  });

  // Remove iframes not in the allowlist.
  $('iframe').each((_, el) => {
    const src = $(el).attr('src') ?? '';
    if (!iframeAllowed(src)) $(el).remove();
  });

  const html = $.html();

  // Injection gate — must pass the same trust boundary as the pattern validator.
  const violations = scanForInjection(html);
  if (violations.length > 0) {
    throw new Error(`html-carry left injection vectors: ${violations.join('; ')}`);
  }

  return {
    html: html.trim(),
    styleText: styles.join('\n'),
  };
}
