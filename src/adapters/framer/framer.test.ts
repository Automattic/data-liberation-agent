import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectFromHttp, detectPlatform } from '../../index.js';
import { applySourceCleanup, cleanupPolicy } from '../../lib/source-cleanup.js';
import { framerAdapter } from './index.js';

describe( 'framer platform', () => {
	afterEach( () => vi.unstubAllGlobals() );

	it( 'detects a hosted Framer subdomain from its URL', async () => {
		const result = await detectPlatform( 'https://example-studio.framer.website/' );
		expect( result.platform ).toBe( 'framer' );
	} );

	it( 'detects a custom domain from the Framer server header', async () => {
		vi.stubGlobal( 'fetch', vi.fn().mockResolvedValue( {
			ok: true,
			headers: new Map( [ [ 'server', 'Framer/4b7df70' ] ] ),
			text: () => Promise.resolve( '<html><body>Owner site</body></html>' ),
		} ) );
		const result = await detectFromHttp( 'https://www.custom-domain-business.com' );
		expect( result.platform ).toBe( 'framer' );
		expect( result.signals ).toContain( 'Server: Framer header' );
	} );

	it( 'detects a custom domain from the Framer page source', async () => {
		vi.stubGlobal( 'fetch', vi.fn().mockResolvedValue( {
			ok: true,
			headers: new Map(),
			text: () => Promise.resolve( '<html><head><meta name="generator" content="Framer 835d061"></head><body></body></html>' ),
		} ) );
		const result = await detectFromHttp( 'https://www.custom-domain-business.com' );
		expect( result.platform ).toBe( 'framer' );
		expect( result.signals ).toContain( 'Framer generator meta tag in page source' );
	} );

	it( 'removes the "Made in Framer" badge overlay without touching owner content', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			await page.setContent( `<!doctype html><html><head><style>body{margin:0}
				#__framer-badge-container{pointer-events:none;width:100%;justify-content:flex-end;padding:20px;display:flex;position:fixed;bottom:0}</style></head><body>
				<main><h1>Owner site</h1><a href="https://www.framer.com/features/">Owner link about our tools</a></main>
				<div id="__framer-badge-container"><a class="__framer-badge" href="https://www.framer.com" title="Create a free website with Framer"><span>Made in Framer</span></a></div>
				</body></html>` );
			await applySourceCleanup( page, cleanupPolicy( framerAdapter.liberation?.cleanupRules ) );
			expect( await page.locator( '#__framer-badge-container' ).count() ).toBe( 0 );
			expect( await page.locator( 'main h1' ).innerText() ).toBe( 'Owner site' );
		} finally {
			await browser.close();
		}
	} );
} );
