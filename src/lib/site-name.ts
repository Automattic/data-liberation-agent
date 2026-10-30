/** Separators sites put between a page's own title and the site name. */
const TITLE_SEPARATOR = /\s+[|\-–—·•]\s+/;

function segments( title: string ): string[] {
	return [ ...new Set( title.split( TITLE_SEPARATOR ).map( segment => segment.trim() ).filter( Boolean ) ) ];
}

/**
 * The site name a discovered title carries, trimmed to the one segment every
 * captured route title repeats.
 *
 * Discovery reads the homepage's document title, which usually pairs the site
 * name with a page title or tagline ("Acme | Hand-made widgets"). Which side
 * holds the name varies by site, but the name is the part every page repeats
 * ("About us | Acme"). The discovered title is only ever trimmed to that
 * segment: without two route titles, without exactly one shared segment, or
 * when the shared segment is not part of the discovered title, it is kept.
 */
export function siteNameFromRouteTitles( title: string | undefined, routeTitles: readonly string[] ): string | undefined {
	const titles = routeTitles.map( routeTitle => routeTitle.trim() ).filter( Boolean );
	if ( titles.length < 2 ) return title;
	const shared = titles.map( segments ).reduce( ( common, next ) => common.filter( segment => next.includes( segment ) ) );
	if ( shared.length !== 1 ) return title;
	const [ name ] = shared;
	if ( title === undefined || segments( title ).includes( name! ) ) return name;
	return title;
}

/**
 * The name a document's schema.org `WebSite` JSON-LD declares for the site,
 * the site's own explicit statement of its name.
 */
export function declaredSiteName( html: string ): string | undefined {
	for ( const [ , json ] of html.matchAll( /<script\b[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi ) ) {
		let data: unknown;
		try {
			data = JSON.parse( json! );
		} catch {
			continue;
		}
		const nodes = ( Array.isArray( data ) ? data : [ data ] ).flatMap( node =>
			node && typeof node === 'object' && Array.isArray( ( node as { '@graph'?: unknown } )[ '@graph' ] ) ? ( node as { '@graph': unknown[] } )[ '@graph' ] : [ node ] );
		for ( const node of nodes as Array< { '@type'?: unknown; name?: unknown } | null > ) {
			const types = Array.isArray( node?.[ '@type' ] ) ? node[ '@type' ] : [ node?.[ '@type' ] ];
			if ( types.includes( 'WebSite' ) && typeof node?.name === 'string' && node.name.trim() ) return node.name.trim();
		}
	}
	return undefined;
}
