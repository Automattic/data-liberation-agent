import * as cheerio from 'cheerio';
import { expect, it } from 'vitest';
import { resolveDocumentReferences } from './document-resource-base.js';

it( 'resolves inline CSS and srcsets against the rendered base while preserving non-network references', () => {
	const html = `<style>@import 'theme.css';.tile{background:url(images/tile.svg)}.paint{fill:url(#paint)}</style>
		<img src="images/thumb.svg" srcset="images/small.svg 1x, images/large.svg 2x" style="background:url('images/inline.svg')">
		<a href="next?view=grid#photos">Next</a><a id="fragment" href="#photos">Photos</a>
		<a id="mail" href="mailto:photos@example.com">Mail</a><img id="data" src="data:image/svg+xml,hello">`;
	const $ = cheerio.load( resolveDocumentReferences( html, 'https://example.com/albums/', 'https://example.com/albums/' ) );
	expect( $( 'img' ).first().attr( 'srcset' ) ).toBe( 'https://example.com/albums/images/small.svg 1x, https://example.com/albums/images/large.svg 2x' );
	expect( $( 'img' ).first().attr( 'style' ) ).toContain( 'https://example.com/albums/images/inline.svg' );
	expect( $( 'style' ).text() ).toContain( '@import "https://example.com/albums/theme.css"' );
	expect( $( 'style' ).text() ).toContain( 'url("https://example.com/albums/images/tile.svg")' );
	expect( $( 'style' ).text() ).toContain( 'fill:url(#paint)' );
	expect( $( 'a' ).first().attr( 'href' ) ).toBe( 'https://example.com/albums/next?view=grid#photos' );
	expect( $( '#fragment' ).attr( 'href' ) ).toBe( '#photos' );
	expect( $( '#mail' ).attr( 'href' ) ).toBe( 'mailto:photos@example.com' );
	expect( $( '#data' ).attr( 'src' ) ).toBe( 'data:image/svg+xml,hello' );
} );

it( 'uses the first authored base for captures without browser metadata, including fragment links', () => {
	const $ = cheerio.load( resolveDocumentReferences(
		'<base href="../assets/"><base href="/ignored/"><img src="photo.svg"><a href="#photos">Photos</a>',
		'https://example.com/albums/'
	) );
	expect( $( 'img' ).attr( 'src' ) ).toBe( 'https://example.com/assets/photo.svg' );
	expect( $( 'a' ).attr( 'href' ) ).toBe( 'https://example.com/assets/#photos' );
} );
