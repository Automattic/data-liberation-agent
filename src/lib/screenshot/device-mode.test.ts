import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices } from 'playwright';
import { captureScreenshots, comparisonFailedAlike } from './screenshotter.js';
import { SOURCE_NAVIGATION_LIMITS, SourceNavigationError } from '../source-navigation.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { startStaticServer } from '../replicate/local-site/static-server.js';
import { compareBodyClasses, compareServerHtml, compareStructure, decideRouteMode, decideSiteMode, normalizeServerHtml, observeSwitchWidth, replayableRequestHeaders, resampleSiteServerHtml, summarizeRouteDecisions } from './device-mode.js';
import type { ManifestEntry } from './manifest-queue.js';
import type { ScreenshotResult } from './types.js';

describe( 'device-mode evidence', () => {
	it( 'never treats a timeout in both identities as the route having no phone document', () => {
		const timeout = () => Object.assign( new Error( 'route.fetch: Timeout 29990ms exceeded.' ), { name: 'TimeoutError' } );
		expect( comparisonFailedAlike( timeout(), timeout() ) ).toBe( false );
		expect( comparisonFailedAlike( new SourceNavigationError( 'Source navigation time budget exhausted' ), new SourceNavigationError( 'Source navigation time budget exhausted' ) ) ).toBe( false );
		expect( comparisonFailedAlike( new Error( 'the desktop document answered HTTP 404' ), new Error( 'the mobile document answered HTTP 404' ) ) ).toBe( true );
		expect( comparisonFailedAlike( new Error( 'the desktop document answered HTTP 404' ), new Error( 'the mobile document answered HTTP 500' ) ) ).toBe( false );
	} );

	it( 'switches at the first boundary where the phone identity stops rendering the phone document', async () => {
		const probed: number[] = [];
		const renders = ( layouts: Array< [ number, 'phone' | 'desktop' | 'other' ] > ) => async ( width: number ) => {
			probed.push( width );
			return [ ...layouts ].reverse().find( ( [ from ] ) => width >= from )?.[ 1 ] ?? 'phone';
		};
		expect( await observeSwitchWidth( [ 1279, 767 ], { phone: 402, desktop: 1440 }, renders( [ [ 768, 'desktop' ] ] ) ) ).toEqual( { switchWidth: 767 } );
		expect( probed ).toEqual( [ 768 ] );
		probed.length = 0;
		// A boundary the phone document still renders above is not the switch.
		expect( await observeSwitchWidth( [ 320, 767, 1279, 1440 ], { phone: 402, desktop: 1440 }, renders( [ [ 1280, 'desktop' ] ] ) ) ).toEqual( { switchWidth: 1279 } );
		expect( probed ).toEqual( [ 768, 1280 ] );
		probed.length = 0;
		// A middle layout keeps the source's first boundary and reports its range.
		expect( await observeSwitchWidth( [ 799, 1279 ], { phone: 390, desktop: 1440 }, renders( [ [ 800, 'other' ], [ 1280, 'desktop' ] ] ) ) )
			.toEqual( { switchWidth: 799, uncapturedLayout: { minWidth: 800, maxWidth: 1279 } } );
		expect( probed ).toEqual( [ 800, 1280 ] );
		expect( await observeSwitchWidth( [ 799 ], { phone: 390, desktop: 1440 }, renders( [ [ 800, 'other' ] ] ) ) )
			.toEqual( { switchWidth: 799, uncapturedLayout: { minWidth: 800 } } );
		// An identity that renders the phone document at every width observes no switch.
		expect( await observeSwitchWidth( [ 767, 1279 ], { phone: 402, desktop: 1440 }, async () => 'phone' ) ).toBeUndefined();
	} );

	it( 'ignores per-request tokens and timestamps, and nothing else', () => {
		const page = ( token: string, time: string, text = 'Hello' ) => `<html><head><meta name="csrf-token" content="${ token }"><script nonce="${ token }">window.cfg={"nonce":"${ token }","builtAt":"${ time }"}</script></head><body><form><input type="hidden" name="_csrf" value="${ token }"></form><time datetime="${ time }">${ text }</time></body></html>`;
		expect( compareServerHtml( page( 'a1', '2026-10-09T10:00:00Z' ), page( 'a1', '2026-10-09T10:00:00Z' ) ) ).toBe( 'identical' );
		expect( compareServerHtml( page( 'a1', '2026-10-09T10:00:00Z' ), page( 'b2', '2026-10-09T10:00:01.250+02:00' ) ) ).toBe( 'identical-after-normalization' );
		expect( compareServerHtml( page( 'a1', '2026-10-09T10:00:00Z' ), page( 'a1', '2026-10-09T10:00:00Z', 'Hello phone' ) ) ).toBe( 'different' );
		// An ordinary attribute or hidden input is content, not noise.
		expect( normalizeServerHtml( '<input type="hidden" name="plan" value="pro">' ) ).toBe( '<input type="hidden" name="plan" value="pro">' );
	} );

	it.each( [
		[ '<p>same</p>', '<p>same</p>', 'identical', 'reflow-only' ],
		[ '<script nonce="a"></script>', '<script nonce="b"></script>', 'identical-after-normalization', 'reflow-only' ],
		[ '<p>desktop</p>', '<p>phone</p>', 'different', 'dual' ],
	] as const )( 'confirms a first HTML difference with one paired re-sample (%s / %s)', async ( desktop, phone, serverHtml, mode ) => {
		let release!: ( html: string ) => void;
		const fetchDesktop = vi.fn( () => new Promise< string >( resolve => { release = resolve; } ) );
		const fetchPhone = vi.fn( async () => { release( desktop ); return phone; } );
		const sample = await resampleSiteServerHtml( 'different', fetchDesktop, fetchPhone );
		expect( sample ).toEqual( { serverHtml, serverHtmlFirstSample: 'different', serverHtmlResampled: true } );
		expect( fetchDesktop ).toHaveBeenCalledTimes( 1 );
		expect( fetchPhone ).toHaveBeenCalledTimes( 1 );
		expect( decideSiteMode( { requested: 'auto', ...sample } ).mode ).toBe( mode );
	} );

	it.each( [ 'identical', 'identical-after-normalization', 'unavailable' ] as const )( 'does not re-sample %s HTML', async first => {
		const fetch = vi.fn();
		expect( await resampleSiteServerHtml( first, fetch, fetch ) ).toEqual( { serverHtml: first } );
		expect( fetch ).not.toHaveBeenCalled();
	} );

	it( 'replays a navigation identity without HTTP/2 pseudo-headers, cookies or encodings', () => {
		expect( replayableRequestHeaders( {
			':authority': 'example.test', ':method': 'GET', ':path': '/', ':scheme': 'https',
			accept: 'text/html', 'accept-encoding': 'gzip, br, zstd', cookie: 'a=1',
			'sec-ch-ua-mobile': '?1', 'user-agent': 'Phone',
		} ) ).toEqual( { accept: 'text/html', 'sec-ch-ua-mobile': '?1', 'user-agent': 'Phone' } );
	} );

	it( 'keeps the first difference when a re-sample fails', async () => {
		const sample = await resampleSiteServerHtml( 'different', async () => { throw new Error( 'timeout' ); }, async () => '<p>phone</p>' );
		expect( sample ).toEqual( { serverHtml: 'different', serverHtmlFirstSample: 'different', serverHtmlResampled: true } );
		expect( decideSiteMode( { requested: 'auto', ...sample } ).mode ).toBe( 'dual' );
	} );

	it( 'counts differing element paths as a multiset and names the first divergence', () => {
		expect( compareStructure( [ 'html', 'html>body[1]' ], [ 'html', 'html>body[1]' ] ) ).toEqual( { desktopElements: 2, phoneElements: 2, differingPaths: 0 } );
		expect( compareStructure( [ 'html', 'html>body[1]' ], [ 'html', 'html>body[1]', 'html>body[1]>aside[1]' ] ) ).toEqual( {
			desktopElements: 2, phoneElements: 3, differingPaths: 1, firstDifference: 'desktop (end) / phone html>body[1]>aside[1]',
		} );
	} );

	it( 'decides on the rendered body: a head-only difference is a diagnostic, a body difference stays dual', () => {
		const body = [ 'html>body[1]', 'html>body[1]>main[1]', 'html>body[1]>main[1]>h1[1]' ];
		// Same HTML; the phone document carries one <meta> fewer before <title> (#1331).
		const desktopPaths = [ 'html', 'html>head[1]', 'html>head[1]>meta[1]', 'html>head[1]>meta[2]', 'html>head[1]>title[1]', ...body ];
		const phonePaths = [ 'html', 'html>head[1]', 'html>head[1]>meta[1]', 'html>head[1]>title[1]', ...body ];
		const structure = compareStructure( desktopPaths, phonePaths );
		expect( structure ).toEqual( {
			desktopElements: 8, phoneElements: 7, differingPaths: 0,
			headDifferingPaths: 1, firstHeadDifference: 'desktop html>head[1]>meta[2] / phone html>head[1]>title[1]',
		} );
		expect( decideRouteMode( { serverHtml: 'identical', structure } ).mode ).toBe( 'reflow-only' );
		// Head child order alone (a <meta> moved after <title>) is reported and decides nothing.
		const reordered = compareStructure( desktopPaths, [ ...phonePaths.slice( 0, 4 ), 'html>head[1]>meta[2]', ...body ] );
		expect( reordered ).toMatchObject( { differingPaths: 0, headDifferingPaths: 0, firstHeadDifference: 'desktop html>head[1]>meta[2] / phone html>head[1]>title[1]' } );
		expect( decideRouteMode( { serverHtml: 'identical', structure: reordered } ).mode ).toBe( 'reflow-only' );
		// Control: the same head difference plus a phone-only body element is dual.
		const bodyDiffers = compareStructure( desktopPaths, [ ...phonePaths, 'html>body[1]>aside[1]' ] );
		expect( bodyDiffers ).toMatchObject( { differingPaths: 1, firstDifference: 'desktop (end) / phone html>body[1]>aside[1]' } );
		expect( decideRouteMode( { serverHtml: 'identical', structure: bodyDiffers } ).mode ).toBe( 'dual' );
	} );

	it( 'uses export equivalence for runtime-injected phone nodes, but keeps real phone content dual', () => {
		const desktop = '<html><head><title>Example</title></head><body><div><h1>Welcome</h1><button>Menu</button></div></body></html>';
		const phone = desktop.replace( '</head>', '<link id="yui_3_17_2_1_123_46" rel="stylesheet" href="/widget.css"></head>' ).replace( '<body>', '<body><div id="yui_3_17_2_1_123_45"><span>Phone widget</span></div>' );
		const desktopPaths = [ 'html', 'html>head[1]', 'html>head[1]>title[1]', 'html>body[1]', 'html>body[1]>div[1]', 'html>body[1]>div[1]>h1[1]', 'html>body[1]>div[1]>button[1]' ];
		const phonePaths = [ 'html', 'html>head[1]', 'html>head[1]>title[1]', 'html>head[1]>link[1]', 'html>body[1]', 'html>body[1]>div[1]', 'html>body[1]>div[1]>span[1]', 'html>body[1]>div[2]', 'html>body[1]>div[2]>h1[1]', 'html>body[1]>div[2]>button[1]' ];
		const input = { serverHtml: 'identical' as const, structure: compareStructure( desktopPaths, phonePaths ), renderedDocuments: { desktop, phone } };
		expect( input.structure.differingPaths ).toBeGreaterThan( 0 );
		expect( decideRouteMode( input ) ).toEqual( {
			mode: 'reflow-only',
			reason: 'the phone DOM differs only in runtime-injected nodes or other differences that export treats as equivalent',
		} );
		// The same insertion without a runtime id is real content, not noise.
		expect( decideRouteMode( { ...input, renderedDocuments: { desktop, phone: phone.replace( ' id="yui_3_17_2_1_123_45"', '' ) } } ).mode ).toBe( 'dual' );
		expect( decideRouteMode( { ...input, serverHtml: 'different' } ).mode ).toBe( 'dual' );
		expect( decideRouteMode( { ...input, bodyClasses: compareBodyClasses( [], [ 'phone' ] ) } ).mode ).toBe( 'dual' );
	} );

	it( 'gates the site on adapter documents and server HTML, and each route on its own structure', () => {
		expect( decideSiteMode( { requested: 'auto', serverHtml: 'identical' } ).mode ).toBe( 'reflow-only' );
		expect( decideSiteMode( { requested: 'auto', serverHtml: 'identical-after-normalization' } ).mode ).toBe( 'reflow-only' );
		expect( decideSiteMode( { requested: 'auto', deviceDocuments: 'documentSelection', serverHtml: 'identical' } ).mode ).toBe( 'dual' );
		expect( decideSiteMode( { requested: 'auto', serverHtml: 'different' } ).mode ).toBe( 'dual' );
		expect( decideSiteMode( { requested: 'auto', serverHtml: 'unavailable' } ).mode ).toBe( 'dual' );
		expect( decideSiteMode( { requested: 'auto', probeError: 'timeout' } ).mode ).toBe( 'dual' );
		expect( decideSiteMode( { requested: 'dual', serverHtml: 'identical' } ).mode ).toBe( 'dual' );
		expect( decideSiteMode( { requested: 'reflow-only', serverHtml: 'different' } ).mode ).toBe( 'reflow-only' );
		const same = { desktopElements: 3, phoneElements: 3, differingPaths: 0 };
		expect( decideRouteMode( { serverHtml: 'identical', structure: same } ).mode ).toBe( 'reflow-only' );
		expect( decideRouteMode( { serverHtml: 'identical', structure: same, runtimeStyles: { desktop: [ [ 'fit', '#x{font-size:56px!important}' ] ], phone: [ [ 'fit', '#x{font-size:32px!important}' ] ] } } ).mode ).toBe( 'dual' );
		expect( decideRouteMode( { serverHtml: 'identical', structure: same, runtimeStyles: { desktop: [ [ 'fit', '#x{font-size:32px}' ] ], phone: [ [ 'fit', '#x{font-size:32px}' ] ] } } ).mode ).toBe( 'reflow-only' );
		expect( decideRouteMode( { serverHtml: 'identical', structure: { ...same, phoneElements: 4, differingPaths: 1 } } ).mode ).toBe( 'dual' );
		expect( decideRouteMode( { serverHtml: 'different', structure: same } ).mode ).toBe( 'dual' );
		expect( decideRouteMode( { error: 'HTTP 401' } ) ).toEqual( { mode: 'dual', reason: 'the phone check failed: HTTP 401' } );
		// A phone-only body flag can gate the source's whole layout, as the responsive assembly treats it.
		expect( decideRouteMode( { serverHtml: 'identical', structure: same, bodyClasses: compareBodyClasses( [ 'home' ], [ 'home', 'phone' ] ) } ) ).toEqual( { mode: 'dual', reason: 'the phone identity renders different body classes (+phone)' } );
		expect( summarizeRouteDecisions( [
			{ url: 'a', mode: 'reflow-only', reason: 'same', checkMs: 30 },
			{ url: 'b', mode: 'dual', reason: 'differs', checkMs: 10 },
			{ url: 'c', mode: 'reflow-only', reason: 'same', checkMs: 20 },
		] ) ).toEqual( { checked: 3, reflowOnly: 2, dual: [ { url: 'b', reason: 'differs' } ], checkMs: { total: 60, median: 20, max: 30 } } );
	} );
} );

