import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { afterEach, describe, expect, it } from 'vitest';
import { exportWebsiteCapture } from './capture-export.js';
import { ASSET_EXCEEDS_BUDGET, DEFAULT_WEBSITE_TOTAL_BYTES } from './export-file-limit.js';

const SOURCE = 'https://example.com/';

const dirs: string[] = [];
afterEach( () => {
	for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } );
} );

function websiteFiles( dir: string ): string[] {
	return readdirSync( dir, { withFileTypes: true } ).flatMap( entry =>
		entry.isDirectory() ? websiteFiles( join( dir, entry.name ) ) : [ join( dir, entry.name ) ] );
}

const rendition = ( family: string, width: number ) => `https://cdn.example/${ family }?format=${ width }w`;
const widthSet = [ 300, 500, 1000, 2500 ];

/**
 * A three-route capture with three srcset families (4 renditions each, captured
 * as page resources — the `website/external` path) plus a shared stylesheet
 * whose CSS pulls a font and a background image. A naive export writes all 12
 * renditions and blows past the small injected budget.
 */
function fixture(): string {
	const outputDir = mkdtempSync( join( tmpdir(), 'liberation-website-budget-' ) );
	dirs.push( outputDir );
	for ( const path of [ 'html', 'screenshots', 'resources/external' ] )
		mkdirSync( join( outputDir, path ), { recursive: true } );
	const stylesheet = '' +
		`@font-face{font-family:FixtureFont;src:url(https://cdn.example/font.woff2) format("woff2")}` +
		`body{background-image:url(https://cdn.example/bg.png)}` +
		`.pad::before{content:"${ 'p'.repeat( 600 ) }"}`;
	const img = ( family: string, label: string ) =>
		`<img alt="${ label }" src="${ rendition( family, 300 ) }" srcset="${ widthSet.map( width => `${ rendition( family, width ) } ${ width }w` ).join( ', ' ) }">`;
	writeFileSync(
		join( outputDir, 'html', 'homepage.html' ),
		`<!doctype html><html><head><title>Home</title><link rel="stylesheet" href="https://cdn.example/styles.css"></head>` +
			`<body><main><h1>Home</h1>${ img( 'alpha', 'Alpha' ) }${ img( 'beta', 'Beta' ) }${ img( 'gamma', 'Gamma' ) }${ img( 'omega', 'Omega' ) }</main></body></html>`
	);
	writeFileSync(
		join( outputDir, 'html', 'about.html' ),
		`<!doctype html><html><head><link rel="stylesheet" href="https://cdn.example/styles.css"></head>` +
			`<body><main><h1>About</h1>${ img( 'alpha', 'Alpha too' ) }${ img( 'omega', 'Omega too' ) }</main></body></html>`
	);
	writeFileSync(
		join( outputDir, 'html', 'work.html' ),
		`<!doctype html><html><head><link rel="stylesheet" href="https://cdn.example/styles.css"></head>` +
			`<body><main><h1>Work</h1><div class="hero"></div>${ img( 'gamma', 'Gallery' ) }</main></body></html>`
	);
	writeFileSync( join( outputDir, 'screenshots', 'manifest.json' ), JSON.stringify( {
		version: 1,
		entries: {
			[ SOURCE ]: { html: 'html/homepage.html' },
			'https://example.com/about': { html: 'html/about.html' },
			'https://example.com/work': { html: 'html/work.html' },
		},
	} ) );
	writeFileSync( join( outputDir, 'resources', 'external', 'styles.css' ), stylesheet );
	writeFileSync( join( outputDir, 'resources', 'external', 'font.woff2' ), Buffer.alloc( 2000, 1 ) );
	writeFileSync( join( outputDir, 'resources', 'external', 'bg.png' ), Buffer.alloc( 1000, 2 ) );
	const resources: Record< string, { path: string; contentType: string } > = {
		'https://cdn.example/styles.css': { path: 'resources/external/styles.css', contentType: 'text/css' },
		'https://cdn.example/font.woff2': { path: 'resources/external/font.woff2', contentType: 'font/woff2' },
		'https://cdn.example/bg.png': { path: 'resources/external/bg.png', contentType: 'image/png' },
	};
	for ( const [ familyIndex, family ] of [ 'alpha', 'beta', 'gamma', 'omega' ].entries() )
		for ( const [ widthIndex, width ] of widthSet.entries() ) {
			const name = `${ family }-${ width }.webp`;
			writeFileSync( join( outputDir, 'resources', 'external', name ), Buffer.alloc( 3000, widthIndex + 16 * familyIndex ) );
			resources[ rendition( family, width ) ] = { path: `resources/external/${ name }`, contentType: 'image/webp' };
		}
	writeFileSync( join( outputDir, 'resources', 'manifest.json' ), JSON.stringify( { version: 1, failures: [], resources } ) );
	return outputDir;
}

