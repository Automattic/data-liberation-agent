import { readDocument } from '../parsed-documents.js';
import { documentRequestUrl } from '../url/route-key.js';
import { onSiteOrigin } from './same-origin.js';

/** Actual resolved document addresses for inspection and diagnostics, not comparison keys.
 * References already resolved against the rendered URL/base retain that identity.
 * Path names do not establish document type or policy: the capture response
 * classifier observes HTML, absent/non-HTML inputs and navigation boundaries.
 */
export function sameOriginPageAnchors( html: string, sourceUrl: string ): string[] {
	const $ = readDocument( html );
	const links = new Set< string >();
	$( 'a[href],area[href]' ).each( ( _, element ) => {
		const href = ( $( element ).attr( 'href' ) ?? '' ).trim();
		if ( ! href || href === '#' ) return;
		try {
			const url = onSiteOrigin( new URL( href, sourceUrl ), sourceUrl );
			if ( url ) links.add( documentRequestUrl( url.href ) );
		} catch {
			// Ignore malformed authored hrefs.
		}
	} );
	return [ ...links ];
}
