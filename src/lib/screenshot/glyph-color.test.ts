// Real-Chromium coverage for rendered glyph colour (#769): the same
// single-colour icon records the same colour whatever format carries it, and
// only bounded, icon-sized glyphs inside links and buttons are sampled.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { exportWebsiteCapture } from '../capture-export.js';
import { capturePageHtml, captureScreenshots } from './screenshotter.js';
import { GLYPH_COLOR_ATTRIBUTE, monochromeGlyphColor, recordGlyphColors } from './glyph-color.js';

const ORIGIN = 'https://glyph-color.test';
const FIXTURES = fileURLToPath( new URL( './fixtures/glyph-color/', import.meta.url ) );
const TYPES: Record< string, string > = { avif: 'image/avif', webp: 'image/webp', png: 'image/png' };
// The fixture glyph's colour (fictional brand blue), lossless in every format.
const BLUE = '#1877f2';
// The same glyph as inline SVG: a rounded square with a cut-out.
const SVG_GLYPH = ( fill: string ) =>
	`<svg width="32" height="32" viewBox="0 0 32 32"><path fill-rule="evenodd" fill="${ fill }" d="M9 2h14a7 7 0 0 1 7 7v14a7 7 0 0 1-7 7H9a7 7 0 0 1-7-7V9a7 7 0 0 1 7-7zM14 8v5h-3v4h3v10h5V17h4v-4h-4V8z"/></svg>`;

async function open( browser: Browser, body: string ): Promise< Page > {
	const page = await browser.newPage( { viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 } );
	await page.route( `${ ORIGIN }/**`, ( route ) => {
		const path = new URL( route.request().url() ).pathname;
		const file = /^\/icons\/([a-z-]+\.(avif|webp|png))$/.exec( path );
		if ( file ) return route.fulfill( { contentType: TYPES[ file[ 2 ] ], body: readFileSync( join( FIXTURES, file[ 1 ] ) ) } );
		return route.fulfill( {
			contentType: 'text/html',
			body: `<!doctype html><html><head><style>body{margin:0;background:#202020}a{display:inline-block;background:#e33;padding:4px;margin:4px}img,svg{display:block}</style></head><body>${ body }</body></html>`,
		} );
	} );
	await page.goto( `${ ORIGIN }/` );
	await page.evaluate( () => Promise.all( Array.from( document.images ).map( ( image ) => image.decode().catch( () => undefined ) ) ) );
	return page;
}

const recorded = ( page: Page ) =>
	page.evaluate( ( attribute ) => Array.from( document.querySelectorAll( '[id]' ) ).map( ( node ) => [ node.id, node.getAttribute( attribute ) ] ), GLYPH_COLOR_ATTRIBUTE );

