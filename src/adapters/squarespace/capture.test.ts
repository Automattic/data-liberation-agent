import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { capture, squarespaceVideoPoster } from './capture.js';

const TEMPLATE = 'https://video.squarespace-cdn.com/content/v1/lib-id/asset-id/{variant}';
const THUMBNAIL = 'https://video.squarespace-cdn.com/content/v1/lib-id/asset-id/thumbnail';

describe.skipIf( ! existsSync( chromium.executablePath() ) )( 'Squarespace header capture', () => {
	it( 'annotates runtime padding owned by the closed overlay menu', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.setContent( '<div data-test="header-menu" style="padding-top:178px"></div><div style="padding-top:30px"></div>' );
			await capture.prepare!( page, { url: page.url(), viewport: 'desktop' } );
			expect( await page.locator( '[data-test="header-menu"]' ).getAttribute( 'data-blocks-engine-capture-fluid-ignore-padding' ) ).toBe( '' );
			expect( await page.locator( 'body > div:not([data-test])' ).getAttribute( 'data-blocks-engine-capture-fluid-ignore-padding' ) ).toBeNull();
		} finally {
			await browser.close();
		}
	}, 20_000 );

	it( 'keeps the top-of-page header visible when static tablet CSS hides it', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { viewport: { width: 768, height: 900 } } );
			await page.setContent( `<style>
				header { position:fixed; top:0; height:120px; }
				@media (min-width:768px) and (max-width:799px) { body #header { transform:translateY(-100%); } }
			</style><header id="header" data-test="header"><img alt="site logo" width="80" height="80"></header>` );
			expect( ( await page.locator( 'header' ).boundingBox() )?.y ).toBe( -120 );
			await capture.prepare!( page, { url: page.url(), viewport: 'desktop' } );
			expect( await page.locator( 'style[data-blocks-engine-capture-squarespace-header-style]' ).textContent() ).toContain( ':is(#data-blocks-engine-capture-squarespace-header-visible,header[data-test="header"]){transition:none!important;transform:none!important}' );
			expect( ( await page.locator( 'header' ).boundingBox() )?.y ).toBe( 0 );
		} finally {
			await browser.close();
		}
	}, 20_000 );

	it( 'normalizes the scroll-latched shrink class before recording the top pose', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { viewport: { width: 768, height: 900 } } );
			await page.setContent( `<header data-test="header" class="bright-inverse header shrink"><img alt="site logo" width="80" height="80"></header><main><img id="hero" width="768" height="297" style="height:297px"></main><script>
				addEventListener('resize', () => { if ( innerWidth >= 1440 ) document.querySelector('#hero').style.height = '333px'; });
			</script>` );
			await capture.prepare!( page, { url: page.url(), viewport: 'desktop' } );
			expect( await page.locator( 'header' ).getAttribute( 'class' ) ).toBe( 'bright-inverse header' );
			expect( ( await page.locator( '#hero' ).boundingBox() )?.height ).toBe( 333 );
		} finally {
			await browser.close();
		}
	}, 20_000 );
} );

describe.skipIf( ! existsSync( chromium.executablePath() ) )( 'Squarespace autoplay galleries', () => {
	it( 'stops autoplay and returns to the first slide once the current one settles', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			// The gallery attribute contract the Squarespace runtime exposes:
			// autoplay advances on a timer; index changes are refused mid-motion.
			await page.setContent( `<script>
				const state = { autoplay: true, currentIndex: 3, inMotion: true };
				setTimeout( () => { state.inMotion = false; }, 300 );
				setInterval( () => { if ( state.autoplay ) state.currentIndex++; }, 100 );
				window.Y = { Squarespace: { GalleryManager: { _galleries: [ {
					get: name => state[ name ],
					set: ( name, value ) => { if ( name !== 'currentIndex' || ! state.inMotion ) state[ name ] = value; },
				} ] } } };
			</script>` );
			await capture.prepare!( page, { url: page.url(), viewport: 'desktop' } );
			await page.waitForTimeout( 300 );
			expect( await page.evaluate( () => [ 'autoplay', 'currentIndex' ].map( name => ( window as any ).Y.Squarespace.GalleryManager._galleries[ 0 ].get( name ) ) ) ).toEqual( [ false, 0 ] );
		} finally {
			await browser.close();
		}
	}, 20_000 );
} );

