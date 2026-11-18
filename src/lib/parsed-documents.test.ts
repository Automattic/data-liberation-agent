import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { ownDocument, readDocument, releaseDocument, serializedDocument, withParsedDocuments } from './parsed-documents.js';
import { removeDanglingResourceReference } from './portable-references.js';

// Parser corner cases a copied tree must keep: doctype identifiers, quirks
// mode, template content, foreign-content namespaces and attribute prefixes,
// raw text, a <pre> leading newline and foster-parented table text.
const HTML = '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><html lang="en"><head><title>A &amp; B</title>' +
	'<style>a>b{color:red}</style><script>if (a < b) {}</script></head><body class="x">' +
	'<template><p>t<b>x</b></p></template><svg viewBox="0 0 1 1"><use xlink:href="#i"></use><foreignObject><p>f</p></foreignObject></svg>' +
	'<math><mi>x</mi></math><pre>\n\nkeep</pre><table>stray<tr><td>c</td></tr></table><textarea>\nt</textarea><p>unclosed<p>next</body></html>';

describe( 'parsed documents', () => {
	it( 'parses afresh outside a scope', () => {
		expect( readDocument( HTML ) ).not.toBe( readDocument( HTML ) );
		expect( ownDocument( HTML ).html() ).toBe( cheerio.load( HTML ).html() );
	} );

	it( 'shares one tree per identical string within a scope and releases it after', () => {
		const shared = withParsedDocuments( () => {
			const $ = readDocument( HTML );
			expect( readDocument( `${ HTML }` ) ).toBe( $ );
			return $;
		} );
		expect( withParsedDocuments( () => readDocument( HTML ) ) ).not.toBe( shared );
	} );

	it( 'gives owners a copy a fresh parse cannot be told apart from, leaving readers untouched', () => {
		withParsedDocuments( () => {
			const shared = readDocument( HTML );
			const owned = ownDocument( HTML );
			expect( owned ).not.toBe( shared );
			expect( owned.html() ).toBe( cheerio.load( HTML ).html() );
			expect( owned( 'template' ).html() ).toBe( cheerio.load( HTML )( 'template' ).html() );
			owned( 'body' ).empty();
			expect( readDocument( HTML ) ).toBe( shared );
			expect( shared.html() ).toBe( cheerio.load( HTML ).html() );
		} );
	} );

	it( 'hands a released tree to its reader alone', () => {
		withParsedDocuments( () => {
			const $ = readDocument( HTML );
			expect( serializedDocument( HTML, $ ) ).toBe( $.html() );
			releaseDocument( HTML, $ );
			$( 'body' ).empty();
			expect( readDocument( HTML ) ).not.toBe( $ );
			expect( readDocument( HTML ).html() ).toBe( cheerio.load( HTML ).html() );
		} );
	} );

	it( 'keeps reference removal identical whether or not it matches', () => {
		const html = '<html><head><link rel="stylesheet" href="/a.css?x=1&amp;y=2"><script src="/b.js"></script></head><body><pre>\n\nx</pre></body></html>';
		const plain = [ '/a.css?x=1&y=2', '/b.js', '/missing.css' ].map( reference => removeDanglingResourceReference( html, reference ) );
		const scoped = withParsedDocuments( () => [ '/a.css?x=1&y=2', '/b.js', '/missing.css' ].map( reference => removeDanglingResourceReference( html, reference ) ) );
		expect( scoped ).toEqual( plain );
		expect( plain[ 0 ] ).not.toContain( 'a.css' );
		expect( plain[ 1 ] ).not.toContain( 'b.js' );
		expect( plain[ 2 ] ).toBe( cheerio.load( html ).html() );
	} );
} );
