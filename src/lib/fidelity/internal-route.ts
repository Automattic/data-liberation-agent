import type { APIRequestContext } from 'playwright';

/** One bounded candidate route check. Status is the last response observed,
 * or null when no response arrived; no outbound Location is persisted. */
export interface InternalRouteOutcome {
	path: string;
	status: number | null;
	redirects: number;
	outcome: 'reachable' | 'http-error' | 'blocked-redirect' | 'missing-location' | 'invalid-location' | 'redirect-loop' | 'redirect-limit' | 'timeout' | 'request-error';
}

/** API requests bypass browser routing. Inspect every redirect manually, as
 * capture's authored-link inspection does, but require the exact candidate
 * origin rather than source-site aliases. The deadline covers the whole chain. */
export async function checkInternalRoute(
	request: APIRequestContext,
	origin: string,
	path: string,
	{ timeoutMs = 10_000, maxRedirects = 20 } = {}
): Promise<InternalRouteOutcome> {
	const result: InternalRouteOutcome = { path, status: null, redirects: 0, outcome: 'request-error' };
	const deadline = performance.now() + timeoutMs;
	const visited = new Set<string>();
	let current = new URL( path, origin );
	for ( ;; ) {
		// Validate before every request, including the initial authored path.
		if ( current.origin !== origin || current.username || current.password ) return { ...result, outcome: 'blocked-redirect' };
		current.hash = '';
		if ( visited.has( current.href ) ) return { ...result, outcome: 'redirect-loop' };
		const remaining = deadline - performance.now();
		if ( remaining <= 0 ) return { ...result, outcome: 'timeout' };
		visited.add( current.href );
		try {
			const response = await request.get( current.href, { maxRedirects: 0, timeout: Math.max( 1, Math.ceil( remaining ) ) } );
			let location: string | undefined;
			try {
				result.status = response.status();
				location = response.headers()[ 'location' ];
			} finally { await response.dispose(); }
			if ( performance.now() >= deadline ) return { ...result, outcome: 'timeout' };
			if ( ! [ 301, 302, 303, 307, 308 ].includes( result.status ) ) {
				return { ...result, outcome: result.status >= 200 && result.status < 300 ? 'reachable' : 'http-error' };
			}
			if ( ! location ) return { ...result, outcome: 'missing-location' };
			let next: URL;
			try { next = new URL( location, current ); }
			catch { return { ...result, outcome: 'invalid-location' }; }
			if ( next.origin !== origin || next.username || next.password ) return { ...result, outcome: 'blocked-redirect' };
			next.hash = '';
			if ( visited.has( next.href ) ) return { ...result, outcome: 'redirect-loop' };
			if ( result.redirects >= maxRedirects ) return { ...result, outcome: 'redirect-limit' };
			result.redirects++;
			current = next;
		} catch ( error ) {
			return { ...result, outcome: performance.now() >= deadline || ( error instanceof Error && /timeout/i.test( error.message ) ) ? 'timeout' : 'request-error' };
		}
	}
}
