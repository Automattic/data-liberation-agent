import { existsSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { describe, expect } from 'vitest';
import { it } from '../../../test/browser.js';
import { capture } from './capture.js';
import { applySourceCleanup, cleanupPolicy, readSourceCleanup } from '../../lib/source-cleanup.js';
import { portWixRuntimeEmbeds } from './embeds.js';
import { wixAdapter } from './index.js';
import {
	googleMapsEmbedUrl,
	googleMapsViewFromLink,
	isWixGoogleMapFrame,
	wixAppInstance,
	wixAppMapView,
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
const APP_MAP = `https://events.wixapps.net/events-server/html/google-map-v2?locale=de&lat=51.3396955&lng=12.3730747&instance=${ INSTANCE }`;
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

describe( 'wixAppMapView', () => {
	it( 'reads the location an App Market map widget names in its URL', () => {
		expect( wixAppMapView( APP_MAP ) ).toEqual( { lat: 51.3396955, lng: 12.3730747 } );
	} );

	it( 'ignores app widgets that are not maps or name no location', () => {
		expect( wixAppMapView( APP_WIDGET ) ).toBeNull();
		expect( wixAppMapView( APP_MAP.replace( 'lat=51.3396955&', '' ) ) ).toBeNull();
		expect( wixAppMapView( APP_MAP.replace( '51.3396955', 'north' ) ) ).toBeNull();
		// Without a signed instance it is not a Wix app widget.
		expect( wixAppMapView( 'https://maps.example.test/map?lat=51.3&lng=12.3' ) ).toBeNull();
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
	it( 'points a Wix map at a Google Maps embed of the marker the wrapper drew', async ({ newPage }) => {

		{
			const page = await newPage();
			await wixEmbedPage( page, { mapHasLocation: true } );
			await capture.beforeSerialize!( page, { url: page.url(), viewport: 'desktop' } );
			const map = page.locator( 'iframe[title="Google Maps"]' );
			expect( await map.getAttribute( 'src' ) ).toBe(
				'https://maps.google.com/maps?q=42.508993%2C-83.400679&z=17&hl=en&output=embed'
			);
			// The source's size is kept: the wrapper filled its 640x350 box.
			expect( await map.evaluate( ( frame ) => [ frame.getBoundingClientRect().width, frame.getBoundingClientRect().height ] ) ).toEqual( [ 640, 350 ] );
		}
	}, 30_000 );

	it( 'replaces App Market widgets with a visible note and drops their token', async ({ newPage }) => {

		{
			const page = await newPage();
			await wixEmbedPage( page, { mapHasLocation: true } );
			await capture.beforeSerialize!( page, { url: page.url(), viewport: 'desktop' } );
			const notes = page.locator( '[data-blocks-engine-capture-unported-embed="wix"]' );
			expect( await notes.count() ).toBe( 1 );
			expect( await notes.first().textContent() ).toBe( wixEmbedNote( 'PDF File Viewer' ) );
			expect( await notes.first().evaluate( ( note ) => [ note.getBoundingClientRect().width, note.getBoundingClientRect().height ] ) ).toEqual( [ 180, 180 ] );
			const html = await page.content();
			expect( html ).not.toContain( 'instance=' );
			expect( html ).not.toContain( 'appspot.com' );
			// A Wix HTML embed is a public file and keeps working as it is.
			expect( await page.locator( '#html-embed' ).getAttribute( 'src' ) ).toBe( HTML_EMBED );
		}
	}, 30_000 );

	it( 'points an App Market map widget at a Google Maps embed of the location in its URL', async ({ newPage }) => {

		{
			const page = await newPage();
			await page.route( /events\.wixapps\.net|maps\.google\.com/, ( route ) =>
				route.fulfill( { contentType: 'text/html', body: '<p>map</p>' } )
			);
			await page.setContent( `<style>body{margin:0}iframe{border:0;display:block;width:640px;height:320px}</style><div data-hook="map"><iframe title="Map" src="${ APP_MAP }"></iframe></div>` );
			await portWixRuntimeEmbeds( page );
			expect( await page.locator( '[data-blocks-engine-capture-unported-embed]' ).count() ).toBe( 0 );
			const map = page.locator( 'iframe[title="Map"]' );
			expect( await map.getAttribute( 'src' ) ).toBe( 'https://maps.google.com/maps?q=51.339695%2C12.373075&z=15&hl=de&output=embed' );
			expect( await map.getAttribute( 'data-blocks-engine-capture-ported-embed' ) ).toBe( 'wix-google-map' );
			expect( await page.content() ).not.toContain( 'instance=' );
		}
	}, 30_000 );

	it( 'replaces App Market custom elements with a same-size visible note', async ({ newPage }) => {

		{
			const page = await newPage();
			// Only the vendor script URL identifies the app; never fetch it.
			await page.route( 'https://bmusic.purplebear.co/**', ( route ) => route.abort() );
			await page.setContent(`<style>body{margin:0}.host{width:240px;height:152px}</style>
				<script src="https://bmusic.purplebear.co/js/wix-plugin/bmusic/wix-plugin.js?appId=9281aa55&appName=Music%20Player"></script>
				<div class="host" data-testid="custom-element"><bmusic-site-widget data-selector="bmusic-id-0"><div id="bmusic-container"></div></bmusic-site-widget></div>`);
			await portWixRuntimeEmbeds(page);
			expect(await page.locator('bmusic-site-widget').count()).toBe(0);
			const note = page.locator('[data-blocks-engine-capture-unported-embed="wix"]');
			expect(await note.textContent()).toBe(wixEmbedNote('Music Player'));
			expect(await note.evaluate((element) => [element.getBoundingClientRect().width, element.getBoundingClientRect().height])).toEqual([240, 152]);
		}
	}, 30_000 );

	it( 'replaces Wix-hosted module custom elements without an App Market script', async ({ newPage }) => {

		{
			const page = await newPage();
			await page.setContent('<style>body{margin:0}.host{width:240px;height:152px}</style><div class="host" data-testid="custom-element"><zeffy-donation-widget></zeffy-donation-widget></div>');
			await portWixRuntimeEmbeds( page );
			expect( await page.locator( 'zeffy-donation-widget' ).count() ).toBe( 0 );
			const note = page.locator( '[data-blocks-engine-capture-unported-embed="wix"]' );
			expect( await note.textContent() ).toBe( wixEmbedNote( 'Zeffy Donation Widget' ) );
			expect( await note.evaluate( ( element ) => [ element.getBoundingClientRect().width, element.getBoundingClientRect().height ] ) ).toEqual( [ 240, 152 ] );
		}
	}, 30_000 );

	it( 'recognizes and removes classic Wix password gates', async ({ newPage }) => {

		{
			const page = await newPage();
			await page.setContent('<main><div id="SM_ROOT_COMP"><p>Please enter the password below.</p><input id="SM_ROOT_COMP_input" type="password"><button>Go</button></div></main>');
			const policy = cleanupPolicy( wixAdapter.liberation?.cleanupRules );
			await applySourceCleanup( page, policy );
			const report = await readSourceCleanup( page, policy );
			expect( report.records.map( record => record.rule ) ).toContain( 'wix-members-gate' );
			expect( await page.locator( '#SM_ROOT_COMP' ).count() ).toBe( 0 );
		}
	}, 30_000 );

	it( 'cleans pinned chat overlays but preserves in-flow widgets and other pinned content', async ({ newPage }) => {

		{
			const page = await newPage();
			await page.setContent(`<style>#pinnedBottomLeft,#pinnedBottomRight{position:fixed;bottom:0}iframe{width:180px;height:60px}</style>
			<div id="pinnedBottomRight"><div id="comp-chat-pinned-layer"><iframe title="Wix Chat" src="${APP_WIDGET}"></iframe></div><div id="comp-top-pinned-layer"><a href="#">Back to top</a></div></div>
			<div id="pinnedBottomLeft"><div id="comp-ai-pinned-layer"><div data-hook="AiAssistantWidgetContainer" role="dialog"><textarea></textarea></div></div><div id="comp-ai-min-pinned-layer"><div data-hook="minimizedChat"><button data-hook="minimizedChatButton" aria-label="Chat with AI"></button></div></div></div>
			<div><iframe title="PDF File Viewer" src="${APP_WIDGET}"></iframe></div>`);
			const policy = cleanupPolicy( wixAdapter.liberation?.cleanupRules );
			await portWixRuntimeEmbeds(page);
			await applySourceCleanup(page, policy);
			const report = await readSourceCleanup(page, policy);
			expect(await page.locator('#comp-chat-pinned-layer,#comp-ai-pinned-layer,#comp-ai-min-pinned-layer').count()).toBe(0);
			expect(report.records.map(record => record.rule)).toEqual(expect.arrayContaining(['wix-chat-launcher','wix-ai-assistant']));
			expect(await page.locator('[data-blocks-engine-capture-unported-embed="wix"]').count()).toBe(1);
			expect(await page.locator('#comp-top-pinned-layer a').count()).toBe(1);
		}
	} );

	it( 'leaves a note, not a blank box, when the map location cannot be read', async ({ newPage }) => {

		{
			const page = await newPage();
			await wixEmbedPage( page, { mapHasLocation: false } );
			await capture.beforeSerialize!( page, { url: page.url(), viewport: 'desktop' } );
			expect( await page.locator( 'iframe[title="Google Maps"]' ).count() ).toBe( 0 );
			expect( await page.locator( '.wixui-google-map [data-blocks-engine-capture-unported-embed="wix"]' ).textContent() ).toBe(
				wixEmbedNote( 'Google Maps' )
			);
		}
	}, 30_000 );
} );
