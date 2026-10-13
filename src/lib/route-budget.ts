import { documentRequestUrl } from './url/route-key.js';

/**
 * Default route budget for browser capture: the entrypoint plus 49 more routes.
 *
 * Browser capture renders every route in several profiles, and a store-sized
 * inventory cannot finish inside a hosted import deadline (~60 minutes). One
 * measured timeout inventoried 3,689 routes and reached about 180 of them in
 * 60 minutes at the default six route workers (each route took ~127 s, so
 * ~20 s of wall time per route). At that worst observed throughput 50 routes
 * take ~17 minutes, which leaves room for discovery, media, export and the
 * homepage preview, and for memory-constrained hosts that admit fewer workers.
 *
 * HTTP review acquisition stays unbounded by default: it fetches documents
 * without rendering them, so its per-route cost is a few requests rather than
 * a full browser navigation, and the same inventory finishes in minutes.
 */
export const DEFAULT_ROUTE_LIMIT = 50;

/** A positive route count, or `'all'` to capture the whole inventory. */
export type RouteLimit = number | 'all';

/** Discovery diagnostic code for a route left out by the capture's route budget. */
export const ROUTE_OMITTED_BY_BUDGET = 'route_omitted_by_budget';

/** Unresolved-anchor reason for a link whose target route the budget left out. */
export const OMITTED_ROUTE_REASON = 'target route was omitted by the route budget';

export function routeBudgetReason( limit: number ): string {
	return `Outside the route budget of ${ limit } routes`;
}

export function validateRouteLimit( limit: unknown ): asserts limit is RouteLimit | undefined {
	if ( limit === undefined || limit === 'all' ) return;
	if ( typeof limit !== 'number' || ! Number.isSafeInteger( limit ) || limit < 1 ) throw new Error( "routeLimit must be a positive integer or 'all'" );
}

/**
 * Pick `limit` routes spread evenly across the list, entrypoint first.
 *
 * Even spacing is the point. Taking the first N of an alphabetical list on a
 * site with sixty posts and a shop page spends every check inside /blog/ and
 * never reaches /shop/.
 */
export function spreadSample( routes: string[], limit: number ): string[] {
	if ( limit <= 0 ) return [];
	if ( routes.length <= limit ) return [ ...routes ];
	const [ first, ...rest ] = routes as [ string, ...string[] ];
	const picks = [ first ];
	const take = limit - 1;
	// Span both ends of the remainder. Stopping short leaves whatever sorts last
	// — often the very sections a blog was burying — permanently unmeasured.
	for ( let index = 0; index < take; index++ ) {
		const position = take === 1 ? rest.length - 1 : Math.round( ( index * ( rest.length - 1 ) ) / ( take - 1 ) );
		const candidate = rest[ position ];
		if ( candidate && ! picks.includes( candidate ) ) picks.push( candidate );
	}
	return picks;
}

/**
 * How the route budget picks routes when it truncates the inventory.
 *
 * - `discovery-order` (default): the entrypoint plus an even spread over the
 *   discovered inventory (`spreadSample`).
 * - `template-coverage`: the entrypoint, then one representative per template
 *   group (`template-groups.ts`), then the even spread over what is left.
 */
export const ROUTE_SELECTIONS = [ 'discovery-order', 'template-coverage' ] as const;
export type RouteSelection = typeof ROUTE_SELECTIONS[ number ];
export const DEFAULT_ROUTE_SELECTION: RouteSelection = 'discovery-order';

export function validateRouteSelection( selection: unknown ): asserts selection is RouteSelection | undefined {
	if ( selection === undefined || ( ROUTE_SELECTIONS as readonly unknown[] ).includes( selection ) ) return;
	throw new RangeError( `routeSelection must be one of ${ ROUTE_SELECTIONS.join( ', ' ) }` );
}

/** Deduplicate an inventory by document request identity, keeping first occurrences in order. */
export function dedupeRouteInventory( urls: readonly string[] ): string[] {
	const seen = new Set< string >();
	return urls.filter( url => {
		const key = documentRequestUrl( url );
		if ( seen.has( key ) ) return false;
		seen.add( key );
		return true;
	} );
}

/**
 * Apply a route budget to an initial inventory whose first URL is the
 * entrypoint. Routes are deduplicated by document request identity, then the
 * entrypoint plus an even spread of the remainder is kept, so the same
 * inventory always yields the same selection. `limit` counts the entrypoint.
 *
 * `preferred` routes (template representatives, highest priority first) are
 * kept right after the entrypoint, as far as the budget allows; the remaining
 * slots are the even spread over the routes not yet kept. Without `preferred`
 * the selection is exactly the even spread.
 */
export function selectRouteBudget( urls: string[], limit: number | undefined, preferred: readonly string[] = [] ): { selected: string[]; omitted: string[] } {
	const inventory = dedupeRouteInventory( urls );
	if ( limit === undefined || inventory.length <= limit ) return { selected: inventory, omitted: [] };
	const selected = preferred.length ? coverageSample( inventory, limit, preferred ) : spreadSample( inventory, limit );
	const kept = new Set( selected );
	return { selected, omitted: inventory.filter( url => ! kept.has( url ) ) };
}

function coverageSample( inventory: string[], limit: number, preferred: readonly string[] ): string[] {
	if ( limit <= 0 ) return [];
	const [ entrypoint, ...rest ] = inventory as [ string, ...string[] ];
	const byKey = new Map( rest.map( url => [ documentRequestUrl( url ), url ] ) );
	const picks = [ entrypoint ];
	const kept = new Set( picks );
	for ( const url of preferred ) {
		if ( picks.length >= limit ) break;
		const route = byKey.get( documentRequestUrl( url ) );
		if ( route && ! kept.has( route ) ) {
			picks.push( route );
			kept.add( route );
		}
	}
	const remaining = rest.filter( url => ! kept.has( url ) );
	return [ ...picks, ...spreadSample( [ entrypoint, ...remaining ], limit - picks.length + 1 ).slice( 1 ) ];
}
