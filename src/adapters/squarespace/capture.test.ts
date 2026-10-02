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
			expect( await page.locator( '[data-test="header-menu"]' ).getAttribute( 'data-dla-fluid-ignore-padding' ) ).toBe( '' );
			expect( await page.locator( 'body > div:not([data-test])' ).getAttribute( 'data-dla-fluid-ignore-padding' ) ).toBeNull();
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
			expect( await page.locator( 'style[data-dla-squarespace-header-style]' ).textContent() ).toContain( ':is(#dla-squarespace-header-visible,header[data-test="header"]){transition:none!important;transform:none!important}' );
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
					[ ...video.attributes ].some( ( attribute ) => attribute.name.startsWith( 'data-dla-' ) ),
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
