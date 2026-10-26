import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as cheerio from 'cheerio';
import { afterEach, describe, expect, it } from 'vitest';
import { exportWebsiteCapture } from './capture-export.js';
import {
	CAPTURE_EVIDENCE_FAMILIES, CAPTURE_EVIDENCE_NAMES, CAPTURE_EVIDENCE_PREFIX, CAPTURE_RUNTIME_SHA256, CAPTURE_SCHEMA_NAMESPACE, CAPTURE_SCHEMAS,
} from './capture-vocabulary.js';

const ROOT = join( import.meta.dirname, '..', '..' );
const dirs: string[] = [];
afterEach( () => {
	for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } );
} );

function files( dir: string, keep: ( path: string ) => boolean ): string[] {
	return readdirSync( dir, { withFileTypes: true } ).flatMap( entry => {
		const path = join( dir, entry.name );
		if ( entry.isDirectory() ) return entry.name === 'node_modules' || entry.name === 'dist' ? [] : files( path, keep );
		return keep( path ) ? [ path ] : [];
	} );
}

const escape = ( text: string ) => text.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );

// The previous producer-specific spellings, assembled so this file does not spell them.
const OLD = { dla: 'dla', liberation: [ 'data', 'liberation' ].join( '-' ) };
const OLD_NAMES = [
	new RegExp( `data-${ OLD.dla }-`, 'i' ),
	new RegExp( `${ OLD.liberation }-(?!agent)`, 'i' ),
	new RegExp( `${ OLD.liberation }/[\\w.-]+/v\\d`, 'i' ),
	new RegExp( `--${ OLD.dla }-`, 'i' ),
	new RegExp( `(?<![\\w$-])${ OLD.dla }-[a-z0-9$]` ),
	new RegExp( `\\b${ OLD.dla }/sticky\\b`, 'i' ),
	new RegExp( `dataset\\??\\.${ OLD.dla }[A-Z]` ),
];
const oldNameIn = ( text: string ) => OLD_NAMES.find( pattern => pattern.test( text ) );

const names = Object.values( CAPTURE_EVIDENCE_NAMES ).flatMap( family => Object.keys( family ) );
const familyHeads = Object.keys( CAPTURE_EVIDENCE_FAMILIES ).map( family => family.slice( 0, family.indexOf( '<' ) ) );

const sourceFiles = files( join( ROOT, 'src' ), path => path.endsWith( '.ts' ) && ! path.endsWith( '.test.ts' ) && ! path.endsWith( 'capture-vocabulary.ts' ) );

