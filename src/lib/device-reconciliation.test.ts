import * as cheerio from 'cheerio';
import { chromium, devices } from 'playwright';
import { describe, expect, it } from 'vitest';
import { reconcileDeviceDocuments } from './device-reconciliation.js';
import type { DeviceDocumentSelection } from './document-selection.js';
import { VIEWPORT_ENTRANCE_ATTRIBUTE as ENTRANCE, withViewportEntrances } from './viewport-entrances.js';

const selection: DeviceDocumentSelection = {
	kind: 'device', id: 'fixture', defaultDocument: 'desktop', documents: [ 'desktop', 'tablet' ],
	rules: [ { userAgent: 'iPad', document: 'tablet' } ], evidence: 'Observed request identities',
};
const state = ( width: number, height: number ) => ( {
	attributes: { 'data-active': { before: 'false', after: 'true' } },
	rootMargin: '0px', threshold: [ 0 ], repeat: false,
	cssAnimations: [ { name: 'reveal', timing: { duration: 100 } as EffectTiming, frames: [ { opacity: '0', offset: 0, computedOffset: 0, easing: 'linear', composite: 'auto' }, { opacity: '1', offset: 1, computedOffset: 1, easing: 'linear', composite: 'auto' } ] as ComputedKeyframe[] } ],
	startupContexts: [ { width, height, started: false } ],
} );
const styles = '<style>body{margin:0}#entrance{margin-top:5000px;animation:reveal .1s both paused}@keyframes reveal{from{opacity:0}to{opacity:1}}</style>';
const documentWithEntrance = ( evidence: unknown ) => {
	const $ = cheerio.load( '<body><main id="content"><section id="entrance" data-active="true">Entrance</section></main></body>' );
	$( '#entrance' ).attr( ENTRANCE, JSON.stringify( evidence ) );
	return $.html();
};

