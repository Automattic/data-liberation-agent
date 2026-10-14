export interface SrcsetCandidate {
	url: string;
	size: number;
	density: boolean;
}

interface SrcsetToken extends SrcsetCandidate {
	start: number;
	end: number;
	descriptors: string[];
}

/** HTML's srcset splitting/descriptor loop: commas inside a URL are not separators.
 * https://html.spec.whatwg.org/multipage/images.html#parsing-a-srcset-attribute
 */
function parseSrcset( value: string ): SrcsetToken[] {
	const candidates: SrcsetToken[] = [];
	const whitespace = ( character: string ) => /[\t\n\f\r ]/.test( character );
	let offset = 0;
	while ( offset < value.length ) {
		while ( offset < value.length && ( whitespace( value[ offset ] ) || value[ offset ] === ',' ) ) offset++;
		if ( offset >= value.length ) break;
		const start = offset;
		while ( offset < value.length && ! whitespace( value[ offset ] ) ) offset++;
		const url = value.slice( start, offset ).replace( /,+$/, '' );
		const end = start + url.length;
		const descriptors: string[] = [];
		// A trailing comma already ended a descriptorless candidate. In particular,
		// do not consume the next URL (or its internal commas) as this one's descriptor.
		if ( value[ offset - 1 ] !== ',' ) {
			let descriptor = '';
			let inParens = false;
			while ( offset < value.length ) {
				const character = value[ offset++ ];
				if ( character === ',' && ! inParens ) break;
				if ( whitespace( character ) && ! inParens ) {
					if ( descriptor ) descriptors.push( descriptor );
					descriptor = '';
				} else {
					descriptor += character;
					if ( character === '(' ) inParens = true;
					else if ( character === ')' ) inParens = false;
				}
			}
			if ( descriptor ) descriptors.push( descriptor );
		}
		if ( ! url ) continue;
		let width: number | undefined;
		let density: number | undefined;
		let height: number | undefined;
		let invalid = false;
		for ( const descriptor of descriptors ) {
			const number = Number( descriptor.slice( 0, -1 ) );
			if ( /^\d+w$/.test( descriptor ) && number > 0 && width === undefined && density === undefined ) width = number;
			else if ( /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?x$/.test( descriptor ) && number >= 0 && width === undefined && density === undefined && height === undefined ) density = number;
			else if ( /^\d+h$/.test( descriptor ) && number > 0 && height === undefined && density === undefined ) height = number;
			else invalid = true;
		}
		if ( height !== undefined && width === undefined ) invalid = true;
		if ( ! invalid ) candidates.push( { url, size: width ?? density ?? 1, density: density !== undefined, start, end, descriptors } );
	}
	return candidates;
}

export function srcsetCandidates( value: string ): SrcsetCandidate[] {
	return parseSrcset( value ).map( ( { url, size, density } ) => ( { url, size, density } ) );
}

export function srcsetReferences( value: string ): string[] {
	return srcsetCandidates( value ).map( ( candidate ) => candidate.url );
}

/** Replace complete candidate URL spans. Null filters a candidate; descriptors
 * and URL-internal commas keep the same meaning as in the browser parser. */
export function rewriteSrcset( value: string, replace: ( url: string ) => string | null ): string {
	const tokens = parseSrcset( value );
	const urls = tokens.map( token => replace( token.url ) );
	if ( urls.some( url => url === null ) ) {
		return tokens.flatMap( ( token, index ) => urls[ index ] === null ? [] : [ [ urls[ index ], ...token.descriptors ].join( ' ' ) ] ).join( ', ' );
	}
	let result = '';
	let offset = 0;
	for ( const [ index, token ] of tokens.entries() ) {
		result += value.slice( offset, token.start ) + urls[ index ];
		offset = token.end;
	}
	return result + value.slice( offset );
}

// Some lazy image runtimes put a descriptor-bearing list in src itself.
export function isSrcsetShaped( value: string ): boolean {
	return /\s+\d+(?:\.\d+)?[wx](?=\s*(?:,|$))/i.test( value );
}

export interface ImageSetSite {
	start: number;
	end: number;
	urls: string[];
}

/** One image-set() list (CSS or an HTML style context): the call's span and
 * each layer's URL token, in authored order. */
function splitImageSetLayers( value: string ): string[] {
	const tokens: string[] = [];
	let layer = '';
	let open = 0;
	let quote = '';
	for ( const character of value ) {
		if ( quote ) {
			layer += character;
			if ( character === quote ) quote = '';
			continue;
		}
		if ( character === '"' || character === "'" ) quote = character;
		else if ( character === '(' ) open++;
		else if ( character === ')' ) open--;
		if ( character === ',' && open === 0 ) {
			tokens.push( layer );
			layer = '';
			continue;
		}
		layer += character;
	}
	tokens.push( layer );
	return tokens;
}

