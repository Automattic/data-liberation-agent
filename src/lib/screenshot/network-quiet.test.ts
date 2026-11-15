import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportReadiness, triggerLazyLoad, waitForStable, type SettleOutcome, type TelemetryRequest } from './page-helpers.js';

// A source whose analytics beacon never stops: a cross-origin fetch every
// 250ms leaves no 500ms request-free gap, so raw Playwright `networkidle` —
// which counts every request — can never resolve, and every readiness wait on
// such a source (capture load, device comparison, fidelity reference cell)
// paid its full 5s bound. The quiet [[waitForNetworkQuiet]] waits on counts
// only what can still change the rendered document: render-affecting requests
// (including same-origin fetch/xhr) and data responses still pending.
// Completed cross-origin beacons are neither.

const BEACON_EVERY_MS = 250;
const HELD_DATA_MS = 1_200;

function beaconOrigin(): Server {
	return createServer( ( request, response ) => {
		if ( request.url === '/telemetry' ) {
			// A declared telemetry endpoint that holds every beacon open: it never answers.
			return;
		}
		if ( request.url === '/late-hydration' ) {
			// A slow cross-origin data response the page renders from.
			response.setHeader( 'access-control-allow-origin', '*' );
			response.setHeader( 'content-type', 'application/json' );
			setTimeout( () => response.end( '{"ok":true}' ), HELD_DATA_MS );
			return;
		}
		if ( request.url === '/held-data' ) {
			// A slow cross-origin data response: while pending it must hold the wait.
			setTimeout( () => response.end(), HELD_DATA_MS );
			return;
		}
		if ( request.url === '/orphan-data' ) {
			// Never answers, like a request whose lifecycle events are lost.
			return;
		}
		response.end();
	} );
}

function chattyOrigin( beaconPort: number ): Server {
	const beacon = `http://127.0.0.1:${ beaconPort }`;
	const page = ( scripts: string ) => `<!doctype html><html><head><title>Chatty analytics</title></head><body>
		<h1>Chatty analytics</h1><div style="height:2400px">scrollable body</div>
		<script>
			setInterval( () => { fetch( '${ beacon }/beacon', { mode: 'no-cors' } ).catch( () => {} ); }, ${ BEACON_EVERY_MS } );
		</script>
		${ scripts }
	</body></html>`;
	const mountFromData = ( endpoint: string ) => `<script>
		fetch( '${ endpoint }' ).then( ( r ) => r.json() ).then( () => {
			const mounted = document.createElement( 'div' );
			mounted.id = 'hydrated';
			mounted.textContent = 'hydrated content';
			document.body.appendChild( mounted );
		} ).catch( () => {} );
	</script>`;
	return createServer( ( request, response ) => {
		if ( request.url === '/slow-data' ) {
			// Held long enough that the response lands well after `load`.
			setTimeout( () => {
				response.setHeader( 'content-type', 'application/json' );
				response.end( '{"ok":true}' );
			}, HELD_DATA_MS );
			return;
		}
		if ( request.url === '/data' ) {
			response.setHeader( 'content-type', 'application/json' );
			response.end( '{"ok":true}' );
			return;
		}
		response.setHeader( 'content-type', 'text/html' );
		if ( request.url === '/hydration' ) {
			response.end( page( mountFromData( '/slow-data' ) ) );
			return;
		}
		if ( request.url === '/orphan-data' ) {
			// An undeclared cross-origin data fetch that never settles.
			response.end( page( `<script>fetch( '${ beacon }/orphan-data' ).catch( () => {} );</script>` ) );
			return;
		}
		if ( request.url === '/cross-data' ) {
			// A pending data response from another origin, its result unused by
			// the page: only the pending-hold keeps the wait on it.
			response.end( page( `<script>fetch( '${ beacon }/held-data' ).catch( () => {} );</script>` ) );
			return;
		}
		if ( request.url === '/telemetry-beacon' ) {
			// A beacon to a declared telemetry endpoint that never lands, beside a
			// cross-origin data response that lands late and is rendered.
			response.end( page( `<script>
				fetch( '${ beacon }/telemetry', { method: 'POST', body: 'event', mode: 'no-cors' } ).catch( () => {} );
			</script>${ mountFromData( `${ beacon }/late-hydration` ) }` ) );
			return;
		}
		if ( request.url === '/same-origin-chatter' ) {
			// Render-affecting traffic that never stops: quiet can never be met,
			// so the wait is bounded, not silent.
			response.end( page( `<script>setInterval( () => { fetch( '/data' ).catch( () => {} ); }, ${ BEACON_EVERY_MS } );</script>` ) );
			return;
		}
		response.end( page( '' ) );
	} );
}

