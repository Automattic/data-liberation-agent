import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureWebsite } from './capture.js';
import { readResolvedPage } from './site-includes.js';

const skipBrowser = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );

// Issue #899: a phone menu button inside the site header toggles a `hidden`
// class on a dropdown of links. Content hydration used to click it open before
// serialization, so every route saved the opened header and the shared part
// recorded an open "resting" state the source never shows.
const page = ( title: string ) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font:16px sans-serif}.hidden{display:none}header{background:#123;color:#fff}
.bar{display:flex;justify-content:space-between;align-items:center;height:64px;padding:0 16px}.bar a{color:#fff}
.toggle{width:44px;height:44px}.dropdown{padding:16px;background:#234}.dropdown a{display:block;color:#fff;padding:8px 0}
main{padding:16px;min-height:600px}@media(min-width:1024px){.toggle{display:none}}</style></head>
<body><header><div class="bar"><a href="/">Neutral Brand</a>
<button id="menu-button" class="toggle" type="button" aria-controls="menu-panel" aria-expanded="false" aria-label="Toggle menu" onclick="toggleMenu()">&#9776;</button></div>
<div id="menu-panel" class="hidden dropdown"><a href="/">Home</a><a href="/about/">About</a><a href="/about/#team">Team</a><a href="/about/#contact">Contact</a></div>
<script>function toggleMenu(){var panel=document.getElementById('menu-panel'),button=document.getElementById('menu-button');
var open=panel.classList.contains('hidden');panel.classList.toggle('hidden',!open);button.setAttribute('aria-expanded',String(open));}</script>
</header><main><h1>${ title }</h1><p>${ title } body copy.</p></main></body></html>`;

it.skipIf( skipBrowser )( 'shared header parts keep the closed resting state of a header dropdown', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const root = mkdtempSync( join( parent, 'issue-899-' ) );
	let copyRoot: string | undefined;
	const server = createServer( ( request, response ) => {
		if ( request.url === '/robots.txt' ) { response.end( '' ); return; }
		if ( request.url?.includes( 'sitemap' ) ) { response.statusCode = 404; response.end(); return; }
		response.setHeader( 'Content-Type', 'text/html' );
		if ( request.url?.startsWith( '/copy/' ) && copyRoot ) {
			response.end( readResolvedPage( copyRoot, join( copyRoot, request.url.slice( '/copy/'.length ), 'index.html' ) ) );
			return;
		}
		response.end( page( request.url?.startsWith( '/about' ) ? 'About' : 'Home' ) );
	} );
	await new Promise< void >( resolve => server.listen( 0, resolve ) );
	const url = `http://localtest.me:${ ( server.address() as { port: number } ).port }/`;
	const browser = await chromium.launch( { args: [ '--host-resolver-rules=MAP localtest.me 127.0.0.1' ] } );
	try {
		const outputDir = join( root, 'capture' );
		const captured = await captureWebsite( { url, outputDir }, {
			findAdapter: () => ( { id: 'neutral-header-dropdown', detect: () => true, discover: async () => ( { urls: [ { url }, { url: `${ url }about/` } ] } ) } ),
		} );
		expect( captured.summary.routesFailed ).toBe( 0 );
		copyRoot = join( outputDir, 'website' );
		const parts = readdirSync( join( copyRoot, 'parts' ) ).filter( name => name.startsWith( 'header-' ) );
		const owner = parts.find( name => readFileSync( join( copyRoot!, 'parts', name ), 'utf8' ).includes( 'id="menu-panel"' ) );
		expect( owner, 'the header dropdown is factored into a shared part' ).toBeDefined();
		const include = `<!--#include virtual="/parts/${ owner }" -->`;
		for ( const route of [ 'index.html', 'about/index.html' ] ) expect( readFileSync( join( copyRoot, route ), 'utf8' ) ).toContain( include );

		const $ = cheerio.load( readFileSync( join( copyRoot, 'parts', owner! ), 'utf8' ) );
		expect( $( '#menu-button' ).attr( 'aria-expanded' ) ).toBe( 'false' );
		const panel = $( '#menu-panel' );
		expect( panel.hasClass( 'data-blocks-engine-capture-dropdown' ) ).toBe( true );
		// Where the toggle is concealed (desktop), the panel returns to its
		// source resting state, which keeps the closing `hidden` token.
		const existing = panel.attr( 'data-blocks-engine-capture-existing-panel' );
		const resting = existing ? ( JSON.parse( existing ) as { resting: { class: string } } ).resting.class : panel.attr( 'class' ) ?? '';
		expect( resting.split( /\s+/ ) ).toContain( 'hidden' );

		const copy = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await copy.goto( `${ url }copy/about/`, { waitUntil: 'load' } );
		expect( await copy.locator( '#menu-panel' ).isVisible(), 'closed at desktop' ).toBe( false );
		await copy.setViewportSize( { width: 390, height: 844 } );
		await copy.goto( `${ url }copy/about/`, { waitUntil: 'load' } );
		expect( await copy.locator( '#menu-panel' ).isVisible(), 'closed on first phone load' ).toBe( false );
		await copy.locator( '#menu-button' ).click();
		expect( await copy.locator( '#menu-panel' ).isVisible(), 'opens from the phone toggle' ).toBe( true );
		await copy.close();
	} finally {
		await browser.close();
		await new Promise< void >( resolve => server.close( () => resolve() ) );
		rmSync( root, { recursive: true, force: true } );
	}
}, 240_000 );
