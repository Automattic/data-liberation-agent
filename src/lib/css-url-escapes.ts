/** Decode CSS escapes in a URL token, leaving selectors and other CSS strings untouched. */
export function decodeCssUrl( value: string ): string {
	return value.replace( /\\(?:([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?|(\r\n|[\n\f\r])|([^\n\f\r]))/gi, ( _match, hex: string | undefined, newline: string | undefined, escaped: string | undefined ) => {
		if ( hex ) { const point = Number.parseInt( hex, 16 ); return String.fromCodePoint( point === 0 || point > 0x10ffff || ( point >= 0xd800 && point <= 0xdfff ) ? 0xfffd : point ); }
		return newline ? '' : escaped ?? '';
	} );
}

/** Canonical URL spelling lets dependency acquisition and export use the same keys. */
export function normalizeCssUrlEscapes( css: string ): string {
	return css.replace( /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:\\.|[^\s)'";])+))\s*\)|@import\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/gis,
		( match, ...groups: Array<string | undefined> ) => {
			const value = groups.slice( 0, 5 ).find( value => value !== undefined )!;
			const decoded = decodeCssUrl( value );
			if ( decoded === value ) return match;
			const quoted = `"${ decoded.replace( /\\/g, '\\\\' ).replace( /"/g, '\\"' ).replace( /\n/g, '\\a ' ).replace( /\r/g, '\\d ' ).replace( /\f/g, '\\c ' ) }"`;
			return /^@import/i.test( match ) ? `@import ${ quoted }` : `url(${ quoted })`;
		} );
}
