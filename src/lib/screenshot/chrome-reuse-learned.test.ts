import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { captureScreenshots } from './screenshotter.js';
import type { ManifestEntry } from './manifest-queue.js';
import type { ScreenshotResult } from './types.js';

/**
 * The home page renders the site header over its hero, styled apart; `/a`,
 * `/b` and `/c` render the plain header. Every page shares one footer whose
 * visually hidden label sits at its static position, so its resolved insets
 * follow each page's height. The header's Contact control and the footer's
 * Newsletter control open site-wide dialogs; only `/b` has a page-specific
 * dialog in its main content. Each control reports its clicks.
 */
function page( path: string ): string {
	const header = `<header class="site-header"><a href="/">Brand</a><nav aria-label="Main"><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></nav>
<button type="button" class="contact" aria-haspopup="dialog" data-control="header">Contact</button>
<div class="contact-dialog" role="dialog" aria-modal="true" aria-label="Contact us" hidden><p>Write to us any time.</p><button type="button" class="close" aria-label="Close" data-control="header-close">×</button></div></header>`;
	const special = path === 'b'
		? `<button type="button" class="offer" aria-haspopup="dialog" data-control="offer">See offer</button>
<div class="offer-dialog" role="dialog" aria-modal="true" aria-label="Offer" hidden><p>Ten percent off B.</p><button type="button" class="close" aria-label="Close offer" data-control="offer-close">×</button></div>`
		: '';
	const main = `<main style="min-height:${ 900 + 300 * [ '', 'a', 'b', 'c' ].indexOf( path ) }px"><h1>${ path || 'home' }</h1>${ special }</main>`;
	const footer = `<footer><form><label class="sr" for="email">Email address</label><input id="email" type="email"></form>
<button type="button" class="newsletter" aria-haspopup="dialog" data-control="footer">Newsletter</button>
<div class="newsletter-dialog" role="dialog" aria-modal="true" aria-label="Newsletter" hidden><p>Monthly news.</p><button type="button" class="close" aria-label="Close newsletter" data-control="footer-close">×</button></div></footer>`;
	return `<!doctype html><html><head><meta charset="utf-8"><title>${ path || 'home' }</title><style>
body{margin:0;font:16px Arial}header{display:flex;gap:16px;align-items:center;height:60px;background:#fff;color:#123}
.hero header{background:transparent;color:#fff}.hero main{background:#345}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.contact-dialog,.offer-dialog,.newsletter-dialog{position:fixed;inset:0;background:#fff;color:#123}[hidden]{display:none!important}
</style></head><body${ path === '' ? ' class="hero"' : '' }>${ header }${ main }${ footer }<script>
document.addEventListener('click', event => { const control = event.target.closest('[data-control]'); if (control) fetch('/__click?path=' + encodeURIComponent(location.pathname) + '&control=' + control.dataset.control); }, true);
for (const [open, panel] of [['.contact', '.contact-dialog'], ['.offer', '.offer-dialog'], ['.newsletter', '.newsletter-dialog']]) {
	const trigger = document.querySelector(open), dialog = document.querySelector(panel);
	if (!trigger) continue;
	trigger.addEventListener('click', () => { dialog.hidden = false; });
	dialog.querySelector('.close').addEventListener('click', () => { dialog.hidden = true; });
}
</script></body></html>`;
}

describe.skipIf( ! existsSync( chromium.executablePath() ) )( 'shared chrome learned on a route', () => {
	const parent = join( process.cwd(), '.tmp-test' );
	const clicks: Array< { path: string; control: string } > = [];
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
				clicks.push( { path: requested.searchParams.get( 'path' )!, control: requested.searchParams.get( 'control' )! } );
				response.end();
				return;
			}
			const path = requested.pathname.slice( 1 );
			if ( ! [ '', 'a', 'b', 'c' ].includes( path ) ) {
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
		outputDir = mkdtempSync( join( parent, 'learned-chrome-' ) );
		const urls = [ url( '' ), url( 'a' ), url( 'b' ), url( 'c' ) ];
		// One route at a time: `/a` finishes before `/b` starts.
		result = await captureScreenshots( {
			urls, primaryUrl: urls[ 0 ], outputDir, concurrency: 1, settleMs: 50, learnFluid: false, force: true,
			viewports: [ { id: 'desktop', width: 1440, height: 900 } ], sharedChrome: true,
		} );
		entries = ( JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) ) as { entries: Record< string, ManifestEntry > } ).entries;
	}, 240_000 );

	afterAll( async () => {
		await new Promise< void >( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	} );

	it( 'probes the plain header once, on the first route that renders it', () => {
		expect( result.captured ).toBe( 4 );
		expect( clicksOn( 'a', 'header' ).length ).toBeGreaterThan( 0 );
		expect( clicksOn( 'b', 'header' ) ).toEqual( [] );
		expect( clicksOn( 'c', 'header' ) ).toEqual( [] );
		expect( entries[ url( 'a' ) ]!.sharedChrome ).toMatchObject( { chromeReused: true, landmarks: { matched: 1 } } );
		for ( const path of [ 'b', 'c' ] ) {
			expect( entries[ url( path ) ]!.sharedChrome ).toMatchObject( { chromeReused: true, learnedFrom: url( 'a' ), landmarks: { route: 3, matched: 3 } } );
			const contact = entries[ url( path ) ]!.interactions!.states.find( state => state.trigger.label === 'Contact' );
			expect( contact ).toMatchObject( { status: 'captured', reusedFrom: url( 'a' ) } );
			expect( contact!.dialog!.html ).toContain( 'Write to us any time.' );
		}
		expect( result.sharedChrome?.profiles.desktop ).toMatchObject( { status: 'captured', learned: 1 } );
	} );

	it( 'reuses the footer whose hidden label sits elsewhere on each page', () => {
		// The one-time entrypoint probe clicks it; no route does.
		expect( clicks.filter( click => click.control === 'footer' && click.path !== '/' ) ).toEqual( [] );
		for ( const path of [ 'a', 'b', 'c' ] ) {
			expect( entries[ url( path ) ]!.interactions!.states.find( state => state.trigger.label === 'Newsletter' ) ).toMatchObject( { status: 'captured' } );
		}
	} );

	it( 'still probes the page-specific dialog', () => {
		expect( clicksOn( 'b', 'offer' ).length ).toBeGreaterThan( 0 );
		const offer = entries[ url( 'b' ) ]!.interactions!.states.find( state => state.trigger.label === 'See offer' );
		expect( offer ).toMatchObject( { status: 'captured' } );
		expect( offer!.reusedFrom ).toBeUndefined();
		expect( offer!.dialog!.html ).toContain( 'Ten percent off B.' );
	} );
} );
