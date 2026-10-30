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

/** Document identity: fragments share content, but query renditions may not. */
export function normalizedUrl( url: string ): string {
	const parsed = new URL( url );
	parsed.hash = '';
	parsed.pathname = parsed.pathname.replace( /\/$/, '' ) || '/';
	return parsed.href;
}
