import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { describe, expect } from 'vitest';
import { it } from '../../../test/browser.js';
import { captureFullPageScreenshot, captureViewportScreenshot } from './viewport-screenshot.js';
import { holdVideoFrames } from './video-hold.js';

// One browser pass, approximately four seconds. Record a real seekable clip
// locally rather than depending on a codec fixture or an external media host.
describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'video screenshot hold', () => {
	it( 'rewinds a playing looping video on both screenshot paths without changing its HTML', async ( { newPage } ) => {
		const page = await newPage( { viewport: { width: 160, height: 120 } } );
		await page.route( 'http://video.test/', route => route.fulfill( { contentType: 'text/html', body: '<style>body{margin:0}video{width:160px;height:120px}</style><video autoplay muted loop playsinline></video>' } ) );
		await page.goto( 'http://video.test/' );
		await page.evaluate( async () => {
			const canvas = document.createElement( 'canvas' );
			canvas.width = 160; canvas.height = 120;
			const ctx = canvas.getContext( '2d' )!;
			ctx.fillStyle = 'red'; ctx.fillRect( 0, 0, 160, 120 );
			const stream = canvas.captureStream( 30 );
			const recorder = new MediaRecorder( stream, { mimeType: 'video/webm;codecs=vp8' } );
			const chunks: Blob[] = [];
			recorder.ondataavailable = event => chunks.push( event.data );
			const stopped = new Promise<void>( resolve => { recorder.onstop = () => resolve(); } );
			recorder.start();
			for ( const color of [ 'red', 'blue', 'lime' ] ) {
				ctx.fillStyle = color; ctx.fillRect( 0, 0, 160, 120 );
				await new Promise( resolve => setTimeout( resolve, 400 ) );
			}
			recorder.stop(); await stopped;
			stream.getTracks().forEach( track => track.stop() );
			const video = document.querySelector( 'video' )!;
			video.src = URL.createObjectURL( new Blob( chunks, { type: 'video/webm' } ) );
			await video.play();
		} );
		const html = await page.locator( 'video' ).evaluate( video => video.outerHTML );
		await page.waitForTimeout( 600 );
		const reference = PNG.sync.read( await captureViewportScreenshot( page ) );
		await page.locator( 'video' ).evaluate( video => ( video as HTMLVideoElement ).play() );
		await page.waitForTimeout( 1_000 );
		const candidate = PNG.sync.read( await captureFullPageScreenshot( page ) );
		expect( candidate.data.equals( reference.data ) ).toBe( true );
		// The held frame is the first (red) frame, not just an arbitrary pause.
		expect( reference.data[ 0 ] ).toBeGreaterThan( 240 );
		expect( reference.data[ 1 ] ).toBeLessThan( 15 );
		expect( await page.locator( 'video' ).evaluate( video => ( { time: ( video as HTMLVideoElement ).currentTime, paused: ( video as HTMLVideoElement ).paused, html: video.outerHTML } ) ) ).toEqual( { time: 0, paused: true, html } );
	}, 20_000 );

	it( 'keeps an unstarted poster and tolerates unavailable media', async ( { newPage } ) => {
		const page = await newPage();
		await page.setContent( '<video autoplay loop poster="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\'/%3E"></video><video></video>' );
		const html = await page.content();
		await holdVideoFrames( page );
		expect( await page.content() ).toBe( html );
		expect( await page.locator( 'video' ).evaluateAll( ( videos: HTMLVideoElement[] ) => videos.map( video => ( { paused: video.paused, time: video.currentTime } ) ) ) ).toEqual( [ { paused: true, time: 0 }, { paused: true, time: 0 } ] );
	}, 10_000 );
} );
