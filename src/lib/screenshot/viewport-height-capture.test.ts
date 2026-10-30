import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { learnAndApplyFluidGeometry } from './fluid-capture.js';

describe( 'viewport-sized inline geometry', () => {
	let browser: Browser;

	beforeAll( async () => {
		browser = await chromium.launch();
	} );

	afterAll( async () => {
		await browser.close();
	} );

	it( 'serializes a section the page pinned to the viewport height relative to the viewport', async () => {
		const page = await browser.newPage( { viewport: { width: 402, height: 681 } } );
		const copy = await browser.newPage( { viewport: { width: 390, height: 900 } } );
		try {
			// A pin-style runtime: the section takes the live viewport height inside
			// a spacer, and refreshes on resize. A width-derived sibling keeps the
			// width sweep running, as on any real responsive page.
			await page.setContent( `<style>body{margin:0}</style>
				<div id="spacer"><section id="pinned">Pinned section</section></div>
				<div id="fluid">Fluid</div><p id="after">After the section</p>
				<script>const refresh=()=>{
					const pinned=document.querySelector('#pinned');
					pinned.style.height=innerHeight+'px';pinned.style.maxHeight=innerHeight+'px';
					document.querySelector('#fluid').style.width=innerWidth/2+'px';
				};addEventListener('resize',refresh);refresh();</script>` );
			const result = await learnAndApplyFluidGeometry( page, { settleMs: 10 } );
			// The width sweep ran and fitted the sibling; height and max-height followed the probe.
			expect( result.sampledWidths.length ).toBeGreaterThan( 0 );
			expect( result.byKind[ 'viewport-height' ] ).toBe( 2 );
			expect( await page.locator( '[data-blocks-engine-capture-viewport-height],[data-blocks-engine-capture-fluid-release]' ).count() ).toBe( 0 );
			await page.locator( 'script' ).evaluateAll( nodes => nodes.forEach( node => node.remove() ) );
			const html = await page.content();
			await copy.setContent( html );
			const rendered = await copy.evaluate( () => ( {
				innerHeight,
				height: document.querySelector( '#pinned' )!.getBoundingClientRect().height,
				after: document.querySelector( '#after' )!.getBoundingClientRect().top,
			} ) );
			expect( rendered.innerHeight ).toBe( 900 );
			expect( rendered.height ).toBe( 900 );
			expect( rendered.after ).toBeGreaterThanOrEqual( 900 );
			// The copy keeps following the viewport without the source runtime.
			await copy.setViewportSize( { width: 390, height: 500 } );
			expect( await copy.evaluate( () => document.querySelector( '#pinned' )!.getBoundingClientRect().height ) ).toBe( 500 );
		} finally {
			await page.close();
			await copy.close();
		}
	}, 60_000 );

	it( 'keeps a pixel height that only coincides with the capture viewport height', async () => {
		const page = await browser.newPage( { viewport: { width: 402, height: 681 } } );
		try {
			await page.setContent( `<section id="fixed">Fixed</section>
				<script>document.querySelector('#fixed').style.height='681px';addEventListener('resize',()=>{});</script>` );
			await learnAndApplyFluidGeometry( page, { settleMs: 10 } );
			expect( await page.locator( '#fixed' ).evaluate( node => ( node as HTMLElement ).style.height ) ).toBe( '681px' );
			expect( page.viewportSize() ).toEqual( { width: 402, height: 681 } );
		} finally {
			await page.close();
		}
	}, 60_000 );
} );
