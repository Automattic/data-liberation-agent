import type { SiteRouteScope } from '../../platform/types.js';

/** Soloist owns one customer per first path segment, not one customer per origin. */
export function soloistRouteScope( sourceUrl: string ): SiteRouteScope {
	const entry = new URL( sourceUrl );
	const handle = entry.pathname.split('/')[1];
	if ( !handle ) throw new Error( 'Soloist discovery requires a customer handle URL' );
	return { origin: entry.origin, pathPrefixes: [ `/${handle}` ] };
}