async function listen( server: Server ): Promise< number > {
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	return ( server.address() as { port: number } ).port;
}

async function close( server: Server ): Promise< void > {
	server.closeAllConnections();
	await new Promise< void >( resolve => server.close( () => resolve() ) );
}

describe.skipIf( !! process.env.SKIP_BROWSER_TESTS || ! existsSync( chromium.executablePath() ) )( 'network quiet readiness (real Chromium)', () => {
	let browser: Browser;
	let beacons: Server;
	let main: Server;
	let origin: string;

	beforeAll( async () => {
		browser = await chromium.launch();
		beacons = beaconOrigin();
		const beaconPort = await listen( beacons );
		main = chattyOrigin( beaconPort );
		const mainPort = await listen( main );
		origin = `http://127.0.0.1:${ mainPort }`;
	} );

	afterAll( async () => {
		await browser.close();
		await close( main );
		await close( beacons );
	} );

	async function settledPage( telemetry?: TelemetryRequest ): Promise< { page: Page; waits: Array< { wait: string } & SettleOutcome > } > {
		const page = await browser.newPage();
		const waits: Array< { wait: string } & SettleOutcome > = [];
		reportReadiness( page, ( wait, outcome ) => waits.push( { wait, ...outcome } ), telemetry );
		return { page, waits };
	}

	function recorded( waits: Array< { wait: string } & SettleOutcome >, name: string ): ( { wait: string } & SettleOutcome ) | undefined {
		return waits.find( ( w ) => w.wait === name );
	}

	it( 'resolves the stable wait at the first quiet gap while analytics beacons never stop', async () => {
		const { page, waits } = await settledPage();
		await page.goto( `${ origin }/`, { waitUntil: 'load', timeout: 15_000 } );
		const started = Date.now();
		await waitForStable( page );
		const elapsed = Date.now() - started;
		// The network step is on the ledger now, and it observed quiet —
		// a request-counting networkidle never could on this page.
		expect( recorded( waits, 'network-quiet' ) ).toEqual( expect.objectContaining( { reason: 'quiet' } ) );
		expect( recorded( waits, 'network-quiet' )?.ms ).toBeLessThan( 4_000 );
		expect( elapsed ).toBeLessThan( 4_500 );
		await page.close();
	}, 30_000 );

	it( 'holds the stable wait for a pending same-origin hydration response and its render', async () => {
		const { page, waits } = await settledPage();
		await page.goto( `${ origin }/hydration`, { waitUntil: 'load', timeout: 15_000 } );
		await waitForStable( page );
		const network = recorded( waits, 'network-quiet' );
		expect( network?.reason ).toBe( 'quiet' );
		// The response is held 1.2s by the server; quiet cannot be declared
		// before it has landed.
		expect( network?.ms ).toBeGreaterThanOrEqual( 900 );
		// The render the response fed is on the page (DOM quiescence held).
		expect( await page.evaluate( () => document.querySelector( '#hydrated' )?.textContent ) ).toBe( 'hydrated content' );
		await page.close();
	}, 30_000 );

	it( 'holds the stable wait for a pending cross-origin data response', async () => {
		const { page, waits } = await settledPage();
		await page.goto( `${ origin }/cross-data`, { waitUntil: 'load', timeout: 15_000 } );
		await waitForStable( page );
		const network = recorded( waits, 'network-quiet' );
		expect( network?.reason ).toBe( 'quiet' );
		// Completed beacons do not reopen the window, but a data response still
		// in flight holds the wait until it lands (1.2s here).
		expect( network?.ms ).toBeGreaterThanOrEqual( 900 );
		await page.close();
	}, 30_000 );

	// An orphaned data request holds quiet only for the readiness bound from
	// its start, not for every later wait on the page.
	it( 'stops holding quiet for a data request once it has outlived the readiness bound', async () => {
		const { page, waits } = await settledPage();
		await page.goto( `${ origin }/orphan-data`, { waitUntil: 'load', timeout: 15_000 } );
		await waitForStable( page );
		expect( waits.find( ( w ) => w.wait === 'network-quiet' )?.ms ).toBeGreaterThanOrEqual( 4_000 );
		const recordedBefore = waits.length;
		const started = Date.now();
		await waitForStable( page );
		const elapsed = Date.now() - started;
		const second = waits.slice( recordedBefore ).find( ( w ) => w.wait === 'network-quiet' );
		expect( second?.reason ).toBe( 'quiet' );
		expect( second?.ms ).toBeLessThan( 3_000 );
		expect( elapsed ).toBeLessThan( 4_500 );
		await page.close();
	}, 30_000 );

	// The source declares its telemetry endpoint (as a platform adapter does);
	// nothing about the request itself is guessed. The declaration releases the
	// beacon only: the undeclared cross-origin response still holds the wait.
	it( 'does not hold for a declared telemetry beacon that never lands, but waits for a late cross-origin hydration response', async () => {
		const isTelemetry = ( url: string ) => new URL( url ).pathname === '/telemetry';
		const { page, waits } = await settledPage( isTelemetry );
		await page.goto( `${ origin }/telemetry-beacon`, { waitUntil: 'load', timeout: 15_000 } );
		await waitForStable( page );
		const network = recorded( waits, 'network-quiet' );
		expect( network?.reason ).toBe( 'quiet' );
		// Held for the hydration response (1.2s), not the beacon (never).
		expect( network?.ms ).toBeGreaterThanOrEqual( 900 );
		expect( network?.ms ).toBeLessThan( 4_000 );
		expect( await page.evaluate( () => document.querySelector( '#hydrated' )?.textContent ) ).toBe( 'hydrated content' );
		await page.close();
	}, 30_000 );

	it( 'still spends the bound when render-affecting requests never stop', async () => {
		const { page, waits } = await settledPage();
		await page.goto( `${ origin }/same-origin-chatter`, { waitUntil: 'load', timeout: 15_000 } );
		const started = Date.now();
		await waitForStable( page );
		const elapsed = Date.now() - started;
		expect( recorded( waits, 'network-quiet' ) ).toEqual( expect.objectContaining( { reason: 'deadline' } ) );
		expect( recorded( waits, 'network-quiet' )?.ms ).toBeGreaterThanOrEqual( 4_500 );
		// Bounded, not silent: the stable wait returns with the spent bound.
		expect( elapsed ).toBeLessThan( 8_000 );
		await page.close();
	}, 30_000 );

	it( 'bounds the lazy-load hydration window by quiet, not by raw networkidle', async () => {
		const { page, waits } = await settledPage();
		await page.goto( `${ origin }/`, { waitUntil: 'load', timeout: 15_000 } );
		const started = Date.now();
		const interruption = await triggerLazyLoad( page, true );
		const elapsed = Date.now() - started;
		expect( interruption ).toBeNull();
		expect( recorded( waits, 'render-quiet' ) ).toEqual( expect.objectContaining( { reason: 'quiet' } ) );
		expect( recorded( waits, 'render-quiet' )?.ms ).toBeLessThan( 4_000 );
		expect( elapsed ).toBeLessThan( 6_000 );
		await page.close();
	}, 30_000 );
} );
