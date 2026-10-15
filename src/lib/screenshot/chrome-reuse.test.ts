import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { startStaticServer } from '../replicate/local-site/static-server.js';
import { rebaseChromeState, selectorFields, summarizeSharedChrome } from './chrome-reuse.js';
import type { CapturedDialogInteraction } from './interaction-capture.js';
import type { ManifestEntry } from './manifest-queue.js';
import type { ScreenshotResult } from './types.js';

describe( 'shared chrome selectors', () => {
	const state: CapturedDialogInteraction = {
		status: 'captured',
		trigger: { selector: 'body > div > header > nav > button', tag: 'button', ariaHaspopup: 'menu', dataBindings: { 'data-modal-target': 'body > div > header' } },
		dialog: {
			selector: 'body > div:nth-of-type(1) > header:nth-of-type(1) > nav:nth-of-type(1) > div:nth-of-type(1)', tag: 'div', ariaModal: false, html: '<div>body > div > header</div>', htmlBytes: 1, htmlTruncated: false,
			ancestorState: { status: 'verified', ancestors: [ { selector: 'body', tag: 'body', depth: 4, closed: {}, opened: {} } ], placement: { parentSelector: '#site > header:nth-of-type(1) > nav:nth-of-type(1)', parentDepth: 1, beforeSelector: null, position: 'absolute' } },
		},
	};

	it( 'lists every selector field in a stable order', () => {
		expect( selectorFields( state ).map( field => field.path ) ).toEqual( [
			'trigger.selector', 'dialog.selector', 'dialog.ancestorState.ancestors[0].selector', 'dialog.ancestorState.placement.parentSelector',
		] );
	} );

	it( 'rebases each selector form from one root prefix to another, at combinator boundaries only', () => {
		const rebased = rebaseChromeState( state,
			[ 'body > div > header', 'body > div:nth-of-type(1) > header:nth-of-type(1)', '#site > header:nth-of-type(1)' ],
			[ 'body > header', 'body > header:nth-of-type(1)', 'body > header:nth-of-type(1)' ] );
		expect( rebased.trigger.selector ).toBe( 'body > header > nav > button' );
		expect( rebased.dialog!.selector ).toBe( 'body > header:nth-of-type(1) > nav:nth-of-type(1) > div:nth-of-type(1)' );
		expect( rebased.dialog!.ancestorState!.placement!.parentSelector ).toBe( 'body > header:nth-of-type(1) > nav:nth-of-type(1)' );
		// The document itself, markup and data bindings are not chrome-relative selectors.
		expect( rebased.dialog!.ancestorState!.ancestors[ 0 ]!.selector ).toBe( 'body' );
		expect( rebased.dialog!.html ).toBe( state.dialog!.html );
		expect( rebased.trigger.dataBindings ).toEqual( state.trigger.dataBindings );
		// A longer sibling tag is not under the prefix.
		expect( rebaseChromeState( { selector: 'body > div > headers > a' }, [ 'body > div > header' ], [ 'body > header' ] ).selector ).toBe( 'body > div > headers > a' );
	} );

	it( 'summarizes the probe and the routes that probed in place', () => {
		expect( summarizeSharedChrome( 'https://example.com/', new Map( [ [ 'desktop', { status: 'captured' as const, durationMs: 9, evidence: { url: 'https://example.com/', landmarks: [], states: [], unanchored: 1 } } ] ] ), [
			{ url: 'https://example.com/', profile: 'desktop', chromeReused: true, reason: 'match' },
			{ url: 'https://example.com/b', profile: 'desktop', chromeReused: false, reason: 'differs' },
		] ) ).toEqual( {
			entrypoint: 'https://example.com/',
			profiles: { desktop: { status: 'captured', landmarks: 0, states: 0, captured: 0, unanchored: 1, durationMs: 9 } },
			routes: { checked: 2, reused: 1, probedInPlace: [ { url: 'https://example.com/b', profile: 'desktop', reason: 'differs' } ] },
		} );
	} );
} );