describe( 'device component reconciliation', () => {
	const document = ( content: string ) => `<!doctype html><html><head><link rel="stylesheet" href="/layout.css"></head><body><main id="content"><p id="intro">Shared content</p>${ content }</main></body></html>`;

	it.each( [
		[ 'text-align:right', 'text-align: right', false ],
		[ 'text-align: right', 'text-align: left', true ],
	] )( 'records device inline style only when declarations differ (%s / %s)', ( desktopStyle, tabletStyle, recorded ) => {
		const list = ( style: string ) => `<ul id="menu" style="${ style }"><li id="item">Item</li></ul>`;
		const result = reconcileDeviceDocuments( { desktop: document( list( desktopStyle ) ), tablet: document( list( tabletStyle ) ) }, selection );
		expect( result.reconciled.has( 'tablet' ) ).toBe( true );
		expect( cheerio.load( result.body )( '#menu' ).attr( 'data-blocks-engine-capture-device-inline' ) !== undefined ).toBe( recorded );
	} );

	it( 'collapses differing data scripts with a linked stylesheet, keeping the default copy', () => {
		const script = ( device: string ) => `<script id="model" type="application/json">{"device":"${ device }"}</script>`;
		const result = reconcileDeviceDocuments( { desktop: document( script( 'desktop' ) ), tablet: document( script( 'tablet' ) ) }, selection );
		expect( result.evidence.devices.tablet.outcome ).toBe( 'collapsed-identity-subset' );
		expect( result.reconciled.has( 'tablet' ) ).toBe( true );
		const $ = cheerio.load( result.body );
		expect( $( 'script' ) ).toHaveLength( 1 );
		expect( $( '#model' ).text() ).toBe( '{"device":"desktop"}' );
		expect( $( '#content' ) ).toHaveLength( 1 );
	} );

	it.each( [ 'style', 'link', 'meta', 'noscript', 'template' ] )( 'keeps the default %s subtree without splitting a component', tag => {
		const subtree = ( device: string ) => tag === 'link' || tag === 'meta'
			? `<${ tag } id="metadata" class="${ device }">`
			: `<${ tag } id="metadata"><span id="nested" class="${ device }">${ device }</span></${ tag }>`;
		const result = reconcileDeviceDocuments( { desktop: document( subtree( 'desktop' ) ), tablet: document( subtree( 'tablet' ) ) }, selection );
		expect( result.evidence.devices.tablet.outcome ).toBe( 'collapsed-identity-subset' );
		const $ = cheerio.load( result.body );
		expect( $( '#metadata' ) ).toHaveLength( 1 );
		expect( $.html() ).not.toContain( 'class="tablet"' );
	} );

	it( 'collapses a component one device wraps in a device-only identified layer', () => {
		const card = '<section id="card"><p id="card-text">Card</p></section>';
		const result = reconcileDeviceDocuments( { desktop: document( `<div id="transition">${ card }</div>` ), tablet: document( card ) }, selection );
		expect( result.evidence.devices.tablet ).toMatchObject( { outcome: 'collapsed-identity-subset', divergedComponents: 0 } );
		const $ = cheerio.load( result.body );
		expect( $( '#transition > #card' ) ).toHaveLength( 1 );
		expect( $( '[id^="card--"]' ) ).toHaveLength( 0 );
	} );

	it.each( [
		[ 'an uncaptured', undefined, false ],
		[ 'a class-only', '.left{float:left}', true ],
		[ 'an id-selecting', '.right #card{color:red}', false ],
		[ 'an exact id attribute', '[id="card"]{color:red}', false ],
		[ 'an id prefix attribute', '[id^="ca"]{color:red}', false ],
		[ 'an importing', '@import "more.css";', false ],
	] )( 're-parented components collapse with %s linked stylesheet only when it cannot select the renamed copy', ( _label, css, collapsed ) => {
		const result = reconcileDeviceDocuments( {
			desktop: document( '<div class="left"><section id="card">Card</section></div><div class="right"></div>' ),
			tablet: document( '<div class="left"></div><div class="right"><section id="card">Card</section></div>' ),
		}, selection, href => href === '/layout.css' ? css : undefined );
		expect( result.reconciled.has( 'tablet' ) ).toBe( collapsed );
		if ( collapsed ) expect( cheerio.load( result.body )( '#card--data-blocks-engine-capture-tablet' ) ).toHaveLength( 1 );
		else expect( result.evidence.devices.tablet ).toMatchObject( { outcome: 'dual-structural', reason: expect.stringContaining( 'linked stylesheet' ) } );
	} );
} );

