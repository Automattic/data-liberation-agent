import { sameHttpSite } from './same-origin.js';

// src/lib/screenshot/document-integrity.ts
//
// A faithfully-captured page is ONE HTML document — exactly one <body>. A capture
// bug (the interaction/scroll loop interacting with a site's AJAX page-loader)
// can nest the whole document into itself N times, so the saved html/<slug>.html
// carries N <body> elements. Downstream that duplicates every section and, against
// the extractor's section cap, both inflates and TRUNCATES the reconstruction.
//
// This was observed at exactly 11× across Squarespace, Wix, and GoDaddy captures —
// the identical count across platforms is why it's our capture, not a platform
// quirk. Detection is generic (count top-level document markers), so it flags any
// future stacking artifact and is reused both by the segmentation fixture corpus
// (to quarantine corrupted fixtures) and by the capture phase (to refuse/clean a
// corrupted snapshot rather than persist it).

// Content the HTML parser treats as text (or inert markup), so a `<body` inside
// it is not an element: serialized script/style/textarea/title/template bodies
// and comments routinely carry markup-looking strings.
const RAW_TEXT_ELEMENTS = new Set( [ 'script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'noembed', 'noframes', 'iframe' ] );

/** One real start or end tag found by `scanHtmlTags`. */
export interface HtmlTagToken {
  /** Lower-case tag name. */
  name: string;
  closing: boolean;
  /** Index of `<`. */
  start: number;
  /** Index just after `>` (or the end of the input for an unterminated tag). */
  end: number;
  /** Raw text between the tag name and `>`; empty for end tags. */
  attributes: string;
}

/**
 * Visit the real start and end tags of serialized HTML, in order. Return `true`
 * from `visit` to stop.
 *
 * Tokenizes the markup instead of matching substrings: comments, raw-text
 * element contents, `<template>` contents and attribute values are skipped, so
 * markup-looking strings inside them (a script that `document.write`s a
 * `<body>…</body>` popup, a commented-out block) are never reported as tags.
 */
export function scanHtmlTags(html: string, visit: (tag: HtmlTagToken) => boolean | void): void {
  const lower = html.toLowerCase();
  const end = html.length;
  let i = 0;
  const skipPast = (marker: string, from: number): number => {
    const at = lower.indexOf(marker, from);
    return at === -1 ? end : at + marker.length;
  };
  const indexOrEnd = (marker: string, from: number): number => {
    const at = lower.indexOf(marker, from);
    return at === -1 ? end : at;
  };
  while (i < end) {
    const open = html.indexOf('<', i);
    if (open === -1) break;
    i = open + 1;
    if (html.startsWith('!--', i)) { i = skipPast('-->', i + 3); continue; }
    const first = html[i] ?? '';
    if (first === '!' || first === '?') { i = skipPast('>', i); continue; }
    const closing = first === '/';
    if (closing) {
      if (!/[a-z]/i.test(html[i + 1] ?? '')) { i = skipPast('>', i); continue; }
      i++;
    } else if (!/[a-z]/i.test(first)) continue;
    let nameEnd = i;
    while (nameEnd < end && !/[\s/>]/.test(html[nameEnd]!)) nameEnd++;
    const name = lower.slice(i, nameEnd);
    if (closing) {
      i = skipPast('>', nameEnd);
      if (visit({ name, closing, start: open, end: i, attributes: '' })) return;
      continue;
    }
    // Attributes: quoted values may contain `>` and `<body`.
    i = nameEnd;
    while (i < end && html[i] !== '>') {
      if (html[i] === '=') {
        i++;
        while (i < end && /\s/.test(html[i]!)) i++;
        const quote = html[i];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, i + 1);
          i = close === -1 ? end : close + 1;
        } else {
          while (i < end && !/[\s>]/.test(html[i]!)) i++;
        }
      } else i++;
    }
    const attributes = html.slice(nameEnd, Math.min(i, end));
    i = Math.min(i + 1, end);
    if (visit({ name, closing, start: open, end: i, attributes })) return;
    // The raw text runs to its end tag, which is then tokenized like any other.
    if (RAW_TEXT_ELEMENTS.has(name)) i = indexOrEnd(`</${name}`, i);
    else if (name === 'plaintext') i = end;
    else if (name === 'template') {
      for (let depth = 1; depth > 0 && i < end;) {
        const close = lower.indexOf('</template', i);
        const nested = lower.indexOf('<template', i);
        if (nested !== -1 && (close === -1 || nested < close)) { depth++; i = nested + 9; }
        else if (close === -1) i = end;
        else if (--depth > 0) i = close + 10;
        else i = close;
      }
    }
  }
}

/**
 * Number of real `<body>` elements — a clean document has exactly one.
 * Strings inside scripts, comments, templates and attribute values do not count.
 */
export function countBodyTags(html: string): number {
  let count = 0;
  scanHtmlTags(html, (tag) => { if (!tag.closing && tag.name === 'body') count++; });
  return count;
}

