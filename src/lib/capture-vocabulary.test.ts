import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { afterEach, describe, expect, it } from 'vitest';
import { exportWebsiteCapture } from './capture-export.js';
import { mirrorCaptureVocabulary, neutralCaptureName } from './capture-vocabulary.js';

const dirs: string[] = [];
afterEach( () => {
	for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } );
} );

/** Every producer attribute and class token in `html`, paired with its neutral counterpart. */
function vocabularyPairs( html: string ) {
	const $ = cheerio.load( html, { scriptingEnabled: false } );
	const attributes: Array< { producer: string; neutral: string; value: string; mirrored: string | undefined } > = [];
	const classes: Array< { producer: string; neutral: string; present: boolean } > = [];
	$( '*' ).each( ( _index, node ) => {
		const element = $( node );
		for ( const [ name, value ] of Object.entries( ( node as Element ).attribs ) ) {
			const neutral = neutralCaptureName( name, 'attribute' );
			if ( neutral ) attributes.push( { producer: name, neutral, value, mirrored: element.attr( neutral ) } );
		}
		for ( const token of ( element.attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean ) ) {
			const neutral = neutralCaptureName( token, 'class' );
			if ( neutral ) classes.push( { producer: token, neutral, present: element.hasClass( neutral ) } );
		}
	} );
	return { attributes, classes };
}

function htmlFiles( dir: string ): string[] {
	return readdirSync( dir, { withFileTypes: true } ).flatMap( entry =>
		entry.isDirectory() ? htmlFiles( join( dir, entry.name ) ) : entry.name.endsWith( '.html' ) ? [ join( dir, entry.name ) ] : [] );
}