/**
 * `/` and `/about` render the same header at different places in the page; `/landing`
 * renders a header with other text. Every page has its own tab set in main
 * content. Each control reports its clicks, with the page instance that ran them.
 */
function page( path: string ): string {
	const brand = path === 'landing' ? 'Shop' : 'Products';
	const header = `<header class="site-header"><a href="/">Brand</a><nav aria-label="Main">
<button type="button" class="products" aria-haspopup="menu" aria-expanded="false" data-control="header">${ brand }</button>
<div class="products-menu" role="menu" hidden><a role="menuitem" href="/alpha">Alpha</a><a role="menuitem" href="/beta">Beta</a></div></nav>
<button type="button" class="contact" aria-haspopup="dialog" data-control="header">Contact</button>
<div class="contact-dialog" role="dialog" aria-modal="true" aria-label="Contact us" hidden><p>Write to us any time.</p><button type="button" class="close" aria-label="Close" data-control="header">×</button></div>
<button type="button" class="info" aria-haspopup="dialog" data-control="header">Info</button></header>`;
	const main = `<main><h1>${ path || 'home' }</h1><div class="tabs"><div role="tablist"><button role="tab" aria-selected="true" data-control="tab">Overview</button><button role="tab" aria-selected="false" data-control="tab">Details</button><button role="tab" aria-selected="false" data-control="tab">Pricing</button></div>
<div class="tab-region">The overview of ${ path || 'home' } is short.</div></div></main>`;
	const body = path === '' ? `<div class="wrap"><div class="promo">Sale this week</div>${ header }${ main }</div>` : `${ header }${ main }<footer>Footer</footer>`;
	// The Info control's panel lives in the site chrome (its trigger is in the
	// header) but renders as a body-level portal, outside the landmark.
	const infoDialog = `<div id="site-info-dialog" class="info-dialog" role="dialog" aria-label="Site info" hidden><p>Everything about this site.</p><button type="button" class="close" aria-label="Dismiss site info">×</button></div>`;
	return `<!doctype html><html><head><meta charset="utf-8"><title>${ path || 'home' }</title><style>
body{margin:0;font:16px Arial}header{display:flex;gap:16px;align-items:center;height:60px;position:relative}
.products-menu{position:absolute;top:60px;left:0;background:#fff;padding:8px}.products-menu a{display:block}
.contact-dialog{position:fixed;inset:0;background:#fff}[hidden]{display:none!important}main{min-height:1400px}
</style></head><body>${ body }${ infoDialog }<script>
const instance = Math.random().toString(36).slice(2);
document.addEventListener('click', event => { const control = event.target.closest('[data-control]'); if (control) fetch('/__click?path=' + encodeURIComponent(location.pathname) + '&control=' + control.dataset.control + '&instance=' + instance); }, true);
const products = document.querySelector('.products'), menu = document.querySelector('.products-menu');
products.addEventListener('click', () => { menu.hidden = !menu.hidden; products.setAttribute('aria-expanded', String(!menu.hidden)); });
const dialog = document.querySelector('.contact-dialog');
document.querySelector('.contact').addEventListener('click', () => { dialog.hidden = false; });
dialog.querySelector('.close').addEventListener('click', () => { dialog.hidden = true; });
const info = document.querySelector('.info-dialog');
document.querySelector('.info').addEventListener('click', () => { info.hidden = false; });
info.querySelector('.close').addEventListener('click', () => { info.hidden = true; });
const copy = { Overview: 'The overview of ${ path || 'home' } is short.', Details: 'Details for ${ path || 'home' }: every feature, listed one by one, with notes on each of them.', Pricing: 'Pricing for ${ path || 'home' }: three plans, billed monthly or yearly, with a free trial included.' };
for (const tab of document.querySelectorAll('[role=tab]')) tab.addEventListener('click', () => {
	for (const other of document.querySelectorAll('[role=tab]')) other.setAttribute('aria-selected', String(other === tab));
	document.querySelector('.tab-region').textContent = copy[tab.textContent];
});
</script></body></html>`;
}