/** The real start and end tag of one document-level element (`head` or `body`). */
export interface DocumentElementTags {
  open?: { start: number; end: number; attributes: string };
  /** The first real end tag after the start tag (or anywhere, when there is no start tag). */
  close?: { start: number; end: number };
}

/**
 * Locate the real `<head>`/`<body>` start tag and its end tag in serialized
 * HTML. Use this instead of a `/<body\b[^>]*>([\s\S]*?)<\/body>/` style match:
 * a regex stops at the first `</body>` text, which can sit inside a script.
 */
export function documentElementTags(html: string, name: 'head' | 'body'): DocumentElementTags {
  const found: DocumentElementTags = {};
  let strayClose: DocumentElementTags['close'];
  scanHtmlTags(html, (tag) => {
    if (tag.name !== name) return false;
    if (!tag.closing) {
      if (!found.open) found.open = { start: tag.start, end: tag.end, attributes: tag.attributes };
      return false;
    }
    if (!found.open) {
      strayClose ??= { start: tag.start, end: tag.end };
      return false;
    }
    found.close = { start: tag.start, end: tag.end };
    return true;
  });
  if (!found.open && strayClose) found.close = strayClose;
  return found;
}

/**
 * True when the HTML nests more than one document (>1 real `<body>` element), i.e. the capture
 * stacked the page into itself. Such a snapshot is not a faithful single-page
 * render and must not be used as a parity fixture or persisted as output.
 */
export function isStackingArtifact(html: string): boolean {
  return countBodyTags(html) > 1;
}

// ---------------------------------------------------------------------------
// Route identity — a faithfully-captured page is the SAME route it was asked
// to capture. Every DOM-mutating capture step (lazy-load probing, disclosure
// hydration, dialog probing…) runs on a live, script-controlled page, and the
// HTML is deliberately serialized only after all of them — correct for
// capturing their settled state, but it means any of them navigating the page
// gets silently baked into the file for the ROUTE THAT WAS INTENDED, not the
// route that actually got captured (see `expandCollapsedContent`'s own guard
// against exactly this — this check exists independently of it, because it is
// generic: whichever operation causes the drift, in this codebase or a future
// one, a wrong document must never be persisted as if it were the right one).
// ---------------------------------------------------------------------------

function normalizeRoutePath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

/**
 * True when `capturedUrl` (the page's live location after every DOM-mutating
 * capture step has run) no longer names the same route as `intendedUrl` (the
 * URL the caller asked to capture). Ignores hash and query string, and
 * tolerates a trailing slash — a route-preserving difference (an anchor, a
 * tracking param, an SPA's own initial `replaceState` back to the same path)
 * must not be reported as drift. Only the origin and normalized pathname have
 * to agree; anything else disagreeing means the document that got serialized
 * belongs to a different page than the one on record for this capture.
 */
export function isRouteDrift(capturedUrl: string, intendedUrl: string): boolean {
  try {
    const captured = new URL(capturedUrl);
    const intended = new URL(intendedUrl);
    if (captured.origin !== intended.origin) return true;
    return normalizeRoutePath(captured.pathname) !== normalizeRoutePath(intended.pathname);
  } catch {
    // An unparseable URL can't be proven equivalent — treat unproven as drift
    // rather than silently accepting it.
    return capturedUrl !== intendedUrl;
  }
}

/** Initial document identity; only an observed same-site server redirect can change it. */
export function navigationDocumentUrl(requestedUrl: string, responseUrl: string, redirected: boolean): string {
  return redirected && sameHttpSite(requestedUrl, responseUrl) ? responseUrl : requestedUrl;
}

/**
 * The route a server redirect resolved `requestedUrl` to during navigation, or
 * undefined when it names the same path or another site. `finalUrl` is the
 * URL of the response navigation ended on after following redirect hops.
 *
 * A redirect answered by the server is the site saying the requested URL is
 * another name for the target — nothing ran on the page yet, so it is not the
 * drift {@link isRouteDrift} guards against (a live page navigating itself
 * after load). HTTP/HTTPS and apex/www aliases remain on the same site;
 * unrelated hosts and non-default ports remain outside its boundary.
 */
export function serverRedirectTarget( requestedUrl: string, finalUrl: string ): string | undefined {
	if ( ! sameHttpSite( requestedUrl, finalUrl ) ) return undefined;
	try {
		return normalizeRoutePath( new URL( finalUrl ).pathname ) !== normalizeRoutePath( new URL( requestedUrl ).pathname ) ? finalUrl : undefined;
	} catch {
		return undefined;
	}
}

/** Route identity {@link isRouteDrift} compares: origin plus normalized path. */
export function routeIdentity( url: string ): string {
	try {
		const parsed = new URL( url );
		return `${ parsed.origin }${ normalizeRoutePath( parsed.pathname ) }`;
	} catch {
		return url;
	}
}
