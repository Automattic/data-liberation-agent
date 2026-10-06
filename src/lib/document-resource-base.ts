import * as cheerio from 'cheerio';
import { decodeCssUrl } from './css-url-escapes.js';
import { srcsetReferences } from './srcset.js';

export interface RenderedDocumentUrl {
	url: string;
	baseUrl: string;
}

/** Resolve source references before removing <base> or combining viewport documents. */
export function resolveDocumentReferences( html: string, documentUrl: string, browserBaseUrl?: string ): string {
	const $ = cheerio.load( html );
	const authoredBase = $( 'base[href]' ).first().attr( 'href' );
	if ( browserBaseUrl === undefined && authoredBase === undefined ) return html;
	let baseUrl: string;
	try {
		baseUrl = new URL( browserBaseUrl ?? authoredBase!, documentUrl ).href;
	} catch {
		baseUrl = documentUrl;
	}
	const resolve = ( reference: string ): string => {
		if ( ! reference.trim() ) return reference;
		// A document fragment remains local when its base still names this document.
		if ( reference.startsWith( '#' ) && new URL( baseUrl ).href.split( '#' )[ 0 ] === documentUrl.split( '#' )[ 0 ] ) return reference;
		try {
			const url = new URL( reference, baseUrl );
			return /^https?:$/.test( url.protocol ) ? url.href : reference;
		} catch { return reference; }
	};
	const css = ( value: string ) => value.replace(
		/url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:\\.|[^\s)'";])+))\s*\)|@import\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/gis,
		( match, ...groups: Array<string | undefined> ) => {
			const reference = groups.slice( 0, 5 ).find( value => value !== undefined )!;
			// Local SVG paint servers do not become document downloads.
			if ( reference.startsWith( '#' ) ) return match;
			const resolved = resolve( decodeCssUrl( reference ) );
			if ( resolved === reference ) return match;
			const quoted = JSON.stringify( resolved );
			return /^@import/i.test( match ) ? `@import ${ quoted }` : `url(${ quoted })`;
		}
	);
	$( '[href],[src],[poster],[xlink\\:href],[srcset],[style]' ).each( ( _, element ) => {
		const node = $( element );
		for ( const attribute of [ 'href', 'src', 'poster', 'xlink:href' ] ) {
			const reference = node.attr( attribute );
			if ( reference !== undefined && element.name !== 'base' ) node.attr( attribute, resolve( reference ) );
		}
		const srcset = node.attr( 'srcset' );
		if ( srcset ) {
			const references = srcsetReferences( srcset ).sort( ( a, b ) => b.length - a.length );
			const tokens = references.map( value => value.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) );
			if ( tokens.length ) node.attr( 'srcset', srcset.replace( new RegExp( `(^|[\\s,])(${ tokens.join( '|' ) })(?=[\\s,]|$)`, 'g' ), ( _, prefix, reference ) => prefix + resolve( reference ) ) );
		}
		const style = node.attr( 'style' );
		if ( style ) node.attr( 'style', css( style ) );
	} );
	$( 'style' ).each( ( _, element ) => { const node = $( element ); node.text( css( node.text() ) ); } );
	return $.html();
}