describe.skipIf( ! existsSync( chromium.executablePath() ) )( 'shared chrome capture', () => {
	const parent = join( process.cwd(), '.tmp-test' );
	const clicks: Array< { path: string; control: string; instance: string } > = [];
	let server: Server;
	let origin: string;
	let outputDir: string;
	let result: ScreenshotResult;
	let entries: Record< string, ManifestEntry >;
	const url = ( path: string ) => `${ origin }/${ path }`;
	const clicksOn = ( path: string, control: string ) => clicks.filter( click => click.path === `/${ path }` && click.control === control );

	beforeAll( async () => {
		server = createServer( ( request, response ) => {
			const requested = new URL( request.url ?? '/', 'http://fixture' );
			if ( requested.pathname === '/__click' ) {
				clicks.push( { path: requested.searchParams.get( 'path' )!, control: requested.searchParams.get( 'control' )!, instance: requested.searchParams.get( 'instance' )! } );
				response.end();
				return;
			}
			const path = requested.pathname.slice( 1 );
			if ( ! [ '', 'about', 'landing' ].includes( path ) ) {
				response.statusCode = 404;
				response.end( 'not found' );
				return;
			}
			response.setHeader( 'content-type', 'text/html; charset=utf-8' );
			response.end( page( path ) );
		} );
		await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
		origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
		mkdirSync( parent, { recursive: true } );
		outputDir = mkdtempSync( join( parent, 'shared-chrome-' ) );
		const urls = [ url( '' ), url( 'about' ), url( 'landing' ) ];
		result = await captureScreenshots( {
			urls, primaryUrl: urls[ 0 ], outputDir, concurrency: 2, settleMs: 50, learnFluid: false, force: true,
			viewports: [ { id: 'desktop', width: 1440, height: 900 } ], sharedChrome: true,
		} );
		entries = ( JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) ) as { entries: Record< string, ManifestEntry > } ).entries;
	}, 180_000 );

	afterAll( async () => {
		await new Promise< void >( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	} );

	it( 'probes the shared header once, on the entrypoint, and on no other route', () => {
		expect( result.captured ).toBe( 3 );
		expect( result.sharedChrome?.profiles.desktop ).toMatchObject( { status: 'captured', landmarks: 1, states: 3, captured: 3, unanchored: 0 } );
		// One page instance clicked the shared header: the one-time probe of the entrypoint.
		const shared = clicks.filter( click => click.control === 'header' && click.path !== '/landing' );
		expect( shared.length ).toBeGreaterThan( 0 );
		expect( new Set( shared.map( click => click.instance ) ).size ).toBe( 1 );
		// The shared header is not clicked on a route that reused it: neither the
		// controls whose panels render inside the header nor the Info control,
		// whose panel renders outside it at body level.
		expect( clicksOn( 'about', 'header' ) ).toEqual( [] );
		expect( clicksOn( 'about', 'info' ) ).toEqual( [] );
		for ( const path of [ '', 'about' ] ) {
			// `/about` also has a footer, which the entrypoint does not.
			expect( entries[ url( path ) ]!.sharedChrome ).toMatchObject( { chromeReused: true, landmarks: { route: path ? 2 : 1, entrypoint: 1, matched: 1 }, reusedStates: 3 } );
			expect( entries[ url( path ) ]!.profiles!.desktop!.sharedChrome ).toEqual( entries[ url( path ) ]!.sharedChrome );
		}
	} );

	it( 'records the rebased entrypoint states on the route that reused them', () => {
		const states = entries[ url( 'about' ) ]!.interactions!.states.filter( state => state.reusedFrom );
		expect( states.map( state => [ state.status, state.trigger.label, state.reusedFrom ] ) ).toEqual( [
			[ 'captured', 'Products', url( '' ) ],
			[ 'captured', 'Contact', url( '' ) ],
			[ 'captured', 'Info', url( '' ) ],
		] );
		// Where the panel renders outside the landmark (the Info portal at body
		// level), its state is still chrome evidence, addressed by the node's own id.
		expect( states[ 2 ]!.dialog!.selector ).toBe( '#site-info-dialog' );
		expect( states[ 2 ]!.dialog!.html ).toContain( 'Everything about this site.' );
		// The entrypoint header is inside a wrapper; on this route it is a child of <body>.
		const entrypointStates = entries[ url( '' ) ]!.interactions!.states.filter( state => state.reusedFrom );
		expect( entrypointStates[ 0 ]!.trigger.selector ).toMatch( /^body > div:nth-of-type\(1\) > header/ );
		expect( states[ 0 ]!.trigger.selector ).toMatch( /^body > header/ );
		// Each trigger keeps its own panel, not the first id-less panel probed.
		expect( states[ 1 ]!.dialog ).toMatchObject( { selector: 'body > header:nth-of-type(1) > div:nth-of-type(1)', presentation: 'modal' } );
		expect( states[ 1 ]!.dialog!.html ).toContain( 'Write to us any time.' );
	} );

	it( 'probes a route whose header differs in place', () => {
		const landing = entries[ url( 'landing' ) ]!;
		expect( landing.sharedChrome ).toMatchObject( { chromeReused: false, landmarks: { route: 2, entrypoint: 1, matched: 0 } } );
		expect( landing.sharedChrome!.reason ).toContain( 'no chrome landmark matches' );
		expect( clicksOn( 'landing', 'header' ).length ).toBeGreaterThan( 0 );
		expect( landing.interactions!.states.filter( state => state.reusedFrom ) ).toEqual( [] );
		expect( landing.interactions!.states.find( state => state.trigger.label === 'Shop' ) ).toMatchObject( { status: 'captured' } );
		expect( result.sharedChrome!.routes ).toMatchObject( { checked: 3, reused: 2, probedInPlace: [ { url: url( 'landing' ), profile: 'desktop' } ] } );
	} );

	it( 'still probes the tab set in each route\'s main content', () => {
		for ( const path of [ '', 'about', 'landing' ] ) {
			expect( clicksOn( path, 'tab' ).length ).toBeGreaterThan( 0 );
			expect( entries[ url( path ) ]!.interactions!.states.some( state => ( state.kind === 'selectable-set' || state.kind === 'choice-group' ) && state.status === 'captured' && ! state.reusedFrom ) ).toBe( true );
		}
	} );

	it( 'exports the reused menu and dialog working on the route that did not probe them', async () => {
		exportWebsiteCapture( { outputDir, sourceUrl: url( '' ), platform: 'neutral', summary: {}, failures: [] } );
		const site = await startStaticServer( join( outputDir, 'website' ) );
		const browser = await chromium.launch();
		try {
			const view = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
			await view.goto( new URL( 'about/', site.url ).href );
			// Both header controls are wired from the reused evidence, not by a source script.
			expect( await view.locator( 'header [data-blocks-engine-capture-dialog-trigger]' ).count() ).toBe( 3 );
			const infoWired = await view.locator( '[data-blocks-engine-capture-dialog-trigger][aria-controls="site-info-dialog"]' ).count();
			expect( infoWired ).toBe( 1 );
			await expect.poll( () => view.getByRole( 'menuitem', { name: 'Alpha' } ).isVisible() ).toBe( false );
			await view.getByRole( 'button', { name: 'Products' } ).click();
			await expect.poll( () => view.getByRole( 'menuitem', { name: 'Alpha' } ).isVisible() ).toBe( true );
			await view.getByRole( 'button', { name: 'Products' } ).click();
			const infoButton = view.locator( 'header button.info, [data-blocks-engine-capture-disclosure-label="Info"]' ).first();
			await infoButton.click();
			await expect.poll( () => view.getByText( 'Everything about this site.' ).isVisible() ).toBe( true );
			await view.getByRole( 'button', { name: 'Contact' } ).click();
			await expect.poll( () => view.getByText( 'Write to us any time.' ).isVisible() ).toBe( true );
		} finally {
			await browser.close();
			await site.close();
		}
	}, 60_000 );
} );