describe( 'capture evidence vocabulary', () => {
	it( 'is the one table of every name the source spells, and nothing else', () => {
		const spelled = new Set< string >();
		const dynamicHeads = new Set< string >();
		const literal = new RegExp( `${ escape( CAPTURE_EVIDENCE_PREFIX ) }([A-Za-z0-9-]*)(\\$\\{)?`, 'g' );
		for ( const file of sourceFiles ) {
			const text = readFileSync( file, 'utf8' );
			// `element.dataset.blocksEngineCaptureFooBar` is the attribute `data-blocks-engine-capture-foo-bar`.
			for ( const [ , camel ] of text.matchAll( /dataset\??\.blocksEngineCapture([A-Z]\w*)/g ) ) {
				spelled.add( camel.replace( /[A-Z]/g, letter => `-${ letter.toLowerCase() }` ).slice( 1 ) );
			}
			for ( const match of text.matchAll( literal ) ) {
				const [ , name, dynamic ] = match;
				if ( dynamic || name === '' || name.endsWith( '-' ) ) dynamicHeads.add( name );
				else spelled.add( name );
			}
		}
		// A spelled name is a listed name; a generated name is a listed family.
		expect( [ ...spelled ].filter( name => ! names.includes( name ) ).sort() ).toEqual( [] );
		expect( [ ...dynamicHeads ].filter( head => head !== '' && ! familyHeads.includes( head ) && ! names.some( name => `${ name }-` === head ) ).sort() ).toEqual( [] );
		// Every listed name is used.
		expect( names.filter( name => ! spelled.has( name ) ).sort() ).toEqual( [] );
		expect( new Set( names ).size ).toBe( names.length );
	} );

	it( 'lists every sidecar schema the source writes', () => {
		const pattern = new RegExp( `${ escape( CAPTURE_SCHEMA_NAMESPACE ) }([\\w.-]+/v\\d+)`, 'g' );
		const writers = [ ...sourceFiles, ...files( join( ROOT, 'scripts' ), path => path.endsWith( '.mjs' ) ) ];
		const spelled = new Set( writers.flatMap( file => [ ...readFileSync( file, 'utf8' ).matchAll( pattern ) ].map( match => match[ 1 ] ) ) );
		expect( [ ...spelled ].sort() ).toEqual( [ ...CAPTURE_SCHEMAS ].sort() );
	} );

	it( 'covers every name Blocks Engine publishes in its capture-evidence contract', () => {
		// Automattic/blocks-engine php-transformer docs/contracts/capture-evidence.md (Contract\CaptureEvidence).
		const published = [
			'document-scope', 'device-document', 'mobile-document', 'desktop-document', 'responsive-counterpart-<n>', 'responsive-source', 'source-media',
			'dialog-trigger', 'dialog-panel', 'dialog-close', 'dialog-panel-state', 'dialog-ancestor-state', 'dialog-ancestor-unverified', 'observed-placement',
			'dropdown', 'dialog', 'disclosure', 'disclosure-runtime', 'disclosure-label', 'disclosure-open-<svg attribute>', 'disclosure-closed-<svg attribute>',
			'local-disclosure', 'local-disclosure-runtime', 'exclusive-disclosures', 'disclosure-transition', 'listbox-trigger', 'listbox-panel',
			'gallery', 'gallery-sequence', 'gallery-slot', 'gallery-stage', 'gallery-initial', 'gallery-display', 'gallery-direction', 'gallery-index',
			'gallery-source', 'gallery-capture-width', 'gallery-runtime',
			'collection', 'collection-field', 'collection-category-control', 'collection-index', 'collection-empty', 'collection-item', 'collection-members',
			'collection-status', 'collection-runtime', 'collection-visibility', 'status-template', 'status-hide-zero', 'no-match', 'finite-probe',
			'choice-index', 'native-control-state', 'native-control-runtime', 'glyph-color', 'anchor-unresolved',
			// Static Site Importer reads these from the same namespace.
			'device-style', 'selected-document', 'member-login', 'device-selection', 'device-body', 'selected-viewport', 'document-unavailable',
		];
		const known = [ ...names, ...Object.keys( CAPTURE_EVIDENCE_FAMILIES ) ];
		expect( published.filter( name => ! known.includes( name ) ) ).toEqual( [] );
		for ( const schema of [ 'captured-interactions/v1', 'capture-receipt/v1', 'source-interactivity/v1', 'finite-bootstrap/v1', 'collection-status/v1' ] ) {
			expect( CAPTURE_SCHEMAS ).toContain( schema );
		}
		// Blocks Engine CaptureEvidence::DISCLOSURE_RUNTIME_SHA256.
		expect( CAPTURE_RUNTIME_SHA256.disclosure ).toBe( 'b545f43a77b79d075373048431101fe11d7ff8cdfe7987de6d7971512763d88f' );
	} );

	it( 'leaves no previous producer-specific name in source, scripts, skills or docs outside the migration note', () => {
		const migrationNote = join( ROOT, 'docs', 'contracts', 'capture-evidence.md' );
		const scanned = [
			...files( join( ROOT, 'src' ), path => /\.(?:ts|mjs|js|json|html|css)$/.test( path ) ),
			...files( join( ROOT, 'scripts' ), path => /\.(?:mjs|js|ts)$/.test( path ) ),
			...files( join( ROOT, 'skills' ), path => /\.(?:md|mjs|js)$/.test( path ) ),
			...files( join( ROOT, 'docs' ), path => path.endsWith( '.md' ) && path !== migrationNote ),
			...files( join( ROOT, 'test' ), path => /\.(?:ts|mjs|js|json|html)$/.test( path ) ),
			join( ROOT, 'README.md' ), join( ROOT, 'AGENTS.md' ),
		];
		const offenders = scanned.flatMap( file => {
			const text = readFileSync( file, 'utf8' );
			const pattern = oldNameIn( text );
			return pattern ? [ `${ relative( ROOT, file ) }: ${ pattern }` ] : [];
		} );
		expect( offenders ).toEqual( [] );
		// The migration note keeps the old spellings in one section only.
		const note = readFileSync( migrationNote, 'utf8' );
		const migration = note.slice( note.indexOf( '## Migration' ) );
		expect( note.indexOf( '## Migration' ) ).toBeGreaterThan( 0 );
		expect( oldNameIn( note.slice( 0, note.indexOf( '## Migration' ) ) ) ).toBeUndefined();
		expect( oldNameIn( migration ) ).toBeDefined();
	} );

	it( 'exports only the neutral names, and the recognized runtime bodies byte for byte', () => {
		const outputDir = mkdtempSync( join( tmpdir(), 'capture-vocabulary-' ) );
		dirs.push( outputDir );
		for ( const path of [ 'html', 'screenshots' ] ) mkdirSync( join( outputDir, path ), { recursive: true } );
		const source = 'https://example.com/';
		const p = CAPTURE_EVIDENCE_PREFIX;
		// Capture-time evidence as capture serializes it: a device document and its
		// scope, a collection with its status template, a rendered glyph colour.
		// Export wires the dialog, the listbox and the gallery from the states below.
		const page = '<!doctype html><html><head><title>Home</title></head><body>'
			+ `<div class="${ p }mobile-document" ${ p }device-document="mobile" ${ p }document-scope="">`
			+ '<header><button id="open" aria-haspopup="dialog">Menu</button><button id="sort" aria-haspopup="listbox">Sort</button></header>'
			+ `<a href="https://social.example/brand"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Brand" ${ p }glyph-color="#1877f2"></a>`
			+ `<section ${ p }collection="c1" ${ p }collection-category="0" ${ p }collection-mode="category">`
			+ `<article ${ p }collection-item="one" ${ p }collection-members="[0]">One</article>`
			+ `<p ${ p }collection-status="c1" ${ p }status-hide-zero="true"><span ${ p }status-template="{count} results">2 results</span></p>`
			+ '</section>'
			+ '<section id="carousel"><div id="stage"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""></div><button id="previous">Previous</button><button id="next">Next</button></section>'
			+ '</div></body></html>';
		writeFileSync( join( outputDir, 'html', 'homepage.html' ), page );
		const panel = `<div id="panel" role="dialog" ${ p }native-node="n1"><a href="/about">About</a></div>`;
		const listbox = '<ul id="sort-options" role="listbox"><li role="option">Newest</li></ul>';
		const frame = '<div><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="One"></div>';
		writeFileSync( join( outputDir, 'screenshots', 'manifest.json' ), JSON.stringify( { version: 1, entries: { [ source ]: {
			html: 'html/homepage.html',
			interactions: {
				schema: `${ CAPTURE_SCHEMA_NAMESPACE }interaction-states/v2`, sourceUrl: source,
				viewport: { width: 1440, height: 900 }, capturedAt: '2026-10-13T00:00:00.000Z',
				states: [
					{ status: 'captured', trigger: { selector: '#open', tag: 'button', id: 'open', ariaHaspopup: 'dialog', dataBindings: {} },
						dialog: { selector: '#panel', tag: 'div', id: 'panel', role: 'dialog', ariaModal: true, html: panel, htmlBytes: Buffer.byteLength( panel ), htmlTruncated: false } },
					{ status: 'captured', trigger: { selector: '#sort', tag: 'button', id: 'sort', ariaHaspopup: 'listbox', dataBindings: {} },
						dialog: { selector: '#sort-options', tag: 'ul', id: 'sort-options', role: 'listbox', ariaModal: false, html: listbox, htmlBytes: Buffer.byteLength( listbox ), htmlTruncated: false } },
					{ status: 'captured', kind: 'gallery', trigger: { selector: '#carousel', tag: 'section', ariaHaspopup: '', dataBindings: {} }, gallery: { inline: {
						selector: '#carousel', stage: ':scope > div', next: '#next', previous: '#previous', viewport: { width: 1440, height: 900 }, order: [ 'one', 'two' ], initial: 0,
						frames: [ { key: 'one', html: frame, text: [] }, { key: 'two', html: frame.replace( 'One', 'Two' ), text: [] } ],
						coverage: 'complete', restoration: 'verified', autoplay: 'unmeasured',
					} } },
				],
				initialDialogs: [],
			},
		} } } ) );
		exportWebsiteCapture( { outputDir, sourceUrl: source, platform: 'generic', summary: {}, failures: [] } );

		// No previous name in any exported file or sidecar.
		const exported = files( outputDir, path => /\.(?:html|json|css|js)$/.test( path ) && ! path.includes( `${ join( outputDir, 'html' ) }` ) && ! path.includes( join( outputDir, 'screenshots' ) ) );
		expect( exported.map( path => relative( outputDir, path ) ) ).toEqual( expect.arrayContaining( [ 'website/index.html', 'interaction-states.json', 'capture-receipt.json' ] ) );
		for ( const file of exported ) expect( oldNameIn( readFileSync( file, 'utf8' ) ), relative( outputDir, file ) ).toBeUndefined();

		const html = readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' );
		const $ = cheerio.load( html );
		const present = new Set< string >();
		$( '*' ).each( ( _index, node ) => {
			for ( const name of Object.keys( ( node as unknown as { attribs: Record< string, string > } ).attribs ?? {} ) ) if ( name.startsWith( p ) ) present.add( name.slice( p.length ) );
			for ( const token of ( $( node ).attr( 'class' ) ?? '' ).split( /\s+/ ) ) if ( token.startsWith( p ) ) present.add( `.${ token.slice( p.length ) }` );
		} );
		expect( [ ...present ] ).toEqual( expect.arrayContaining( [
			'dialog-trigger', 'dialog-panel', 'dialog-close', '.dialog', 'disclosure-runtime', 'listbox-trigger', 'listbox-panel',
			'device-document', 'document-scope', '.mobile-document', 'collection', 'collection-item', 'collection-members', 'collection-status',
			'status-template', 'status-hide-zero', 'gallery', 'gallery-direction', 'gallery-runtime', 'glyph-color',
		] ) );
		for ( const name of present ) expect( names.includes( name.replace( /^\./, '' ) ) || familyHeads.some( head => head && name.replace( /^\./, '' ).startsWith( head ) ), name ).toBe( true );

		// Consumers recognize these runtimes by the sha256 of their trimmed body.
		const digest = ( marker: string ) => createHash( 'sha256' ).update( $( `script[${ p }${ marker }]` ).text().trim() ).digest( 'hex' );
		expect( digest( 'disclosure-runtime' ) ).toBe( CAPTURE_RUNTIME_SHA256.disclosure );
		expect( digest( 'gallery-runtime' ) ).toBe( CAPTURE_RUNTIME_SHA256.gallery );

		const states = JSON.parse( readFileSync( join( outputDir, 'interaction-states.json' ), 'utf8' ) );
		expect( states.schema ).toBe( `${ CAPTURE_SCHEMA_NAMESPACE }captured-interactions/v1` );
		expect( JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) ).schema ).toBe( `${ CAPTURE_SCHEMA_NAMESPACE }capture-receipt/v1` );
		expect( statSync( join( outputDir, 'website', 'index.html' ) ).size ).toBeGreaterThan( 0 );
	} );
} );
