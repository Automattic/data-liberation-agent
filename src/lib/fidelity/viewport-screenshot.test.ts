import { existsSync } from 'node:fs';
import { chromium, devices } from 'playwright';
import { PNG } from 'pngjs';
import { describe, expect } from 'vitest';
import { it } from '../../../test/browser.js';
import { captureFullPageScreenshot, captureViewportScreenshot } from './viewport-screenshot.js';

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'compositor viewport evidence', () => {
	it( 'captures the complete fixed-width mobile frame without changing its viewport or raster', async ({ newContext }) => {

		{
			const { defaultBrowserType: _browserType, ...iphone } = devices[ 'iPhone 17' ];
			const context = await newContext( iphone );
			const page = await context.newPage();
			await page.setViewportSize( { width: 390, height: 900 } );
			await page.setContent( '<meta name="viewport" content="width=320,user-scalable=yes"><style>body{margin:0;background:rgb(11,22,33)}main{height:2000px}</style><main>Neutral mobile frame</main>' );
			const before = await page.evaluate( () => ( { width: innerWidth, height: innerHeight, scale: visualViewport!.scale } ) );
			const clipped = PNG.sync.read( await page.screenshot( { scale: 'css' } ) );
			expect( [ clipped.width, clipped.height ] ).toEqual( [ 390, 899 ] );
			const complete = PNG.sync.read( await captureViewportScreenshot( page ) );
			expect( [ complete.width, complete.height ] ).toEqual( [ 390, 900 ] );
			expect( [ ...complete.data.subarray( ( 899 * 390 ) * 4, ( 899 * 390 ) * 4 + 4 ) ] ).toEqual( [ 11, 22, 33, 255 ] );
			expect( await page.evaluate( () => ( { width: innerWidth, height: innerHeight, scale: visualViewport!.scale } ) ) ).toEqual( before );
			expect( before.width ).toBe( 320 );
			expect( before.scale ).toBe( 1.21875 );
		}
	}, 30_000 );
	it( 'captures desktop CSS dimensions with the fractional capture DPR', async ({ newPage }) => {

		{
			const page = await newPage( { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 0.7 } );
			await page.setContent( '<main>Neutral desktop frame</main>' );
			// Raw CDP capture does not wait for the initial compositor frame like
			// Playwright's screenshot API does. Let the new page paint first.
			await page.evaluate( () => new Promise<void>( resolve => requestAnimationFrame( () => requestAnimationFrame( () => resolve() ) ) ) );
			const raster = PNG.sync.read( await captureViewportScreenshot( page ) );
			expect( [ raster.width, raster.height ] ).toEqual( [ 1440, 900 ] );
		}
	}, 30_000 );
	it( 'paints the resting pose of a scroll-state transition still settling when the full page is taken', async ({ newPage }) => {
		// #2048: a navbar shrinks on scroll and grows back over 0.3s. A scroll
		// probe that just returned to the top, and the beyond-viewport capture
		// itself (it re-evaluates media queries), start that transition; the
		// raster must show where it ends, not part-way.
		const page = await newPage( { viewport: { width: 1440, height: 900 } } );
		await page.setContent( `<style>
			body { margin: 0; background: rgb(255,255,255) } main { height: 4000px }
			#logo { position: fixed; top: 0; left: 0; height: 40px; width: 100px; background: rgb(255,0,0) }
			@media (min-width: 992px) { #logo { width: 300px; transition: width 2s linear } #logo.shrink { width: 100px } }
		</style><div id="logo"></div><main></main>
		<script>document.addEventListener( 'scroll', () => document.getElementById( 'logo' ).classList.toggle( 'shrink', scrollY > 0 ) );</script>` );
		await page.evaluate( async () => {
			scrollTo( 0, 1200 );
			await new Promise<void>( resolve => requestAnimationFrame( () => requestAnimationFrame( () => resolve() ) ) );
			await new Promise<void>( resolve => setTimeout( resolve, 2_100 ) );
			scrollTo( 0, 0 );
		} );
		const raster = PNG.sync.read( await captureFullPageScreenshot( page ) );
		const red = ( x: number ) => raster.data[ ( 20 * raster.width + x ) * 4 ] === 255 && raster.data[ ( 20 * raster.width + x ) * 4 + 1 ] === 0;
		expect( [ red( 150 ), red( 290 ), red( 310 ) ] ).toEqual( [ true, true, false ] );
		// The page keeps its own transitions once the screenshot is taken.
		expect( await page.evaluate( () => getComputedStyle( document.getElementById( 'logo' )! ).transitionProperty ) ).toBe( 'width' );
	}, 30_000 );
} );
