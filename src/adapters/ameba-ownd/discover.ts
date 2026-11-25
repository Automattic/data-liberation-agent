import { discoverGeneric } from '../discover-generic.js';
import { amebaRouteKind } from './routes.js';

/**
 * Every Ameba Ownd site publishes `/sitemap.xml` listing its posts, static
 * pages, category archives and month archives. Generic discovery reads it;
 * routes are typed by the platform's fixed route table.
 */
export async function discover( url: string, opts: Record< string, unknown > ) {
	const inventory = await discoverGeneric( url, opts );
	return { ...inventory, urls: inventory.urls.map( entry => ( { ...entry, type: amebaRouteKind( entry.url ) } ) ) };
}