describe.skipIf( ! existsSync( chromium.executablePath() ) )( 'Squarespace slideshow', () => {
	it( 'restates script-written caption and image geometry relative to its slide', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			// Inline px as the runtime writes them at 1440 (slide 576x288).
			await page.setContent( `<style>.slide,.content-fill{position:absolute;inset:0}.content-fill{overflow:hidden}.meta{position:absolute;bottom:0;overflow:auto}</style>
				<div class="sqs-gallery sqs-gallery-design-stacked" style="position:relative;width:40vw;height:20vw">
					<div class="slide sqs-active-slide">
						<a class="content-fill"><img data-image-dimensions="800x1000" width="800" height="1000" data-image-focal-point="0.5,0.5" style="position:relative;left:0px;top:-216px;width:576px;height:720px"></a>
						<div class="meta overflow" style="left:0px;width:576px;height:115.2px">${ 'caption '.repeat( 400 ) }</div>
					</div>
				</div>` );
			await capture.beforeSerialize!( page, { url: page.url(), viewport: 'desktop' } );
			// The runtime keeps replacing inline styles as slides cycle.
			await page.locator( 'img' ).evaluate( img => img.setAttribute( 'style', 'position:relative;left:0px;top:-216px;width:576px;height:720px' ) );
			await page.setContent( await page.content() );
			await page.setViewportSize( { width: 768, height: 900 } );
			// At 768 the slide is 307.2x153.6: the caption is 100% x 40% of it,
			// and the 4:5 image is cover-scaled to its width and centred, as the
			// loader would write it at 768 (top -115.2 = (153.6 - 384) / 2).
			expect( await page.locator( '.meta' ).boundingBox() ).toMatchObject( { width: 307.1875, height: 61.4375 } );
			const img = await page.locator( 'img' ).boundingBox();
			expect( img ).toMatchObject( { width: 307.1875 } );
			expect( img!.height ).toBeCloseTo( 384, 0 );
			expect( img!.y - 8 ).toBeCloseTo( -115.2, 0 );
		} finally {
			await browser.close();
		}
	}, 20_000 );
} );

describe( 'squarespaceVideoPoster', () => {
	it( 'resolves the thumbnail rendition of a hosted video record', () => {
		expect( squarespaceVideoPoster( JSON.stringify( { alexandriaUrl: TEMPLATE } ) ) ).toBe( THUMBNAIL );
		// As serialized in an HTML attribute.
		expect( squarespaceVideoPoster( `{&quot;alexandriaUrl&quot;: &quot;${ TEMPLATE }&quot;}` ) ).toBe( THUMBNAIL );
	} );

	it( 'ignores anything that is not a Squarespace rendition template', () => {
		expect( squarespaceVideoPoster( '{}' ) ).toBeUndefined();
		expect( squarespaceVideoPoster( JSON.stringify( { alexandriaUrl: THUMBNAIL } ) ) ).toBeUndefined();
		expect(
			squarespaceVideoPoster( JSON.stringify( { alexandriaUrl: 'https://cdn.example.test/v/{variant}' } ) )
		).toBeUndefined();
	} );
} );

describe.skipIf( ! existsSync( chromium.executablePath() ) )( 'Squarespace video capture', () => {
	it( 'gives a stream-backed hosted video its published poster', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			const config = JSON.stringify( { structuredContent: { alexandriaUrl: TEMPLATE } } ).replace( /"/g, '&quot;' );
			await page.route( 'https://squarespace-video.test/**', ( route ) =>
				route.fulfill( {
					contentType: 'text/html',
					body: `<div class="sqs-video-background-native" data-config-native-video="${ config }">
						<div><video id="streamed" muted autoplay loop></video></div>
						<div><video id="declared" data-poster="/own.jpg"></video></div>
					</div>
					<video id="unrelated"></video>`,
				} )
			);
			await page.goto( 'https://squarespace-video.test/' );
			await page.evaluate( () => {
				for ( const id of [ 'streamed', 'declared', 'unrelated' ] )
					( document.getElementById( id ) as HTMLVideoElement ).src = URL.createObjectURL( new MediaSource() );
			} );

			await capture.beforeSerialize!( page, { url: page.url(), viewport: 'desktop' } );

			const posters = await page.evaluate( () =>
				[ ...document.querySelectorAll( 'video' ) ].map( ( video ) => [
					video.id,
					video.getAttribute( 'poster' ),
					[ ...video.attributes ].some( ( attribute ) => attribute.name.startsWith( 'data-blocks-engine-capture-' ) ),
				] )
			);
			expect( posters ).toEqual( [
				[ 'streamed', THUMBNAIL, false ],
				[ 'declared', null, false ],
				[ 'unrelated', null, false ],
			] );
		} finally {
			await browser.close();
		}
	}, 20_000 );
} );
