/** Document identity: fragments share content, but query renditions may not. */
export function normalizedUrl( url: string ): string {
	const parsed = new URL( url );
	parsed.hash = '';
	parsed.pathname = parsed.pathname.replace( /\/$/, '' ) || '/';
	return parsed.href;
}
