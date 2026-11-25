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
	it( 'paints every image synchronously in the full-page frame and restores authored decoding', async ({ newPage }) => {
		const page = await newPage( { viewport: { width: 400, height: 300 } } );
		const pixel = new PNG( { width: 4, height: 4 } );
		for ( let i = 0; i < pixel.data.length; i += 4 ) pixel.data.set( [ 200, 40, 90, 255 ], i );
		const src = `data:image/png;base64,${ PNG.sync.write( pixel ).toString( 'base64' ) }`;
		await page.setContent( `<style>body{margin:0;background:rgb(11,22,33)}img{display:block;width:400px;height:300px}</style>
			<img id="async" decoding="async" src="${ src }"><img id="authored-auto" decoding="auto" src="${ src }"><img id="unset" src="${ src }">` );
		await page.evaluate( () => Promise.all( [ ...document.images ].map( image => image.decode() ) ) );
		// Chromium can leave an async-decoding image whose decode was evicted out of
		// the full-surface frame (a real page reproduced this only after a lazy-load
		// sweep). Pin the frame contract at the moment CDP captures it.
		const context = page.context();
		const newCDPSession = context.newCDPSession.bind( context );
		const atCapture: Array<Array<string | null>> = [];
		context.newCDPSession = async target => {
			const session = await newCDPSession( target );
			const send = session.send.bind( session ) as ( method: string, params?: object ) => Promise<unknown>;
			( session as unknown as { send: typeof send } ).send = async ( method, params ) => {
				if ( method === 'Page.captureScreenshot' ) atCapture.push( await page.evaluate( () => [ ...document.images ].map( image => image.decoding ) ) );
				return send( method, params );
			};
			return session;
		};
		const raster = PNG.sync.read( await captureFullPageScreenshot( page ) );
		expect( atCapture ).toEqual( [ [ 'sync', 'sync', 'sync' ] ] );
		expect( [ ...raster.data.subarray( ( 150 * 400 + 200 ) * 4, ( 150 * 400 + 200 ) * 4 + 4 ) ] ).toEqual( [ 200, 40, 90, 255 ] );
		expect( await page.evaluate( () => [ ...document.images ].map( image => image.getAttribute( 'decoding' ) ) ) ).toEqual( [ 'async', 'auto', null ] );
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
} );
