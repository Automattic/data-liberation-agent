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
  /(^|\.)vimeo\.com$/i,
  /(^|\.)player\.vimeo\.com$/i,
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
 * - Strips `<script>`, `<noscript>`, and inline event handlers (`on*=`).
 * - Extracts `<style>` blocks into `styleText` (removes them from `html`).
 * - Removes non-allowlisted `<iframe>` elements.
 * - Rewrites media URLs and internal hrefs via the provided maps.
 * - Throws if the sanitized result still contains injection vectors.
 */
export function carryHtml(regionHtml: string, opts: CarryOpts): CarryResult {
  // Fragment mode (third arg = false) — no <html><head><body> wrapper injected.
  const $ = cheerio.load(regionHtml, null, false);

  // Extract and remove <style> blocks.
  const styles: string[] = [];
  $('style').each((_, el) => {
    styles.push($(el).html() ?? '');
    $(el).remove();
  });

  // Remove script and noscript elements entirely.
  $('script, noscript').remove();

  // Strip inline event handler attributes (onclick, onerror, onload, …).
  $('*').each((_, el) => {
    const attribs = (el as { attribs?: Record<string, string> }).attribs ?? {};
    for (const name of Object.keys(attribs)) {
      if (/^on/i.test(name)) $(el).removeAttr(name);
    }
  });

  // Remove iframes not in the allowlist.
  $('iframe').each((_, el) => {
    const src = $(el).attr('src') ?? '';
    if (!iframeAllowed(src)) $(el).remove();
  });

  let html = $.html();

  // URL rewrites (same maps as the block-reconstruction path).
  if (opts.mediaUrlMap && opts.mediaUrlMap.size > 0) {
    html = rewriteMediaUrls(html, opts.mediaUrlMap);
  }
  if (opts.linkMap && (opts.linkMap as Map<string, unknown>).size > 0) {
    html = rewriteInternalLinks(html, opts.linkMap);
  }

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
