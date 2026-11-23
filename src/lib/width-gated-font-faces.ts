import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathWithin } from './portable-assets.js';

/**
 * Face sets a document reaches only under a width media: the stylesheet a
 * non-default document (phone, middle range) loaded with other bytes than the
 * default document — a font service hands a phone identity other face
 * binaries under the same family names — imported as `@import url(…) <media>`.
 *
 * A media-gated import is only conditional for a browser loading that
 * document. A consumer that hoists every `@font-face` to one global set (a
 * WordPress theme registers each face it finds) drops the gate, and two faces
 * with the same family and descriptors then resolve by declaration order: one
 * identity's binaries win at every width. Selection must not depend on the
 * gate or on order. Each gated face therefore declares its own `font-stretch`
 * and the import's media requests that stretch from the root: under the media
 * the gated face is the exact match, elsewhere the default face is. Its file
 * url is qualified so a consumer that registers faces by file keeps the gated
 * face with its stylesheet instead of merging it into the unconditional set.
 *
 * Runs on the private generation after resources are localized; only local
 * stylesheets and faces with a local `src` and no authored `font-stretch` move.
 */
export const WIDTH_GATED_FACE_QUERY = 'blocks-engine-capture-width-gated';
const FIRST_GATED_STRETCH = 101;
const MAX_GATED_FACE_SETS = 16;

/** An `@import url("…") media;` style the responsive assembly emits for a variant stylesheet. */
const GATED_IMPORT_STYLE = /(<style\b[^>]*>)(\s*@import url\(("(?:[^"\\]|\\.)*")\) ([^;<{}]+);\s*)(<\/style>)/gi;

export interface WidthGatedFontFaceResult {
	/** Website-relative stylesheet paths whose faces were made width-selectable. */
	stylesheets: string[];
}

export function projectWidthGatedFontFaces( websiteDir: string, htmlPaths: readonly string[] ): WidthGatedFontFaceResult {
	// One stretch per stylesheet: a mobile and a middle face set both hoisted
	// globally stay distinct, and a sheet shared by many routes is rewritten once.
	const stretches = new Map< string, number | undefined >();
	const stretchFor = ( href: string ): number | undefined => {
		if ( stretches.has( href ) ) return stretches.get( href );
		let stretch: number | undefined;
		const path = localStylesheetPath( websiteDir, href );
		const allocated = [ ...stretches.values() ].filter( value => value !== undefined ).length;
		if ( path && allocated < MAX_GATED_FACE_SETS ) {
			const css = readFileSync( path, 'utf8' );
			const candidate = FIRST_GATED_STRETCH + allocated;
			const projected = withGatedFaceStretch( css, candidate );
			if ( projected !== undefined ) {
				writeFileSync( path, projected );
				stretch = candidate;
			}
		}
		stretches.set( href, stretch );
		return stretch;
	};
	for ( const htmlPath of htmlPaths ) {
		const html = readFileSync( htmlPath, 'utf8' );
		const projected = html.replace( GATED_IMPORT_STYLE, ( match, open: string, rule: string, quoted: string, media: string, close: string ) => {
			let href: string;
			try { href = JSON.parse( quoted ); } catch { return match; }
			const stretch = stretchFor( href );
			if ( stretch === undefined ) return match;
			return `${ open }${ rule }@media ${ media.trim() }{:root{font-stretch:${ stretch }%}}${ close }`;
		} );
		if ( projected !== html ) writeFileSync( htmlPath, projected );
	}
	return { stylesheets: [ ...stretches ].flatMap( ( [ href, stretch ] ) => stretch === undefined ? [] : [ href ] ) };
}

function localStylesheetPath( websiteDir: string, href: string ): string | undefined {
	if ( ! href.startsWith( '/' ) || href.startsWith( '//' ) ) return undefined;
	let pathname: string;
	try { pathname = decodeURIComponent( new URL( href, 'https://portable.invalid/' ).pathname ); } catch { return undefined; }
	if ( ! /\.css$/i.test( pathname ) ) return undefined;
	const path = resolve( websiteDir, `.${ pathname }` );
	return pathWithin( websiteDir, path ) && existsSync( path ) ? path : undefined;
}

/**
 * The stylesheet with each eligible face declaring `stretch` and its local
 * file url qualified, or `undefined` when no face is eligible.
 */
export function withGatedFaceStretch( css: string, stretch: number ): string | undefined {
	let changed = false;
	const projected = css.replace( /@font-face\s*\{([^{}]*)\}/gi, ( rule, body: string ) => {
		if ( /(?:^|[;\s])font-stretch\s*:/i.test( body ) ) return rule;
		let qualified = false;
		const declarations = body.replace( /(^|[;\s])(src\s*:)([^;]*)/i, ( _match, prefix: string, name: string, value: string ) =>
			prefix + name + value.replace( /url\(\s*(["']?)([^"')]+)\1\s*\)/gi, ( url, quote: string, target: string ) => {
				if ( /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test( target ) ) return url;
				qualified = true;
				const [ path, fragment ] = target.split( '#', 2 );
				const query = `${ path.includes( '?' ) ? '&' : '?' }${ WIDTH_GATED_FACE_QUERY }`;
				return `url(${ quote }${ path }${ query }${ fragment === undefined ? '' : `#${ fragment }` }${ quote })`;
			} )
		);
		if ( ! qualified ) return rule;
		changed = true;
		const trimmed = declarations.replace( /\s*;?\s*$/, '' );
		return `@font-face {${ trimmed };\n  font-stretch: ${ stretch }%;\n}`;
	} );
	return changed ? projected : undefined;
}