describe( 'neutral capture vocabulary', () => {
	it( 'maps producer names onto the Blocks Engine capture namespace by one lexical rule', () => {
		expect( neutralCaptureName( 'data-dla-dialog-trigger', 'attribute' ) ).toBe( 'data-blocks-engine-capture-dialog-trigger' );
		expect( neutralCaptureName( 'data-liberation-mobile-document', 'attribute' ) ).toBe( 'data-blocks-engine-capture-mobile-document' );
		expect( neutralCaptureName( 'data-liberation-mobile-document', 'class' ) ).toBe( 'data-blocks-engine-capture-mobile-document' );
		expect( neutralCaptureName( 'dla-dialog', 'class' ) ).toBe( 'blocks-engine-capture-dialog' );
		// Class tokens are case-sensitive; attribute names are not.
		expect( neutralCaptureName( 'dla-page-About', 'class' ) ).toBe( 'blocks-engine-capture-page-About' );
		expect( neutralCaptureName( 'DLA-page', 'class' ) ).toBeUndefined();
		expect( neutralCaptureName( 'DATA-DLA-Dialog-Panel', 'attribute' ) ).toBe( 'data-blocks-engine-capture-dialog-panel' );
		// `dla-` is a class rule only, and a bare prefix names nothing.
		expect( neutralCaptureName( 'dla-dialog', 'attribute' ) ).toBeUndefined();
		expect( neutralCaptureName( 'data-dla-', 'attribute' ) ).toBeUndefined();
		expect( neutralCaptureName( 'data-liberation', 'attribute' ) ).toBeUndefined();
		expect( neutralCaptureName( 'data-blocks-engine-capture-dialog-trigger', 'attribute' ) ).toBeUndefined();
		expect( neutralCaptureName( 'aria-dla-x', 'attribute' ) ).toBeUndefined();
	} );

	it( 'splices the neutral attribute after its producer attribute and keeps every other byte', () => {
		const html = `<!doctype html>\n<html data-dla-selected-document="mobile"><head><style>.dla-dialog{display:none}[data-dla-x]{}</style></head>`
			+ `<body><a href="#" DATA-DLA-DIALOG-TRIGGER='menu' data-dla-anchor-unresolved title="t">Open</a>`
			+ `<img src="a.png" data-dla-glyph-color=#1877f2 alt="">`
			+ `<div data-dla-collection-members="[&quot;a&quot;,&quot;b&quot;]" data-dla-status-template="{count} &amp; more"></div>`
			+ `<template><span data-dla-gallery-slot="1"></span></template>`
			+ `<script>document.querySelector('[data-dla-dialog-panel]')</script></body></html>`;
		const mirrored = mirrorCaptureVocabulary( html );
		expect( mirrored ).toBe(
			`<!doctype html>\n<html data-dla-selected-document="mobile" data-blocks-engine-capture-selected-document="mobile"><head><style>.dla-dialog{display:none}[data-dla-x]{}</style></head>`
			+ `<body><a href="#" DATA-DLA-DIALOG-TRIGGER='menu' data-blocks-engine-capture-dialog-trigger='menu' data-dla-anchor-unresolved data-blocks-engine-capture-anchor-unresolved title="t">Open</a>`
			+ `<img src="a.png" data-dla-glyph-color=#1877f2 data-blocks-engine-capture-glyph-color=#1877f2 alt="">`
			+ `<div data-dla-collection-members="[&quot;a&quot;,&quot;b&quot;]" data-blocks-engine-capture-collection-members="[&quot;a&quot;,&quot;b&quot;]" data-dla-status-template="{count} &amp; more" data-blocks-engine-capture-status-template="{count} &amp; more"></div>`
			+ `<template><span data-dla-gallery-slot="1" data-blocks-engine-capture-gallery-slot="1"></span></template>`
			+ `<script>document.querySelector('[data-dla-dialog-panel]')</script></body></html>`
		);
	} );

	it( 'appends neutral class tokens to the same class value', () => {
		expect( mirrorCaptureVocabulary( '<div class="menu dla-dialog dla-dropdown" id="m"></div>' ) )
			.toBe( '<div class="menu dla-dialog dla-dropdown blocks-engine-capture-dialog blocks-engine-capture-dropdown" id="m"></div>' );
		expect( mirrorCaptureVocabulary( `<div class='data-liberation-mobile-document'></div>` ) )
			.toBe( `<div class='data-liberation-mobile-document data-blocks-engine-capture-mobile-document'></div>` );
		expect( mirrorCaptureVocabulary( '<details class=dla-disclosure open></details>' ) )
			.toBe( '<details class="dla-disclosure blocks-engine-capture-disclosure" open></details>' );
	} );

	it( 'is idempotent and leaves markup without producer names untouched', () => {
		const html = '<div data-dla-dialog-panel="p" class="dla-dialog"><p class="dla">x</p></div>';
		const once = mirrorCaptureVocabulary( html );
		expect( mirrorCaptureVocabulary( once ) ).toBe( once );
		const plain = '<html><body class="dlax"><p data-dlax="1">no names</p></body></html>';
		expect( mirrorCaptureVocabulary( plain ) ).toBe( plain );
		// A selector string is text, not markup.
		expect( mirrorCaptureVocabulary( '[data-dla-dialog-trigger="menu"] > .dla-dialog' ) ).toBe( '[data-dla-dialog-trigger="menu"] > .dla-dialog' );
	} );

	it( 'writes both names with identical values into every exported HTML document and the interaction states', () => {
		const outputDir = mkdtempSync( join( tmpdir(), 'dla-capture-vocabulary-' ) );
		dirs.push( outputDir );
		for ( const path of [ 'html', 'screenshots' ] ) mkdirSync( join( outputDir, path ), { recursive: true } );
		const source = 'https://example.com/';
		// Capture-time evidence as capture serializes it: device documents and
		// their scope, a collection with its status template, a gallery, a
		// rendered glyph colour. Export wires the dialog and listbox below.
		const page = '<!doctype html><html><head><title>Home</title></head><body>'
			+ '<div class="data-liberation-mobile-document" data-dla-device-document="mobile" data-dla-document-scope="">'
			+ '<header><button id="open" aria-haspopup="dialog">Menu</button><button id="sort" aria-haspopup="listbox">Sort</button></header>'
			+ '<a href="https://social.example/brand"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Brand" data-dla-glyph-color="#1877f2"></a>'
			+ '<section data-dla-collection="c1" data-dla-collection-category="0" data-dla-collection-mode="category">'
			+ '<article data-dla-collection-item="one" data-dla-collection-members="[0]">One</article>'
			+ '<p data-dla-collection-status="c1" data-dla-status-hide-zero="true"><span data-dla-status-template="{count} results">2 results</span></p>'
			+ '</section>'
			+ '<div data-dla-gallery="g1" data-dla-gallery-direction="horizontal" data-dla-gallery-index="0"><img data-dla-gallery-slot="0" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""></div>'
			+ '</div></body></html>';
		writeFileSync( join( outputDir, 'html', 'homepage.html' ), page );
		const panel = '<div id="panel" role="dialog" data-dla-native-node="n1"><a href="/about">About</a></div>';
		const listbox = '<ul id="sort-options" role="listbox"><li role="option">Newest</li></ul>';
		writeFileSync( join( outputDir, 'screenshots', 'manifest.json' ), JSON.stringify( { version: 1, entries: { [ source ]: {
			html: 'html/homepage.html',
			interactions: {
				schema: 'data-liberation/interaction-states/v2', sourceUrl: source,
				viewport: { width: 1440, height: 900 }, capturedAt: '2026-10-10T00:00:00.000Z',
				states: [
					{ status: 'captured', trigger: { selector: '#open', tag: 'button', id: 'open', ariaHaspopup: 'dialog', dataBindings: {} },
						dialog: { selector: '#panel', tag: 'div', id: 'panel', role: 'dialog', ariaModal: true, html: panel, htmlBytes: Buffer.byteLength( panel ), htmlTruncated: false } },
					{ status: 'captured', trigger: { selector: '#sort', tag: 'button', id: 'sort', ariaHaspopup: 'listbox', dataBindings: {} },
						dialog: { selector: '#sort-options', tag: 'ul', id: 'sort-options', role: 'listbox', ariaModal: false, html: listbox, htmlBytes: Buffer.byteLength( listbox ), htmlTruncated: false } },
				],
				initialDialogs: [],
			},
		} } } ) );
		exportWebsiteCapture( { outputDir, sourceUrl: source, platform: 'generic', summary: {}, failures: [] } );

		const producerNames = new Set< string >();
		for ( const file of htmlFiles( join( outputDir, 'website' ) ) ) {
			const { attributes, classes } = vocabularyPairs( readFileSync( file, 'utf8' ) );
			for ( const pair of attributes ) {
				producerNames.add( pair.producer );
				expect( pair.mirrored, `${ file }: ${ pair.producer }` ).toBe( pair.value );
			}
			for ( const pair of classes ) {
				producerNames.add( `.${ pair.producer }` );
				expect( pair.present, `${ file }: .${ pair.producer }` ).toBe( true );
			}
		}
		// The fixture reaches every family Blocks Engine and Static Site Importer read.
		expect( [ ...producerNames ] ).toEqual( expect.arrayContaining( [
			'data-dla-dialog-trigger', 'data-dla-dialog-panel', 'data-dla-dialog-close', '.dla-dialog',
			'data-dla-listbox-trigger', 'data-dla-listbox-panel',
			'data-dla-device-document', 'data-dla-document-scope', '.data-liberation-mobile-document',
			'data-dla-collection', 'data-dla-collection-item', 'data-dla-collection-members', 'data-dla-collection-status',
			'data-dla-status-template', 'data-dla-status-hide-zero',
			'data-dla-gallery', 'data-dla-gallery-direction', 'data-dla-gallery-slot',
			'data-dla-glyph-color',
		] ) );

		const states = JSON.parse( readFileSync( join( outputDir, 'interaction-states.json' ), 'utf8' ) );
		const dialog = states.pages[ 0 ].states[ 0 ].dialog;
		expect( dialog.html ).toContain( 'data-dla-native-node="n1" data-blocks-engine-capture-native-node="n1"' );
		// Consumers reject a region whose declared length does not match.
		expect( dialog.htmlBytes ).toBe( Buffer.byteLength( dialog.html ) );
	} );
} );