/**
 * One page per fixture. `responsive` reflows through media queries and hides a
 * hamburger menu at desktop width; `by-agent` serves phones different HTML;
 * `mixed/promo` builds a phone-only element at narrow widths; `mixed/` reflows;
 * each `reorder/` route moves a sibling below the nav breakpoint.
 */
/**
 * Runtime-revealed nav (#1287): items become visible at >=768 and phones get a
 * body class below it; a tablet-only logo rule adds an unrelated 1279 boundary.
 */
const SWITCH_FIXTURE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Nav</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{margin:0;font-family:sans-serif}
.bar{display:flex;justify-content:space-between;align-items:center;padding:24px 48px}
.logo{margin:0;font-size:20px}
.menu{margin:0;padding:0;list-style:none;white-space:nowrap}
.item{display:inline-block;padding-left:32px;visibility:hidden}
.burger{display:none}
@media (max-width:767px){.menu{display:none}.burger{display:block}}
@media (min-width:1024px) and (max-width:1279px){.logo{font-size:18px}}
</style></head>
<body>
<header class="bar"><p class="logo">Site Title</p><a class="burger" href="#menu">&#9776;</a>
<nav><ul class="menu">
<li class="item"><a href="/">Home</a></li><li class="item"><a href="/team/">Team</a></li>
<li class="item"><a href="/partners/">Partners</a></li><li class="item"><a href="/store/">Store</a></li>
</ul></nav></header>
<main><p>Body text.</p></main>
<script>
function fit(){var wide=innerWidth>=768;document.querySelectorAll('.item').forEach(function(li){li.style.visibility=wide?'visible':'';});}
if(innerWidth<768){document.body.classList.add("phone");}
fit();addEventListener('resize',fit);
</script>
</body></html>`;

/**
 * Three runtime-rendered layouts selected by `min-width` queries at 1 / 800 /
 * 1280 (#1379): each renders a structurally different tree for its range.
 */
const LAYOUTS_FIXTURE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Layouts</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{margin:0;font-family:sans-serif}
@media (min-width:1px){.stack p{margin:0 0 12px}}
@media (min-width:800px){.grid{display:grid;grid-template-columns:1fr 1fr}}
@media (min-width:1280px){.columns{display:flex}.columns aside{width:240px}}
</style></head>
<body><main id="root"></main>
<script>
var layouts={
phone:'<section class="stack" data-layout="phone"><p>One</p><p>Two</p></section>',
middle:'<div class="grid" data-layout="middle"><article><h2>One</h2></article><article><h2>Two</h2></article></div>',
desktop:'<div class="columns" data-layout="desktop"><aside><ul><li>Index</li></ul></aside><div><article><h2>One</h2><p>Lead</p></article><article><h2>Two</h2><p>Lead</p></article></div></div>'
};
var current;
function render(){var key=matchMedia('(min-width:1280px)').matches?'desktop':matchMedia('(min-width:800px)').matches?'middle':'phone';if(key===current)return;current=key;document.getElementById('root').innerHTML=layouts[key];}
render();addEventListener('resize',render);
</script>
</body></html>`;

