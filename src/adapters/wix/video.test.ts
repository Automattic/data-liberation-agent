import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capture } from './capture.js';
import { selectWixVideoRendition, wixVideoRecord } from './video.js';

const MB = 1024 * 1024;

/** A `data-video-info` record in the shape the Wix video player publishes. */
function videoInfo( origin: string ): string {
	const rendition = ( quality: string, width: number, height: number ) => ( {
		quality,
		width,
		height,
		types: [ { format: 'mp4', uri: `video/clip/${ quality }/mp4/file.mp4`, url: `${ origin }/video/clip/${ quality }/mp4/file.mp4` } ],
	} );
	return JSON.stringify( {
		name: 'clip.mp4',
		poster: { uri: 'clip-poster.jpg', width: 1920, height: 1080, url: `${ origin }/media/clip-poster.jpg/v1/fill/w_1920,h_1080/clip-poster.jpg` },
		adaptiveSources: [ { format: 'hls', url: `${ origin }/site/media/video/clip/hls` } ],
		sources: [
			rendition( '360p', 640, 360 ),
			rendition( '480p', 854, 480 ),
			rendition( '720p', 1280, 720 ),
			rendition( '1080p', 1920, 1080 ),
		],
		hasAudio: true,
		autoplay: true,
		focalPoint: { x: 50, y: 30 },
	} );
}

const BYTES: Record< string, number > = {
	'/video/clip/360p/mp4/file.mp4': 1 * MB,
	'/video/clip/480p/mp4/file.mp4': 2 * MB,
	'/video/clip/720p/mp4/file.mp4': 4 * MB,
	// Larger than a portable media file may be.
	'/video/clip/1080p/mp4/file.mp4': 9 * MB,
};

describe( 'wixVideoRecord', () => {
	it( 'reads the progressive renditions and the poster, not the adaptive stream', () => {
		const record = wixVideoRecord( videoInfo( 'https://video.example.test' ) );
		expect( record?.renditions.map( ( rendition ) => [ rendition.width, rendition.height ] ) ).toEqual( [
			[ 640, 360 ], [ 854, 480 ], [ 1280, 720 ], [ 1920, 1080 ],
		] );
		expect( record?.renditions.every( ( rendition ) => rendition.url.endsWith( '/mp4/file.mp4' ) ) ).toBe( true );
		expect( record?.poster ).toBe( 'https://video.example.test/media/clip-poster.jpg/v1/fill/w_1920,h_1080/clip-poster.jpg' );
		expect( record?.focalPoint ).toEqual( { x: 50, y: 30 } );
	} );

	it( 'refuses records with no playable rendition', () => {
		expect( wixVideoRecord( 'not json' ) ).toBeNull();
		expect( wixVideoRecord( JSON.stringify( { sources: [ { width: 640, height: 360, types: [ { format: 'hls', url: 'https://x.test/a' } ] } ] } ) ) ).toBeNull();
	} );
} );

/** A `data-video-info` record in the shape a background `<wix-video>` publishes. */
function backgroundVideoInfo(): string {
	return JSON.stringify( {
		videoId: '498fe4_background',
		videoWidth: 1920,
		videoHeight: 1080,
		autoPlay: true,
		qualities: [
			{ quality: '480p', size: 409920, url: 'video/498fe4_background/480p/mp4/file.mp4' },
			{ quality: '720p', size: 921600, url: 'video/498fe4_background/720p/mp4/file.mp4' },
			{ quality: '1080p', size: 2073600, url: 'video/498fe4_background/1080p/mp4/file.mp4' },
		],
	} );
}

describe( 'wixVideoRecord on a background-video record', () => {
	it( 'reads the quality list, deriving each rendition from its label and the intrinsic size', () => {
		const record = wixVideoRecord( backgroundVideoInfo() );
		expect( record?.renditions.map( ( rendition ) => [ rendition.width, rendition.height, rendition.url ] ) ).toEqual( [
			[ 853, 480, 'https://video.wixstatic.com/video/498fe4_background/480p/mp4/file.mp4' ],
			[ 1280, 720, 'https://video.wixstatic.com/video/498fe4_background/720p/mp4/file.mp4' ],
			[ 1920, 1080, 'https://video.wixstatic.com/video/498fe4_background/1080p/mp4/file.mp4' ],
		] );
	} );

	it( 'refuses a background record with no intrinsic size to scale from', () => {
		expect( wixVideoRecord( JSON.stringify( { qualities: [ { quality: '720p', url: 'video/x/720p/mp4/file.mp4' } ] } ) ) ).toBeNull();
	} );
} );

