import * as cheerio from 'cheerio';
import { documentRequestUrl } from '../url/route-key.js';

const SKIP_PATHS = /^\/(cart|account|login|signup|checkout|search|api|admin|favicon)/i;
const ASSET_PATH = /\.(css|js|mjs|png|jpg|jpeg|gif|webp|avif|svg|ico|woff|woff2|ttf|eot|pdf|docx?|zip|xml|json|mp3|mp4|mov|webm|wav|ogg)$/i;

/** Actual resolved document addresses for inspection and diagnostics, not comparison keys.
 * References already resolved against the rendered URL/base retain that identity.
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
			if ( url.origin !== source.origin || ! [ 'http:', 'https:' ].includes( url.protocol ) ||
				ASSET_PATH.test( url.pathname ) || SKIP_PATHS.test( url.pathname ) ) return;
			links.add( documentRequestUrl( url.href ) );
		} catch {
			// Ignore malformed authored hrefs.
		}
	} );
	return [ ...links ];
}
