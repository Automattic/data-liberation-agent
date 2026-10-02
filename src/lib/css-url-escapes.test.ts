import { describe, expect, it } from 'vitest';
import { decodeCssUrl, normalizeCssUrlEscapes } from './css-url-escapes.js';

describe( 'CSS URL spelling', () => {
	it( 'decodes punctuation and hexadecimal escapes using CSS token semantics', () => {
		expect( decodeCssUrl( String.raw`https\:\/\/cdn.example\/photo.png` ) ).toBe( 'https://cdn.example/photo.png' );
		expect( decodeCssUrl( String.raw`\68 ttps\3a \/\/cdn.example/pic\20 name.png` ) ).toBe( 'https://cdn.example/pic name.png' );
		expect( decodeCssUrl( '\\0 \\110000 \\d800 ' ) ).toBe( '\ufffd\ufffd\ufffd' );
		expect( decodeCssUrl( 'a\\\nb' ) ).toBe( 'ab' );
	} );
	it( 'canonicalizes URL tokens without changing selector or content escapes', () => {
		const input = String.raw`.x\:hover{background:url(https\:\/\/cdn.example\/photo.png);content:"\41";filter:url("#local")}@import 'https\3a //cdn.example/base.css' screen;`;
		const output = normalizeCssUrlEscapes( input );
		expect( output ).toContain( 'url("https://cdn.example/photo.png")' );
		expect( output ).toContain( '@import "https://cdn.example/base.css" screen;' );
		expect( output ).toContain( String.raw`.x\:hover` );
		expect( output ).toContain( String.raw`content:"\41"` );
		expect( output ).toContain( 'url("#local")' );
		expect( normalizeCssUrlEscapes( output ) ).toBe( output );
		expect( normalizeCssUrlEscapes( 'background:url("https://cdn.example/a\\\nb.png")' ) ).toBe( 'background:url("https://cdn.example/ab.png")' );
	} );
} );