describe( 'selectWixVideoRendition', () => {
	const renditions = wixVideoRecord( videoInfo( 'https://video.example.test' ) )!.renditions;
	const bytes = new Map( Object.entries( BYTES ).map( ( [ path, size ] ) => [ `https://video.example.test${ path }`, size ] ) );

	it( 'takes the smallest rendition that covers the rendered width', () => {
		expect( selectWixVideoRendition( renditions, 772, bytes )?.width ).toBe( 854 );
	} );

	it( 'falls back to the widest rendition a portable website can carry', () => {
		// 1440px wide wants 1080p, which is over the byte limit.
		expect( selectWixVideoRendition( renditions, 1448, bytes )?.width ).toBe( 1280 );
	} );

	it( 'keeps a rendition whose size is unknown eligible', () => {
		expect( selectWixVideoRendition( renditions, 1448, new Map() )?.width ).toBe( 1920 );
	} );
} );

describe.skipIf( ! existsSync( chromium.executablePath() ) )( 'Wix video player at serialization', () => {
	let server: Server;
	let origin: string;

	beforeAll( async () => {
		server = createServer( ( request, response ) => {
			const path = new URL( request.url ?? '/', 'http://localhost' ).pathname;
			if ( path in BYTES ) {
				response.writeHead( 200, { 'content-type': 'video/mp4', 'content-length': String( BYTES[ path ] ) } );
				response.end();
				return;
			}
			if ( path.startsWith( '/media/' ) ) {
				response.writeHead( 200, { 'content-type': 'image/svg+xml' } );
				response.end( '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"/>' );
				return;
			}
			const info = videoInfo( origin ).replace( /&/g, '&amp;' ).replace( /"/g, '&quot;' );
			response.writeHead( 200, { 'content-type': 'text/html' } );
			response.end( `<!doctype html><style>
				body{margin:0}
				.root{width:1440px;height:810px;container-type:size}
				.wrapper,.container,.box{position:relative;width:100%;height:100%}
				.wow{display:block;position:relative;width:100%;height:100%}
				.runtime-video{position:absolute;inset:0;width:100%;height:100%;opacity:0}
				.play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
			</style>
			<main>
				<div id="player" class="root wixui-video-upload"><div class="wrapper"><div class="container" style="--aspect-ratio:1.78" tabindex="0">
					<div class="box"><wow-video class="wow" data-video-info="${ info }">
						<video class="runtime-video" muted autoplay preload="none" src="${ origin }/video/clip/1080p/mp4/file.mp4"></video>
						<wow-image id="videoPoster_player"><img alt="clip.mp4" style="object-fit:cover;width:100%;height:100%" src="${ origin }/media/clip-poster.jpg/v1/fill/w_1440,h_810/clip.jpg"></wow-image>
					</wow-video></div>
					<div class="play"><button type="button" aria-label="Play video">▶</button></div>
				</div></div></div>
				<div id="background"><wow-video class="wow" data-video-info="${ info }"><video src="${ origin }/video/clip/360p/mp4/file.mp4"></video></wow-video></div>
			</main>` );
		} );
		await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
		origin = `http://127.0.0.1:${ ( server.address() as AddressInfo ).port }`;
	} );

	afterAll( async () => {
		await new Promise( ( resolve ) => server.close( resolve ) );
	} );

	it( 'leaves a standard video with a portable rendition, poster, controls and the source size', async () => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			await page.goto( `${ origin }/` );
			await capture.beforeSerialize!( page, { url: page.url(), viewport: 'desktop' } );

			const player = page.locator( '#player' );
			expect( await player.locator( 'wow-video' ).count() ).toBe( 0 );
			// The runtime's play button answers to nothing in a copy.
			expect( await player.locator( 'button' ).count() ).toBe( 0 );
			const video = player.locator( 'video' );
			expect( await video.count() ).toBe( 1 );
			const attributes = await video.evaluate( ( element ) => Object.fromEntries(
				[ ...element.attributes ].map( ( attribute ) => [ attribute.name, attribute.value ] )
			) );
			expect( attributes ).toMatchObject( {
				// 1440px wants 1080p, which a portable website cannot carry.
				src: `${ origin }/video/clip/720p/mp4/file.mp4`,
				poster: `${ origin }/media/clip-poster.jpg/v1/fill/w_1440,h_810/clip.jpg`,
				controls: '',
				width: '1280',
				height: '720',
			} );
			expect( attributes ).not.toHaveProperty( 'autoplay' );
			expect( attributes ).not.toHaveProperty( 'class' );
			// The static video fills the player box, as the runtime's did.
			expect( await video.evaluate( ( element ) => {
				const box = element.getBoundingClientRect();
				return [ box.width, box.height, getComputedStyle( element ).opacity ];
			} ) ).toEqual( [ 1440, 810, '1' ] );

			// A video outside the player component is not this contract.
			expect( await page.locator( '#background wow-video' ).count() ).toBe( 1 );
			expect( await page.content() ).not.toContain( 'data-blocks-engine-capture-wix-video' );
		} finally {
			await browser.close();
		}
	}, 30_000 );
} );