describe( 'rendered glyph colour', () => {
	let browser: Browser;
	beforeAll( async () => {
		browser = await chromium.launch();
	} );
	afterAll( async () => {
		await browser.close();
	} );

	it( 'records the same colour for an AVIF, WebP, PNG, picture, inline SVG and background-image glyph', async () => {
		const page = await open(
			browser,
			`<footer>
				<a id="avif" href="/a"><img src="/icons/glyph.avif" width="32" height="32" alt="A"></a>
				<a id="webp-link" href="/b"><img id="webp" src="/icons/glyph.webp" width="32" height="32" alt="B"></a>
				<a href="/c"><img id="png" src="/icons/glyph.png" width="32" height="32" alt="C"></a>
				<a href="/d"><picture><source type="image/avif" srcset="/icons/glyph.avif"><img id="picture" src="/icons/glyph.png" width="32" height="32" alt="D"></picture></a>
				<a href="/e">${ SVG_GLYPH( BLUE ).replace( '<svg', '<svg id="svg"' ) }</a>
				<button type="button"><span id="background" style="display:block;width:32px;height:32px;background:url(/icons/glyph.webp) center/contain no-repeat #fff"></span></button>
				<a href="/f" style="opacity:.6"><img id="faded" src="/icons/glyph.png" width="32" height="32" alt="F"></a>
				<a href="/g" style="color:#fff">${ SVG_GLYPH( 'currentColor' ).replace( '<svg', '<svg id="current"' ) }</a>
				<div style="height:1600px"></div>
				<a href="/h"><img id="below-fold" src="/icons/glyph.avif" width="32" height="32" alt="H"></a>
			</footer>`
		);
		const result = await recordGlyphColors( page );
		expect( result ).toEqual( { candidates: 9, sampled: 9, recorded: 9 } );
		expect( Object.fromEntries( await page.evaluate( ( attribute ) =>
			Array.from( document.querySelectorAll( `[${ attribute }]` ) ).map( ( node ) => [ node.id || node.querySelector( '[id]' )?.id || node.closest( '[id]' )?.id, node.getAttribute( attribute ) ] ), GLYPH_COLOR_ATTRIBUTE ) ) ).toEqual( {
			avif: BLUE, webp: BLUE, png: BLUE, picture: BLUE, svg: BLUE, background: BLUE, faded: BLUE, current: '#ffffff', 'below-fold': BLUE,
		} );
		// The attribute sits on the glyph element itself, not its link.
		expect( await page.locator( '#avif' ).getAttribute( GLYPH_COLOR_ATTRIBUTE ) ).toBeNull();
		expect( await page.locator( '#avif img' ).getAttribute( GLYPH_COLOR_ATTRIBUTE ) ).toBe( BLUE );

		// The probe leaves nothing behind but the recorded colour.
		const html = await capturePageHtml( page );
		expect( html ).toContain( `${ GLYPH_COLOR_ATTRIBUTE }="${ BLUE }"` );
		expect( html ).not.toContain( 'data-blocks-engine-capture-glyph-probe' );
		expect( await page.locator( 'footer a' ).first().evaluate( ( node ) => getComputedStyle( node ).visibility ) ).toBe( 'visible' );
		expect( await page.locator( '#background' ).evaluate( ( node ) => getComputedStyle( node ).backgroundColor ) ).toBe( 'rgb(255, 255, 255)' );
		expect( await page.locator( '#faded' ).evaluate( ( node ) => getComputedStyle( node.parentElement! ).opacity ) ).toBe( '0.6' );
		await page.close();
	} );

	it( 'records nothing for a multicolour glyph, a large image, or an image outside a link or button', async () => {
		const page = await open(
			browser,
			`<a href="/a"><img id="multicolor" src="/icons/multicolor.png" width="32" height="32" alt="A"></a>
			<a href="/b"><img id="large" src="/icons/glyph.png" width="96" height="96" alt="B"></a>
			<img id="unlinked" src="/icons/glyph.png" width="32" height="32" alt="C">
			<a href="/c"><span id="labelled" style="display:block;width:32px;height:32px;background:url(/icons/glyph.png)">Label</span></a>
			<a href="/d"><img id="spoofed" src="/icons/multicolor.png" width="200" height="40" data-blocks-engine-capture-glyph-color="#123456" alt="D"></a>
			<a href="/e" style="opacity:0"><img id="transparent" src="/icons/glyph.png" width="32" height="32" alt="E"></a>`
		);
		expect( await recordGlyphColors( page ) ).toEqual( { candidates: 1, sampled: 1, recorded: 0 } );
		expect( ( await recorded( page ) ).filter( ( [ , color ] ) => color !== null ) ).toEqual( [] );
		await page.close();
	} );

	it( 'samples at most the per-document bound, in document order', async () => {
		const icons = Array.from( { length: 30 }, ( _, index ) => `<a href="/${ index }"><img id="icon-${ index }" src="/icons/glyph.png" width="16" height="16" alt=""></a>` ).join( '' );
		const page = await open( browser, icons );
		expect( await recordGlyphColors( page, { maxGlyphs: 24 } ) ).toEqual( { candidates: 30, sampled: 24, recorded: 24 } );
		const colors = await recorded( page );
		expect( colors.slice( 0, 24 ).every( ( [ , color ] ) => color === BLUE ) ).toBe( true );
		expect( colors.slice( 24 ).every( ( [ , color ] ) => color === null ) ).toBe( true );
		await page.close();
	} );

	it( 'mirrors the Blocks Engine monochrome test', () => {
		const pixels = ( fill: ( index: number ) => [ number, number, number, number ], count = 64 ) =>
			Uint8Array.from( Array.from( { length: count }, ( _, index ) => fill( index ) ).flat() );
		expect( monochromeGlyphColor( pixels( () => [ 252, 251, 255, 255 ] ), 8, 8 ) ).toBe( '#ffffff' );
		expect( monochromeGlyphColor( pixels( () => [ 3, 0, 5, 255 ] ), 8, 8 ) ).toBe( '#000000' );
		// Edge pixels within the channel delta still count toward the cluster.
		expect( monochromeGlyphColor( pixels( ( index ) => ( index % 8 ? [ 24, 119, 242, 255 ] : [ 40, 130, 250, 255 ] ) ), 8, 8 ) ).toBe( BLUE );
		// Two colours at 50% each are not a glyph colour.
		expect( monochromeGlyphColor( pixels( ( index ) => ( index % 2 ? [ 24, 119, 242, 255 ] : [ 240, 40, 40, 255 ] ) ), 8, 8 ) ).toBe( '' );
		// Fewer than eight opaque pixels, or a fully transparent clip.
		expect( monochromeGlyphColor( pixels( ( index ) => [ 24, 119, 242, index < 7 ? 255 : 0 ] ), 8, 8 ) ).toBe( '' );
		expect( monochromeGlyphColor( pixels( () => [ 24, 119, 242, 0 ] ), 8, 8 ) ).toBe( '' );
	} );

	it( 'records the colour in the desktop and mobile documents a capture saves', async () => {
		const server = createServer( ( request, response ) => {
			const file = /^\/icons\/([a-z-]+\.(avif|webp|png))$/.exec( request.url ?? '' );
			if ( file ) {
				response.setHeader( 'content-type', TYPES[ file[ 2 ] ] );
				response.end( readFileSync( join( FIXTURES, file[ 1 ] ) ) );
				return;
			}
			response.setHeader( 'content-type', 'text/html' );
			response.end( '<!doctype html><title>Home</title><main><h1>Home</h1></main><footer><a href="https://social.example/brand"><img src="/icons/glyph.avif" width="32" height="32" alt="Brand"></a></footer>' );
		} );
		await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
		const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
		mkdirSync( '.tmp-test', { recursive: true } );
		const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'glyph-color-' ) );
		try {
			const result = await captureScreenshots( {
				urls: [ `${ origin }/` ], outputDir, concurrency: 1, settleMs: 0, learnFluid: false,
				viewports: [ { id: 'desktop', width: 1440, height: 900 }, { id: 'mobile', width: 390, height: 844 } ],
			} );
			expect( result ).toMatchObject( { captured: 1, failed: 0 } );
			const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots/manifest.json' ), 'utf8' ) ) as { entries: Record< string, { html?: string; mobileHtml?: string } > };
			const entry = manifest.entries[ `${ origin }/` ];
			for ( const path of [ entry.html, entry.mobileHtml ] ) {
				const html = readFileSync( join( outputDir, path! ), 'utf8' );
				expect( html ).toMatch( new RegExp( `<img[^>]*${ GLYPH_COLOR_ATTRIBUTE }="${ BLUE }"` ) );
				expect( html ).not.toContain( 'data-blocks-engine-capture-glyph-probe' );
			}
		} finally {
			await new Promise< void >( ( resolve ) => server.close( () => resolve() ) );
			rmSync( outputDir, { recursive: true, force: true } );
		}
	}, 60_000 );

	it( 'keeps the recorded colour through website export', () => {
		const outputDir = mkdtempSync( join( tmpdir(), 'liberation-glyph-color-export-' ) );
		try {
			for ( const path of [ 'html', 'html-mobile', 'screenshots' ] ) mkdirSync( join( outputDir, path ), { recursive: true } );
			const page = ( width: number ) =>
				`<html><body><main><h1>Home</h1></main><footer style="width:${ width }px"><a href="https://social.example/brand"><img src="https://example.com/icons/glyph.avif" width="32" height="32" alt="Brand" ${ GLYPH_COLOR_ATTRIBUTE }="${ BLUE }"></a></footer></body></html>`;
			writeFileSync( join( outputDir, 'html', 'homepage.html' ), page( 940 ) );
			writeFileSync( join( outputDir, 'html-mobile', 'homepage.html' ), page( 360 ) );
			writeFileSync(
				join( outputDir, 'screenshots', 'manifest.json' ),
				JSON.stringify( { version: 1, entries: { 'https://example.com/': { slug: 'homepage', html: 'html/homepage.html', mobileHtml: 'html-mobile/homepage.html' } } } )
			);
			exportWebsiteCapture( { outputDir, sourceUrl: 'https://example.com/', platform: 'generic', summary: {}, failures: [] } );
			const html = readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' );
			expect( html ).toMatch( new RegExp( `<img[^>]*${ GLYPH_COLOR_ATTRIBUTE }="${ BLUE }"` ) );
		} finally {
			rmSync( outputDir, { recursive: true, force: true } );
		}
	} );
} );
