import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { capturePageHtml } from './screenshotter.js';
import { applySourceCleanup, cleanupPolicy, sweepSourceCleanup } from '../source-cleanup.js';

// A source widget can mount after the pre-serialization sweep, while capture
// still waits on the document (here a pending video source). Once the cleanup
// observer has spent its budget, only a sweep inside the serializing task
// keeps the widget out of the saved document.
it( 'serializes without a cleanup match that mounted after the last sweep', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.setContent( '<main><p>Content</p><video></video></main>' );
		await applySourceCleanup( page, cleanupPolicy( [ { id: 'chat', category: 'provider-service', selector: '.chat-widget' } ] ) );
		await page.evaluate( () => ( window as unknown as { __dlaCleanup: { observer: MutationObserver } } ).__dlaCleanup.observer.disconnect() );
		await sweepSourceCleanup( page );
		await page.evaluate( () => setTimeout( () => document.body.insertAdjacentHTML( 'beforeend', '<div class="chat-widget"><textarea></textarea></div>' ), 100 ) );
		const html = await capturePageHtml( page );
		expect( html ).toContain( 'Content' );
		expect( html ).not.toContain( 'chat-widget' );
	} finally { await browser.close(); }
}, 30_000 );

// A framework component re-mounts its banner when cleanup removes it. Removing
// the re-mounted copy again fights the runtime (a free Wix site's React locked
// up this way and every route stopped responding). Cleanup removes each match
// once, hides what the runtime puts back, and serialization still omits it.
it( 'hides a match the source runtime re-renders instead of removing it again', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.setContent( `<main><p>Owner content</p></main>
			<aside class="promo-bar">Static promo one</aside><aside class="promo-bar">Static promo two</aside>
			<div id="banner-host"></div>
			<script>
				window.mounts = 0;
				const host = document.getElementById( 'banner-host' );
				const mount = () => {
					const bar = document.createElement( 'div' );
					bar.className = 'promo-bar';
					bar.textContent = 'Runtime promo';
					host.append( bar );
					window.mounts++;
				};
				mount();
				new MutationObserver( () => { if ( ! host.querySelector( '.promo-bar' ) ) mount(); } ).observe( host, { childList: true } );
			</script>` );
		await applySourceCleanup( page, cleanupPolicy( [ { id: 'promo', category: 'source-attribution', selector: '.promo-bar' } ] ) );
		await page.waitForTimeout( 300 );
		const live = await page.evaluate( () => ( {
			mounts: ( window as unknown as { mounts: number } ).mounts,
			staticLeft: document.querySelectorAll( 'aside.promo-bar' ).length,
			hidden: Array.from( document.querySelectorAll( '#banner-host .promo-bar' ), ( bar ) => getComputedStyle( bar ).display ),
		} ) );
		// Mounted once by the page, re-mounted once after the only removal.
		expect( live.mounts ).toBe( 2 );
		expect( live.staticLeft ).toBe( 0 );
		expect( live.hidden ).toEqual( [ 'none' ] );
		const html = await capturePageHtml( page );
		expect( html ).toContain( 'Owner content' );
		expect( html ).not.toContain( 'class="promo-bar"' );
		expect( html ).not.toContain( 'data-dla-cleanup-hidden' );
	} finally { await browser.close(); }
}, 30_000 );