/** A URL token (quoted, url()-wrapped, or bare) out of one image-set layer. */
function imageSetLayerUrl( layer: string ): string | undefined {
	const layerMatch = /^\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]+))\s*\)|([^\s,('"]+))/i.exec( layer );
	const url = layerMatch?.[ 1 ] ?? layerMatch?.[ 2 ] ?? layerMatch?.[ 3 ] ?? layerMatch?.[ 4 ] ?? layerMatch?.[ 5 ] ?? layerMatch?.[ 6 ];
	return url && ! /^(?:blob|data):/i.test( url ) ? url : undefined;
}

export function imageSetSites( content: string ): ImageSetSite[] {
	const sites: ImageSetSite[] = [];
	for ( const match of content.matchAll( /(?:-webkit-)?image-set\s*\(/gi ) ) {
		const openParen = match.index! + match[ 0 ].lastIndexOf( '(' );
		let depth = 0;
		let quote = '';
		let end = openParen;
		for ( let offset = openParen; offset < content.length; offset++ ) {
			const character = content[ offset ];
			if ( quote ) {
				if ( character === quote ) quote = '';
			} else if ( character === '"' || character === "'" ) quote = character;
			else if ( character === '(' ) depth++;
			else if ( character === ')' ) {
				depth--;
				if ( depth === 0 ) {
					end = offset;
					break;
				}
			}
		}
		if ( end === openParen ) continue;
		const urls = splitImageSetLayers( content.slice( openParen + 1, end ) )
			.map( imageSetLayerUrl )
			.filter( ( url ): url is string => url !== undefined );
		if ( urls.length >= 2 ) sites.push( { start: match.index!, end: end + 1, urls } );
	}
	return sites;
}

/** Remove image-set() layers whose URL passes `drop`, keeping the layers that
 * stay and the call's formatting. A call never becomes empty: with no layer
 * left, the call stays as written. */
export function stripImageSetCandidates( content: string, drop: ( url: string ) => boolean ): string {
	const sites = imageSetSites( content );
	if ( ! sites.length ) return content;
	let result = '';
	let offset = 0;
	for ( const site of sites ) {
		const call = content.slice( site.start, site.end );
		const openParen = call.indexOf( '(' );
		const layers = splitImageSetLayers( call.slice( openParen + 1, call.length - 1 ) );
		const layerUrls = layers.map( imageSetLayerUrl );
		const dropped = layerUrls.filter( url => url !== undefined && drop( url ) ).length;
		const present = layerUrls.filter( url => url !== undefined ).length;
		if ( dropped === 0 || dropped === present ) continue;
		const kept = layers.filter( ( _layer, index ) => layerUrls[ index ] === undefined || ! drop( layerUrls[ index ]! ) );
		result += `${ content.slice( offset, site.start ) }${ call.slice( 0, openParen + 1 ) }${ kept.join( ', ' ) })`;
		offset = site.end;
	}
	return result + content.slice( offset );
}

/** Protect media attribute URL tokens from a general HTML/CSS/script replacement
 * pass. The callback for other content retains the caller's own policy. */
export function rewriteMediaReferences(
	content: string,
	replaceUrl: ( url: string ) => string,
	replaceOther: ( content: string ) => string
): string {
	const attributes = /\s(srcset|data-srcset|src|poster|data-src|data-lazy-src|data-original|data-image|data-image-src)\s*=\s*(["'])([\s\S]*?)\2/gi;
	let result = '';
	let offset = 0;
	for ( const match of content.matchAll( attributes ) ) {
		result += replaceOther( content.slice( offset, match.index ) );
		const value = match[ 3 ];
		const replaced = /srcset$/i.test( match[ 1 ] ) || isSrcsetShaped( value )
			? rewriteSrcset( value, replaceUrl )
			// Browsers resolve a single URL after stripping its surrounding ASCII
			// whitespace. Replace only that token, preserving the authored padding.
			: value.replace( /^([\t\n\f\r ]*)([\s\S]*?)([\t\n\f\r ]*)$/, ( _, before, url, after ) => before + replaceUrl( url ) + after );
		const valueStart = match[ 0 ].indexOf( match[ 2 ] ) + 1;
		result += match[ 0 ].slice( 0, valueStart ) + replaced + match[ 2 ];
		offset = match.index + match[ 0 ].length;
	}
	return result + replaceOther( content.slice( offset ) );
}
