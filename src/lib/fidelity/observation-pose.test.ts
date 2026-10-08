import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { observePage } from './check.js';

// Image and text geometry are viewport-relative. An observation that ran the
// lazy-load sweep must describe the document at its top pose, never wherever
// the page was left scrolled.
describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'observation pose', () => {
	const fixture = ( pin: boolean ) => `<style>body{margin:0}</style>
		<img alt="" width="400" height="300" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22300%22/%3E">
		<main style="height:3000px">Content</main>
		<script>${ pin ? `let armed = false;
			addEventListener( 'scroll', () => { if ( scrollY > 0 ) armed = true; else if ( armed ) scrollTo( { top: 700, behavior: 'instant' } ); } );` : '' }</script>`;

	it( 'measures the swept document at the top pose', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { viewport: { width: 800, height: 600 } } );
			await page.setContent( fixture( false ) );
			const observation = await observePage( page, 'about:blank', 800, 0, null, undefined, undefined, true, false );
			expect( observation.images.map( image => [ image.x, image.y ] ) ).toEqual( [ [ 0, 0 ] ] );
		} finally { await browser.close(); }
	}, 60_000 );

	it( 'refuses to report geometry from a page that will not return to the top', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { viewport: { width: 800, height: 600 } } );
			await page.setContent( fixture( true ) );
			await expect( observePage( page, 'about:blank', 800, 0, null, undefined, undefined, true, false ) )
				.rejects.toThrow( /Observation pose unproven: .* \(0, 700\)/ );
		} finally { await browser.close(); }
	}, 60_000 );
} );
