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
