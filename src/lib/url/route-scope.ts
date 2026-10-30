import type { SiteRouteScope } from '../../platform/types.js';
import { documentRequestUrl, withoutQueryParams } from './route-key.js';

/** Validate once at the owning boundary; malformed ownership must not widen capture. */
export function validateRouteScope( scope: SiteRouteScope ): void {
	const origin = new URL( scope.origin );
	if ( ![ 'http:', 'https:' ].includes( origin.protocol ) || origin.origin !== scope.origin ||
		!Array.isArray( scope.pathPrefixes ) || !scope.pathPrefixes.length || scope.pathPrefixes.some( path => {
			if ( typeof path !== 'string' || !path.startsWith('/') || (path !== '/' && path.endsWith('/')) ) return true;
			const parsed = new URL( path, origin );
			return parsed.origin !== origin.origin || parsed.pathname !== path || !!parsed.search || !!parsed.hash;
		} ) || ( scope.ignoredQueryParams !== undefined && ( !Array.isArray( scope.ignoredQueryParams ) ||
			scope.ignoredQueryParams.some( name => typeof name !== 'string' || !name ) ) ) ) throw new Error( 'Invalid adapter route scope' );
}

/** Route identity inside an adapter scope: the document request minus the platform's non-semantic parameters. */
export function scopedRouteKey( url: string, scope?: SiteRouteScope ): string {
	const key = documentRequestUrl( url );
	const ignored = scope?.ignoredQueryParams;
	if ( !ignored?.length ) return key;
	const parsed = new URL( key );
	withoutQueryParams( parsed, name => ignored.includes( name ) );
	return parsed.href;
}

/** Route admission only. Native resources remain independent of customer namespaces. */
export function routeInScope( url: string, scope?: SiteRouteScope ): boolean {
	if ( !scope ) return true;
	const parsed = new URL( url );
	return parsed.origin === scope.origin && scope.pathPrefixes.some( prefix =>
		prefix === '/' || parsed.pathname === prefix || parsed.pathname.startsWith( `${prefix}/` ) );
}
