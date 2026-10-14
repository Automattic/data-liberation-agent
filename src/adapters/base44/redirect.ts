import type { Page } from 'playwright';
import { serverRedirectTarget } from '../../lib/screenshot/document-integrity.js';
import { sameHttpSite } from '../../lib/screenshot/same-origin.js';

/**
 * Base44 applications answer every route with HTTP 200 and let the client
 * router decide. A members-only rewrite (for example `/pipeline` →
 * `/login?from_url=%2Fpipeline`) is a `history.pushState`, not a server
 * response, so the navigation guard cannot see it: DNS/routing don't ban —
 * the app itself rewrites the URL shortly after boot.
 *
 * A bounded probe waits for that rewrite once per route document. Only a
 * same-site path departure is declared, through exactly the predicate the
 * caller applies (`serverRedirectTarget`), so nothing external or
 * path-preserving becomes an alias. The query stays out of the copy the same
 * way server-evidence redirects leave it out: the alias binds to the target's
 * portable path.
 */
export const CLIENT_REDIRECT_PROBE_MS = 1_500;
export const CLIENT_REDIRECT_POLL_MS = 150;

/** Wait once for the app's own same-site route rewrite and declare its target. */
export async function resolveClientRedirect( page: Page, url: string ): Promise< string | undefined > {
	const started = Date.now();
	try {
		// The navigation guard is not armed yet; a real main-frame navigation
		// the app performs here keeps the capture route (and its retry policy)
		// as the honest failure, so no Promise rejection is needed.
		while ( Date.now() - started < CLIENT_REDIRECT_PROBE_MS ) {
			const target = observedClientRedirect( url, page.url() );
			if ( target ) return target;
			await page.waitForTimeout( CLIENT_REDIRECT_POLL_MS );
		}
	} catch {
		// A crashed or closed page has no alias to declare.
	}
	return undefined;
}

/** Same-site path departure, exposed for unit tests. */
export function observedClientRedirect( requestedUrl: string, settledUrl: string ): string | undefined {
	try {
		if ( ! sameHttpSite( requestedUrl, settledUrl ) ) return undefined;
	} catch { return undefined; }
	return serverRedirectTarget( requestedUrl, settledUrl );
}
