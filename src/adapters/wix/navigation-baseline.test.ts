import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { capture } from './capture.js';
import { createReferenceCollector, readFrozenObservation, type FidelityReference } from '../../lib/fidelity/reference.js';
import { captureTriggeredDialogs } from '../../lib/screenshot/interaction-capture.js';
import { wireCapturedDialogs } from '../../lib/static-dialogs.js';

const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;font:16px Arial}header{height:64px}nav{position:relative}ul{display:flex;gap:8px;margin:0;padding:0;list-style:none}
li{flex:none;width:180px;height:64px}a,[data-testid=linkElement],button{display:block;padding:12px}main{height:1100px}
#overflow{display:none;visibility:hidden!important;position:absolute;top:64px;right:0;background:white;width:220px}
nav[data-open] #overflow{visibility:visible!important}
#MENU_AS_CONTAINER{display:none;position:absolute;top:64px;left:0;background:white;width:220px}
#MENU_AS_CONTAINER_TOGGLE{display:none}#MENU_AS_CONTAINER ul{display:block}
@media(max-width:599px){#nav-fixture{display:none}#MENU_AS_CONTAINER_TOGGLE{display:block}}
</style></head><body>${ '<div>'.repeat( 9 ) }<header><nav>
<ul id="nav-fixture"><li><a href="#content">Home</a></li><li><div id="locations-control" role="button" tabindex="0" data-testid="linkElement" aria-haspopup="menu" aria-expanded="false" aria-controls="overflow">Visit</div></li>
<li aria-hidden="true" style="height:0;overflow:hidden;position:absolute"><a href="#content" tabindex="-1">Hidden destination</a></li>
<li id="nav-fixture__more__" data-width="100"><div id="overflow-control" tabindex="0" data-testid="linkElement" aria-haspopup="true" aria-expanded="false" aria-controls="overflow">More</div></li></ul>
<div id="overflow" role="menu"><a href="#content">Hidden destination</a><a href="#content">Another destination</a></div>
<button id="MENU_AS_CONTAINER_TOGGLE" aria-label="Menu" aria-haspopup="menu" aria-expanded="false" aria-controls="MENU_AS_CONTAINER">Menu</button>
<div id="MENU_AS_CONTAINER" role="menu"><ul><li><a href="#content">Mobile destination</a></li></ul></div>
</nav></header>${ '</div>'.repeat( 9 ) }<main id="content"><h1>Source content</h1></main>
<script>
const more=document.getElementById('overflow-control'),locations=document.getElementById('locations-control'),toggle=document.getElementById('MENU_AS_CONTAINER_TOGGLE');
function switchPanel(control,panel){const open=control.getAttribute('aria-expanded')!=='true';control.setAttribute('aria-expanded',String(open));if(panel.id==='overflow'){panel.innerHTML=control===more?'<a href="#content">Hidden destination</a><a href="#content">Another destination</a>':'<a href="#content">First location</a><a href="#content">Second location</a>';document.querySelector('nav').toggleAttribute('data-open',open)}panel.style.display=open?'block':'none'}
more.onclick=()=>switchPanel(more,document.getElementById('overflow'));
locations.onclick=()=>switchPanel(locations,document.getElementById('overflow'));
toggle.onclick=()=>switchPanel(toggle,document.getElementById('MENU_AS_CONTAINER'));
document.addEventListener('keydown',event=>{if(event.key==='Escape'){document.querySelector('nav').removeAttribute('data-open');for(const [control,id] of [[more,'overflow'],[locations,'overflow'],[toggle,'MENU_AS_CONTAINER']]){control.setAttribute('aria-expanded','false');document.getElementById(id).style.display='none'}}});
// Like a builder's two-phase layout service, measurement requires its owned
// overflow node, and patching consumes the successful measurement transaction.
let measured;
function schedule(){measured=undefined;requestAnimationFrame(()=>{const width=document.getElementById('nav-fixture__more__').dataset.width;measured={'nav-fixture':width}});requestAnimationFrame(()=>{document.body.dataset.measured=measured['nav-fixture']})}
new MutationObserver(schedule).observe(document.getElementById('nav-fixture'),{childList:true,subtree:true});
addEventListener('resize',schedule);schedule();
</script></body></html>`;

async function geometry( page: Page ) {
	return page.evaluate( () => {
		const box = ( element: Element ) => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle( element );
			return { id: element.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height, display: style.display,
				painted: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden', expanded: element.getAttribute( 'aria-expanded' ) };
		};
		return { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
			controls: Array.from( document.querySelectorAll( 'header a,header [data-testid=linkElement],header button' ), box ),
			more: Boolean( document.getElementById( 'nav-fixture__more__' ) ) };
	} );
}

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'Wix resting overflow navigation', () => {
	for ( const width of [ 768, 1440, 390 ] ) {
		it( `preserves source runtime, frozen readiness and offline overflow at ${ width }px`, async () => {
			const browser = await chromium.launch();
			const { defaultBrowserType: _browserType, ...mobile } = devices[ 'iPhone 17' ];
			const context = await browser.newContext( { ...( width === 390 ? mobile : {} ), viewport: { width, height: 900 } } );
			await context.addInitScript( "globalThis.__name=function(fn){return fn;}" );
			const url = 'https://navigation.test/';
			await context.route( `${ url }**`, route => route.fulfill( { contentType: 'text/html', body: fixture } ) );
			const page = await context.newPage();
			const errors: string[] = [];
			page.on( 'pageerror', error => errors.push( error.message ) );
			const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
			const directory = mkdtempSync( join( parent, 'wix-navigation-' ) );
			try {
				await page.goto( url );
				await page.waitForFunction( () => document.body.dataset.measured === '100' );
				const before = await geometry( page );
				await capture.prepare!( page, { url, viewport: width === 390 ? 'mobile' : 'desktop' } );
				await page.setViewportSize( { width: width - 1, height: 900 } );
				await page.setViewportSize( { width, height: 900 } );
				await page.waitForTimeout( 100 );
				const after = await geometry( page );
				expect( { errors, geometry: after } ).toEqual( { errors: [], geometry: before } );
				const baseline = ( await page.content() ).replace( /<script\b[^>]*>[\s\S]*?<\/script>/gi, '' );
				const collector = createReferenceCollector( directory, url, [ url ], { prepareCapture: capture.prepare, removeSelectors: capture.removeSelectors } );
				await collector.observe( page, url, width === 390 ? 'mobile' : 'desktop', errors,
					{ isMobile: width === 390, hasTouch: width === 390 } );
				const receipt = join( directory, 'capture-receipt.json' );
				writeFileSync( receipt, JSON.stringify( { source: { url }, routes: [ { url, path: 'website/index.html' } ] } ) );
				const reference = JSON.parse( readFileSync( collector.finalize( receipt ), 'utf8' ) ) as FidelityReference;
				for ( const entry of reference.entries ) {
					expect( entry.readiness.ready, entry.readiness.reasons.join( ', ' ) ).toBe( true );
					expect( () => readFrozenObservation( directory, entry ) ).not.toThrow();
				}
				const report = await captureTriggeredDialogs( page, url );
				const id = width === 390 ? 'MENU_AS_CONTAINER_TOGGLE' : 'overflow-control';
				const state = report.states.find( state => state.trigger.id === id || state.trigger.selector.includes( id ) );
				expect( state?.status ).toBe( 'captured' );
				expect( await geometry( page ) ).toEqual( before );
				await page.setContent( wireCapturedDialogs( baseline, report.states ) );
				// Offline source scripts are gone; the existing generic popup replay
				// must own opening/closing without changing the resting header layout.
				expect( await geometry( page ) ).toEqual( before );
				const control = width === 390 ? page.locator( '#MENU_AS_CONTAINER_TOGGLE' ) : page.locator( '#overflow-control' );
				const panel = page.locator( `[id="${ await control.getAttribute( 'aria-controls' ) }"]` );
				expect( await panel.isVisible() ).toBe( false );
				await control.click();
				expect( await panel.isVisible() ).toBe( true );
				expect( await control.getAttribute( 'aria-expanded' ) ).toBe( 'true' );
				if ( width !== 390 ) {
					expect( await panel.locator( 'a' ).allTextContents() ).toEqual( [ 'Hidden destination', 'Another destination' ] );
					await page.evaluate( () => window.dispatchEvent( new Event( 'resize' ) ) );
					expect( await panel.isVisible() ).toBe( true );
					await page.locator( '#locations-control' ).click();
					expect( await panel.locator( 'a' ).allTextContents() ).toEqual( [ 'First location', 'Second location' ] );
					expect( await control.getAttribute( 'aria-expanded' ) ).toBe( 'false' );
					await control.click();
					expect( await panel.locator( 'a' ).allTextContents() ).toEqual( [ 'Hidden destination', 'Another destination' ] );
					expect( await page.locator( '#overflow' ).count() ).toBe( 1 );
				}
				await page.keyboard.press( 'Escape' );
				expect( await panel.isVisible() ).toBe( false );
				expect( await geometry( page ) ).toEqual( before );
				expect( errors ).toEqual( [] );
			} finally { await browser.close(); rmSync( directory, { recursive: true, force: true } ); }
		}, 60_000 );
	}

	it( 'keeps genuine errors from a fresh reference page unready', async () => {
		const browser = await chromium.launch();
		const context = await browser.newContext();
		await context.addInitScript( "globalThis.__name=function(fn){return fn;}" );
		let navigations = 0;
		const url = 'https://navigation.test/';
		await context.route( url, route => route.fulfill( { contentType: 'text/html', body: '<h1>Source</h1>' +
			( navigations++ ? '<script>throw new Error("reference-only failure")</script>' : '' ) } ) );
		const page = await context.newPage();
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const directory = mkdtempSync( join( parent, 'wix-reference-error-' ) );
		try {
			await page.goto( url );
			const collector = createReferenceCollector( directory, url, [ url ] );
			await collector.observe( page, url, 'desktop', [], { isMobile: false, hasTouch: false } );
			const receipt = join( directory, 'capture-receipt.json' );
			writeFileSync( receipt, JSON.stringify( { source: { url }, routes: [ { url, path: 'website/index.html' } ] } ) );
			const reference = JSON.parse( readFileSync( collector.finalize( receipt ), 'utf8' ) ) as FidelityReference;
			for ( const entry of reference.entries ) {
				expect( entry.readiness.ready ).toBe( false );
				expect( entry.readiness.reasons.join( ', ' ) ).toContain( 'reference-only failure' );
				expect( () => readFrozenObservation( directory, entry ) ).toThrow( /reference-only failure/ );
			}
		} finally { await browser.close(); rmSync( directory, { recursive: true, force: true } ); }
	}, 30_000 );
} );
