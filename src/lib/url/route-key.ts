/** Click and campaign identifiers analytics appends to links; they never select a different document. */
const TRACKING_PARAMS = new Set( [ 'fbclid', 'gclid', 'gbraid', 'wbraid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'igshid', 'yclid', 'twclid', 'ttclid', 'li_fat_id' ] );

/** Whether a query parameter is analytics tracking rather than document state. */
export function isTrackingParam( name: string ): boolean {
	const key = name.toLowerCase();
	return key.startsWith( 'utm_' ) || TRACKING_PARAMS.has( key );
}

/** Drop query parameters by name; an emptied query leaves no trailing `?`. */
export function withoutQueryParams( url: URL, drop: ( name: string ) => boolean ): void {
	for ( const name of new Set( url.searchParams.keys() ) ) if ( drop( name ) ) url.searchParams.delete( name );
}

/**
 * Address of a document request: a fragment is client-side and tracking
 * parameters are analytics; path, scheme and any other query are not aliases.
 */
export function documentRequestUrl( url: string ): string {
	const parsed = new URL( url );
	parsed.hash = '';
	withoutQueryParams( parsed, isTrackingParam );
	return parsed.href;
}

/** Discovery identity: path encoding and slash variants share a route; origin and document queries do not. */
export function normalizedUrl( url: string ): string {
	const parsed = new URL( documentRequestUrl( url ) );
	// Decode only RFC 3986 pchar literals (unreserved, sub-delims, ':' and '@').
	// Separators and '%' stay escaped, so this cannot change path structure or
	// recursively decode an escaped escape. Canonicalize all remaining hex.
	parsed.pathname = parsed.pathname.replace( /%[\da-f]{2}/gi, escape => {
		const character = String.fromCharCode( parseInt( escape.slice( 1 ), 16 ) );
		return /^[A-Za-z0-9._~!$&'()*+,;=:@-]$/.test( character ) ? character : escape.toUpperCase();
	} ).replace( /\/$/, '' ) || '/';
	return parsed.href;
}
