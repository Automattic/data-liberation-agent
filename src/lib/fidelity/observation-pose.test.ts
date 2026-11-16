import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect } from 'vitest';
import { it } from '../../../test/browser.js';
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

	it( 'measures the swept document at the top pose', async ({ newPage }) => {

		{
			const page = await newPage( { viewport: { width: 800, height: 600 } } );
			await page.setContent( fixture( false ) );
			const observation = await observePage( page, 'about:blank', 800, 0, null, undefined, undefined, true, false );
			expect( observation.images.map( image => [ image.x, image.y ] ) ).toEqual( [ [ 0, 0 ] ] );
		}
	}, 60_000 );

	it( 'restores the baseline after a post-sweep fragment probe before measuring geometry', async ({ newPage }) => {

		{
			const page = await newPage( { viewport: { width: 800, height: 600 } } );
			await page.setContent( fixture( false ) + '<a href="#target">Jump</a><div id="target">Target</div>' );
			const observation = await observePage( page, 'about:blank', 800, 0, null, undefined, async () => {
				expect( await page.evaluate( () => scrollY ) ).toBe( 0 );
				await page.locator( 'a' ).evaluate( link => ( link as HTMLAnchorElement ).click() );
				expect( await page.evaluate( () => scrollY ) ).toBeGreaterThan( 0 );
			}, true, false );
			expect( await page.evaluate( () => scrollY ) ).toBe( 0 );
			expect( observation.images.map( image => [ image.x, image.y ] ) ).toEqual( [ [ 0, 0 ] ] );
		}
	}, 60_000 );

	it( 'refuses to report geometry from a page that will not return to the top', async ({ newPage }) => {

		{
			const page = await newPage( { viewport: { width: 800, height: 600 } } );
			await page.setContent( fixture( true ) );
			await expect( observePage( page, 'about:blank', 800, 0, null, undefined, undefined, true, false ) )
				.rejects.toThrow( /Observation pose unproven: .* \(0, 700\)/ );
		}
	}, 60_000 );
} );