describe( 'portable export website byte budget', () => {
	it( 'defaults below the importer staged archive intake', () => {
		expect( DEFAULT_WEBSITE_TOTAL_BYTES ).toBe( 240 * 1024 * 1024 );
	} );

	it( 'keeps the whole website tree within the budget, spends required bytes first, and degrades what does not fit', () => {
		const outputDir = fixture();
		const websiteTotalBytes = 16_000;
		exportWebsiteCapture( {
			outputDir,
			sourceUrl: SOURCE,
			platform: 'generic',
			summary: {},
			failures: [],
			limits: { websiteTotalBytes },
		} );

		const websiteDir = join( outputDir, 'website' );
		const files = websiteFiles( websiteDir );
		// (1) The exported tree fits the budget a naive export blows past.
		const totalBytes = files.reduce( ( total, file ) => total + statSync( file ).size, 0 );
		// eslint-disable-next-line no-console
		console.log( 'FILES', files.map( file => `${ file.replace( websiteDir, '' ) } ${ statSync( file ).size }` ).join( ' | ' ) );
		expect( totalBytes ).toBeLessThanOrEqual( websiteTotalBytes );

		// (2) Required bytes were written: the stylesheet, its nested font and
		// background image, and the widest rendition of each family the budget
		// still covers.
		expect( files.some( file => file.endsWith( 'font.woff2' ) ) ).toBe( true );
		expect( files.some( file => file.endsWith( 'bg.png' ) ) ).toBe( true );
		expect( files.some( file => file.endsWith( 'alpha-2500.webp' ) ) ).toBe( true );
		expect( files.some( file => file.endsWith( 'beta-2500.webp' ) ) ).toBe( true );
		// What does not fit is degraded: after the documents, stylesheet, font
		// and background image spend the budget, only three of the four required
		// primaries and no additional (smaller) rendition fit.
		expect( files.some( file => /omega-\d+\.webp$/.test( file ) ) ).toBe( false );
		expect( files.filter( file => /\.webp$/.test( file ) ) ).toHaveLength( 3 );

		// (3) Every src/srcset/url() reference in the exported HTML and CSS
		// resolves to a written file or a data: fallback — no dangling source
		// URLs, no references to files that were not written.
		const resolved = ( value: string ): boolean => {
			if ( /^(?:data:|blob:|about:)/.test( value ) ) return true;
			if ( /^https?:\/\//i.test( value ) ) return false;
			return exists( join( websiteDir, decodeURIComponent( new URL( value, 'https://portable.invalid' ).pathname ) ) );
		};
		const exists = ( path: string ) => {
			try { return statSync( path ).isFile(); } catch { return false; }
		};
		const cssFiles = files.filter( file => file.endsWith( '.css' ) );
		expect( cssFiles.length ).toBeGreaterThanOrEqual( 1 );
		let checks = 0;
		for ( const file of [ ...files.filter( path => /\.html$/.test( path ) ), ...cssFiles ] ) {
			const content = readFileSync( file, 'utf8' );
		const references = [
			...content.matchAll( /\s(?:src|href|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi ),
			...content.matchAll( /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi ),
		].flatMap( match => {
			const value = match[ 1 ] ?? match[ 2 ] ?? match[ 3 ] ?? '';
			// A data: or fragment reference is already resolved; comma-splitting
			// only applies to multi-candidate srcset attributes that never start
			// with a comma-separated data: URL here.
			if ( /^(?:data:|#|^\/\/)/.test( value ) ) return [ value ];
			return value
				.split( /\s*,\s*/ )
				.map( candidate => candidate.replace( /\s\S*$/, '' ).trim() );
		} );
			for ( const reference of references )
				if ( reference && ! /^#/.test( reference ) ) { checks++; expect( resolved( reference ), `${ reference } in ${ file }` ).toBe( true ); }
		}
		expect( checks ).toBeGreaterThan( 12 );

		// Home keeps its retained alpha renditions (the picture's primary) and
		// loses no attribute information other than the omissions themselves.
		const $ = cheerio.load( readFileSync( join( websiteDir, 'index.html' ), 'utf8' ) );
		const alpha = $( 'img[alt="Alpha"]' );
		expect( alpha.attr( 'srcset' ) ).toContain( '/external/alpha-2500.webp' );
		expect( alpha.attr( 'srcset' ) ).not.toContain( 'cdn.example' );

		// (4) Omissions are diagnosed with the stable budget code, both in the
		// diagnostics report and the receipt.
		const diagnostics = JSON.parse( readFileSync( join( outputDir, 'diagnostics.json' ), 'utf8' ) ) as {
			unresolvedDependencies: Array< { url: string; error: string } >;
		};
		const budgetRows = diagnostics.unresolvedDependencies.filter( row =>
			/portable export budget/.test( row.error ) );
		expect( budgetRows.length ).toBeGreaterThanOrEqual( 8 );
		expect( budgetRows.map( row => row.url ) ).toContain( rendition( 'omega', 2500 ) );
		const receipt = JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) ) as {
			discoveryDiagnostics: Array< { code: string; url: string; metrics?: Record< string, number > } >;
		};
		const receiptRows = receipt.discoveryDiagnostics.filter( row => row.code === ASSET_EXCEEDS_BUDGET );
		expect( receiptRows.length ).toBeGreaterThanOrEqual( 8 );
		expect( receiptRows[ 0 ].metrics ).toEqual( { bytes: 3000, limit: websiteTotalBytes } );
	} );
} );
