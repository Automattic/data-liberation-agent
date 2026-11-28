import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { mediaFamily } from './capture-export-collection.js';
import { parseSrcset } from './srcset.js';

export interface ImageRenditionDocument {
	viewport: number;
	html: string;
}

// Runtime-generated density lists describe the image's slot at only one
// viewport. Recover the slot's other captured renditions before localization
// so they participate in the ordinary dependency and budget accounting.
export function retainObservedImageRenditions(
	html: string,
	url: string,
	documents: readonly ImageRenditionDocument[],
	capturedWidths: ( url: string ) => number | undefined,
): string {
	const images = ( $: CheerioAPI ) => {
		const matches = new Map< string, { node: Element; src: string; candidates: ReturnType<typeof parseSrcset> } | null >();
		for ( const node of $( 'img[src][srcset]' ).toArray() ) {
			const image = $( node );
			if ( image.closest( 'picture' ).length || image.attr( 'sizes' ) ) continue;
			const resolve = ( value: string ) => URL.canParse( value, url ) ? new URL( value, url ).href : '';
			const src = resolve( image.attr( 'src' )! );
			if ( ! /^https?:/i.test( src ) ) continue;
			const family = mediaFamily( src );
			if ( family === src ) continue;
			const candidates = parseSrcset( image.attr( 'srcset' )! ).map( candidate => ( { ...candidate, url: resolve( candidate.url ) } ) );
			if ( ! candidates.some( candidate => candidate.size === 1 && candidate.url === src ) || candidates.some( candidate => ! candidate.density || ! /^https?:/i.test( candidate.url ) || mediaFamily( candidate.url ) !== family ) ) continue;
			const key = JSON.stringify( [ family, image.attr( 'alt' ) ?? '', image.attr( 'class' ) ?? '' ] );
			matches.set( key, matches.has( key ) ? null : { node, src, candidates } );
		}
		return matches;
	};
	const $ = cheerio.load( html );
	const baseline = images( $ );
	if ( ! [ ...baseline.values() ].some( Boolean ) ) return html;
	const observed = [ ...documents ].sort( ( a, b ) => a.viewport - b.viewport ).map( document => ( { viewport: document.viewport, images: images( cheerio.load( document.html ) ) } ) );
	let changed = false;
	for ( const [ key, image ] of baseline ) {
		if ( ! image ) continue;
		const fallbackWidth = capturedWidths( image.src );
		if ( ! fallbackWidth ) continue;
		const alternatives = new Map< number, string >( [ [ fallbackWidth, image.src ] ] );
		const sizes: string[] = [];
		for ( const sample of observed ) {
			const rendition = sample.images.get( key )?.src;
			if ( ! rendition || rendition === image.src || ! Number.isSafeInteger( sample.viewport ) || sample.viewport < 1 ) continue;
			const width = capturedWidths( rendition );
			if ( ! width || ( alternatives.has( width ) && alternatives.get( width ) !== rendition ) ) continue;
			alternatives.set( width, rendition );
			sizes.push( `(width: ${ sample.viewport }px) ${ width }px` );
		}
		if ( ! sizes.length ) continue;
		for ( const candidate of image.candidates ) {
			const width = capturedWidths( candidate.url );
			if ( width && ! alternatives.has( width ) ) alternatives.set( width, candidate.url );
		}
		$( image.node ).attr( {
			srcset: [ ...alternatives ].sort( ( a, b ) => a[ 0 ] - b[ 0 ] ).map( ( [ width, src ] ) => `${ src } ${ width }w` ).join( ', ' ),
			sizes: [ ...sizes, `${ fallbackWidth }px` ].join( ', ' ),
		} );
		changed = true;
	}
	return changed ? $.html() : html;
}
