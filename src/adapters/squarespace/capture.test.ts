import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { capture, squarespaceVideoPoster } from './capture.js';

const TEMPLATE = 'https://video.squarespace-cdn.com/content/v1/lib-id/asset-id/{variant}';
const THUMBNAIL = 'https://video.squarespace-cdn.com/content/v1/lib-id/asset-id/thumbnail';

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
