//
// Pure URL-rewrite for HTML / block markup
// ========================================
// Phase 3.5 hook: after compose-page-blocks emits markup, swap source-domain
// media URLs for the local upload URLs registered by `installMediaForUrl`.
//
// This is intentionally pure (no I/O): the caller builds the mapping from
// MediaStubStore and hands us a string. The same function is used for raw
// HTML and for serialized block markup — the regexes target attribute
// surfaces (`src=`, `srcset=`, `href=`) plus the JSON-shaped attributes that
// block markup carries inline (`"src":"..."`, `"url":"..."`).
//
// Rewrite rule: only URLs present in `mapping` get rewritten. URLs not in
// the map are left untouched and reported via the optional `onMissing`
// callback so the caller can log a warning.
//
// Patterns mirrored from src/lib/preview/media-url-map.ts:rewriteWxrAttachmentUrls.
// That function targets <wp:attachment_url> CDATA — this one targets the
// content surfaces a block-rendered post would expose.

import { rewriteMediaReferences, srcsetReferences } from '../srcset.js';

export interface RewriteWarnings {
  /** Source URLs that appeared in the input but had no mapping. */
  missing: string[];
}

export interface RewriteOpts {
  /**
   * Optional logging callback fired for each unique source URL we found in
   * the input but couldn't rewrite. Useful for streaming-mode warning
   * surfaces (watch.log) without coupling this module to a logger.
   */
  onMissing?: (sourceUrl: string) => void;
}

/**
 * Rewrite source URLs in an HTML or block-markup string.
 *
 * @param input HTML or block markup to rewrite. Returned unchanged when
 *   `mapping` is empty.
 * @param mapping Map<sourceUrl, localUrl>. The local URL replaces the source
 *   URL verbatim wherever the source URL appears in any of the recognized
 *   attribute surfaces.
 * @param opts Optional handlers; see RewriteOpts.
 */
export function rewriteMediaUrls(
  input: string,
  mapping: Map<string, string>,
  opts: RewriteOpts = {},
): string {
  if (!input || mapping.size === 0) return input;

  const replacements = new Map<string, string>();
  for (const [source, local] of mapping) {
    if (source && source !== '/' && input.includes(source)) replacements.set(source, local);
  }
  // Inline CSS and other HTML attributes serialize query separators as &amp;.
  for (const [source, local] of mapping) {
    if (source.includes('&')) {
      const encoded = source.replace(/&/g, '&amp;');
      if (input.includes(encoded)) replacements.set(encoded, local.replace(/&/g, '&amp;'));
    }
  }

  // Resolve complete attribute/list candidates by exact URL identity.
  // Media attributes use exact URL-token replacement; the other
  // HTML/CSS/JSON surfaces retain the bounded raw replacement pass below.
  // Scan the *input* (pre-rewrite) for missing URLs so the local
  // replacement URL isn't itself reported as "missing" after the rewrite.
  const seen = new Set<string>();
  const candidates = collectMediaCandidates(input);
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const decoded = candidate.replace(/&amp;/g, '&');
    const local = mapping.get(decoded);
    if (local) {
      replacements.set(candidate, decoded === candidate ? local : local.replace(/&/g, '&amp;'));
    } else if (opts.onMissing) {
      opts.onMissing(candidate);
    }
  }

  // Prefer complete, most-specific source URLs over their shorter prefixes.
  const ordered = [...replacements.entries()]
    // A same-origin media URL can produce `/` as an alias. Replacing that
    // substring would corrupt every path, closing tag, and MIME type in the document.
    .filter(([source]) => source && source !== '/')
    .sort((a, b) => b[0].length - a[0].length);
  if (ordered.length === 0) return input;
  const patterns = ordered.map(([source]) => {
    // Escape the source URL for safe inclusion in a RegExp. This handles
    // querystring `?`, `&`, `+` and other regex metacharacters that often
    // appear in CDN URLs.
    const safe = escapeRegex(source);
    // Longest-first only removes the mangle for transform urls the candidate
    // scan reached. A transform url on any other surface - a `data-` attribute,
    // a `<source src>`, a `<video poster>` - never enters `replacements`, so
    // the shorter base entry would still be free to match its prefix. The URL
    // terminator lookahead refuses every such partial match: a mapped url
    // continued by any URL character names a longer, different resource, and
    // splicing the local path onto its tail would leave an absent file.
    return `${safe}${URL_TERMINATOR_LOOKAHEAD}`;
  });
  // Match the original input once: a relative source alias must not match
  // the suffix of a local path emitted by an earlier replacement.
  const pattern = new RegExp(patterns.join('|'), 'g');
  return rewriteMediaReferences(
    input,
    url => replacements.get(url) ?? url,
    other => other.replace(pattern, source => replacements.get(source)!),
  );
}