describe( 'device entrance reconciliation', () => {
	it( 'unions startup evidence on matched nodes without duplicating contexts', () => {
		const desktop = state( 1440, 900 ), tablet = state( 980, 1148 );
		tablet.startupContexts.push( ...desktop.startupContexts );
		const result = reconcileDeviceDocuments( { desktop: documentWithEntrance( desktop ), tablet: documentWithEntrance( tablet ) }, selection );
		expect( result.reconciled.has( 'tablet' ) ).toBe( true );
		const $ = cheerio.load( result.body );
		expect( JSON.parse( $( '#entrance' ).attr( ENTRANCE )! ).startupContexts ).toEqual( [ ...desktop.startupContexts, tablet.startupContexts[ 0 ] ] );
	} );

	for ( const difference of [ 'attributes', 'threshold', 'rootMargin', 'cssAnimations', 'repeat', 'conflicting-context', 'invalid', 'missing' ] ) it( `retains a separate device for ${ difference } evidence`, () => {
		const desktop = state( 1440, 900 ), tablet = state( 980, 1148 );
		if ( difference === 'attributes' ) tablet.attributes[ 'data-active' ].before = 'pending';
		if ( difference === 'threshold' ) tablet.threshold = [ 0.5 ];
		if ( difference === 'rootMargin' ) tablet.rootMargin = '10px';
		if ( difference === 'cssAnimations' ) tablet.cssAnimations[ 0 ].name = 'other';
		if ( difference === 'repeat' ) tablet.repeat = true;
		if ( difference === 'conflicting-context' ) tablet.startupContexts = [ { width: 1440, height: 900, started: true } ];
		const tabletHtml = difference === 'missing' ? '<body><main id="content"><section id="entrance" data-active="true">Entrance</section></main></body>' : documentWithEntrance( difference === 'invalid' ? null : tablet );
		const result = reconcileDeviceDocuments( { desktop: documentWithEntrance( desktop ), tablet: tabletHtml }, selection );
		expect( result.reconciled.has( 'tablet' ) ).toBe( false );
		expect( result.evidence.devices.tablet ).toMatchObject( { outcome: 'dual-structural', reason: expect.stringContaining( 'Viewport entrance evidence' ) } );
		const $ = cheerio.load( result.body );
		expect( JSON.parse( $( '#entrance' ).attr( ENTRANCE )! ) ).toEqual( desktop );
	} );

	it( 'does not let a later device overwrite an earlier device startup observation', () => {
		const desktop = state( 1440, 900 ), tablet = state( 980, 1148 ), phone = state( 980, 1148 );
		phone.startupContexts[ 0 ].started = true;
		const result = reconcileDeviceDocuments( { desktop: documentWithEntrance( desktop ), tablet: documentWithEntrance( tablet ), phone: documentWithEntrance( phone ) }, { ...selection, documents: [ 'desktop', 'tablet', 'phone' ] } );
		expect( [ ...result.reconciled ] ).toEqual( [ 'tablet' ] );
		expect( result.evidence.devices.phone.outcome ).toBe( 'dual-structural' );
	} );

	it.skipIf( process.env.SKIP_BROWSER_TESTS )( 'replays the collapsed entrance at both captured device identities and sizes without loss', async () => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const profiles = [ { viewport: { width: 1440, height: 900 } }, { ...devices[ 'iPad (gen 7)' ], viewport: { width: 768, height: 900 } } ];
			const contexts = [];
			const captures: Record<string, string> = {};
			for ( const [ index, profile ] of profiles.entries() ) {
				const context = await browser.newContext( profile );
				contexts.push( context );
				const page = await context.newPage();
				await page.setContent( `<!doctype html><html><head>${ styles }</head><body><section id="entrance">Entrance</section></body></html>` );
				const size = await page.evaluate( () => ( { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight } ) );
				const evidence = state( size.width, size.height );
				evidence.cssAnimations = await page.locator( '#entrance' ).evaluate( element => element.getAnimations().map( animation => ( {
					name: ( animation as CSSAnimation ).animationName, timing: animation.effect!.getTiming(), frames: ( animation.effect as KeyframeEffect ).getKeyframes(),
				} ) ) );
				captures[ index ? 'tablet' : 'desktop' ] = documentWithEntrance( evidence );
			}
			const result = reconcileDeviceDocuments( captures, selection );
			expect( result.reconciled.has( 'tablet' ) ).toBe( true );
			const html = withViewportEntrances( `<!doctype html><html><head>${ styles }</head><body>${ result.body }</body></html>` );
			for ( const context of contexts ) {
				const page = await context.newPage();
				await page.setContent( html );
				expect( await page.locator( '#entrance' ).getAttribute( 'data-blocks-engine-capture-viewport-entrance-loss' ) ).toBeNull();
				await page.locator( '#entrance' ).scrollIntoViewIfNeeded();
				await page.waitForFunction( () => document.getElementById( 'entrance' )?.getAttribute( 'data-active' ) === 'true' );
				expect( await page.locator( '#entrance' ).getAttribute( 'data-blocks-engine-capture-viewport-entrance-loss' ) ).toBeNull();
			}
		} finally { await browser.close(); }
	}, 15_000 );
} );
