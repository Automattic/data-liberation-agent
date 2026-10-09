import * as cheerio from 'cheerio';
import { documentRequestUrl } from '../url/route-key.js';

/** Actual resolved document addresses for inspection and diagnostics, not comparison keys.
 * References already resolved against the rendered URL/base retain that identity.
 * Path names do not establish document type or policy: the capture response
 * classifier observes HTML, absent/non-HTML inputs and navigation boundaries.
 */
export function sameOriginPageAnchors( html: string, sourceUrl: string ): string[] {
	let source: URL;
	try {
		source = new URL( sourceUrl );
	} catch {
		return [];
	}
	const $ = cheerio.load( html );
	const links = new Set< string >();
	$( 'a[href],area[href]' ).each( ( _, element ) => {
		const href = ( $( element ).attr( 'href' ) ?? '' ).trim();
		if ( ! href || href === '#' ) return;
		try {
			const url = new URL( href, sourceUrl );
			if ( url.origin !== source.origin || ! [ 'http:', 'https:' ].includes( url.protocol ) ) return;
			links.add( documentRequestUrl( url.href ) );
		} catch {
			// Ignore malformed authored hrefs.
		}
	} );
	return [ ...links ];
}
