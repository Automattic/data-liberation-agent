import type { SiteRouteScope } from '../../platform/types.js';

/** One medium.com author (`/@handle`) or publication (`/name`) is one site, not the whole origin. */
export function mediumRouteScope( sourceUrl: string ): SiteRouteScope {
	const entry = new URL( sourceUrl );
	const owner = entry.pathname.split('/')[1];
	if ( !owner ) throw new Error( 'Medium discovery requires an author or publication URL' );
	return { origin: entry.origin, pathPrefixes: [ `/${owner}` ] };
}
