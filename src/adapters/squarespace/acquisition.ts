import * as cheerio from 'cheerio';
import type { HttpAcquisitionProfile } from '../../platform/acquisition.js';
import { detection } from './detection.js';

/** Server editorial content is portable even when template derivation cannot be proven. */
export const squarespaceAcquisition: HttpAcquisitionProfile = {
	id: 'squarespace',
	exportVariants: { desktop: 'desktop' },
	variants: [ { id: 'desktop', headers: {
		'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
	} } ],
	prepare: ( html, context ) => {
		if ( ! detection.sourceSignals?.some( signal => signal.pattern.test( html ) ) ) return undefined;
		const $ = cheerio.load( html );
		const content = $( 'main, article, .main-content, #page' ).clone().find( 'script, style, template, noscript' ).remove().end();
		if ( ! content.text().trim() && ! content.find( 'img[src], img[data-src]' ).length ) return undefined;
		$( 'script' ).each( ( _, element ) => {
			const node = $( element );
			if ( ! node.attr( 'src' ) && [ 'application/ld+json', 'application/json' ].includes( ( node.attr( 'type' ) ?? '' ).toLowerCase() ) ) {
				try {
					const data: unknown = JSON.parse( node.text() );
					if ( data !== null && typeof data === 'object' ) {
						node.text( JSON.stringify( data ).replace( /</g, '\\u003c' ) );
						return;
					}
				} catch { /* Invalid data is not portable evidence. */ }
			}
			node.remove();
		} );
		$( '*' ).each( ( _, element ) => {
			if ( 'attribs' in element ) for ( const name of Object.keys( element.attribs ) ) if ( /^on/i.test( name ) ) $( element ).removeAttr( name );
		} );
		$( 'img[data-src]' ).each( ( _, element ) => {
			const image = $( element );
			image.attr( 'src', image.attr( 'data-src' )! );
		} );
		return {
			html: $.html(),
			metadata: {
				document: 'squarespace-server-rendered', title: $( 'title' ).first().text().trim(),
				canonical: $( 'link[rel="canonical"]' ).first().attr( 'href' ) ?? context.url,
				variant: context.variant, rendering: 'unverified', interactions: 'unverified', assets: 'not-localized',
			},
		};
	},
};