/**
 * Convert an extraction-log media URL map into the input expected by
 * rewriteMediaUrls. Builds Map<sourceUrl, `${localBase}/${filename}`>.
 *
 * Mirrors the caller pattern in src/lib/preview/studio.ts where
 * `buildMediaUrlMap(outputDir)` is paired with a `localBase` URL.
 */
export function toLocalUrlMapping(
  filenameMap: Map<string, string>,
  localBase: string,
): Map<string, string> {
  const trimmed = localBase.replace(/\/+$/, '');
  const out = new Map<string, string>();
  for (const [sourceUrl, filename] of filenameMap) {
    out.set(sourceUrl, `${trimmed}/${filename}`);
  }
  return out;
}

// NB: `)` is intentionally NOT excluded. Wix appends the human display filename
// to transform URLs (`…/Cornelius%20Holmes%20(1).png`), so stopping at `)` would
// truncate the URL at `(1`, and the rewrite would then swap only the prefix —
// leaving `<local>).png` (a 404). Candidates are extracted from quoted attribute
// surfaces / srcset (whitespace- and comma-delimited), so a literal `)` is part
// of the URL, never a delimiter. Attribute values are bounded before this
// matcher runs, so apostrophes remain valid inside double-quoted URLs.
const URL_LIKE = /https?:\/\/[^\s"<>\\]+/g;

/**
 * Collect plausible media URLs from common attribute surfaces. We don't try
 * to be exhaustive — the goal is to flag obvious source-domain references
 * that didn't get rewritten so the caller can warn.
 */
function collectMediaCandidates(input: string): string[] {
  const candidates: string[] = [];
  // Direct attribute-style matches first — high signal.
  const attrPatterns: RegExp[] = [
    /<img[^>]*\bsrc\s*=\s*(["'])([\s\S]*?)\1/gi,
    /<a[^>]*\bhref\s*=\s*(["'])([\s\S]*?\.(?:jpe?g|png|gif|webp|svg|avif|mp4|webm|pdf))\1/gi,
    /\bsrcset\s*=\s*(["'])([\s\S]*?)\1/gi,
    /"src"\s*:\s*"([^"]+)"/g,
    /"url"\s*:\s*"([^"]+)"/g,
  ];
  for (const re of attrPatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      const value = m[2] ?? m[1];
      // Use the same browser URL tokens for descriptors and descriptorless lists.
      if (re.source.includes('srcset')) {
        candidates.push(...srcsetReferences(value));
      } else {
        candidates.push(value);
      }
    }
  }
  // Cheap sanity filter — only keep things that parse as URLs, drop relative
  // paths and `data:` URIs.
  return candidates
    .map((c) => c.match(URL_LIKE)?.[0] ?? c)
    .filter((c) => /^https?:\/\//i.test(c));
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A reference names a complete URL only where a URL terminator follows it.
// Image runtimes derive rendition URLs by appending to the bare asset URL
// (`…/IMG_2019.JPG/:/` → `…/IMG_2019.JPG/:/rs=w:1160,h:720`), so the bare URL
// occurs in markup as a string-prefix of every one of its renditions. Any
// rewrite — to a local path, a blank, or about:blank — that splices the
// reference at such a position mangles the rendition into a URL no file
// answers (the issue #398 absent `/rs=w:1160` hero). Only rewrite where the
// match is the whole URL: end of string, whitespace, quote, tag/CSS boundary,
// or an entity-encoded quote (attribute JSON encodes both the quote and any
// `&` inside the URL, so the terminator may itself be double-encoded).
// Everything else — letters, `/`, `?`, `&`, `:`, `,`, `;`, `=` — continues the
// longer URL.
export const URL_TERMINATOR_LOOKAHEAD =
  '(?=$|[\\s"\'()<>]|&(?:amp;)?(?:quot|apos|#3[49]|#x2[27]);?)';

// The same boundary before the match. A relative reference such as
// `media/photo.jpg` is also the tail of `/media/photo.jpg`, the local path an
// earlier replacement map already wrote. Matching there again turns it into
// `//media/photo.jpg`, a protocol-relative URL on another host.
export const URL_START_LOOKBEHIND =
  '(?<=^|[\\s"\'()<>]|&(?:amp;)?(?:quot|apos|#3[49]|#x2[27]);)';
