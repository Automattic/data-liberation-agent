import * as cheerio from 'cheerio';
import { rewriteSrcset } from '../../lib/srcset.js';
import type { LiberationHooks } from '../page-actions.js';
import { wixDeclaredImageSource } from './image-geometry.js';

/** Server declarations own member identity; only that member's light render
 * owns its runtime geometry. Repeated identities pair in occurrence order.
 * An image the render never hydrated (no `src`, no `srcset`: an off-screen
 * carousel slide) takes its sized declared source, as capture's
 * `normalizeWixImageSources` gives it; an unsized declaration still declines. */
export const rewriteWixDerivedMedia: NonNullable<LiberationHooks['rewriteDerivedMedia']> = input => {
	const member = cheerio.load( input.memberServerHtml );
	const derived = cheerio.load( input.derivedHtml );
	const selector = 'wow-image[data-image-info]';
	const members = member( selector ).toArray();
	const targets = derived( selector ).toArray();
	if ( members.length !== targets.length ) return undefined;
	if ( ! members.length ) return input.derivedHtml;
	if ( ! input.memberRenderedHtml ) return undefined;
	const rendered = cheerio.load( input.memberRenderedHtml );
	const uriOf = ( value: string | undefined ): string | undefined => {
		try {
			const uri: unknown = JSON.parse( value ?? '' )?.imageData?.uri;
			return typeof uri === 'string' && /^[a-zA-Z0-9_~.-]+$/.test( uri ) ? uri : undefined;
		} catch { return undefined; }
	};
	const sources = new Map<string, ReturnType<typeof rendered>[]>();
	for ( const node of rendered( selector ).toArray() ) {
		const wrapper = rendered( node );
		const uri = uriOf( wrapper.attr( 'data-image-info' ) );
		if ( ! uri ) return undefined;
		const list = sources.get( uri ) ?? [];
		list.push( wrapper );
		sources.set( uri, list );
	}
	for ( let i = 0; i < members.length; i++ ) {
		const uri = uriOf( member( members[ i ]! ).attr( 'data-image-info' ) );
		if ( ! uri ) return undefined;
		const wrapper = sources.get( uri )?.shift();
		const source = wrapper?.find( 'img' );
		const target = derived( targets[ i ]! ).find( 'img' );
		if ( ! wrapper || source?.length !== 1 || target.length !== 1 ) return undefined;
		if ( source.attr( 'src' ) === undefined && source.attr( 'srcset' ) === undefined ) {
			const declared = wixDeclaredImageSource( wrapper.attr( 'data-image-info' ) ?? '' );
			if ( declared?.width && declared.height ) source.attr( 'src', declared.src );
		}
		for ( const attribute of [ 'src', 'srcset' ] ) {
			const value = source.attr( attribute );
			if ( ! value ) {
				if ( attribute === 'src' ) return undefined;
				target.removeAttr( attribute );
				continue;
			}
			let invalid = false;
			const validate = ( url: string ): string => {
				const match = /^https:\/\/static\.wixstatic\.com\/media\/([^/]+)\/v1\/(?:crop\/[^/?#\s]+\/)?(?:fill|fit)\/[^/?#\s]+\/[^/?#\s]+$/.exec( url );
				if ( ! match || match[ 1 ] !== uri || /\bblur_\d+/.test( url ) ) invalid = true;
				return url;
			};
			if ( attribute === 'srcset' ) rewriteSrcset( value, validate );
			else validate( value );
			if ( invalid ) return undefined;
			target.attr( attribute, value );
		}
	}
	return derived.html();
};
