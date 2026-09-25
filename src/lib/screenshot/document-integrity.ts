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

/** Number of `<body>` open tags — a clean document has exactly one. */
export function countBodyTags(html: string): number {
  return (html.match(/<body[\s>]/gi) ?? []).length;
}

/**
 * True when the HTML nests more than one document (>1 `<body>`), i.e. the capture
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

/**
 * The route a server redirect resolved `requestedUrl` to during navigation, or
 * undefined when it names the same route or another origin. `finalUrl` is the
 * URL of the response navigation ended on after following redirect hops.
 *
 * A redirect answered by the server is the site saying the requested URL is
 * another name for the target — nothing ran on the page yet, so it is not the
 * drift {@link isRouteDrift} guards against (a live page navigating itself
 * after load). A redirect off the origin names a different site, not an alias.
 */
export function serverRedirectTarget( requestedUrl: string, finalUrl: string ): string | undefined {
	if ( ! isRouteDrift( finalUrl, requestedUrl ) ) return undefined;
	try {
		return new URL( finalUrl ).origin === new URL( requestedUrl ).origin ? finalUrl : undefined;
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
