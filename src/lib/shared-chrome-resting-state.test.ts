import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureWebsite } from './capture.js';
import { readResolvedPage } from './site-includes.js';

const skipBrowser = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );

// Issue #899, modelled on the production shape: a Tailwind-like header whose
// phone menu button (`lg:hidden`, so concealed at desktop) toggles `hidden` on
// a `hidden lg:hidden` dropdown of links. The entrypoint's header links to
// in-page anchors while every interior route's header links to pages, so the
// interior chrome does not match the entrypoint's and cannot reuse its
// phone-only evidence. Interior routes are captured once, at desktop, where the
// button is not laid out; without an in-place phone probe their shared header
// part shipped the dropdown without its dropdown/dialog evidence, and the copy
// either showed it open on load or never opened it.
// Interior links are relative, as on the source site, so a nested route writes
// different bytes for the same destinations.
const header = ( depth: number ) => {
	const link = ( path: string, anchor: string ) => depth ? `${ '../'.repeat( depth ) }${ path }` : anchor;
	return `<header class="relative w-full"><div class="bar"><a href="${ link( '', '#' ) }">Neutral Brand</a>
<nav class="hidden lg:flex"><a href="${ link( 'about/', '#about' ) }">About</a><a href="${ link( 'contact/', '#contact' ) }">Contact</a></nav>
<button aria-controls="mobileNav" aria-expanded="false" aria-label="Toggle Mobile Menu" class="lg:hidden toggle" id="mobileBtn" onclick="toggleNav()">&#9776;</button></div>
<div class="hidden lg:hidden dropdown" id="mobileNav"><div class="flex flex-col"><a href="${ link( 'about/', '#about' ) }" onclick="toggleNav()">About</a><a href="${ link( 'programs/youth/', '/programs/youth/' ) }" onclick="toggleNav()">Programs</a><a href="${ link( 'contact/', '#contact' ) }" onclick="toggleNav()">Contact</a></div></div>
<script>function toggleNav(){var nav=document.getElementById('mobileNav'),btn=document.getElementById('mobileBtn');if(!nav)return;
if(nav.classList.contains('hidden')){nav.classList.remove('hidden');btn.setAttribute('aria-expanded','true');}else{nav.classList.add('hidden');btn.setAttribute('aria-expanded','false');}}</script>
</header>`;
};
const page = ( title: string, depth: number ) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font:16px sans-serif}.hidden{display:none}header{background:#123;color:#fff}.flex{display:flex}.flex-col{flex-direction:column}
.bar{display:flex;justify-content:space-between;align-items:center;height:64px;padding:0 16px}.bar a,.dropdown a{color:#fff}
.toggle{width:44px;height:44px}.dropdown{padding:16px;background:#234}.dropdown a{padding:8px 0}
main{padding:16px;min-height:600px}@media(min-width:1024px){.lg\\:hidden{display:none}.lg\\:flex{display:flex;gap:16px}}</style></head>
<body>${ header( depth ) }<main><h1>${ title }</h1><p>${ title } body copy.</p></main></body></html>`;

const interior = [ 'about', 'programs/youth', 'contact' ];

it.skipIf( skipBrowser )( 'shared header parts keep the resting state and dropdown evidence of a phone-only header menu', async () => {
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
		const name = interior.find( route => request.url?.startsWith( `/${ route }/` ) );
		response.end( page( name ?? 'Home', name ? name.split( '/' ).length : 0 ) );
	} );
	await new Promise< void >( resolve => server.listen( 0, resolve ) );
	const url = `http://localtest.me:${ ( server.address() as { port: number } ).port }/`;
	const browser = await chromium.launch( { args: [ '--host-resolver-rules=MAP localtest.me 127.0.0.1' ] } );
	try {
		const outputDir = join( root, 'capture' );
		const captured = await captureWebsite( { url, outputDir }, {
			findAdapter: () => ( { id: 'neutral-header-dropdown', detect: () => true, discover: async () => ( { urls: [ { url }, ...interior.map( route => ( { url: `${ url }${ route }/` } ) ) ] } ) } ),
		} );
		expect( captured.summary.routesFailed ).toBe( 0 );
		copyRoot = join( outputDir, 'website' );

		// The interior header resolves identically on every interior route, so it
		// is factored once: one part, included by each of them.
		const owners = readdirSync( join( copyRoot, 'parts' ) ).filter( name => name.startsWith( 'header-' ) &&
			readFileSync( join( copyRoot!, 'parts', name ), 'utf8' ).includes( 'id="mobileNav"' ) );
		expect( owners, 'one shared header part owns the phone menu' ).toHaveLength( 1 );
		const include = `<!--#include virtual="/parts/${ owners[ 0 ] }" -->`;
		for ( const route of interior ) expect( readFileSync( join( copyRoot, route, 'index.html' ), 'utf8' ) ).toContain( include );

		const $ = cheerio.load( readFileSync( join( copyRoot, 'parts', owners[ 0 ]! ), 'utf8' ) );
		const trigger = $( '#mobileBtn' );
		expect( trigger.attr( 'aria-expanded' ) ).toBe( 'false' );
		expect( trigger.attr( 'aria-controls' ), 'the trigger still names its panel' ).toBe( 'mobileNav' );
		expect( trigger.attr( 'data-blocks-engine-capture-dialog-trigger' ), 'the trigger carries its dialog-trigger marker' ).toBe( 'mobileNav' );
		const panel = $( '#mobileNav' );
		expect( panel.hasClass( 'data-blocks-engine-capture-dropdown' ) ).toBe( true );
		expect( panel.attr( 'data-blocks-engine-capture-dialog-panel' ) ).toBe( 'mobileNav' );
		// The resting state is the source's closed form, `hidden` included.
		const existing = panel.attr( 'data-blocks-engine-capture-existing-panel' );
		expect( existing, 'the panel carries its resting-state evidence' ).toBeDefined();
		const resting = ( JSON.parse( existing! ) as { resting: { class: string } } ).resting.class.split( /\s+/ );
		expect( resting ).toContain( 'hidden' );
		expect( resting ).toContain( 'lg:hidden' );

		// The entrypoint's own header differs in source; it is still wired.
		const home = cheerio.load( readResolvedPage( copyRoot, join( copyRoot, 'index.html' ) ) );
		expect( home( '#mobileNav' ).hasClass( 'data-blocks-engine-capture-dropdown' ) ).toBe( true );
		expect( home( '#mobileBtn' ).attr( 'data-blocks-engine-capture-dialog-trigger' ) ).toBe( 'mobileNav' );

		const copy = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await copy.goto( `${ url }copy/about/`, { waitUntil: 'load' } );
		expect( await copy.locator( '#mobileNav' ).isVisible(), 'closed at desktop' ).toBe( false );
		for ( const route of interior ) {
			await copy.setViewportSize( { width: 390, height: 844 } );
			await copy.goto( `${ url }copy/${ route }/`, { waitUntil: 'load' } );
			expect( await copy.locator( '#mobileNav' ).isVisible(), `${ route }: closed on first phone load` ).toBe( false );
			await copy.locator( '#mobileBtn' ).click();
			expect( await copy.locator( '#mobileNav' ).isVisible(), `${ route }: opens from the phone toggle` ).toBe( true );
			// The opened menu links where the copy's own navigation does.
			expect( await copy.locator( '#mobileNav a' ).first().getAttribute( 'href' ) ).toBe( await copy.locator( 'nav a' ).first().getAttribute( 'href' ) );
		}
		await copy.close();
	} finally {
		await browser.close();
		await new Promise< void >( resolve => server.close( () => resolve() ) );
		rmSync( root, { recursive: true, force: true } );
	}
}, 240_000 );
