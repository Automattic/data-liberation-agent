import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { CapturedResourceStore } from './resource-capture.js';
import { capturePageHtml } from './screenshotter.js';
import { preserveStreamedVideoPosters } from './streamed-video.js';

const PAGE_URL = 'https://streamed-video.test/';

// A player that feeds <video> through Media Source Extensions, the way HLS and
// DASH players do: the element's src is a `blob:` URL that only exists inside
// this page session. `frames` records a real (solid red) clip in the browser and
// appends it, so the element has a decoded frame; without it the MediaSource is
// attached but never fed.
async function streamedVideoPage(
	browser: Browser,
	{ frames, attributes = '', sourceChild = false }: { frames: boolean; attributes?: string; sourceChild?: boolean }
): Promise< Page > {
	const page = await browser.newPage( { viewport: { width: 800, height: 600 } } );
	await page.route( PAGE_URL, ( route ) =>
		route.fulfill( {
			contentType: 'text/html',
			body: `<!doctype html><html><body><section><video muted loop playsinline autoplay ${ attributes } style="width:320px;height:180px"></video></section></body></html>`,
		} )
	);
	await page.goto( PAGE_URL );
	await page.evaluate(
		async ( { frames, sourceChild } ) => {
			const video = document.querySelector( 'video' )!;
			const mediaSource = new MediaSource();
			const blobUrl = URL.createObjectURL( mediaSource );
			if ( sourceChild ) {
				const source = document.createElement( 'source' );
				source.src = blobUrl;
				video.appendChild( source );
				video.load();
			} else {
				video.src = blobUrl;
			}
			await new Promise( ( done ) => mediaSource.addEventListener( 'sourceopen', done, { once: true } ) );
			if ( ! frames ) return;
			const canvas = document.createElement( 'canvas' );
			canvas.width = 160;
			canvas.height = 90;
			const context = canvas.getContext( '2d' )!;
			const paint = () => {
				context.fillStyle = '#ff0000';
				context.fillRect( 0, 0, canvas.width, canvas.height );
			};
			paint();
			const recorder = new MediaRecorder( canvas.captureStream( 30 ), { mimeType: 'video/webm;codecs=vp8' } );
			const chunks: Blob[] = [];
			recorder.ondataavailable = ( event ) => chunks.push( event.data );
			const stopped = new Promise( ( done ) => ( recorder.onstop = done ) );
			recorder.start();
			const timer = setInterval( paint, 30 );
			await new Promise( ( done ) => setTimeout( done, 600 ) );
			clearInterval( timer );
			recorder.stop();
			await stopped;
			const buffer = mediaSource.addSourceBuffer( 'video/webm; codecs="vp8"' );
			buffer.appendBuffer( await new Blob( chunks ).arrayBuffer() );
			await new Promise( ( done ) => buffer.addEventListener( 'updateend', done, { once: true } ) );
			mediaSource.endOfStream();
			await video.play().catch( () => undefined );
			for ( let attempt = 0; attempt < 50 && video.readyState < 2; attempt++ )
				await new Promise( ( done ) => setTimeout( done, 50 ) );
		},
		{ frames, sourceChild }
	);
	return page;
}

function videoTag( html: string ): string {
	return /<video\b[^>]*>/i.exec( html )?.[ 0 ] ?? '';
}

