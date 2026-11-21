import { load } from 'cheerio';
import { existsSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { describe, expect } from 'vitest';
import { it } from '../../../test/browser.js';
import { capture } from './capture.js';
import { applySourceCleanup, cleanupPolicy, readSourceCleanup } from '../../lib/source-cleanup.js';
import { portWixRuntimeEmbeds } from './embeds.js';
import { capturePageHtml } from '../../lib/screenshot/screenshotter.js';
import { wixAdapter } from './index.js';
import {
	googleMapsEmbedUrl,
	googleMapsViewFromLink,
	googleMapsViewFromSearchLink,
	portWixEventMaps,
	wixEventVenueView,
	isWixGoogleMapFrame,
	wixAppInstance,
	wixAppMapView,
	wixEmbedNote,
	wixFaqItems,
	sealWixAppFrameHtml,
	trackWixFaqQueries,
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
const FAQ_INSTANCE = `sig.${ base64Url( { instanceId: '00000000-0000-4000-8000-000000000001', appDefId: '14c92d28-031e-7910-c9a8-a670011e062d' } ) }`;
const FAQ_WIDGET = `https://faq-app.example.test/render/FaqOoi?compId=comp-faq&instance=${ FAQ_INSTANCE }`;
/** What capture saves for the page now: the real serializer, then Wix's canonicalization. */
const escape = ( text: string ) => text.replace( /&/g, '&amp;' ).replace( /"/g, '&quot;' ).replace( /</g, '&lt;' );
const savedHtml = async ( page: Page ) => capture.canonicalizeHtml!( await capturePageHtml( page ) );
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

describe( 'wixFaqItems', () => {
	const item = ( answer: unknown, extra = {} ) => ( { layout: 'accordion', items: [ { question: ' Why? ', open: true, answer, ...extra } ] } );

	it( 'keeps allowlisted structure and absolute links, and unwraps or drops the rest', () => {
		expect( wixFaqItems( item( [
			{ tag: 'p', children: [ { tag: 'span', children: [ { text: 'Because ' } ] }, { tag: 'a', href: 'https://example.test/', children: [ { text: 'this' } ] } ] },
			{ tag: 'a', href: 'javascript:alert(1)', children: [ { text: ' and that' } ] },
			{ tag: 'img onerror=alert(1)', children: [] },
			{ tag: 'script', children: [ { text: 'alert(1)' } ] },
		] ) ) ).toEqual( [ { question: 'Why?', open: true, answer: [
			{ tag: 'p', children: [ { text: 'Because ' }, { tag: 'a', href: 'https://example.test/', children: [ { text: 'this' } ] } ] },
			{ text: ' and that' },
		] } ] );
	} );

	it( 'waits for answers, and refuses layouts and trees it cannot carry whole', () => {
		expect( wixFaqItems( null ) ).toBe( 'pending' );
		expect( wixFaqItems( item( null ) ) ).toBe( 'pending' );
		expect( wixFaqItems( item( [ { text: '  ' } ] ) ) ).toBe( 'pending' );
		expect( wixFaqItems( { layout: 'unsupported', items: [] } ) ).toBe( 'unsupported' );
		expect( wixFaqItems( item( [ { tag: 'p', children: 'not a list' } ] ) ) ).toBe( 'unsupported' );
		const deep = Array.from( { length: 40 } ).reduce< unknown >( ( child ) => ( { tag: 'div', children: [ child ] } ), { text: 'deep' } );
		expect( wixFaqItems( item( [ deep ] ) ) ).toBe( 'unsupported' );
	} );
} );

describe( 'sealWixAppFrameHtml', () => {
	const frame = ( attributes: string ) => `<iframe title="PDF File Viewer" ${ attributes }></iframe>`;
	const widget = APP_WIDGET.replace( /&/g, '&amp;' );

	it( 'turns a painted app frame into the note at its recorded size and drops an unpainted one', () => {
		const html = sealWixAppFrameHtml( `<p>${ frame( `src="${ widget }" data-blocks-engine-capture-visual-iframe-width="180" data-blocks-engine-capture-visual-iframe-height="120" data-blocks-engine-node-id="n7"` ) }${ frame( `src="${ widget }"` ) }</p>` );
		expect( html ).not.toContain( 'instance=' );
		expect( html ).toContain( 'max-width:180px;min-height:120px' );
		expect( html ).toContain( 'data-blocks-engine-node-id="n7"' );
		expect( html.match( /role="note"/g ) ).toHaveLength( 1 );
		expect( html ).toContain( `>${ wixEmbedNote( 'PDF File Viewer' ) }</div>` );
	} );

	it( 'reads the real src past decoy attributes, decoded query keys, relative and protocol-relative addresses, data-src and srcdoc', () => {
		const signed = new URL( APP_WIDGET ).search;
		const pages = [
			`<iframe title="Details src='https://public.example/info'" src="${ widget }"></iframe>`,
			`<iframe src="${ widget.replace( 'instance=', '%69nstance=' ) }"></iframe>`,
			`<iframe src="/render/widget${ signed.replace( /&/g, '&amp;' ) }"></iframe>`,
			`<iframe src="//editor.wixapps.net/render/widget${ signed.replace( /&/g, '&amp;' ) }"></iframe>`,
			'<IFRAME SRC="https://editor.wixapps.net/render/w?instance=unsigned-but-wix-host"></IFRAME>',
			`<iframe data-src="${ widget }"></iframe>`,
			`<iframe srcdoc="${ escape( `<p>doc</p><iframe src="${ widget }"></iframe>` ) }"></iframe>`,
		];
		for ( const page of pages ) {
			const sealed = sealWixAppFrameHtml( `<main>${ page }</main><p>after</p>` );
			expect( sealed, page ).not.toMatch( /instance=|%69nstance|unsigned-but-wix-host|7UqG_/ );
			expect( sealed, page ).toContain( '<p>after</p>' );
		}
	} );

	it( 'finds a credential under any key case, repeat, encoding depth or fragment, and in noscript', () => {
		const pages = [
			`<iframe src="https://widgets.example.test/w?instance=&amp;instance=${ INSTANCE }"></iframe>`,
			`<iframe src="https://widgets.example.test/w?Instance=${ INSTANCE }"></iframe>`,
			`<iframe src="https://widgets.example.test/w#instance=${ INSTANCE }"></iframe>`,
			`<iframe src="https://widgets.example.test/w?%2569nstance=${ INSTANCE }"></iframe>`,
			`<noscript><iframe src="${ widget }"></iframe></noscript>`,
		];
		for ( const page of pages ) {
			const sealed = sealWixAppFrameHtml( `<main>${ page }</main><p>after</p>` );
			expect( sealed, page ).not.toContain( '7UqG_' );
			expect( sealed, page ).toContain( '<p>after</p>' );
		}
	} );

	it( 'resolves frames against the effective base, never a template base, and nested markup against its owner', () => {
		const unsigned = '<iframe src="/render/w?instance=unsigned-value"></iframe>';
		const pages = [
			`<head><base href="//app.wixapps.net/"></head><body>${ unsigned }</body>`,
			`<template><base href="https://public.example.test/"></template>${ unsigned }`,
			`<base href="https://app.wixapps.net/"><iframe srcdoc="${ escape( '<iframe src="/render/w?instance=unsigned-value"></iframe>' ) }"></iframe>`,
		];
		for ( const page of pages ) expect( sealWixAppFrameHtml( page ), page ).not.toContain( 'unsigned-value' );
		// A captured fragment resolves against the page it came from.
		expect( sealWixAppFrameHtml( '<iframe src="https://public.example.test/w?instance=x"></iframe>', '<base href="https://app.wixapps.net/">' ) ).toContain( 'instance=x' );
	} );

	it( 'removes replay markup nested past the sealing depth instead of passing it through', () => {
		let markup = `<iframe src="${ widget }"></iframe>`;
		for ( let level = 0; level < 12; level++ ) markup = `<button data-blocks-engine-capture-dialog-panel-state="${ escape( JSON.stringify( { html: `<div>${ markup }</div>` } ) ) }">Open</button>`;
		const sealed = sealWixAppFrameHtml( `<nav>${ markup }</nav>` );
		expect( sealed ).not.toContain( '7UqG_' );
		expect( sealed ).toMatch( /^<nav><button data-blocks-engine-capture-dialog-panel-state=/ );
	} );

	it( 'seals app frames inside captured panel replay markup, recursively', () => {
		const frameMarkup = `<iframe src="${ widget }" data-blocks-engine-capture-visual-iframe-width="180" data-blocks-engine-capture-visual-iframe-height="120"></iframe>`;
		const inner = `<button data-blocks-engine-capture-dialog-panel-state="${ escape( JSON.stringify( { html: `<div>${ frameMarkup }</div>`, style: '', class: '' } ) ) }">Open</button>`;
		const page = `<nav><button data-blocks-engine-capture-dialog-panel-state="${ escape( JSON.stringify( { html: `<div>${ inner }</div>`, style: 'x', class: 'y' } ) ) }">Menu</button>`
			+ `<div data-blocks-engine-capture-existing-panel="${ escape( JSON.stringify( { resting: { html: frameMarkup, hidden: true }, opened: { html: `<p>${ frameMarkup }</p>`, style: null } } ) ) }"></div></nav>`;
		const sealed = sealWixAppFrameHtml( page );
		expect( sealed ).not.toContain( '7UqG_' );
		const $ = load( sealed );
		const outer = JSON.parse( $( 'nav > button' ).attr( 'data-blocks-engine-capture-dialog-panel-state' )! );
		expect( outer ).toMatchObject( { style: 'x', class: 'y' } );
		const nested = JSON.parse( load( outer.html )( 'button' ).attr( 'data-blocks-engine-capture-dialog-panel-state' )! );
		expect( nested.html ).toContain( wixEmbedNote( undefined ) );
		const existing = JSON.parse( $( 'nav > div' ).attr( 'data-blocks-engine-capture-existing-panel' )! );
		expect( existing.resting ).toMatchObject( { hidden: true } );
		expect( `${ existing.resting.html }${ existing.opened.html }` ).toContain( 'role="note"' );
	} );

	it( 'keeps pages, public embeds and ported maps byte for byte', () => {
		const page = `<iframe src="${ HTML_EMBED }?instance=1"></iframe><iframe src="https://maps.google.com/maps?q=1%2C2&amp;output=embed"></iframe>`;
		expect( sealWixAppFrameHtml( page ) ).toBe( page );
		expect( sealWixAppFrameHtml( '<p>no frames</p>' ) ).toBe( '<p>no frames</p>' );
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

describe( 'Wix Events venue location', () => {
	it( 'reads the venue from the phone map image\'s Google Maps search link', () => {
		expect( googleMapsViewFromSearchLink( 'https://www.google.com/maps/search/?api=1&query=48.8566,2.3522' ) ).toEqual( { lat: 48.8566, lng: 2.3522 } );
		expect( googleMapsViewFromSearchLink( 'https://www.google.com/maps/search/?api=1&query=Some+Street' ) ).toBeNull();
		expect( googleMapsViewFromSearchLink( 'https://maps.example.test/maps/search/?query=48.8566,2.3522' ) ).toBeNull();
	} );

	it( 'reads the venue of the one event the warmup data describes', () => {
		const event = ( id: string, lat: number, lng: number ) => ( { id, location: { name: 'Venue', coordinates: { lat, lng } } } );
		expect( wixEventVenueView( JSON.stringify( { appsWarmupData: { events: { event: { event: event( 'e1', 48.8566, 2.3522 ) } } } } ) ) ).toEqual( { lat: 48.8566, lng: 2.3522 } );
		// Several events at different venues: none of them is the page's.
		expect( wixEventVenueView( JSON.stringify( { list: [ event( 'e1', 48.8566, 2.3522 ), event( 'e2', 40.7128, -74.006 ) ] } ) ) ).toBeNull();
		expect( wixEventVenueView( '{"event":{}}' ) ).toBeNull();
		expect( wixEventVenueView( 'not json' ) ).toBeNull();
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
			const html = await savedHtml( page );
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

	const EVENT_EMBED = 'https://maps.google.com/maps?q=48.8566%2C2.3522&z=15&hl=fr&output=embed';
	const phoneEventMap = ( mountAfterMs?: number ) => `<!doctype html><html lang="fr"><style>body{margin:0}.map{width:320px}.map img{display:block;width:100%;height:auto}</style>
		<div class="map"><a href="https://www.google.com/maps/search/?api=1&amp;query=48.8566,2.3522" target="_blank"><img id="event-details-page-map" data-hook="map" class="venue" alt="Venue map" width="640" height="360"></a></div>
		${ mountAfterMs === undefined ? '' : `<script>setTimeout(() => { document.querySelector('#event-details-page-map').src = 'https://maps.example.test/static.png'; }, ${ mountAfterMs });</script>` }</html>`;

	it( 'waits for a Wix Events venue map that mounts after hydration', async ({ newPage }) => {
		const page = await newPage();
		await page.route( 'https://maps.example.test/**', ( route ) => route.fulfill( { contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"/>' } ) );
		await page.setContent( phoneEventMap( 1_500 ) );
		await portWixRuntimeEmbeds( page );
		expect( await page.locator( 'a > img#event-details-page-map' ).getAttribute( 'src' ) ).toBe( 'https://maps.example.test/static.png' );
		expect( await page.locator( '[data-blocks-engine-capture-ported-embed], [data-blocks-engine-capture-unported-embed]' ).count() ).toBe( 0 );
	}, 30_000 );

	it( 'points a phone venue map that never mounts at a Google Maps embed of its link\'s location', async ({ newPage }) => {
		const page = await newPage();
		await page.route( /maps\.google\.com/, ( route ) => route.fulfill( { contentType: 'text/html', body: '<p>map</p>' } ) );
		await page.setContent( phoneEventMap() );
		await portWixEventMaps( page, 500 );
		expect( await page.locator( 'img#event-details-page-map, .map a' ).count() ).toBe( 0 );
		const map = page.locator( '.map > iframe#event-details-page-map' );
		expect( await map.getAttribute( 'src' ) ).toBe( EVENT_EMBED );
		expect( await map.getAttribute( 'data-blocks-engine-capture-ported-embed' ) ).toBe( 'wix-google-map' );
		// The image's 640x360 box at the column's width.
		expect( await map.evaluate( ( frame ) => [ frame.getBoundingClientRect().width, frame.getBoundingClientRect().height ] ) ).toEqual( [ 320, 180 ] );
	}, 30_000 );

	it( 'fills a desktop venue map that never mounts from the event\'s warmup data, or leaves a note', async ({ newPage }) => {
		const page = await newPage();
		await page.route( /maps\.google\.com/, ( route ) => route.fulfill( { contentType: 'text/html', body: '<p>map</p>' } ) );
		const desktop = ( warmup: unknown ) => `<!doctype html><html lang="fr"><style>body{margin:0}#event-details-page-map{width:600px;height:300px}</style>
			<script type="application/json" id="wix-warmup-data">${ JSON.stringify( warmup ) }</script>
			<div id="event-details-page-map" data-hook="map"></div></html>`;
		await page.setContent( desktop( { appsWarmupData: { events: { event: { event: { id: 'e1', location: { coordinates: { lat: 48.8566, lng: 2.3522 } } } } } } } ) );
		await portWixEventMaps( page, 500 );
		const map = page.locator( '#event-details-page-map > iframe' );
		expect( await map.getAttribute( 'src' ) ).toBe( EVENT_EMBED );
		expect( await map.evaluate( ( frame ) => [ frame.getBoundingClientRect().width, frame.getBoundingClientRect().height ] ) ).toEqual( [ 600, 300 ] );

		await page.setContent( desktop( {} ) );
		await portWixEventMaps( page, 500 );
		expect( await page.locator( '#event-details-page-map iframe' ).count() ).toBe( 0 );
		expect( await page.locator( '[data-blocks-engine-capture-unported-embed="wix"]' ).textContent() ).toBe( wixEmbedNote( 'Map' ) );
	}, 30_000 );

	const FAQ_ENTRIES = [
		{ question: 'First question?', answer: '<div data-id="content-viewer"><p class="x" style="color:red"><span>An answer with </span><strong>bold text</strong> and <a href="https://example.test/more" onclick="alert(1)">a link</a>.</p></div>' },
		{ question: 'Second question?', answer: '<p>Hidden answer <a href="javascript:alert(1)">kept</a> <a href="/relative">as text</a>.</p><ul><li>One</li><li>Two</li></ul><script>window.bad = 1</script>' },
	];
	/**
	 * A neutral FAQ app frame: it loads empty, asks its server for the
	 * questions with a POST query and renders them in the app's accordion
	 * markup. `variant` (in the frame URL) bends it: a frame that tampers with
	 * its own DOM APIs, a panel that never renders, category tabs, or no render.
	 */
	const faqFrame = ( variant = 'plain' ) => `${ FAQ_WIDGET }&variant=${ variant }`;
	const TOKEN_LINK_ENTRIES = [ { question: 'First question?', answer: `<p>See <a href="https://app.example.test/widget?instance=${ INSTANCE }">the app page</a>.</p>` }, FAQ_ENTRIES[ 1 ] ];
	let errorServed = false;
	const routeFaqApp = async ( page: Page ) => page.route( 'https://faq-app.example.test/**', async ( route ) => {
		const url = new URL( route.request().url() );
		if ( route.request().method() === 'POST' ) {
			// Wix's answer shape: one page of questions and whether more follow, by cursor.
			const asking = new URL( route.request().frame().url() ).searchParams.get( 'variant' ) ?? '';
			const next = ( route.request().postData() ?? '' ).includes( 'cursor' );
			const whole = { questionEntries: asking === 'token-link' ? TOKEN_LINK_ENTRIES : FAQ_ENTRIES, pagingMetadata: { count: FAQ_ENTRIES.length, hasNext: false } };
			let status = 200;
			let body: unknown = whole;
			if ( /staggered|final-late/.test( asking ) ) {
				// The final page counts only its own questions (or, for 'final-late', omits the count).
				body = next
					? { questionEntries: FAQ_ENTRIES.slice( 1 ), pagingMetadata: { ...( asking === 'final-late' ? {} : { count: FAQ_ENTRIES.length - 1 } ), hasNext: false } }
					: { questionEntries: FAQ_ENTRIES.slice( 0, 1 ), pagingMetadata: { count: 1, hasNext: true, cursors: { next: 'page-2' } } };
			} else if ( asking === 'renav-a' ) {
				body = { questionEntries: FAQ_ENTRIES.slice( 0, 1 ), pagingMetadata: { count: 1, hasNext: false } };
			} else if ( asking === 'error-first' && ! errorServed ) {
				// A failed query whose body still looks final.
				errorServed = true;
				status = 500;
				body = { questionEntries: FAQ_ENTRIES.slice( 0, 1 ), pagingMetadata: { count: 1, hasNext: false } };
			}
			await new Promise( ( resolve ) => setTimeout( resolve, 500 ) );
			await route.fulfill( { status, contentType: 'application/json', body: JSON.stringify( body ) } );
			return;
		}
		const variant = url.searchParams.get( 'variant' );
		const tamper = variant === 'tamper' ? `
			Object.defineProperty( Element.prototype, 'innerHTML', { get() { return '<img src=x onerror="parent.pwned = 1">'; } } );
			const create = Document.prototype.createElement;
			Document.prototype.createElement = function ( tag ) { return create.call( this, tag === 'p' ? 'img' : tag ); };` : '';
		const answer = variant === 'tamper' ? `'<img src="x" onerror="parent.pwned = 1">' + entry.answer` : 'entry.answer';
		const panelId = variant === 'missing-panel' ? `'elsewhere-' + index` : `'item-' + index`;
		const tabs = variant === 'tabs' ? `'<div data-hook="faq-tabs" role="tablist"><button role="tab">One</button></div>' + ` : '';
		// The frame navigates once it has loaded, as a widget's router can; the new document renders the questions.
		if ( variant === 'navigate' ) {
			await route.fulfill( { contentType: 'text/html', body: `<script>setTimeout( () => location.replace( ${ JSON.stringify( faqFrame() ) } ), 200 );</script>` } );
			return;
		}
		const widget = variant === 'never' ? '<div id="root"></div>' : `<!doctype html><div id="root"></div><script>${ tamper }
			const render = ( entries ) => {
				const root = document.getElementById( 'root' );
				root.replaceChildren();
				root.insertAdjacentHTML( 'beforeend', '<div data-hook="faq-root">' + ${ tabs }'<div data-hook="widget-accordion-wrapper">' + entries.map( ( entry, index ) =>
					'<button data-hook="accordion-item-header" aria-expanded="' + ( index === 0 ) + '" aria-controls="item-' + index + '"><h3 data-hook="title">' + entry.question + '</h3><svg data-hook="expandIcon"></svg></button>' +
					'<div id="' + ${ panelId } + '" data-hook="accordion-item-content" style="display:' + ( index === 0 ? 'block' : 'none' ) + '">' + ${ answer } + '</div>' ).join( '' ) + '</div></div>' );
			};
			const query = ( cursor ) => fetch( '/_api/faq-server/v2/question-entries/query', { method: 'POST', body: JSON.stringify( cursor ? { query: { cursorPaging: { cursor } } } : { query: {} } ) } ).then( response => response.json() );
			${ {
				// Renders the first page, asks for the final one at once, and renders it 900 ms after the answer.
				'final-late': `query().then( ( first ) => { render( first.questionEntries ); query( first.pagingMetadata.cursors.next ).then( ( second ) => setTimeout( () => render( first.questionEntries.concat( second.questionEntries ) ), 900 ) ); } );`,
				// Renders what a failed query returned, then retries.
				'error-first': `query().then( ( first ) => { render( first.questionEntries ); setTimeout( () => query().then( ( second ) => render( second.questionEntries ) ), 900 ); } );`,
				// Gets a final answer, then navigates in place before rendering.
				'renav-a': `query().then( () => location.replace( ${ JSON.stringify( faqFrame( 'renav-b' ) ) } ) );`,
				// Renders one remembered question at once and queries for the rest later.
				'renav-b': `render( ${ JSON.stringify( FAQ_ENTRIES.slice( 0, 1 ) ) } ); setTimeout( () => query().then( ( all ) => render( all.questionEntries ) ), 1200 );`,
			}[ variant ?? '' ] ?? `
			// A batched variant renders its first page, then asks for the next one later
			// ('staggered' 800 ms, 'slow-staggered' 1.8 s), as cursor paging does.
			query().then( ( first ) => {
				render( first.questionEntries );
				if ( first.pagingMetadata.hasNext ) setTimeout( () => query( first.pagingMetadata.cursors.next ).then( ( second ) => render( first.questionEntries.concat( second.questionEntries ) ) ), ${ variant === 'slow-staggered' ? 1_800 : 800 } );
			} );` }
		</script>`;
		await route.fulfill( { contentType: 'text/html', body: widget } );
	} );
	const FRAME_STYLE = '<style>body{margin:0}iframe{border:0;display:block;width:600px;height:400px}</style>';
	const expectPortedFaq = async ( page: Page ) => {
		expect( await page.locator( '[data-blocks-engine-capture-unported-embed]' ).count() ).toBe( 0 );
		const faq = page.locator( '[data-blocks-engine-capture-ported-embed="wix-faq"]' );
		expect( await faq.locator( 'details > summary' ).allTextContents() ).toEqual( [ 'First question?', 'Second question?' ] );
		expect( await faq.locator( 'details' ).evaluateAll( ( items ) => items.map( ( item ) => ( item as HTMLDetailsElement ).open ) ) ).toEqual( [ true, false ] );
		expect( await faq.locator( 'details > div' ).evaluateAll( ( items ) => items.map( ( item ) => item.innerHTML ) ) ).toEqual( [
			'<p>An answer with <strong>bold text</strong> and <a href="https://example.test/more">a link</a>.</p>',
			'<p>Hidden answer kept as text.</p><ul><li>One</li><li>Two</li></ul>',
		] );
		const html = await page.content();
		expect( html ).not.toContain( 'instance=' );
		expect( html ).not.toContain( '<iframe' );
	};

	it( 'keeps the questions a Wix FAQ widget frame renders after its own query', async ({ newPage }) => {
		const page = await newPage();
		await routeFaqApp( page );
		await page.setContent( `${ FRAME_STYLE }<div id="comp-faq"><iframe title="Wix FAQ" src="${ faqFrame() }"></iframe></div>` );
		await portWixRuntimeEmbeds( page );
		await expectPortedFaq( page );
		expect( await page.locator( '#comp-faq > [data-blocks-engine-capture-ported-embed="wix-faq"]' ).count() ).toBe( 1 );
	}, 30_000 );

	it( 'carries only validated data out of a FAQ frame that tampers with its own DOM, under Trusted Types', async ({ newPage }) => {
		const page = await newPage();
		await routeFaqApp( page );
		await page.setContent( `<meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'">${ FRAME_STYLE }<iframe title="Wix FAQ" src="${ faqFrame( 'tamper' ) }"></iframe>` );
		await portWixRuntimeEmbeds( page );
		await expectPortedFaq( page );
		expect( await page.locator( 'img' ).count() ).toBe( 0 );
		expect( await page.evaluate( () => ( window as unknown as { pwned?: number } ).pwned ) ).toBeUndefined();
	}, 30_000 );

	it( 'reads a FAQ frame that navigated while it was awaited', async ({ newPage }) => {
		const page = await newPage();
		await routeFaqApp( page );
		await page.setContent( `${ FRAME_STYLE }<iframe title="Wix FAQ" src="${ faqFrame( 'navigate' ) }"></iframe>` );
		await portWixRuntimeEmbeds( page, { faqRenderMilliseconds: 4_000 } );
		await expectPortedFaq( page );
	}, 30_000 );

	it( 'ports the frame Wix remounts while the first one is awaited, and leaves no token behind', async ({ newPage }) => {
		const page = await newPage();
		await routeFaqApp( page );
		// The first frame never renders; the viewer replaces it with a working one meanwhile.
		await page.setContent( `${ FRAME_STYLE }<div id="comp-faq"><iframe title="Wix FAQ" src="${ faqFrame( 'never' ) }"></iframe></div>` );
		await page.evaluate( ( src ) => setTimeout( () => {
			const next = document.createElement( 'iframe' );
			next.title = 'Wix FAQ';
			next.src = src;
			document.querySelector( '#comp-faq iframe' )!.replaceWith( next );
		}, 300 ), faqFrame() );
		await portWixRuntimeEmbeds( page, { faqRenderMilliseconds: 4_000 } );
		await expectPortedFaq( page );
		// A frame mounted after the port never reaches the saved HTML with its token.
		await page.evaluate( ( src ) => { const late = document.createElement( 'iframe' ); late.title = 'Wix FAQ'; late.src = src; late.style.cssText = 'width:600px;height:400px'; document.body.append( late ); }, faqFrame() );
		const html = await savedHtml( page );
		expect( html ).not.toContain( 'instance=' );
		expect( html ).toContain( wixEmbedNote( 'Wix FAQ' ) );
	}, 30_000 );

	it( 'shares one wait across FAQ frames that never show, and saves them without their token', async ({ newPage }) => {
		const page = await newPage();
		await routeFaqApp( page );
		await page.setContent( `${ FRAME_STYLE }<div style="display:none"><iframe title="Wix FAQ" src="${ faqFrame( 'never' ) }"></iframe></div>
			<iframe title="Wix FAQ" style="height:0" src="${ faqFrame( 'never' ) }"></iframe>` );
		const startedAt = Date.now();
		await portWixRuntimeEmbeds( page, { faqRenderMilliseconds: 1_500 } );
		expect( Date.now() - startedAt ).toBeLessThan( 2_500 );
		const html = await savedHtml( page );
		expect( html ).not.toContain( 'instance=' );
		expect( html ).not.toContain( '<iframe' );
		expect( html ).not.toContain( 'data-blocks-engine-capture-unported-embed' );
	}, 30_000 );

	it( 'ports a FAQ frame Wix reveals once loaded, but not one that stays hidden', async ({ newPage }) => {
		const page = await newPage();
		await routeFaqApp( page );
		// Wix keeps an app frame visibility:hidden until it has loaded, then shows it.
		await page.setContent( `${ FRAME_STYLE }<iframe title="Wix FAQ" style="visibility:hidden" src="${ faqFrame() }"></iframe>` );
		await page.evaluate( () => setTimeout( () => { document.querySelector< HTMLElement >( 'iframe' )!.style.visibility = 'visible'; }, 1_000 ) );
		await portWixRuntimeEmbeds( page, { faqRenderMilliseconds: 4_000 } );
		await expectPortedFaq( page );

		for ( const hidden of [ 'visibility:hidden', 'opacity:0' ] ) {
			await page.setContent( `${ FRAME_STYLE }<iframe title="Wix FAQ" style="${ hidden }" src="${ faqFrame() }"></iframe>` );
			await portWixRuntimeEmbeds( page, { faqRenderMilliseconds: 2_500 } );
			expect( await page.locator( 'details, [data-blocks-engine-capture-ported-embed]' ).count(), hidden ).toBe( 0 );
			const html = await savedHtml( page );
			expect( html, hidden ).not.toContain( 'instance=' );
			expect( html, hidden ).not.toContain( '<iframe' );
		}
	}, 30_000 );

	it( 'ports a FAQ that was inside display:none and is revealed during the wait', async ({ newPage }) => {
		const page = await newPage();
		await routeFaqApp( page );
		await page.setContent( `${ FRAME_STYLE }<div id="host" style="display:none"><iframe title="Wix FAQ" src="${ faqFrame() }"></iframe></div>` );
		await page.evaluate( () => setTimeout( () => { document.getElementById( 'host' )!.style.display = 'block'; }, 300 ) );
		await portWixRuntimeEmbeds( page, { faqRenderMilliseconds: 4_000 } );
		await expectPortedFaq( page );
	}, 30_000 );

	it( 'waits for a FAQ whose questions arrive in batches, however slowly within the budget', async ({ newPage }) => {
		const page = await newPage();
		await routeFaqApp( page );
		for ( const variant of [ 'staggered', 'slow-staggered' ] ) {
			await page.setContent( `${ FRAME_STYLE }<iframe title="Wix FAQ" src="${ faqFrame( variant ) }"></iframe>` );
			await portWixRuntimeEmbeds( page, { faqRenderMilliseconds: 6_000 } );
			await expectPortedFaq( page );
		}
	}, 30_000 );

	it( 'leaves early once an already-rendered FAQ is ported and the page has been quiet', async ({ newPage }) => {
		const page = await newPage();
		await routeFaqApp( page );
		// The adapter starts following the app's queries in prepare, before the frame loads.
		trackWixFaqQueries( page );
		await page.setContent( `${ FRAME_STYLE }<iframe title="Wix FAQ" src="${ faqFrame() }"></iframe>` );
		await page.frameLocator( 'iframe' ).locator( '[data-hook="accordion-item-header"]' ).first().waitFor();
		await page.waitForTimeout( 100 );
		const startedAt = Date.now();
		await portWixRuntimeEmbeds( page );
		expect( Date.now() - startedAt ).toBeLessThan( 1_500 );
		await expectPortedFaq( page );
	}, 30_000 );

	it( 'waits for every question a cursor chain counted, and ignores failed queries', async ({ newPage }) => {
		const page = await newPage();
		await routeFaqApp( page );
		for ( const variant of [ 'final-late', 'error-first' ] ) {
			await page.setContent( `${ FRAME_STYLE }<iframe title="Wix FAQ" src="${ faqFrame( variant ) }"></iframe>` );
			await portWixRuntimeEmbeds( page, { faqRenderMilliseconds: 6_000 } );
			await expectPortedFaq( page );
		}
	}, 30_000 );

	it( 'sees a FAQ that queried once at startup, from the adapter init script', async ({ newPage }) => {
		const page = await newPage();
		await routeFaqApp( page );
		await capture.initScript!( page );
		await page.setContent( `${ FRAME_STYLE }<iframe title="Wix FAQ" src="${ faqFrame() }"></iframe>` );
		await page.frameLocator( 'iframe' ).locator( '[data-hook="accordion-item-header"]' ).first().waitFor();
		await portWixRuntimeEmbeds( page );
		await expectPortedFaq( page );
	}, 30_000 );

	it( 'starts over when a FAQ frame navigates in place after a final answer, and forgets detached frames', async ({ newPage }) => {
		const page = await newPage();
		await routeFaqApp( page );
		const frames = trackWixFaqQueries( page );
		await page.setContent( `${ FRAME_STYLE }<iframe title="Wix FAQ" src="${ faqFrame( 'renav-a' ) }"></iframe>` );
		await portWixRuntimeEmbeds( page, { faqRenderMilliseconds: 6_000 } );
		await expectPortedFaq( page );
		await page.setContent( `${ FRAME_STYLE }<iframe src="${ faqFrame() }"></iframe><iframe src="${ faqFrame() }"></iframe>` );
		await expect.poll( () => frames.size ).toBe( 2 );
		await page.evaluate( () => document.querySelectorAll( 'iframe' ).forEach( ( frame ) => frame.remove() ) );
		await expect.poll( () => frames.size ).toBe( 0 );
	}, 30_000 );

	it( 'keeps an answer link that carries an app credential as text only', async ({ newPage }) => {
		const page = await newPage();
		await routeFaqApp( page );
		await page.setContent( `${ FRAME_STYLE }<iframe title="Wix FAQ" src="${ faqFrame( 'token-link' ) }"></iframe>` );
		await portWixRuntimeEmbeds( page );
		const faq = page.locator( '[data-blocks-engine-capture-ported-embed="wix-faq"]' );
		expect( await faq.locator( 'details > div' ).first().innerHTML() ).toBe( '<p>See the app page.</p>' );
		expect( await savedHtml( page ) ).not.toMatch( /instance|7UqG_/i );
	}, 30_000 );

	it( 'gives a venue map host that mounts during the FAQ wait the warmup-data fallback', async ({ newPage }) => {
		const page = await newPage();
		await routeFaqApp( page );
		await page.route( /maps\.google\.com/, ( route ) => route.fulfill( { contentType: 'text/html', body: '<p>map</p>' } ) );
		const warmup = { appsWarmupData: { events: { event: { event: { id: 'e1', location: { coordinates: { lat: 48.8566, lng: 2.3522 } } } } } } };
		await page.setContent( `<html lang="fr">${ FRAME_STYLE }<script type="application/json" id="wix-warmup-data">${ JSON.stringify( warmup ) }</script><iframe title="Wix FAQ" src="${ faqFrame() }"></iframe><div id="venue" style="width:600px;height:300px"></div></html>` );
		await page.evaluate( () => setTimeout( () => {
			const host = document.createElement( 'div' );
			host.id = 'event-details-page-map';
			host.setAttribute( 'data-hook', 'map' );
			host.style.cssText = 'width:600px;height:300px';
			document.getElementById( 'venue' )!.replaceChildren( host );
		}, 300 ) );
		await portWixRuntimeEmbeds( page, { faqRenderMilliseconds: 4_000 } );
		expect( await page.locator( '#event-details-page-map > iframe' ).getAttribute( 'src' ) ).toBe( 'https://maps.google.com/maps?q=48.8566%2C2.3522&z=15&hl=fr&output=embed' );
	}, 30_000 );

	it( 'reconciles late FAQ mounts, remounts after a port and late Events maps until the deadline', async ({ newPage }) => {
		const page = await newPage();
		await routeFaqApp( page );
		await page.route( /events\.wixapps\.net|maps\.google\.com/, ( route ) => route.fulfill( { contentType: 'text/html', body: '<p>map</p>' } ) );
		const frame = `<iframe title="Wix FAQ" src="${ faqFrame() }"></iframe>`;
		await page.setContent( `${ FRAME_STYLE }<div id="a">${ frame }</div><div id="b">${ frame }</div><div id="c">${ frame }</div><div id="d"></div><div id="e">${ frame }</div><div id="map"></div>` );
		await page.evaluate( ( { faq, map } ) => {
			const mount = ( id: string, src: string, title: string ) => {
				const element = document.createElement( 'iframe' );
				element.title = title;
				element.src = src;
				document.getElementById( id )!.replaceChildren( element );
			};
			// A fourth FAQ mounts a second in, and an Events venue map during the wait.
			setTimeout( () => mount( 'd', faq, 'Wix FAQ' ), 1_000 );
			setTimeout( () => mount( 'map', map, 'Map' ), 600 );
			// Wix remounts #e's widget after it was ported.
			const watch = setInterval( () => {
				if ( ! document.querySelector( '#e > [data-blocks-engine-capture-ported-embed]' ) ) return;
				clearInterval( watch );
				setTimeout( () => mount( 'e', faq, 'Wix FAQ' ), 200 );
			}, 50 );
		}, { faq: faqFrame(), map: APP_MAP } );
		await portWixRuntimeEmbeds( page, { faqRenderMilliseconds: 6_000 } );
		for ( const id of [ 'a', 'b', 'c', 'd', 'e' ] ) {
			expect( await page.locator( `#${ id } > [data-blocks-engine-capture-ported-embed="wix-faq"] summary` ).count(), id ).toBe( 2 );
		}
		expect( await page.locator( '#map > iframe' ).getAttribute( 'data-blocks-engine-capture-ported-embed' ) ).toBe( 'wix-google-map' );
		expect( await page.locator( '[data-blocks-engine-capture-unported-embed]' ).count() ).toBe( 0 );
		expect( await savedHtml( page ) ).not.toContain( 'instance=' );
	}, 30_000 );

	it( 'saves no app frame token after a same-URL reload drops the runtime port', async ({ newPage, serve }) => {
		const { origin } = await serve( ( _request, response ) => {
			response.setHeader( 'content-type', 'text/html' );
			response.end( `<style>body{margin:0}iframe{border:0;display:block;width:180px;height:180px}</style><iframe title="PDF File Viewer" src="${ APP_WIDGET.replace( /&/g, '&amp;' ) }"></iframe><div style="display:none"><iframe title="Hidden" src="${ APP_WIDGET.replace( /&/g, '&amp;' ) }"></iframe></div><iframe id="html-embed" title="Embedded Content" src="${ HTML_EMBED }"></iframe>` );
		} );
		const page = await newPage();
		await page.route( /appspot\.com|filesusr\.com/, ( route ) => route.fulfill( { contentType: 'text/html', body: '<p>widget</p>' } ) );
		await page.goto( origin );
		await capture.beforeSerialize!( page, { url: page.url(), viewport: 'desktop' } );
		// The source reloads itself after the hook ran: its own document, frames and tokens are back.
		await page.reload();
		const html = await savedHtml( page );
		expect( html ).not.toContain( 'instance=' );
		expect( html.match( /data-blocks-engine-capture-unported-embed="wix"/g ) ).toHaveLength( 1 );
		expect( html ).toContain( wixEmbedNote( 'PDF File Viewer' ) );
		// Public embeds are kept as they are.
		expect( html ).toContain( `src="${ HTML_EMBED }"` );
	}, 30_000 );

	it( 'leaves the note rather than empty or partial answers', async ({ newPage }) => {
		const page = await newPage();
		await routeFaqApp( page );
		for ( const variant of [ 'never', 'missing-panel', 'tabs' ] ) {
			await page.setContent( `${ FRAME_STYLE }<iframe title="Wix FAQ" src="${ faqFrame( variant ) }"></iframe>` );
			await portWixRuntimeEmbeds( page, { faqRenderMilliseconds: 1_500 } );
			expect( await page.locator( '[data-blocks-engine-capture-ported-embed], details' ).count(), variant ).toBe( 0 );
			expect( await page.locator( '[data-blocks-engine-capture-unported-embed="wix"]' ).textContent(), variant ).toBe( wixEmbedNote( 'Wix FAQ' ) );
			expect( await savedHtml( page ), variant ).not.toContain( 'instance=' );
		}
	}, 30_000 );
} );
