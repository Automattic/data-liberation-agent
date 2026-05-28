//
// Verbatim core/html fallback
// ===========================
// When a section's structured render drops content (see section-coverage.ts),
// we emit the section's source outerHTML VERBATIM as a `core/html` block rather
// than ship the lossy blocks — mirroring h2bc's "unsupported -> core/html"
// model. The tradeoff: that one section loses block-editability/theming, but
// nothing is dropped or guessed ([[feedback_never_lose_source_content]]).
//
// "Verbatim" = content-faithful, MINUS active/unsafe content. The validate-
// artifacts injection gate rejects `<script>`, inline `on*=` handlers, and raw
// `<?php`, so the island is sanitized to clear all three before it can ship.
// Media URLs and internal links are rewritten through the same maps the rest of
// the reconstruction uses, so the island points at local uploads + imported
// pages.
//
import { rewriteMediaUrls } from '../streaming/media-url-rewrite.js';
import { rewriteInternalLinks, type InternalLinkMap } from '../streaming/internal-link-rewrite.js';
import { scanForInjection } from './validate-artifacts.js';

export interface HtmlFallbackOpts {
  /** Source media URL -> local upload URL (same map the block path uses). */
  mediaUrlMap?: Map<string, string>;
  /** Source-path -> local-permalink map (#2), for inline links in the island. */
  linkMap?: InternalLinkMap;
}

/** Remove script/style/comment blocks, inline event handlers, and PHP tags. */
function sanitize(html: string): string {
  return html
    // Paired script/style including their contents.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    // Any residual/unclosed script/style tags.
    .replace(/<\/?(?:script|style)\b[^>]*>/gi, '')
    // PHP (incl. short tags) — no <?php may survive the injection gate.
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<\?/g, '')
    // HTML comments — strips noise AND any literal `<!-- wp:… -->` lookalikes
    // that would otherwise break block parsing of the surrounding markup.
    .replace(/<!--[\s\S]*?-->/g, '')
    // Inline event handlers (onclick/onerror/onload/…), quoted or bare.
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

/**
 * Build a sanitized, URL-rewritten `core/html` block from a section's source
 * outerHTML. Throws if sanitization left any injection vector (defensive — a bad
 * island must never silently ship past the gate).
 */
export function buildHtmlFallbackBlock(sectionHtml: string, opts: HtmlFallbackOpts = {}): string {
  let inner = sanitize(sectionHtml);
  if (opts.mediaUrlMap && opts.mediaUrlMap.size > 0) inner = rewriteMediaUrls(inner, opts.mediaUrlMap);
  if (opts.linkMap && opts.linkMap.size > 0) inner = rewriteInternalLinks(inner, opts.linkMap);

  const violations = scanForInjection(inner);
  if (violations.length > 0) {
    throw new Error(`html-fallback sanitization left injection vectors: ${violations.join('; ')}`);
  }

  return `<!-- wp:html -->\n${inner.trim()}\n<!-- /wp:html -->`;
}