describe.skipIf( ! existsSync( chromium.executablePath() ) )( 'Wix background video at serialization', () => {
	let server: Server;
	let origin: string;

	beforeAll( async () => {
		server = createServer( ( request, response ) => {
			const path = new URL( request.url ?? '/', 'http://localhost' ).pathname;
			if ( path in BYTES ) {
				response.writeHead( 200, { 'content-type': 'video/mp4', 'content-length': String( BYTES[ path ] ) } );
				response.end();
				return;
			}
			response.writeHead( 404 );
			response.end();
		} );
		await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
		origin = `http://127.0.0.1:${ ( server.address() as AddressInfo ).port }`;
	} );

	afterAll( async () => {
		await new Promise( ( resolve ) => server.close( resolve ) );
	} );

	/** A background `<wix-video>` record: a quality list with absolute URLs, no per-entry dimensions. */
	function backgroundVideoInfo(): string {
		return JSON.stringify( {
			videoId: '498fe4_background',
			videoWidth: 1920,
			videoHeight: 1080,
			autoPlay: true,
			qualities: [ '480p', '720p', '1080p' ].map( ( quality ) => ( {
				quality,
				size: Number( quality.slice( 0, -1 ) ) * 1024,
				url: `${ origin }/video/clip/${ quality }/mp4/file.mp4`,
			} ) ),
		} );
	}

	it( 're-points a background video at a portable rendition and keeps its background semantics', async () => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			const info = backgroundVideoInfo().replace( /&/g, '&amp;' ).replace( /"/g, '&quot;' );
			await page.setContent( `<!doctype html><body style="margin:0">
				<section style="position:relative;width:1440px;height:810px">
					<wix-video data-video-info="${ info }" class="bgVideo" style="position:absolute;inset:0">
						<video muted loop autoplay playsinline src="${ origin }/video/clip/1080p/mp4/file.mp4"></video>
					</wix-video>
				</section>
			</body>` );
			await capture.beforeSerialize!( page, { url: page.url(), viewport: 'desktop' } );

			// The background element stays, classes and all: it is not a player.
			const container = page.locator( 'wix-video.bgVideo' );
			expect( await container.count() ).toBe( 1 );
			const video = container.locator( 'video' );
			expect( await video.count() ).toBe( 1 );
			const attributes = await video.evaluate( ( element ) => Object.fromEntries(
				[ ...element.attributes ].map( ( attribute ) => [ attribute.name, attribute.value ] )
			) );
			// 1440px wants 1080p, which a portable website cannot carry.
			expect( attributes.src ).toBe( `${ origin }/video/clip/720p/mp4/file.mp4` );
			// Background semantics are untouched: no controls appear.
			expect( attributes ).toMatchObject( { muted: '', loop: '', autoplay: '', playsinline: '' } );
			expect( attributes ).not.toHaveProperty( 'controls' );
		} finally {
			await browser.close();
		}
	}, 30_000 );
} );