describe( 'stream-backed (MSE) video capture', () => {
	let browser: Browser;
	let outputDir: string;

	beforeAll( async () => {
		browser = await chromium.launch();
		const parent = join( process.cwd(), '.tmp-test' );
		mkdirSync( parent, { recursive: true } );
		outputDir = mkdtempSync( join( parent, 'streamed-video-' ) );
	} );

	afterAll( async () => {
		await browser.close();
		rmSync( outputDir, { recursive: true, force: true } );
	} );

	it( 'never serializes a session-only blob: media URL', async () => {
		const page = await streamedVideoPage( browser, { frames: false } );
		expect( await page.evaluate( () => document.querySelector( 'video' )!.currentSrc ) ).toMatch( /^blob:/ );

		const html = await capturePageHtml( page );

		expect( html ).not.toContain( 'blob:' );
		expect( videoTag( html ) ).not.toMatch( /\ssrc=/ );
		// Playback attributes still describe the element faithfully.
		expect( videoTag( html ) ).toMatch( /\sautoplay/ );
		expect( videoTag( html ) ).toMatch( /\sloop/ );
		await page.close();
	} );

	it( 'drops a blob: <source> child too', async () => {
		const page = await streamedVideoPage( browser, { frames: false, sourceChild: true } );

		const html = await capturePageHtml( page );

		expect( html ).not.toContain( 'blob:' );
		expect( html ).not.toContain( '<source' );
		await page.close();
	} );

	it( 'promotes a declared data-poster to the poster the copy shows', async () => {
		const page = await streamedVideoPage( browser, {
			frames: false,
			attributes: 'data-poster="/media/still.jpg"',
		} );
		const store = new CapturedResourceStore( outputDir, PAGE_URL );

		await preserveStreamedVideoPosters( page, store, PAGE_URL );
		const html = await capturePageHtml( page );

		expect( html ).not.toContain( 'blob:' );
		expect( videoTag( html ) ).toContain( 'poster="https://streamed-video.test/media/still.jpg"' );
		await page.close();
	} );

	it( 'keeps an authored poster as-is', async () => {
		const page = await streamedVideoPage( browser, {
			frames: true,
			attributes: 'poster="https://cdn.streamed-video.test/authored.jpg"',
		} );
		const store = new CapturedResourceStore( outputDir, PAGE_URL );

		await preserveStreamedVideoPosters( page, store, PAGE_URL );
		const html = await capturePageHtml( page );

		expect( html ).not.toContain( 'blob:' );
		expect( videoTag( html ) ).toContain( 'poster="https://cdn.streamed-video.test/authored.jpg"' );
		await page.close();
	} );

	it( 'captures a still frame of the playing video as a poster image asset', async () => {
		const page = await streamedVideoPage( browser, { frames: true } );
		expect( await page.evaluate( () => document.querySelector( 'video' )!.readyState ) ).toBeGreaterThanOrEqual( 2 );
		const store = new CapturedResourceStore( outputDir, PAGE_URL );

		await preserveStreamedVideoPosters( page, store, PAGE_URL );
		const html = await capturePageHtml( page );
		await store.flush();

		expect( html ).not.toContain( 'blob:' );
		expect( html ).not.toContain( 'data-dla-' );
		const poster = /\sposter="([^"]+)"/.exec( videoTag( html ) )?.[ 1 ];
		expect( poster ).toMatch( /^https:\/\/streamed-video\.test\/_dla\/video-frames\/[0-9a-f]{16}\.jpg$/ );

		// The frame is recorded like any captured dependency, so export localizes it.
		const manifest = JSON.parse( readFileSync( join( outputDir, 'resources', 'manifest.json' ), 'utf8' ) );
		const resource = manifest.resources[ poster! ];
		expect( resource ).toMatchObject( { contentType: 'image/jpeg' } );
		const file = resolve( outputDir, resource.path );
		expect( existsSync( file ) ).toBe( true );
		expect( readFileSync( file ).subarray( 0, 3 ) ).toEqual( Buffer.from( [ 0xff, 0xd8, 0xff ] ) );

		// It is the frame on screen: the recorded clip is solid red.
		const centre = await page.evaluate( async ( url ) => {
			const image = new Image();
			image.src = url;
			await image.decode();
			const canvas = document.createElement( 'canvas' );
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const context = canvas.getContext( '2d' )!;
			context.drawImage( image, 0, 0 );
			return [ ...context.getImageData( canvas.width >> 1, canvas.height >> 1, 1, 1 ).data ];
		}, `data:image/jpeg;base64,${ readFileSync( file ).toString( 'base64' ) }` );
		expect( centre[ 0 ] ).toBeGreaterThan( 200 );
		expect( centre[ 1 ] ).toBeLessThan( 60 );
		expect( centre[ 2 ] ).toBeLessThan( 60 );

		// Capture must not interrupt the live player later probes still observe.
		expect( await page.evaluate( () => document.querySelector( 'video' )!.currentSrc ) ).toMatch( /^blob:/ );
		await page.close();
	} );
} );