function page( fixture: string, userAgent: string, path: string ): string {
	if ( fixture === 'builder' ) return builderPage( path );
	if ( fixture === 'counter' ) return counterPage();
	if ( fixture === 'switch' ) return SWITCH_FIXTURE;
	if ( fixture === 'layouts' ) return LAYOUTS_FIXTURE;
	const phoneHtml = fixture === 'by-agent' && userAgent.includes( 'iPhone' ) ? '<p class="phone-only">Download our app</p>' : '';
	const script = fixture === 'mixed' && path === 'runtime' ? '<script>if(innerWidth<600){const node=document.createElement("div");node.id="yui_3_17_2_1_123_45";node.innerHTML="<span>Widget</span>";document.body.prepend(node)}</script>' : fixture === 'mixed' && path === 'promo' ? '<script>if(innerWidth<600){const aside=document.createElement("aside");aside.textContent="Phone promo";document.body.append(aside)}</script>' : '';
	const reorder = reorderFixture( path );
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reflow ${ path }</title><style>
body{margin:0;font:16px Arial}header{display:flex;justify-content:space-between;padding:0;height:60px}
.links a{margin-right:12px}.burger,.more{display:none;width:44px;height:44px}
#drawer,#search{position:fixed;inset:60px 0 0 0;background:#fff}[hidden]{display:none}
.row{display:flex}.col{width:50%;height:120px;box-sizing:border-box}
@media (max-width:600px){.links{display:none}.burger,.more{display:block}.row{display:block}.col{width:100%}}
</style></head><body><header><a href="/${ fixture }/">Home</a><nav class="links"><a href="/${ fixture }/">Home</a><a href="/${ fixture }/about">About</a></nav>
<button class="search" type="button" aria-haspopup="dialog" aria-controls="search">Search</button>
<button id="menu-toggle" class="burger" type="button" aria-label="Menu" aria-haspopup="dialog">≡</button></header>
<div id="search" role="dialog" aria-label="Site search" hidden><input aria-label="Query"></div>
<main><h1>${ path === 'about' ? 'About us' : 'Welcome' }</h1>${ phoneHtml }${ reorder.markup }${ fixture === 'mixed' && path === 'runtime' ? '<img src="/flag.svg" width="120" height="80" onload="const node=document.createElement(\'section\');node.textContent=\'Image loaded\';this.after(node)">' : '' }<div class="row"><div class="col">One</div><div class="col">Two</div></div>
<button class="more" type="button" aria-expanded="false" aria-controls="more-panel">More</button><div id="more-panel" hidden>Phone extras</div></main>
<script>document.querySelector('.more').addEventListener('click',e=>{const d=document.getElementById('more-panel');d.hidden=!d.hidden;e.currentTarget.setAttribute('aria-expanded',String(!d.hidden))});
document.querySelector('.search').addEventListener('click',()=>{const d=document.getElementById('search');d.hidden=!d.hidden});
document.getElementById('menu-toggle').addEventListener('click',()=>{const open=document.getElementById('drawer');if(open){open.remove();return}const d=document.createElement('div');d.id='drawer';d.setAttribute('role','dialog');d.setAttribute('aria-label','Site menu');d.innerHTML='<a href="/${ fixture }/">Home</a><a href="/${ fixture }/about">About</a>';document.body.append(d)});</script>${ script }${ reorder.script }</body></html>`;
}

/**
 * A site-builder navbar: no header, nav or main landmark, a plain-element
 * "Menu" control its runtime binds a click to, and an off-canvas link drawer
 * it slides in, hidden at desktop width. `about` places the navbar one level
 * shallower; `contact` links its own translation from the navbar.
 */
function builderPage( path: string ): string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Builder ${ path }</title><style>
body{margin:0;font:16px Arial}.navbar{display:flex;justify-content:space-between;height:60px}.links a{margin-right:12px}
.trigger{display:none;cursor:pointer;height:40px;padding:0 12px;background:#b7283d;color:#fff}
.drawer{position:fixed;inset:0 0 0 auto;width:300px;display:flex;flex-direction:column;background:#222;transform:translate3d(101%,0,0)}
@media (max-width:600px){.links{display:none}.trigger{display:flex;align-items:center}}
</style></head><body>${ path === 'about' ? '' : '<div class="page">' }<div class="navbar"><a href="/builder/">Brand</a>
<div class="links"><a href="/builder/">Home</a><a href="/builder/about">About</a><a href="/builder/fr${ path === 'contact' ? '/contact' : '' }">Français</a></div>
<div class="drawer"><div class="close" style="cursor:pointer">Close</div><a href="/builder/">Home</a><a href="/builder/about">About</a></div>
<div class="trigger"><p>Menu</p></div></div>
<div class="hero"><h1>${ path || 'Welcome' }</h1></div>${ path === 'about' ? '' : '</div>' }
<script>const drawer=document.querySelector('.drawer');
document.querySelector('.trigger').addEventListener('click',()=>{drawer.style.transform='translate3d(0,0,0)'});
document.querySelector('.close').addEventListener('click',()=>{drawer.style.transform='translate3d(101%,0,0)'});</script></body></html>`;
}

