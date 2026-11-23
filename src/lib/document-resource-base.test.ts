import * as cheerio from 'cheerio';
import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDocumentReferences } from './document-resource-base.js';
import { capturedDocumentReferences } from './capture-export-collection.js';

it( 'resolves inline CSS and srcsets against the rendered base while preserving non-network references', () => {
	const html = `<style>@import 'theme.css';.tile{background:url(images/tile.svg)}.paint{fill:url(#paint)}</style>
		<img src="images/thumb.svg" srcset="images/small.svg 1x, images/large.svg 2x" style="background:url('images/inline.svg')">
		<a href="next?view=grid#photos">Next</a><a id="fragment" href="#photos">Photos</a>
		<a id="mail" href="mailto:photos@example.com">Mail</a><img id="data" src="data:image/svg+xml,hello">
		<a id="external" href="https://example.org">External</a>`;
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
	// An absolute reference has nothing to resolve; URL#href would append a slash.
	expect( $( '#external' ).attr( 'href' ) ).toBe( 'https://example.org' );
} );

it( 'uses the first authored base for captures without browser metadata, including fragment links', () => {
	const $ = cheerio.load( resolveDocumentReferences(
		'<base href="../assets/"><base href="/ignored/"><img src="photo.svg"><a href="#photos">Photos</a>',
		'https://example.com/albums/'
	) );
	expect( $( 'img' ).attr( 'src' ) ).toBe( 'https://example.com/assets/photo.svg' );
	expect( $( 'a' ).attr( 'href' ) ).toBe( 'https://example.com/assets/#photos' );
} );

it( 'keeps SVG fragment references in this document when a base names another URL', () => {
	const $ = cheerio.load( resolveDocumentReferences(
		'<base href="https://example.com/"><svg><symbol id="icon"></symbol></svg><svg><use xlink:href="#icon"></use><use href="#icon"></use></svg><a href="#icon">Icon</a>',
		'https://example.com/about/'
	) );
	expect( $( 'use' ).map( ( _, use ) => $( use ).attr( 'xlink:href' ) ?? $( use ).attr( 'href' ) ).get() ).toEqual( [ '#icon', '#icon' ] );
	expect( $( 'a' ).attr( 'href' ) ).toBe( 'https://example.com/#icon' );
} );

it( 'keeps a fragment link on this route when the captured base document lacks its target (#2229)', () => {
	// ChatGPT Sites: <base href="/"> on /about/; the router scrolls to #be-why on /about/.
	mkdirSync( join( process.cwd(), '.tmp-test' ), { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'fragment-base-' ) );
	try {
		mkdirSync( join( outputDir, 'html' ) );
		writeFileSync( join( outputDir, 'html', 'homepage.html' ), '<main id="main"><section id="hero"></section></main>' );
		const references = capturedDocumentReferences( {
			'https://example.com/': { slug: 'homepage', html: 'html/homepage.html' },
		} as unknown as Parameters< typeof capturedDocumentReferences >[ 0 ], outputDir );
		const $ = cheerio.load( resolveDocumentReferences(
			'<base href="/"><a id="skip" href="#main">Skip</a><main id="main"><a id="why" href="#be-why">Why</a><section id="be-why"></section>' +
			'<a id="legacy" href="#old">Old</a><a name="old"></a><a id="hero-link" href="#hero">Hero</a><a id="missing" href="#nowhere">Nowhere</a></main>',
			'https://example.com/about/',
			'https://example.com/',
			references
		) );
		expect( $( '#why' ).attr( 'href' ) ).toBe( '#be-why' );
		expect( $( '#legacy' ).attr( 'href' ) ).toBe( '#old' );
		// The base document declares these: a browser's destination stays valid.
		expect( $( '#skip' ).attr( 'href' ) ).toBe( 'https://example.com/#main' );
		expect( $( '#hero-link' ).attr( 'href' ) ).toBe( 'https://example.com/#hero' );
		// No target here: nothing to keep local.
		expect( $( '#missing' ).attr( 'href' ) ).toBe( 'https://example.com/#nowhere' );
		// An uncaptured base document is not evidence; browser semantics stay.
		const uncaptured = cheerio.load( resolveDocumentReferences(
			'<base href="/assets/"><a href="#be-why">Why</a><section id="be-why"></section>',
			'https://example.com/about/',
			undefined,
			references
		) );
		expect( uncaptured( 'a' ).attr( 'href' ) ).toBe( 'https://example.com/assets/#be-why' );
	} finally {
		rmSync( outputDir, { recursive: true, force: true } );
	}
} );
