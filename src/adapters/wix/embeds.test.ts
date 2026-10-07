import { existsSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { capture } from './capture.js';
import {
	googleMapsEmbedUrl,
	googleMapsViewFromLink,
	isWixGoogleMapFrame,
	wixAppInstance,
	wixEmbedNote,
} from './embeds.js';

const MAP_WRAPPER =
	'https://static.parastorage.com/services/editor-elements-library/dist/thunderbolt/media/googleMap.f3347ff6.html?defaultLocation=0&showZoom=true&language=en&region=US&id=dataItem-l6jp98mb&origin=https%3A%2F%2Fwww.example-hoa.test';

const base64Url = ( value: unknown ) =>
	Buffer.from( JSON.stringify( value ) ).toString( 'base64' ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/, '' );
const INSTANCE = `7UqG_EpycyF9calKVehmsqGeIuka3seGpv-QJJliLrY.${ base64Url( {
	instanceId: '782da0af-ba00-440a-a6bf-7e12144559d0',
	appDefId: '13ee10a3-ecb9-7eff-4298-d2f9f34acf0d',
	siteOwnerId: 'cf2dfb92-9277-42cc-8440-d28b68b81db4',
} ) }`;
const APP_WIDGET = `https://dev-wix-languages.appspot.com/widget?pageId=vt13i&compId=comp-l76p8of1&viewerCompId=comp-l76p8of1&width=180&height=180&instance=${ INSTANCE }&commonConfig=%7B%22host%22%3A%22VIEWER%22%7D`;
const HTML_EMBED = 'https://www-example-hoa-test.filesusr.com/html/cf2dfb_0123456789abcdef0123456789abcdef.html';

describe( 'isWixGoogleMapFrame', () => {
	it( 'recognises the Wix map wrapper page', () => {
		expect( isWixGoogleMapFrame( MAP_WRAPPER ) ).toBe( true );
	} );

	it( 'ignores real Google Maps embeds and other parastorage files', () => {
		expect( isWixGoogleMapFrame( 'https://www.google.com/maps/embed?pb=!1m18' ) ).toBe( false );
		expect( isWixGoogleMapFrame( 'https://static.parastorage.com/services/editor-elements-library/dist/thunderbolt/media/video.html' ) ).toBe( false );
		expect( isWixGoogleMapFrame( 'not a url' ) ).toBe( false );
	} );
} );

describe( 'wixAppInstance', () => {
	it( 'recognises an App Market widget by its signed instance token', () => {
		expect( wixAppInstance( APP_WIDGET ) ).toEqual( { appDefId: '13ee10a3-ecb9-7eff-4298-d2f9f34acf0d' } );
	} );

	it( 'leaves Wix HTML embeds and ordinary third-party iframes alone', () => {
		expect( wixAppInstance( HTML_EMBED ) ).toBeNull();
		expect( wixAppInstance( 'https://www.youtube.com/embed/abc123' ) ).toBeNull();
		// An `instance` parameter that is not a signed Wix payload is not an app widget.
		expect( wixAppInstance( 'https://widgets.example.test/w?instance=42' ) ).toBeNull();
		expect( wixAppInstance( `https://widgets.example.test/w?instance=abc.${ base64Url( { other: 1 } ) }` ) ).toBeNull();
	} );
} );

describe( 'Google Maps embed URL', () => {
	it( 'reads the centre and zoom from Google’s own view link', () => {
		expect(
			googleMapsViewFromLink( 'https://maps.google.com/maps?ll=42.508993,-83.400679&z=17&t=m&hl=en&gl=US&mapclient=apiv3' )
		).toEqual( { lat: 42.508993, lng: -83.400679, zoom: 17 } );
		expect( googleMapsViewFromLink( 'https://evil.test/maps?ll=1,2&z=3' ) ).toBeNull();
	} );

	it( 'builds a keyless embed that keeps the zoom and language', () => {
		expect( googleMapsEmbedUrl( { lat: 42.5089929, lng: -83.4006792, zoom: 17 }, 'en' ) ).toBe(
			'https://maps.google.com/maps?q=42.508993%2C-83.400679&z=17&hl=en&output=embed'
		);
	} );

	it( 'refuses a location that is not one', () => {
		expect( googleMapsEmbedUrl( { lat: 0, lng: 0 } ) ).toBeNull();
		expect( googleMapsEmbedUrl( { lat: 91, lng: 10 } ) ).toBeNull();
		expect( googleMapsEmbedUrl( { lat: Number.NaN, lng: 10 } ) ).toBeNull();
	} );
} );

/**
 * A Wix-like page. The map wrapper behaves like the real one after the viewer
 * has posted it locations: the map and markers live on `window`.
 */
async function wixEmbedPage( page: Page, options: { mapHasLocation: boolean } ): Promise< void > {
	await page.route( 'https://www.example-hoa.test/**', ( route ) =>
		route.fulfill( {
			contentType: 'text/html',
			body: `<style>body{margin:0;font-family:Georgia,serif}iframe{border:0;display:block}.map{width:640px;height:350px}.tpa{width:180px;height:180px}</style>
				<main>
					<div class="map wixui-google-map"><wix-iframe data-src=""><iframe title="Google Maps" width="100%" height="100%" src="${ MAP_WRAPPER.replace( /&/g, '&amp;' ) }"></iframe></wix-iframe></div>
					<div class="tpa"><iframe class="UkML6" title="PDF File Viewer" width="180" height="180" src="${ APP_WIDGET.replace( /&/g, '&amp;' ) }"></iframe></div>
					<div class="tpa" style="display:none"><iframe title="PDF File Viewer" src="${ APP_WIDGET.replace( /&/g, '&amp;' ) }"></iframe></div>
					<iframe id="html-embed" title="Embedded Content" width="300" height="200" src="${ HTML_EMBED }"></iframe>
				</main>`,
		} )
	);
	await page.route( 'https://static.parastorage.com/**', ( route ) =>
		route.fulfill( {
			contentType: 'text/html',
			body: options.mapHasLocation
				? `<script>
					window.googleMapsInstance = { getZoom: () => 17, getCenter: () => ( { lat: () => 42.5, lng: () => -83.4 } ) };
					window.googleMapsMarkerInstances = [ { getPosition: () => ( { lat: () => 42.5089929, lng: () => -83.4006792 } ), getTitle: () => 'Example HOA' } ];
				</script><a href="https://maps.google.com/maps?ll=42.5,-83.4&z=17&mapclient=apiv3">Open this area in Google Maps</a>`
				: '<p>waiting for the Wix viewer</p>',
		} )
	);
	await page.route( 'https://dev-wix-languages.appspot.com/**', ( route ) =>
		route.fulfill( { contentType: 'text/html', body: '<title>App Unavailable</title>' } )
	);
	await page.route( /filesusr\.com|maps\.google\.com/, ( route ) =>
		route.fulfill( { contentType: 'text/html', body: '<p>embedded</p>' } )
	);
	await page.goto( 'https://www.example-hoa.test/contact-us' );
}

describe.skipIf( ! existsSync( chromium.executablePath() ) )( 'Wix runtime embeds at serialization', () => {
	it( 'points a Wix map at a Google Maps embed of the marker the wrapper drew', async () => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			await wixEmbedPage( page, { mapHasLocation: true } );
			await capture.beforeSerialize!( page, { url: page.url(), viewport: 'desktop' } );
			const map = page.locator( 'iframe[title="Google Maps"]' );
			expect( await map.getAttribute( 'src' ) ).toBe(
				'https://maps.google.com/maps?q=42.508993%2C-83.400679&z=17&hl=en&output=embed'
			);
			// The source's size is kept: the wrapper filled its 640x350 box.
			expect( await map.evaluate( ( frame ) => [ frame.getBoundingClientRect().width, frame.getBoundingClientRect().height ] ) ).toEqual( [ 640, 350 ] );
		} finally {
			await browser.close();
		}
	}, 30_000 );

	it( 'replaces App Market widgets with a visible note and drops their token', async () => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			await wixEmbedPage( page, { mapHasLocation: true } );
			await capture.beforeSerialize!( page, { url: page.url(), viewport: 'desktop' } );
			const notes = page.locator( '[data-dla-unported-embed="wix"]' );
			expect( await notes.count() ).toBe( 1 );
			expect( await notes.first().textContent() ).toBe( wixEmbedNote( 'PDF File Viewer' ) );
			expect( await notes.first().evaluate( ( note ) => [ note.getBoundingClientRect().width, note.getBoundingClientRect().height ] ) ).toEqual( [ 180, 180 ] );
			const html = await page.content();
			expect( html ).not.toContain( 'instance=' );
			expect( html ).not.toContain( 'appspot.com' );
			// A Wix HTML embed is a public file and keeps working as it is.
			expect( await page.locator( '#html-embed' ).getAttribute( 'src' ) ).toBe( HTML_EMBED );
		} finally {
			await browser.close();
		}
	}, 30_000 );

	it( 'leaves a note, not a blank box, when the map location cannot be read', async () => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			await wixEmbedPage( page, { mapHasLocation: false } );
			await capture.beforeSerialize!( page, { url: page.url(), viewport: 'desktop' } );
			expect( await page.locator( 'iframe[title="Google Maps"]' ).count() ).toBe( 0 );
			expect( await page.locator( '.wixui-google-map [data-dla-unported-embed="wix"]' ).textContent() ).toBe(
				wixEmbedNote( 'Google Maps' )
			);
		} finally {
			await browser.close();
		}
	}, 30_000 );
} );
