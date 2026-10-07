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
			: replaceUrl( value );
		const valueStart = match[ 0 ].indexOf( match[ 2 ] ) + 1;
		result += match[ 0 ].slice( 0, valueStart ) + replaced + match[ 2 ];
		offset = match.index + match[ 0 ].length;
	}
	return result + replaceOther( content.slice( offset ) );
}
