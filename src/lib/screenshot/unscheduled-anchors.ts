import * as cheerio from 'cheerio';
import { normalizedUrl } from '../url/route-key.js';

const SKIP_PATHS = /^\/(cart|account|login|signup|checkout|search|api|admin|favicon)/i;
const ASSET_PATH = /\.(css|js|mjs|png|jpg|jpeg|gif|webp|avif|svg|ico|woff|woff2|ttf|eot|pdf|docx?|zip|xml|json|mp3|mp4|mov|webm|wav|ogg)$/i;

/** The same page-link selection is used for source inspection and export diagnostics. */
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
			if ( url.origin !== source.origin || ! [ 'http:', 'https:' ].includes( url.protocol ) ||
				ASSET_PATH.test( url.pathname ) || SKIP_PATHS.test( url.pathname ) ) return;
			links.add( normalizedUrl( url.href ) );
		} catch {
			// Ignore malformed authored hrefs.
		}
	} );
	return [ ...links ];
}
