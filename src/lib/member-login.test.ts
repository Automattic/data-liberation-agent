import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'cheerio';
import { afterEach, expect, it } from 'vitest';
import { cleanupPolicy } from './source-cleanup.js';
import { capture as wixCapture } from '../adapters/wix/capture.js';
import { captureScreenshots } from './screenshot/screenshotter.js';
import { exportWebsiteCapture } from './capture-export.js';
import { MEMBER_LOGIN_ATTRIBUTE } from './member-login.js';

const MARK = 'dla-member-login-wix';

let server: Server | undefined;
let directory: string | undefined;
afterEach( async () => {
	server?.closeAllConnections();
	if ( server ) await new Promise< void >( ( resolve ) => server!.close( () => resolve() ) );
	server = undefined;
	if ( directory ) rmSync( directory, { recursive: true, force: true } );
	directory = undefined;
} );

const membersDialog = `<div role="dialog" aria-modal="true" data-testid="siteMembersDialogLayout"><h2>Log In</h2><form data-testid="emailAuth"><input type="email"><input type="password"><button data-testid="submit">Log In</button></form></div>`;

// Wix's login bar as its runtime renders it for a visitor: a button that opens
// the members dialog. The hero links into the Wix members area, which a
// visitor only ever reaches through that same login.
const home = `<!doctype html><html><head><meta charset="utf-8"><title>Home | Owner HOA</title>
<style>body{margin:0;font:16px Arial}header,main{padding:20px}.O4eQsz{cursor:pointer;font:inherit;color:inherit;display:flex;align-items:center;padding:6px 7px;background:none;border:0}</style></head>
<body><div id="SITE_CONTAINER"><header id="SITE_HEADER"><nav><a href="/">Home</a> <a href="/contact">Contact</a></nav>
<div id="comp-login" class="wixui-login-social-bar login-social-bar" dir="ltr" tabindex="-1"><button class="O4eQsz" data-testid="handle-button" type="button" aria-haspopup="dialog"><svg width="20" height="20" viewBox="0 0 50 50"><circle cx="25" cy="25" r="25"></circle></svg><span class="HuH6Ex">Sign In</span></button></div></header>
<main><h1>Welcome neighbours</h1><p>${ 'Owner home content. '.repeat( 10 ) }</p>
<a id="hero-sign-in" class="wixui-button" href="/account/my-account" aria-label="Sign In"><span>Sign In</span></a>
<a id="contact" href="/contact">Contact us</a> <a id="elsewhere" href="https://elsewhere.example/account/my-account">Another site's account</a></main></div>
<script>document.querySelector('[data-testid="handle-button"]').addEventListener('click',()=>{const layer=document.createElement('div');layer.innerHTML=${ JSON.stringify( membersDialog ) };document.body.append(layer.firstElementChild)});</script>
</body></html>`;

async function source(): Promise< string > {
	server = createServer( ( req, res ) => {
		const path = new URL( req.url ?? '/', 'http://x' ).pathname;
		res.statusCode = path === '/' ? 200 : 404;
		res.setHeader( 'content-type', 'text/html' );
		res.end( path === '/' ? home : 'not found' );
	} );
	await new Promise< void >( ( resolve ) => server!.listen( 0, '127.0.0.1', resolve ) );
	return `http://localtest.me:${ ( server.address() as { port: number } ).port }/`;
}

it( 'marks Wix sign-in controls for the destination login without changing the elements', async () => {
	const url = await source();
	mkdirSync( join( process.cwd(), '.tmp-test' ), { recursive: true } );
	directory = mkdtempSync( join( process.cwd(), '.tmp-test', 'member-login-' ) );
	const result = await captureScreenshots( {
		urls: [ url ], primaryUrl: url, outputDir: directory,
		cleanupPolicy: cleanupPolicy( wixCapture.cleanupRules ), beforeSerialize: wixCapture.beforeSerialize,
		captureImages: true, learnFluid: false, settleMs: 200,
	} );
	expect( result.failed ).toBe( 0 );
	exportWebsiteCapture( { outputDir: directory, sourceUrl: url, platform: 'wix', summary: {}, failures: [] } );
	const $ = load( readFileSync( join( directory, 'website', 'index.html' ), 'utf8' ) );

	// The header control stays the runtime's own button (focusable, with its
	// classes, icon and label) and only gains the marker, as a class that
	// block conversion keeps and as a data attribute.
	const header = $( '.wixui-login-social-bar [data-testid="handle-button"]' );
	expect( header ).toHaveLength( 1 );
	expect( header.prop( 'tagName' ) ).toBe( 'BUTTON' );
	expect( header.hasClass( MARK ) ).toBe( true );
	expect( header.hasClass( 'O4eQsz' ) ).toBe( true );
	expect( header.attr( MEMBER_LOGIN_ATTRIBUTE ) ).toBe( 'wix' );
	expect( header.attr( 'type' ) ).toBe( 'button' );
	expect( header.text() ).toContain( 'Sign In' );
	expect( header.find( 'svg' ) ).toHaveLength( 1 );

	// A link into the members area is the same entry point and keeps its href.
	expect( $( '#hero-sign-in' ).hasClass( MARK ) ).toBe( true );
	expect( $( '#hero-sign-in' ).attr( MEMBER_LOGIN_ATTRIBUTE ) ).toBe( 'wix' );
	expect( $( '#hero-sign-in' ).attr( 'href' ) ).toContain( '/account/my-account' );
	// Ordinary links and other sites' account pages are left alone.
	expect( $( '#contact' ).hasClass( MARK ) ).toBe( false );
	expect( $( '#elsewhere' ).hasClass( MARK ) ).toBe( false );
	expect( $( `.${ MARK }` ) ).toHaveLength( 2 );
	// The provider's login itself stays out.
	expect( $.html() ).not.toContain( 'emailAuth' );
}, 240_000 );
