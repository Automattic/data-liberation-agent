import type { SiteRouteScope } from '../../platform/types.js';

/** Validate once at the owning boundary; malformed ownership must not widen capture. */
export function validateRouteScope( scope: SiteRouteScope ): void {
	const origin = new URL( scope.origin );
	if ( ![ 'http:', 'https:' ].includes( origin.protocol ) || origin.origin !== scope.origin ||
		!Array.isArray( scope.pathPrefixes ) || !scope.pathPrefixes.length || scope.pathPrefixes.some( path => {
			if ( typeof path !== 'string' || !path.startsWith('/') || (path !== '/' && path.endsWith('/')) ) return true;
			const parsed = new URL( path, origin );
			return parsed.origin !== origin.origin || parsed.pathname !== path || !!parsed.search || !!parsed.hash;
		} ) ) throw new Error( 'Invalid adapter route scope' );
}

/** Route admission only. Native resources remain independent of customer namespaces. */
export function routeInScope( url: string, scope?: SiteRouteScope ): boolean {
	if ( !scope ) return true;
	const parsed = new URL( url );
	return parsed.origin === scope.origin && scope.pathPrefixes.some( prefix =>
		prefix === '/' || parsed.pathname === prefix || parsed.pathname.startsWith( `${prefix}/` ) );
}
