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
