import { existsSync } from 'node:fs';
import { chromium, devices } from 'playwright';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { captureViewportScreenshot } from './viewport-screenshot.js';

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'compositor viewport evidence', () => {
	it( 'captures the complete fixed-width mobile frame without changing its viewport or raster', async () => {
		const browser = await chromium.launch();
		try {
			const { defaultBrowserType: _browserType, ...iphone } = devices[ 'iPhone 17' ];
			const context = await browser.newContext( iphone );
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
		} finally { await browser.close(); }
	}, 30_000 );
	it( 'captures desktop CSS dimensions with the fractional capture DPR', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 0.7 } );
			await page.setContent( '<main>Neutral desktop frame</main>' );
			const raster = PNG.sync.read( await captureViewportScreenshot( page ) );
			expect( [ raster.width, raster.height ] ).toEqual( [ 1440, 900 ] );
		} finally { await browser.close(); }
	}, 30_000 );
} );
