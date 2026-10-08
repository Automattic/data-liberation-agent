import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { lovableAdapter } from './index.js';
import { applySourceCleanup, cleanupPolicy } from '../../lib/source-cleanup.js';
import { inspectSourceInteractivity } from '../../lib/source-interactivity.js';

describe( 'Lovable provider-script ownership', () => {
	let browser: Browser;
	beforeAll( async () => { browser = await chromium.launch(); } );
	afterAll( async () => { await browser.close(); } );
	it( 'removes badge behavior without hiding retained application motion', async () => {
		const page = await browser.newPage();
		try {
			await page.setContent( `<main><button id="feature">Feature</button><p id="result">Ready</p></main><aside id="lovable-badge"><button id="lovable-badge-close">Close badge</button></aside>
<script>(()=>{const close=document.querySelector('#lovable-badge-close');if(close)close.addEventListener('click',()=>{const badge=document.querySelector('#lovable-badge');if(badge){badge.classList.add('closing');setTimeout(()=>badge.style.display='none',10);}});})();</script>
<script type="application/json">{"example":"document.querySelector('#lovable-badge-close')"}</script>` );
			await applySourceCleanup( page, cleanupPolicy( lovableAdapter.liberation!.cleanupRules ) );
			const resources = { version: 1 as const, resources: {}, failures: [] };
			const before = inspectSourceInteractivity( await page.content(), 'https://fixture.test/', '.', resources );
			expect( before.status ).toBe( 'unreproduced' );
			await lovableAdapter.liberation!.prepare!( page, { url: 'https://fixture.test/', viewport: 'desktop' } );
			expect( inspectSourceInteractivity( await page.content(), 'https://fixture.test/', '.', resources ).status ).toBe( 'not_detected' );
			expect( JSON.parse( ( await page.locator( 'script[type="application/json"]' ).textContent() )! ) ).toEqual( { example: "document.querySelector('#lovable-badge-close')" } );
			await page.addScriptTag( { content: `const badge=document.querySelector('#lovable-badge-close');feature.addEventListener('click',()=>setTimeout(()=>result.textContent='Changed',10));` } );
			await lovableAdapter.liberation!.prepare!( page, { url: 'https://fixture.test/', viewport: 'desktop' } );
			await page.locator( '#feature' ).click();
			await expect.poll( () => page.locator( '#result' ).textContent() ).toBe( 'Changed' );
			expect( inspectSourceInteractivity( await page.content(), 'https://fixture.test/', '.', resources ).status ).toBe( 'unreproduced' );
		} finally { await page.close(); }
	} );
} );
