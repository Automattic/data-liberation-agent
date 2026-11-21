import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'cheerio';
import { describe, expect } from 'vitest';
import { it } from '../../../test/browser.js';
import { CHROME_HYDRATION_LANDMARKS, waitForChromePlaceholderLinks, waitForDialogContent } from './chrome-hydration.js';
import { captureTriggeredDialogs } from './interaction-capture.js';
import { captureScreenshots } from './screenshotter.js';

// A store widget server-renders its header cart as a nameless placeholder link
// and hydrates it later (#1261). The delay is longer than the document settles.
const hydratingCart = ( delayMs: number ) => `<!doctype html><html><head><meta charset="utf-8"><title>Shop</title>
<style>header{display:flex;gap:1rem;padding:1rem}a.cart{display:inline-block;width:32px;height:32px;background:#333}</style></head>
<body><header><a href="/">Shop</a><a class="cart" role="button"><svg width="32" height="32"><text class="count"></text></svg></a></header>
<main><h1>Products</h1><p>Plain page content.</p></main>
<script>addEventListener('load',()=>setTimeout(()=>{const cart=document.querySelector('a.cart');cart.href='/cart';cart.setAttribute('aria-label','Cart with 0 items');cart.querySelector('.count').textContent='0';},${ delayMs }));</script>
</body></html>`;

describe( 'chrome hydration', () => {
	it( 'waits for a nameless header placeholder link to gain a destination or name', async ( { newPage } ) => {
		const page = await newPage();
		await page.setContent( `<header><a class="cart"><svg width="20" height="20"></svg></a></header>
			<script>setTimeout(()=>{const a=document.querySelector('a.cart');a.href='/cart';a.setAttribute('aria-label','Cart');},400)</script>` );
		const outcome = await page.evaluate( waitForChromePlaceholderLinks, { timeoutMs: 5_000, landmarks: CHROME_HYDRATION_LANDMARKS } );
		expect( outcome ).toMatchObject( { placeholders: 1, pending: 0 } );
		expect( outcome.waitedMs ).toBeGreaterThanOrEqual( 300 );
		expect( await page.locator( 'a.cart' ).getAttribute( 'href' ) ).toBe( '/cart' );
	} );

	it( 'does not wait for named, hidden or out-of-chrome placeholder links', async ( { newPage } ) => {
		const page = await newPage();
		await page.setContent( `<header><a>Skip</a><a aria-label="Account"><svg width="20" height="20"></svg></a><a hidden><svg width="20" height="20"></svg></a><a style="display:none"></a></header>
			<main><a class="anchor"><svg width="20" height="20"></svg></a></main>` );
		const outcome = await page.evaluate( waitForChromePlaceholderLinks, { timeoutMs: 5_000, landmarks: CHROME_HYDRATION_LANDMARKS } );
		expect( outcome ).toEqual( { placeholders: 0, pending: 0, pendingLinks: [], waitedMs: 0 } );
	} );

	it( 'reports a placeholder that never hydrates once the bound ends', async ( { newPage } ) => {
		const page = await newPage();
		await page.setContent( '<nav><a class="stuck" data-hook="cart-icon"><svg width="20" height="20"></svg></a></nav>' );
		const outcome = await page.evaluate( waitForChromePlaceholderLinks, { timeoutMs: 300, landmarks: CHROME_HYDRATION_LANDMARKS } );
		expect( outcome ).toMatchObject( { placeholders: 1, pending: 1, pendingLinks: [ 'a.stuck[data-hook="cart-icon"]' ] } );
	} );

	it( 'waits for a dialog shell to mount its content, and returns at once for a filled dialog', async ( { newPage } ) => {
		const page = await newPage();
		await page.setContent( `<div id="shell" role="dialog" aria-label="Side cart"><div class="content"><div></div></div></div><div id="full" role="dialog"><p>Ready</p></div>
			<script>setTimeout(()=>{document.querySelector('#shell .content').innerHTML='<h2>Cart</h2><p>Cart is empty.</p>';},400)</script>` );
		expect( await page.evaluate( waitForDialogContent, { selector: '#full', timeoutMs: 5_000 } ) ).toBe( 'present' );
		expect( await page.evaluate( waitForDialogContent, { selector: '#shell', timeoutMs: 5_000 } ) ).toBe( 'mounted' );
		expect( await page.evaluate( waitForDialogContent, { selector: '#missing', timeoutMs: 5_000 } ) ).toBe( 'empty' );
	} );

	// One local route, desktop only (~10s with Chromium).
	it( 'serializes a late-hydrating header cart as the hydrated control', async ( { serve } ) => {
		const { origin } = await serve( ( _, response ) => {
			response.setHeader( 'Content-Type', 'text/html' );
			response.end( hydratingCart( 8_000 ) );
		} );
		mkdirSync( '.tmp-test', { recursive: true } );
		const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test/chrome-hydration-' ) );
		try {
			const url = `${ origin }/`;
			const result = await captureScreenshots( {
				urls: [ url ], outputDir, concurrency: 1, settleMs: 0, learnFluid: false,
				viewports: [ { id: 'desktop', width: 1280, height: 800 } ],
			} );
			expect( result.failed ).toBe( 0 );
			const entry = JSON.parse( readFileSync( result.manifestPath, 'utf8' ) ).entries[ url ];
			const $ = load( readFileSync( join( outputDir, entry.html ), 'utf8' ) );
			expect( $( 'header a.cart' ).attr( 'href' ) ).toBe( '/cart' );
			expect( $( 'header a.cart' ).attr( 'aria-label' ) ).toBe( 'Cart with 0 items' );
			expect( $( 'header a.cart .count' ).text() ).toBe( '0' );
		} finally {
			rmSync( outputDir, { recursive: true, force: true } );
		}
	}, 60_000 );

	it( 'captures a chrome dialog after its content mounts, not its empty shell', async ( { newPage } ) => {
		const page = await newPage();
		await page.setContent( `<header><button class="cart" aria-label="Cart">Cart</button></header><main><h1>Shop</h1></main>
			<div id="popups" hidden></div>
			<script>
			document.querySelector('button.cart').addEventListener('click',()=>{
				const root=document.getElementById('popups');root.hidden=false;
				root.innerHTML='<div role="dialog" aria-modal="true" aria-label="Side cart" style="position:fixed;inset:0;background:#fff"><div class="content"><div></div></div></div>';
				setTimeout(()=>{root.querySelector('.content').innerHTML='<h2>Cart</h2><p>Cart is empty.</p><button aria-label="Close cart">x</button>';},1_200);
			});
			</script>` );
		const report = await captureTriggeredDialogs( page, 'https://fixture.test/' );
		const cart = report.states.find( state => state.status === 'captured' && state.trigger.label === 'Cart' );
		expect( cart?.dialog?.html ).toContain( 'Cart is empty.' );
	}, 30_000 );
} );
