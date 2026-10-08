/** Address of a document request: a fragment is client-side; path, scheme and query are not aliases. */
export function documentRequestUrl( url: string ): string {
	const parsed = new URL( url );
	parsed.hash = '';
	return parsed.href;
}

/** Document identity: fragments share content, but query renditions may not. */
export function normalizedUrl( url: string ): string {
	const parsed = new URL( url );
	parsed.hash = '';
	parsed.pathname = parsed.pathname.replace( /\/$/, '' ) || '/';
	return parsed.href;
}