/**
 * A navbar whose runtime numbers its rendered controls in render order, as
 * some site builders do, skipping the desktop-only More dropdown at phone
 * width: at desktop width More is `#1` and the phone menu button `#2`; at
 * phone width the menu button is `#1`. The document is otherwise identical.
 */
function counterPage(): string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Counter</title><style>
body{margin:0;font:16px Arial}nav{display:flex;justify-content:space-between;height:60px}.links a{margin-right:12px}
.burger{display:none;width:44px;height:44px}.panel{position:fixed;inset:60px 0 0 0;background:#fff}[hidden]{display:none}
@media (max-width:600px){.links,.more{display:none}.burger{display:block}}
</style></head><body><nav><a href="/counter/">Brand</a><div class="links"><a href="/counter/">Home</a></div>
<button class="more" type="button" aria-haspopup="menu" data-counted>More</button>
<button class="burger" type="button" aria-label="Menu" aria-haspopup="menu" data-counted>=</button></nav>
<div id="more-list" class="panel" role="menu" aria-label="More pages" hidden><a href="/counter/">Extra</a></div>
<div id="drawer" class="panel" role="menu" aria-label="Site menu" hidden><a href="/counter/">Home</a><a href="/counter/">About</a></div>
<main><h1>Welcome</h1></main>
<script>let next=1;for(const control of document.querySelectorAll('[data-counted]'))if(innerWidth>600||!control.matches('.more'))control.id=String(next++);
const toggle=(button,panel)=>button.addEventListener('click',()=>{const d=document.getElementById(panel);d.hidden=!d.hidden});
toggle(document.querySelector('.more'),'more-list');toggle(document.querySelector('.burger'),'drawer');</script></body></html>`;
}

/**
 * The `reorder` routes. Each script moves a sibling below the nav breakpoint,
 * the way a phone layout regroups its lists: `empty-ul` swaps an empty `<ul>`
 * ahead of a populated one, `move-content` swaps two populated `<ul>`s, and
 * `move-img` moves the photo out of its frame, ahead of it.
 */
function reorderFixture( path: string ): { markup: string; script: string } {
	if ( path === 'empty-ul' ) return {
		markup: '<nav class="lists" aria-label="Sections"><ul class="main-menu"><li><a href="/reorder/">Home</a></li></ul><ul class="ghost-menu"></ul></nav>',
		script: '<script>if(innerWidth<600){const nav=document.querySelector(".lists");nav.insertBefore(nav.querySelector(".ghost-menu"),nav.querySelector(".main-menu"))}</script>',
	};
	if ( path === 'move-content' ) return {
		markup: '<nav class="lists" aria-label="Sections"><ul class="first"><li><a href="/reorder/">Home</a></li><li><a href="/reorder/move-content">About</a></li></ul><ul class="second"><li><a href="/reorder/">Join</a></li></ul></nav>',
		script: '<script>if(innerWidth<600){const nav=document.querySelector(".lists");nav.insertBefore(nav.querySelector(".second"),nav.querySelector(".first"))}</script>',
	};
	if ( path === 'move-img' ) return {
		markup: '<figure class="photo"><img class="pic" src="/reorder/flag.svg" alt="Flag" width="120" height="80"></figure>',
		script: '<script>if(innerWidth<600){const fig=document.querySelector(".photo");fig.parentNode.insertBefore(fig.querySelector(".pic"),fig)}</script>',
	};
	return { markup: '', script: '' };
}

describe.skipIf( ! existsSync( chromium.executablePath() ) )( 'device-mode capture', () => {
	const parent = join( process.cwd(), '.tmp-test' );
	const directories: string[] = [];
	let server: Server;
	let origin: string;
	const documentLoads = new Map< string, number >();
	let transientPhoneServed = false;
	beforeAll( async () => {
		server = createServer( ( request, response ) => {
			if ( ( request.url ?? '' ).endsWith( '.svg' ) ) {
				response.setHeader( 'content-type', 'image/svg+xml' );
				response.end( '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#36c"/></svg>' );
				return;
			}
			documentLoads.set( request.url!, ( documentLoads.get( request.url! ) ?? 0 ) + 1 );
			const [ , fixture = '', path = '' ] = ( request.url ?? '/' ).split( '/' );
			response.setHeader( 'content-type', 'text/html; charset=utf-8' );
			let body = page( fixture, request.headers[ 'user-agent' ] ?? '', path );
			// One cache variant: only the first phone document request differs.
			if ( fixture === 'transient' && path === '' && ( request.headers[ 'user-agent' ] ?? '' ).includes( 'iPhone' ) && ! transientPhoneServed ) {
				transientPhoneServed = true;
				body = body.replace( '</head>', '<link rel="preload" href="/transient/x.css" as="style"></head>' );
			}
			// A route slower than the (shrunk) navigation budget on every request.
			if ( fixture === 'slow' && path === 'late' ) { setTimeout( () => response.end( body ), 4_000 ); return; }
			response.end( body );
		} );
		await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
		origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
	} );
	afterAll( async () => {
		await new Promise< void >( resolve => server.close( () => resolve() ) );
		for ( const directory of directories ) rmSync( directory, { recursive: true, force: true } );
	} );

	const capture = async ( fixture: string, options: { routes?: string[]; deviceDocumentSelection?: boolean } = {} ) => {
		mkdirSync( parent, { recursive: true } );
		const outputDir = mkdtempSync( join( parent, `device-mode-${ fixture }-` ) );
		directories.push( outputDir );
		const urls = [ `${ origin }/${ fixture }/`, ...( options.routes ?? [] ).map( route => `${ origin }/${ fixture }/${ route }` ) ];
		const result = await captureScreenshots( { urls, primaryUrl: urls[ 0 ], outputDir, concurrency: 1, settleMs: 50, learnFluid: false, force: true, deviceMode: 'auto',
			...( options.deviceDocumentSelection ? { deviceDocumentSelection: true } : {} ) } );
		const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) ) as { entries: Record< string, ManifestEntry > };
		return { outputDir, result, entries: manifest.entries };
	};

	it( 'probes where a runtime-revealed phone document starts and guards the export at that width', async () => {
		const run = await capture( 'switch' );
		const entry = run.entries[ `${ origin }/switch/` ]!;
		expect( entry.deviceMode ).toMatchObject( { mode: 'dual', reason: expect.stringContaining( '+phone' ), switchWidth: 767 } );
		writeFileSync( join( run.outputDir, 'breakpoints.json' ), JSON.stringify( { minWidth: [ 1024 ], maxWidth: [ 767, 1279 ] } ) );
		exportWebsiteCapture( { outputDir: run.outputDir, sourceUrl: `${ origin }/switch/`, platform: 'generic', summary: {}, failures: [] } );
		const html = readFileSync( join( run.outputDir, 'website', 'index.html' ), 'utf8' );
		expect( html ).not.toContain( '(min-width:1280px)' );
		const browser = await chromium.launch();
		try {
			const tab = await browser.newPage();
			for ( const [ width, items ] of [ [ 390, 0 ], [ 767, 0 ], [ 768, 4 ], [ 900, 4 ], [ 1024, 4 ], [ 1440, 4 ] ] ) {
				await tab.setViewportSize( { width, height: 900 } );
				await tab.setContent( html );
				const visible = await tab.evaluate( () => [ ...document.querySelectorAll( '.item' ) ].filter( item => item.getClientRects().length > 0 && getComputedStyle( item ).visibility === 'visible' ).length );
				expect( { width, visible } ).toEqual( { width, visible: items } );
			}
		} finally {
			await browser.close();
		}
	}, 120_000 );

	it( 'switches at the source\'s own min-width boundary and reports a middle layout it does not capture', async () => {
		const run = await capture( 'layouts' );
		const entry = run.entries[ `${ origin }/layouts/` ]!;
		expect( entry.deviceMode ).toMatchObject( { mode: 'dual', switchWidth: 799, uncapturedLayout: { minWidth: 800, maxWidth: 1279 } } );
		const receipt = JSON.parse( readFileSync( exportWebsiteCapture( { outputDir: run.outputDir, sourceUrl: `${ origin }/layouts/`, platform: 'neutral', summary: {}, failures: [] } ), 'utf8' ) );
		expect( receipt.discoveryDiagnostics ).toContainEqual( expect.objectContaining( {
			code: 'responsive_layout_uncaptured', url: `${ origin }/layouts/`, unit: 'profile', metrics: { minWidth: 800, maxWidth: 1279 },
		} ) );
		const html = readFileSync( join( run.outputDir, 'website', 'index.html' ), 'utf8' );
		const browser = await chromium.launch();
		try {
			const tab = await browser.newPage();
			// 1024 is the uncaptured middle range: the copy serves the desktop document there.
			for ( const [ width, layout ] of [ [ 390, 'phone' ], [ 768, 'phone' ], [ 799, 'phone' ], [ 800, 'desktop' ], [ 1024, 'desktop' ], [ 1440, 'desktop' ] ] as const ) {
				await tab.setViewportSize( { width, height: 900 } );
				await tab.setContent( html );
				const visible = await tab.evaluate( () => [ ...document.querySelectorAll( '[data-layout]' ) ].filter( node => node.getClientRects().length > 0 ).map( node => node.getAttribute( 'data-layout' ) ) );
				expect( { width, visible } ).toEqual( { width, visible: [ layout ] } );
			}
		} finally {
			await browser.close();
		}
	}, 120_000 );

	it( 'confirms a transient entrypoint HTML difference before committing the site to dual', async () => {
		const run = await capture( 'transient' );
		expect( transientPhoneServed ).toBe( true );
		expect( run.result.deviceMode ).toMatchObject( { mode: 'reflow-only', serverHtml: 'identical', serverHtmlFirstSample: 'different', serverHtmlResampled: true } );
	}, 120_000 );

	describe( 'a site whose phone view is CSS reflow', () => {
		let run: { outputDir: string; result: ScreenshotResult; entries: Record< string, ManifestEntry > };
		beforeAll( async () => { run = await capture( 'responsive', { routes: [ 'about' ] } ); }, 120_000 );

		it( 'decides reflow-only and captures one desktop profile per route', () => {
			expect( run.result.deviceMode ).toMatchObject( {
				mode: 'reflow-only', requested: 'auto', serverHtml: 'identical',
				structure: { differingPaths: 0 },
				routes: { checked: 2, reflowOnly: 2, dual: [] },
			} );
			expect( run.result.deviceMode!.structure!.desktopElements ).toBeGreaterThan( 10 );
			expect( run.result.captured ).toBe( 2 );
			for ( const entry of Object.values( run.entries ) ) {
				expect( Object.keys( entry.profiles ?? {} ) ).toEqual( [ 'desktop' ] );
				expect( entry.mobileHtml ).toBeUndefined();
				// The desktop document also freezes the phone-width reference cell.
				expect( entry.profiles!.desktop!.recipe.referenceWidths ).toEqual( [ 390, 768, 1440 ] );
				expect( entry.deviceMode ).toMatchObject( { mode: 'reflow-only' } );
				if ( entry.deviceMode!.inheritedFrom ) expect( entry.deviceMode!.serverHtml ).toMatch( /^identical/ );
				else expect( entry.deviceMode!.structure ).toMatchObject( { differingPaths: 0 } );
				// The check blocks images, media and fonts and settles briefly.
				expect( entry.deviceMode!.checkMs ).toBeLessThan( 8_000 );
			}
		} );

		it( 'captures the phone-only menu on the entrypoint and nothing the desktop pass probes', () => {
			// Search is visible at both widths, so only the desktop pass probes it;
			// the phone-only More disclosure is restored in place by desktop hydration.
			expect( run.result.deviceMode!.phoneProbe ).toEqual( { status: 'captured', triggers: 1, captured: 1 } );
			const home = run.entries[ `${ origin }/responsive/` ]!;
			expect( home.interactions?.states.find( state => state.trigger.label === 'Search' ) ).toMatchObject( { status: 'captured', dialog: { id: 'search' } } );
			const menu = home.interactions?.states.find( state => state.trigger.label === 'Menu' );
			expect( menu ).toMatchObject( { status: 'captured', dialog: { id: 'drawer' } } );
			expect( menu!.dialog!.html ).toContain( 'About' );
			expect( JSON.stringify( home.interactions ) ).not.toContain( 'data-lib-desktop-control' );
			// The shared header carries the phone-only menu to every route whose header matches.
			const about = run.entries[ `${ origin }/responsive/about` ]!;
			expect( about.sharedChrome ).toMatchObject( { chromeReused: true } );
			expect( about.interactions?.states.find( state => state.trigger.label === 'Menu' ) ).toMatchObject( { status: 'captured', dialog: { id: 'drawer' }, reusedFrom: `${ origin }/responsive/` } );
			expect( run.result.sharedChrome?.routes ).toMatchObject( { checked: 2, reused: 2, probedInPlace: [] } );
		} );

		it( 'exports a single document that reflows at 390 px and opens the captured menu', async () => {
			const receiptPath = exportWebsiteCapture( { outputDir: run.outputDir, sourceUrl: `${ origin }/responsive/`, platform: 'neutral', summary: {}, failures: [], deviceMode: 'reflow-only' } );
			const receipt = JSON.parse( readFileSync( receiptPath, 'utf8' ) );
			expect( receipt.routes ).toHaveLength( 2 );
			expect( receipt.sourceProfile ).toMatchObject( { variants: 'single', documentsPerRoute: 1 } );
			expect( receipt.discoveryDiagnostics.filter( ( row: { code: string } ) => row.code === 'route_profile_uncaptured' ) ).toEqual( [] );
			const site = await startStaticServer( join( run.outputDir, 'website' ) );
			const browser = await chromium.launch();
			try {
				const { defaultBrowserType: _type, ...iphone } = devices[ 'iPhone 17' ];
				const phone = await browser.newPage( { ...iphone, viewport: { width: 390, height: 844 } } );
				await phone.goto( site.url );
				expect( await phone.evaluate( () => [ ...document.querySelectorAll( '.col' ) ].map( col => col.getBoundingClientRect().width ) ) ).toEqual( [ 390, 390 ] );
				expect( await phone.locator( '.links' ).isVisible() ).toBe( false );
				await phone.getByRole( 'button', { name: 'Menu' } ).click();
				await expect.poll( () => phone.getByRole( 'dialog', { name: 'Site menu' } ).getByText( 'About' ).isVisible() ).toBe( true );
				// A route other than the entrypoint opens the same menu.
				await phone.goto( new URL( 'about/', site.url ).href );
				await phone.getByRole( 'button', { name: 'Menu' } ).click();
				await expect.poll( () => phone.getByRole( 'dialog', { name: 'Site menu' } ).getByText( 'About' ).isVisible() ).toBe( true );
				const desktop = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
				await desktop.goto( site.url );
				expect( await desktop.evaluate( () => [ ...document.querySelectorAll( '.col' ) ].map( col => col.getBoundingClientRect().width ) ) ).toEqual( [ 720, 720 ] );
				expect( await desktop.getByRole( 'button', { name: 'Menu' } ).isVisible() ).toBe( false );
			} finally {
				await browser.close();
				await site.close();
			}
		}, 60_000 );
	} );

	it( 'carries a builder navbar\'s phone-only menu control to every route and opens and closes its drawer there', async () => {
		const run = await capture( 'builder', { routes: [ 'about', 'contact' ] } );
		expect( run.result.deviceMode ).toMatchObject( { mode: 'reflow-only', phoneProbe: { status: 'captured', triggers: 1, captured: 1 } } );
		const menu = ( route: string ) => run.entries[ `${ origin }/builder/${ route }` ]!.interactions?.states.find( state => state.trigger.label === 'Menu' );
		// The same navbar at another depth is found by its classes and reused.
		expect( run.entries[ `${ origin }/builder/about` ]!.sharedChrome ).toMatchObject( { chromeReused: true, reusedStates: 1 } );
		expect( menu( 'about' ) ).toMatchObject( { status: 'captured', dialog: { role: 'menu' }, reusedFrom: `${ origin }/builder/` } );
		// A navbar whose links differ is probed in place at phone width.
		expect( run.entries[ `${ origin }/builder/contact` ]!.sharedChrome ).toMatchObject( { chromeReused: false } );
		expect( menu( 'contact' ) ).toMatchObject( { status: 'captured', dialog: { role: 'menu' } } );
		expect( menu( 'contact' )!.reusedFrom ).toBeUndefined();
		exportWebsiteCapture( { outputDir: run.outputDir, sourceUrl: `${ origin }/builder/`, platform: 'neutral', summary: {}, failures: [], deviceMode: 'reflow-only' } );
		const site = await startStaticServer( join( run.outputDir, 'website' ) );
		const browser = await chromium.launch();
		try {
			const phone = await browser.newPage( { viewport: { width: 390, height: 844 } } );
			for ( const route of [ '', 'about/', 'contact/' ] ) {
				await phone.goto( new URL( route, site.url ).href );
				await phone.getByText( 'Menu', { exact: true } ).click();
				await expect.poll( () => phone.getByRole( 'dialog' ).getByText( 'About' ).isVisible() ).toBe( true );
				// The drawer's own Close control closes it; no generated one is added.
				expect( await phone.locator( 'button[data-blocks-engine-capture-dialog-close]' ).count() ).toBe( 0 );
				await phone.getByRole( 'dialog' ).getByText( 'Close', { exact: true } ).click();
				await expect.poll( () => phone.getByRole( 'dialog' ).getByText( 'About' ).isVisible() ).toBe( false );
			}
		} finally {
			await browser.close();
			await site.close();
		}
	}, 120_000 );

	it( 'records the phone-only menu under the desktop document\'s identity when a runtime numbers controls per rendering', async () => {
		const run = await capture( 'counter' );
		expect( run.result.deviceMode ).toMatchObject( { mode: 'reflow-only', phoneProbe: { status: 'captured', triggers: 1, captured: 1 } } );
		const home = run.entries[ `${ origin }/counter/` ]!;
		const state = ( label: string ) => home.interactions?.states.find( item => item.trigger.label === label );
		// The phone rendering numbered the menu button `1`, the desktop document's
		// More. Its ID differs per rendering, so it is named by position.
		expect( state( 'Menu' ) ).toMatchObject( { status: 'captured', trigger: { selector: 'body > nav:nth-of-type(1) > button:nth-of-type(2)' }, dialog: { id: 'drawer' } } );
		expect( state( 'Menu' )!.trigger.id ).toBeUndefined();
		expect( state( 'More' ) ).toMatchObject( { status: 'captured', trigger: { id: '1' }, dialog: { id: 'more-list' } } );
		exportWebsiteCapture( { outputDir: run.outputDir, sourceUrl: `${ origin }/counter/`, platform: 'neutral', summary: {}, failures: [], deviceMode: 'reflow-only' } );
		const site = await startStaticServer( join( run.outputDir, 'website' ) );
		const browser = await chromium.launch();
		try {
			const phone = await browser.newPage( { viewport: { width: 390, height: 844 } } );
			await phone.goto( site.url );
			await phone.getByRole( 'button', { name: 'Menu' } ).click();
			await expect.poll( () => phone.getByRole( 'menu', { name: 'Site menu' } ).getByText( 'About' ).isVisible() ).toBe( true );
			await phone.keyboard.press( 'Escape' );
			await expect.poll( () => phone.getByRole( 'menu', { name: 'Site menu' } ).getByText( 'About' ).isVisible() ).toBe( false );
			const desktop = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			await desktop.goto( site.url );
			await desktop.getByRole( 'button', { name: 'More' } ).click();
			await expect.poll( () => desktop.getByRole( 'menu', { name: 'More pages' } ).getByText( 'Extra' ).isVisible() ).toBe( true );
		} finally {
			await browser.close();
			await site.close();
		}
	}, 120_000 );

	it( 'keeps both captures when the server sends phones different HTML', async () => {
		const run = await capture( 'by-agent' );
		expect( run.result.deviceMode ).toMatchObject( { mode: 'dual', serverHtml: 'different' } );
		expect( run.result.deviceMode!.reason ).toContain( 'different HTML' );
		const entry = Object.values( run.entries )[ 0 ]!;
		expect( Object.keys( entry.profiles ?? {} ).sort() ).toEqual( [ 'desktop', 'mobile' ] );
		expect( readFileSync( join( run.outputDir, entry.mobileHtml! ), 'utf8' ) ).toContain( 'Download our app' );
	}, 120_000 );

	it( 'captures only the route whose script builds a different phone DOM in both profiles', async () => {
		let stderr = '';
		const write = vi.spyOn( process.stderr, 'write' ).mockImplementation( chunk => { stderr += String( chunk ); return true; } );
		let run: Awaited< ReturnType< typeof capture > >;
		try {
			run = await capture( 'mixed', { routes: [ 'promo', 'runtime' ] } );
		} finally { write.mockRestore(); }
		// Resource-dependent DOM must not manufacture a second device document.
		expect( run.entries[ `${ origin }/mixed/runtime` ]!.deviceMode!.mode ).toBe( 'reflow-only' );
		for ( const route of [ 'promo', 'runtime' ] ) {
			const url = `${ origin }/mixed/${ route }`;
			// The request pair hands its bytes to rendered checks and capture.
			// Phone UA remains a separate request; resizing needs no new document.
			expect( documentLoads.get( `/mixed/${ route }` ) ).toBe( 2 );
			expect( run.entries[ url ]!.profiles!.desktop!.phases!.some( phase => phase.phase === 'device-check' ) ).toBe( true );
			const line = stderr.split( '\n' ).find( line => line.startsWith( '[timing] route-phases ' ) && line.includes( url ) )!;
			expect( JSON.parse( line.slice( '[timing] route-phases '.length ) )[ 'device-check' ] ).toBeGreaterThan( 0 );
		}
		const runtime = run.entries[ `${ origin }/mixed/runtime` ]!.deviceMode!;
		expect( runtime ).toMatchObject( { mode: 'reflow-only', reason: expect.stringContaining( 'export treats as equivalent' ) } );
		expect( runtime.rechecked ).toBeUndefined();
		expect( runtime.checkTimings ).toEqual( { navigate: expect.any( Number ), settle: expect.any( Number ), equivalence: expect.any( Number ), recheck: 0 } );
		const timing = stderr.split( '\n' ).find( line => line.startsWith( '[timing] device-check ' ) && line.includes( '/mixed/runtime' ) )!;
		expect( JSON.parse( timing.slice( '[timing] device-check '.length ) ) ).toMatchObject( runtime.checkTimings! );
		// The image loads in capture and inserts real content. The matched blocked
		// comparison pair must still agree; full desktop versus blocked phone did not.
		expect( readFileSync( join( run.outputDir, run.entries[ `${ origin }/mixed/runtime` ]!.html! ), 'utf8' ) ).toContain( 'Image loaded' );
		const home = `${ origin }/mixed/`;
		const promo = `${ origin }/mixed/promo`;
		expect( run.result.deviceMode ).toMatchObject( { mode: 'reflow-only', routes: { checked: 3, reflowOnly: 2, dual: [ { url: promo } ] } } );
		expect( run.result.deviceMode!.routes!.dual[ 0 ]!.reason ).toContain( 'aside' );
		expect( run.entries[ home ]!.deviceMode ).toMatchObject( { mode: 'reflow-only' } );
		expect( run.entries[ promo ]!.deviceMode ).toMatchObject( { mode: 'dual', structure: { differingPaths: 1 }, rechecked: true, switchWidth: 600 } );
		expect( run.entries[ promo ]!.deviceMode!.checkTimings!.recheck ).toBeGreaterThanOrEqual( 1_500 );
		expect( Object.keys( run.entries[ home ]!.profiles ?? {} ) ).toEqual( [ 'desktop' ] );
		expect( run.entries[ home ]!.mobileHtml ).toBeUndefined();
		expect( Object.keys( run.entries[ promo ]!.profiles ?? {} ).sort() ).toEqual( [ 'desktop', 'mobile' ] );
		// The dual route keeps the main-branch phone reference cell; the reflow route freezes it at desktop.
		expect( run.entries[ promo ]!.profiles!.desktop!.recipe.referenceWidths ).toEqual( [ 768, 1440 ] );
		expect( readFileSync( join( run.outputDir, run.entries[ promo ]!.mobileHtml! ), 'utf8' ) ).toContain( 'Phone promo' );
		// Export reads the phone document of the dual route only.
		const receipt = JSON.parse( readFileSync( exportWebsiteCapture( { outputDir: run.outputDir, sourceUrl: home, platform: 'neutral', summary: {}, failures: [], deviceMode: 'reflow-only' } ), 'utf8' ) );
		const route = ( url: string ) => receipt.routes.find( ( row: { url: string } ) => row.url === url );
		expect( route( home ).responsiveVariants ).toBeUndefined();
		expect( route( promo ).responsiveVariants ).toBeDefined();
		expect( readFileSync( join( run.outputDir, 'website', 'promo', 'index.html' ), 'utf8' ) ).toContain( 'Phone promo' );
		expect( readFileSync( join( run.outputDir, 'website', 'index.html' ), 'utf8' ) ).not.toContain( 'Phone promo' );
	}, 120_000 );

	it( 'keeps export-equivalent reorders reflow-only but captures real structure changes twice', async () => {
		const run = await capture( 'reorder', { routes: [ 'empty-ul', 'move-content', 'move-img' ] } );
		const base = `${ origin }/reorder`;
		const expected: ReadonlyArray< readonly [ string, 'reflow-only' | 'dual' ] > = [
			[ 'empty-ul', 'reflow-only' ],
			[ 'move-content', 'dual' ],
			[ 'move-img', 'reflow-only' ],
		];
		for ( const [ route, mode ] of expected ) {
			expect( run.entries[ `${ base }/${ route }` ]!.deviceMode ).toMatchObject( { mode } );
		}
		expect( run.result.deviceMode ).toMatchObject( { mode: 'reflow-only', routes: { checked: 4, reflowOnly: 3,
			dual: [ { url: `${ base }/move-content` } ] } } );
		// Export also ignores image placement, so that reorder avoids a second capture.
		expect( run.entries[ `${ base }/move-img` ]!.deviceMode!.reason ).toContain( 'export treats as equivalent' );
		expect( Object.keys( run.entries[ `${ base }/move-img` ]!.profiles ?? {} ) ).toEqual( [ 'desktop' ] );
		expect( Object.keys( run.entries[ `${ base }/empty-ul` ]!.profiles ?? {} ) ).toEqual( [ 'desktop' ] );
		expect( Object.keys( run.entries[ `${ base }/move-content` ]!.profiles ?? {} ).sort() ).toEqual( [ 'desktop', 'mobile' ] );
	}, 120_000 );

	it( 'avoids a rendered timeout when request evidence already proves the slow route', async () => {
		// Request-only evidence arrives outside the shrunk rendering budget.
		// A covered route need not navigate either comparison page at all.
		const limits = SOURCE_NAVIGATION_LIMITS as { timeoutMs: number };
		const budget = limits.timeoutMs;
		limits.timeoutMs = 3_000;
		try {
			const run = await capture( 'slow', { routes: [ 'late' ] } );
			const late = `${ origin }/slow/late`;
			expect( run.result.deviceMode ).toMatchObject( { mode: 'reflow-only' } );
			expect( run.entries[ late ]!.deviceMode ).toMatchObject( { mode: 'reflow-only', inheritedFrom: `${ origin }/slow/` } );
			expect( Object.keys( run.entries[ late ]!.profiles ?? {} ) ).toEqual( [ 'desktop' ] );
			expect( readFileSync( join( run.outputDir, run.entries[ late ]!.html! ), 'utf8' ) ).toContain( 'Welcome' );
		} finally {
			limits.timeoutMs = budget;
		}
	}, 120_000 );

	it( 'keeps both captures whenever the adapter selects among device documents', async () => {
		const run = await capture( 'responsive', { deviceDocumentSelection: true } );
		expect( run.result.deviceMode ).toMatchObject( { mode: 'dual', reason: 'the adapter declares per-device documents (documentSelection)' } );
		expect( run.result.deviceMode!.serverHtml ).toBeUndefined();
		expect( Object.keys( Object.values( run.entries )[ 0 ]!.profiles ?? {} ).sort() ).toEqual( [ 'desktop', 'mobile' ] );
	}, 120_000 );
} );
