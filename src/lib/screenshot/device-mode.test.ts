import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices } from 'playwright';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { startStaticServer } from '../replicate/local-site/static-server.js';
import { compareBodyClasses, compareServerHtml, compareStructure, decideRouteMode, decideSiteMode, normalizeServerHtml, summarizeRouteDecisions } from './device-mode.js';
import type { ManifestEntry } from './manifest-queue.js';
import type { ScreenshotResult } from './types.js';

describe( 'device-mode evidence', () => {
	it( 'ignores per-request tokens and timestamps, and nothing else', () => {
		const page = ( token: string, time: string, text = 'Hello' ) => `<html><head><meta name="csrf-token" content="${ token }"><script nonce="${ token }">window.cfg={"nonce":"${ token }","builtAt":"${ time }"}</script></head><body><form><input type="hidden" name="_csrf" value="${ token }"></form><time datetime="${ time }">${ text }</time></body></html>`;
		expect( compareServerHtml( page( 'a1', '2026-10-09T10:00:00Z' ), page( 'a1', '2026-10-09T10:00:00Z' ) ) ).toBe( 'identical' );
		expect( compareServerHtml( page( 'a1', '2026-10-09T10:00:00Z' ), page( 'b2', '2026-10-09T10:00:01.250+02:00' ) ) ).toBe( 'identical-after-normalization' );
		expect( compareServerHtml( page( 'a1', '2026-10-09T10:00:00Z' ), page( 'a1', '2026-10-09T10:00:00Z', 'Hello phone' ) ) ).toBe( 'different' );
		// An ordinary attribute or hidden input is content, not noise.
		expect( normalizeServerHtml( '<input type="hidden" name="plan" value="pro">' ) ).toBe( '<input type="hidden" name="plan" value="pro">' );
	} );

	it( 'counts differing element paths as a multiset and names the first divergence', () => {
		expect( compareStructure( [ 'html', 'html>body[1]' ], [ 'html', 'html>body[1]' ] ) ).toEqual( { desktopElements: 2, phoneElements: 2, differingPaths: 0 } );
		expect( compareStructure( [ 'html', 'html>body[1]' ], [ 'html', 'html>body[1]', 'html>body[1]>aside[1]' ] ) ).toEqual( {
			desktopElements: 2, phoneElements: 3, differingPaths: 1, firstDifference: 'desktop (end) / phone html>body[1]>aside[1]',
		} );
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
 * `mixed/promo` builds a phone-only element at narrow widths; `mixed/` reflows.
 */
function page( fixture: string, userAgent: string, path: string ): string {
	const phoneHtml = fixture === 'by-agent' && userAgent.includes( 'iPhone' ) ? '<p class="phone-only">Download our app</p>' : '';
	const script = fixture === 'mixed' && path === 'promo' ? '<script>if(innerWidth<600){const aside=document.createElement("aside");aside.textContent="Phone promo";document.body.append(aside)}</script>' : '';
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
<main><h1>${ path === 'about' ? 'About us' : 'Welcome' }</h1>${ phoneHtml }<div class="row"><div class="col">One</div><div class="col">Two</div></div>
<button class="more" type="button" aria-expanded="false" aria-controls="more-panel">More</button><div id="more-panel" hidden>Phone extras</div></main>
<script>document.querySelector('.more').addEventListener('click',e=>{const d=document.getElementById('more-panel');d.hidden=!d.hidden;e.currentTarget.setAttribute('aria-expanded',String(!d.hidden))});
document.querySelector('.search').addEventListener('click',()=>{const d=document.getElementById('search');d.hidden=!d.hidden});
document.getElementById('menu-toggle').addEventListener('click',()=>{const open=document.getElementById('drawer');if(open){open.remove();return}const d=document.createElement('div');d.id='drawer';d.setAttribute('role','dialog');d.setAttribute('aria-label','Site menu');d.innerHTML='<a href="/${ fixture }/">Home</a><a href="/${ fixture }/about">About</a>';document.body.append(d)});</script>${ script }</body></html>`;
}

describe.skipIf( ! existsSync( chromium.executablePath() ) )( 'device-mode capture', () => {
	const parent = join( process.cwd(), '.tmp-test' );
	const directories: string[] = [];
	let server: Server;
	let origin: string;
	beforeAll( async () => {
		server = createServer( ( request, response ) => {
			const [ , fixture = '', path = '' ] = ( request.url ?? '/' ).split( '/' );
			response.setHeader( 'content-type', 'text/html; charset=utf-8' );
			response.end( page( fixture, request.headers[ 'user-agent' ] ?? '', path ) );
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
				expect( entry.deviceMode ).toMatchObject( { mode: 'reflow-only', structure: { differingPaths: 0 } } );
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

	it( 'keeps both captures when the server sends phones different HTML', async () => {
		const run = await capture( 'by-agent' );
		expect( run.result.deviceMode ).toMatchObject( { mode: 'dual', serverHtml: 'different' } );
		expect( run.result.deviceMode!.reason ).toContain( 'different HTML' );
		const entry = Object.values( run.entries )[ 0 ]!;
		expect( Object.keys( entry.profiles ?? {} ).sort() ).toEqual( [ 'desktop', 'mobile' ] );
		expect( readFileSync( join( run.outputDir, entry.mobileHtml! ), 'utf8' ) ).toContain( 'Download our app' );
	}, 120_000 );

	it( 'captures only the route whose script builds a different phone DOM in both profiles', async () => {
		const run = await capture( 'mixed', { routes: [ 'promo' ] } );
		const home = `${ origin }/mixed/`;
		const promo = `${ origin }/mixed/promo`;
		expect( run.result.deviceMode ).toMatchObject( { mode: 'reflow-only', routes: { checked: 2, reflowOnly: 1, dual: [ { url: promo } ] } } );
		expect( run.result.deviceMode!.routes!.dual[ 0 ]!.reason ).toContain( 'aside' );
		expect( run.entries[ home ]!.deviceMode ).toMatchObject( { mode: 'reflow-only' } );
		expect( run.entries[ promo ]!.deviceMode ).toMatchObject( { mode: 'dual', structure: { differingPaths: 1 } } );
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

	it( 'keeps both captures whenever the adapter selects among device documents', async () => {
		const run = await capture( 'responsive', { deviceDocumentSelection: true } );
		expect( run.result.deviceMode ).toMatchObject( { mode: 'dual', reason: 'the adapter declares per-device documents (documentSelection)' } );
		expect( run.result.deviceMode!.serverHtml ).toBeUndefined();
		expect( Object.keys( Object.values( run.entries )[ 0 ]!.profiles ?? {} ).sort() ).toEqual( [ 'desktop', 'mobile' ] );
	}, 120_000 );
} );
