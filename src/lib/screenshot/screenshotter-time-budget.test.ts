import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { exportWebsiteCapture } from '../capture-export.js';
import { buildSourceFindings } from '../source-findings.js';
import { RouteTimeBudget, captureTimeBudgetWindow, CAPTURE_BUDGET_DRAIN_MS, ROUTE_DEADLINE_MIN_MS, deriveRouteDeadlineMs } from '../capture-time-budget.js';
import { DEFAULT_CAPTURE_TIME_BUDGET_MS, selectRouteBudget } from '../route-budget.js';
import { isUsableCapture, missingRoutes } from '../capture-usability.js';
import { captureScreenshots } from './screenshotter.js';
import type { ScreenshotResult } from './types.js';

const skipBrowser = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );

async function site( slow: Set< string > = new Set() ): Promise< { origin: string; server: Server; requested: string[] } > {
	const requested: string[] = [];
	const server = createServer( ( request, response ) => {
		requested.push( request.url ?? '' );
		if ( request.url?.includes( 'liberation-absent-' ) ) { response.writeHead( 404 ); response.end(); return; }
		// A route that never answers: only the budget's deadline ends it.
		if ( slow.has( request.url ?? '' ) ) return;
		response.setHeader( 'content-type', 'text/html' );
		const title = request.url === '/' ? 'Home' : request.url ?? '';
		response.end( `<!doctype html><html><head><title>${ title }</title></head><body><h1>${ title }</h1><a href="/about">About</a></body></html>` );
	} );
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	return { origin: `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`, server, requested };
}

async function close( server: Server ): Promise< void > {
	server.closeAllConnections();
	await new Promise< void >( resolve => server.close( () => resolve() ) );
}

/** Export the screenshot result the way `captureWebsite` composes it. */
function exportCapture( outputDir: string, sourceUrl: string, result: ScreenshotResult ) {
	const failuresPath = join( outputDir, 'screenshots', 'failures.json' );
	const failures = existsSync( failuresPath ) ? JSON.parse( readFileSync( failuresPath, 'utf8' ) ) : [];
	const routesOmitted = result.routeDiagnostics?.filter( row => row.code === 'route_omitted_by_budget' ).length ?? 0;
	const summary = { routesDiscovered: result.urls.length - routesOmitted, routesCaptured: result.captured, routesSkipped: result.skipped, routesFailed: result.failed, routesOmitted, durationMs: result.durationMs };
	const startedAt = Date.now();
	exportWebsiteCapture( { outputDir, sourceUrl, platform: 'generic', summary, failures, discoveryDiagnostics: result.routeDiagnostics ?? [] } );
	const exportMs = Date.now() - startedAt;
	const receipt = JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) );
	const missing = missingRoutes( receipt.discoveryDiagnostics );
	const complete = receipt.summary.complete as boolean;
	const usable = isUsableCapture( { complete, entrypointCaptured: true, missingRoutes: missing, summary } );
	const findings = buildSourceFindings( { complete, entrypointCaptured: true, summary: { ...summary, ...receipt.summary }, unresolvedAnchors: [], discoveryDiagnostics: receipt.discoveryDiagnostics } );
	return { receipt, missing, complete, usable, findings, exportMs };
}

const viewports = [ { id: 'desktop', width: 1440, height: 900 } ];

it.skipIf( skipBrowser )( 'starts the entrypoint first and records deadline-admission omissions as scope, not failures', async () => {
	const { origin, server, requested } = await site();
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'time-budget-closed-' ) );
	try {
		const now = Date.now();
		// The entrypoint is listed last: the budget still captures it, first.
		const result = await captureScreenshots( {
			urls: [ `${ origin }/about`, `${ origin }/contact`, `${ origin }/` ], primaryUrl: `${ origin }/`,
			outputDir, settleMs: 0, learnFluid: false, viewports,
			timeBudget: { timeBudgetMs: 1, admitUntil: now - 1, abandonAt: now - 1, projectAdmission: true },
		} );
		expect( result.urls[ 0 ] ).toBe( `${ origin }/` );
		expect( result ).toMatchObject( { captured: 1, skipped: 0, failed: 0 } );
		expect( result.captured + result.skipped + result.failed ).toBeLessThanOrEqual( result.urls.length );
		expect( result.routeDiagnostics?.map( row => [ row.code, row.url, row.unit ] ) ).toEqual( [
			[ 'route_omitted_by_budget', `${ origin }/about`, undefined ],
			[ 'route_omitted_by_budget', `${ origin }/contact`, undefined ],
		] );
		// Skipped routes were never requested, and no linked wave was expanded.
		expect( requested.filter( url => url !== '/' && ! /\.(?:ico|png)$/.test( url ) ) ).toEqual( [] );

		const { receipt, missing, complete, findings } = exportCapture( outputDir, `${ origin }/`, result );
		expect( receipt.routes.map( ( route: { url: string } ) => route.url ) ).toEqual( [ `${ origin }/` ] );
		expect( existsSync( join( outputDir, 'website', 'index.html' ) ) ).toBe( true );
		expect( complete ).toBe( true );
		expect( receipt.summary ).toMatchObject( { routesOmitted: 2, routesFailed: 0 } );
		expect( missing ).toEqual( [] );
		expect( findings.findings.filter( finding => finding.code === 'route_capture_skipped_budget' ) ).toHaveLength( 0 );
	} finally {
		await close( server );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );

it.skipIf( skipBrowser ).each( [
	// 3 routes x 127s uncalibrated estimate / 2 workers = 190.5s.
	{ fit: 'fits every route', admitWindowMs: 600_000, entryFirst: false },
	{ fit: 'projects truncation', admitWindowMs: 150_000, entryFirst: true },
] )( 'holds successors behind the entrypoint only when the budget $fit', async ( { admitWindowMs, entryFirst } ) => {
	const requests = new Map< string, number >();
	const server = createServer( ( request, response ) => {
		const path = request.url ?? '';
		if ( ! requests.has( path ) ) requests.set( path, Date.now() );
		if ( path.includes( 'liberation-absent-' ) ) { response.writeHead( 404 ); response.end(); return; }
		response.setHeader( 'content-type', 'text/html' );
		// The entrypoint is slow, so a successor admitted beside it starts before it finishes.
		setTimeout( () => response.end( `<!doctype html><html><head><title>${ path }</title></head><body><h1>${ path }</h1></body></html>` ), path === '/' ? 2_000 : 0 );
	} );
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'time-budget-entry-first-' ) );
	try {
		const now = Date.now();
		let entryObservedAt = Infinity;
		const prioritized: string[][] = [];
		const requestedBeforePriority = new Set< string >();
		const result = await captureScreenshots( {
			urls: [ `${ origin }/`, `${ origin }/a`, `${ origin }/b` ], primaryUrl: `${ origin }/`,
			outputDir, settleMs: 0, learnFluid: false, viewports, concurrency: 2,
			timeBudget: { timeBudgetMs: admitWindowMs + 60_000, admitUntil: now + admitWindowMs, abandonAt: now + admitWindowMs + 60_000, projectAdmission: true },
			prioritizePendingRoutes: pending => {
				for ( const url of pending ) if ( requests.has( new URL( url ).pathname ) ) requestedBeforePriority.add( url );
				prioritized.push( pending );
				return [ ...pending ].reverse();
			},
			// Successors wait for the entrypoint's rendered link evidence (#2240).
			observeSource: async ( _page, url ) => { if ( url === `${ origin }/` ) entryObservedAt = Math.min( entryObservedAt, Date.now() ); },
		} );
		expect( result ).toMatchObject( { captured: 3, failed: 0 } );
		const successorStartedAt = Math.min( requests.get( '/a' ) ?? Infinity, requests.get( '/b' ) ?? Infinity );
		expect( successorStartedAt < entryObservedAt ).toBe( ! entryFirst );
		// Only routes still pending once the entrypoint is released are reordered.
		expect( prioritized.length ).toBeLessThanOrEqual( 1 );
		expect( prioritized.flat().filter( url => requestedBeforePriority.has( url ) ) ).toEqual( [] );
		if ( entryFirst ) expect( prioritized ).toEqual( [ [ `${ origin }/a`, `${ origin }/b` ] ] );
	} finally {
		await close( server );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );

it.skipIf( skipBrowser )( 'abandons a route still running at the deadline and exports usable partial output', async () => {
	const { origin, server } = await site( new Set( [ '/slow' ] ) );
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'time-budget-abandon-' ) );
	try {
		const startedAt = Date.now();
		const timeBudgetMs = 12_000;
		const result = await captureScreenshots( {
			urls: [ `${ origin }/`, `${ origin }/about`, `${ origin }/slow` ], primaryUrl: `${ origin }/`,
			outputDir, settleMs: 0, learnFluid: false, viewports,
			// Every route is admitted; /slow is still navigating at the deadline.
			timeBudget: { timeBudgetMs, admitUntil: startedAt + timeBudgetMs, abandonAt: startedAt + timeBudgetMs },
		} );
		const captureMs = Date.now() - startedAt;
		// Bounded: the deadline plus the abandoned routes' drain, plus teardown.
		expect( captureMs ).toBeLessThan( timeBudgetMs + CAPTURE_BUDGET_DRAIN_MS + 5_000 );
		expect( result ).toMatchObject( { captured: 2, skipped: 0, failed: 1 } );
		expect( result.routeDiagnostics ).toEqual( [ {
			code: 'route_capture_skipped_budget', url: `${ origin }/slow`, reason: `capture time budget ${ timeBudgetMs }ms: abandoned in flight at the deadline`,
			unit: 'route', severity: 'error', metrics: { timeBudgetMs },
		} ] );
		// An abandoned route records nothing a later export could trip on.
		const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) ) as { entries: Record< string, unknown > };
		expect( Object.keys( manifest.entries ).sort() ).toEqual( [ `${ origin }/`, `${ origin }/about` ] );

		const { receipt, missing, complete, usable, findings } = exportCapture( outputDir, `${ origin }/`, result );
		expect( receipt.routes.map( ( route: { url: string } ) => route.url ).sort() ).toEqual( [ `${ origin }/`, `${ origin }/about` ] );
		expect( complete ).toBe( false );
		expect( missing ).toEqual( [ { url: `${ origin }/slow`, code: 'route_capture_skipped_budget', reason: expect.stringContaining( 'abandoned in flight' ) } ] );
		expect( usable ).toBe( true );
		expect( findings ).toMatchObject( { complete: false, usable: true } );
		expect( findings.findings ).toContainEqual( expect.objectContaining( { code: 'route_capture_skipped_budget', loss_class: 'omitted_unit', unit: 'route' } ) );
	} finally {
		await close( server );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );

it.skipIf( skipBrowser )( 'leaves capture unchanged without a time budget', async () => {
	const { origin, server } = await site();
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'time-budget-off-' ) );
	try {
		const result = await captureScreenshots( {
			urls: [ `${ origin }/contact`, `${ origin }/` ], primaryUrl: `${ origin }/`,
			outputDir, settleMs: 0, learnFluid: false, viewports,
		} );
		// Input order is kept and nothing is reported.
		expect( result.urls.slice( 0, 2 ) ).toEqual( [ `${ origin }/contact`, `${ origin }/` ] );
		expect( result.routeDiagnostics ).toBeUndefined();
		expect( result.failed ).toBe( 0 );
	} finally {
		await close( server );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );

it.skipIf( skipBrowser )( 'abandons a stalled route at its per-route deadline and frees the slot for the next route', async () => {
	// A route whose page never answers: no time budget, only the per-route
	// deadline ends it (deriveRouteDeadlineMs has a 10-minute floor, so the
	// configurable routeDeadlineMs is what makes this test cheap).
	const { origin, server } = await site( new Set( [ '/slow' ] ) );
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'route-deadline-' ) );
	try {
		const startedAt = Date.now();
		// Healthy routes now also pay for the bounded root-class quiet windows.
		const routeDeadlineMs = 6_000;
		const result = await captureScreenshots( {
			// The stalled route is admitted first; the entries after it complete.
			urls: [ `${ origin }/slow`, `${ origin }/`, `${ origin }/about` ], primaryUrl: `${ origin }/`,
			outputDir, settleMs: 0, learnFluid: false, viewports, routeDeadlineMs, concurrency: 1,
		} );
		const captureMs = Date.now() - startedAt;
		expect( result ).toMatchObject( { captured: 2, skipped: 0, failed: 1 } );
		// The stalled route cost its deadline, not the whole capture.
		expect( captureMs ).toBeLessThan( routeDeadlineMs + 10_000 );
		expect( result.routeDiagnostics ).toEqual( [ {
			code: 'route_capture_timeout', url: `${ origin }/slow`,
			reason: expect.stringContaining( `route capture deadline ${ routeDeadlineMs }ms` ),
			unit: 'route', severity: 'error', metrics: { routeDeadlineMs },
		} ] );

		const { receipt, missing, complete, usable, findings } = exportCapture( outputDir, `${ origin }/`, result );
		expect( receipt.routes.map( ( route: { url: string } ) => route.url ).sort() ).toEqual( [ `${ origin }/`, `${ origin }/about` ] );
		expect( missing ).toEqual( [ { url: `${ origin }/slow`, code: 'route_capture_timeout', reason: expect.stringContaining( `route capture deadline ${ routeDeadlineMs }ms` ) } ] );
		expect( complete ).toBe( false );
		expect( usable ).toBe( true );
		expect( findings.findings ).toContainEqual( expect.objectContaining( { code: 'route_capture_timeout', loss_class: 'omitted_unit', unit: 'route' } ) );
	} finally {
		await close( server );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );

// One public-interface regression for #1374; expected wall time about 45s.
it.skipIf( skipBrowser )( 'stops admitting routes when the source stops answering navigations and exports captured routes', async () => {
	const requested: string[] = [];
	const server = createServer( ( request, response ) => {
		if ( request.url?.includes( 'liberation-absent-' ) ) { response.writeHead( 404 ); response.end(); return; }
		if ( request.url === '/' || request.url?.startsWith( '/route-' ) ) {
			const path = request.url!;
			if ( ! requested.includes( path ) ) requested.push( path );
			if ( requested.indexOf( path ) >= 2 ) return;
		}
		response.setHeader( 'content-type', 'text/html' );
		response.end( '<!doctype html><html><head><title>Captured</title></head><body><h1>Captured</h1></body></html>' );
	} );
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'source-stall-' ) );
	try {
		const urls = [ `${ origin }/`, ...Array.from( { length: 13 }, ( _, i ) => `${ origin }/route-${ i }` ) ];
		const routeDeadlineMs = 12_000;
		const startedAt = Date.now();
		const result = await captureScreenshots( {
			urls, primaryUrl: urls[ 0 ], outputDir, settleMs: 0, learnFluid: false,
			viewports, routeDeadlineMs, concurrency: 1,
		} );
		expect( Date.now() - startedAt ).toBeLessThan( routeDeadlineMs * 7 );
		expect( result ).toMatchObject( { captured: 2, failed: 12 } );
		expect( requested ).toEqual( [ '/', '/route-0', '/route-1', '/route-2', '/route-3' ] );
		const skipped = result.routeDiagnostics?.filter( row => row.code === 'route_capture_failed' );
		expect( skipped?.map( row => row.url ) ).toEqual( urls.slice( 5 ) );
		expect( skipped?.every( row => row.reason.includes( 'source stalled' ) ) ).toBe( true );
		const { receipt, missing, complete, usable } = exportCapture( outputDir, urls[ 0 ]!, result );
		expect( receipt.routes.map( ( route: { url: string } ) => route.url ).sort() ).toEqual( urls.slice( 0, 2 ).sort() );
		expect( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) ).toContain( 'Captured' );
		expect( missing ).toHaveLength( 12 );
		expect( missing.filter( row => row.code === 'route_capture_failed' ).map( row => row.url ) ).toEqual( urls.slice( 5 ) );
		expect( complete ).toBe( false );
		expect( usable ).toBe( true );
	} finally {
		await close( server );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 120_000 );

it.skipIf( skipBrowser )( 'keeps the completed desktop profile of a route abandoned at its deadline while its phone profile stalls', async () => {
	// The homepage answers desktop identities and never answers the phone one:
	// desktop completes, the phone profile is in flight at the deadline.
	const requested: string[] = [];
	const server = createServer( ( request, response ) => {
		requested.push( request.url ?? '' );
		if ( request.url?.includes( 'liberation-absent-' ) ) { response.writeHead( 404 ); response.end(); return; }
		if ( request.url === '/' && /iPhone/.test( request.headers[ 'user-agent' ] ?? '' ) ) return;
		response.setHeader( 'content-type', 'text/html' );
		const title = request.url === '/' ? 'Home' : request.url ?? '';
		response.end( `<!doctype html><html><head><title>${ title }</title></head><body><h1>${ title }</h1><a href="/about">About</a></body></html>` );
	} );
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'route-deadline-partial-' ) );
	try {
		const routeDeadlineMs = 8_000;
		const result = await captureScreenshots( {
			urls: [ `${ origin }/`, `${ origin }/about` ], primaryUrl: `${ origin }/`,
			outputDir, settleMs: 0, learnFluid: false, routeDeadlineMs, concurrency: 1,
			viewports: [ { id: 'desktop', width: 1440, height: 900 }, { id: 'mobile', width: 390, height: 844 } ],
		} );
		// The partially committed route is captured, not failed.
		expect( result ).toMatchObject( { captured: 2, skipped: 0, failed: 0 } );
		expect( result.routeDiagnostics ).toEqual( [ {
			code: 'route_profile_capture_timeout', url: `${ origin }/`, profile: 'mobile',
			reason: expect.stringMatching( /^route capture deadline 8000ms: abandoned during the "[^"]+" phase in the mobile profile$/ ),
			unit: 'profile', severity: 'error', metrics: { routeDeadlineMs },
		} ] );
		const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) ) as { entries: Record< string, { html?: string; mobileHtml?: string; profiles?: Record< string, unknown > } > };
		const home = manifest.entries[ `${ origin }/` ]!;
		expect( home.html && existsSync( join( outputDir, home.html ) ) ).toBeTruthy();
		// Nothing from the in-flight phone profile is recorded.
		expect( home.mobileHtml ).toBeUndefined();
		expect( Object.keys( home.profiles ?? {} ) ).toEqual( [ 'desktop' ] );
		const failures = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'failures.json' ), 'utf8' ) ) as Array< { url: string; viewport: string; stage: string; error: string } >;
		expect( failures.filter( failure => failure.url === `${ origin }/` ) ).toEqual( [ expect.objectContaining( {
			viewport: 'mobile', stage: 'deadline', error: expect.stringContaining( 'route capture deadline 8000ms' ),
		} ) ] );

		const { receipt, missing, complete, usable } = exportCapture( outputDir, `${ origin }/`, result );
		expect( existsSync( join( outputDir, 'website', 'index.html' ) ) ).toBe( true );
		expect( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) ).toContain( 'Home' );
		expect( receipt.discoveryDiagnostics ).toContainEqual( expect.objectContaining( {
			code: 'route_profile_uncaptured', url: `${ origin }/`, profile: 'mobile', reason: expect.stringContaining( 'mobile/deadline: route capture deadline 8000ms' ),
		} ) );
		expect( missing ).toEqual( [] );
		expect( complete ).toBe( false );
		// A lost profile is not a missing route.
		expect( usable ).toBe( true );
	} finally {
		await close( server );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );

it.skipIf( skipBrowser )( 'derives the per-route deadline from the time budget and concurrency, never below the floor', () => {
	expect( deriveRouteDeadlineMs( undefined, 42 * 60_000, 3 ) ).toBe( 14 * 60_000 );
	expect( deriveRouteDeadlineMs( undefined, 12_000, 6 ) ).toBe( ROUTE_DEADLINE_MIN_MS );
	expect( deriveRouteDeadlineMs( undefined, undefined, 6 ) ).toBe( ROUTE_DEADLINE_MIN_MS );
	expect( deriveRouteDeadlineMs( 1_500, undefined, 6 ) ).toBe( 1_500 );
	expect( deriveRouteDeadlineMs( 0, 42 * 60_000, 3 ) ).toBe( 0 );
} );

// Deterministic route-pool simulation: same admits/start/finish contract as
// the browser loop, without thousands of browser navigations.
function timedInventory( count: number, duration: number, concurrency: number, limit?: number ) {
	const inventory = Array.from( { length: count }, ( _, index ) => `https://example.com/${ index }` );
	const selection = selectRouteBudget( inventory, limit, [], limit === undefined );
	let now = 0;
	const budget = new RouteTimeBudget( { ...captureTimeBudgetWindow( 0, DEFAULT_CAPTURE_TIME_BUDGET_MS ), projectAdmission: limit === undefined }, inventory[ 0 ]!, () => now );
	const running = new Map< string, number >();
	const captured: string[] = [];
	let cursor = 0;
	while ( cursor < selection.selected.length || running.size ) {
		while ( cursor < selection.selected.length && running.size < concurrency && budget.admits( selection.selected[ cursor ]!, running.size + 1 ) ) {
			const url = selection.selected[ cursor++ ]!;
			budget.start( url );
			running.set( url, now + duration );
		}
		if ( ! running.size ) break;
		now = Math.min( ...running.values() );
		for ( const [ url, end ] of running ) {
			if ( end !== now ) continue;
			budget.commit( url );
			budget.finish( url );
			running.delete( url );
			captured.push( url );
		}
	}
	return { captured, diagnostics: budget.diagnostics( selection.selected ), omitted: selection.omitted, now };
}

it( 'captures all 53 fast routes within the default time window, without a count cap', () => {
	const result = timedInventory( 53, 15_000, 1 );
	expect( result.captured ).toHaveLength( 53 );
	expect( result.diagnostics ).toEqual( [] );
} );

it.each( [ 1, 3, 6 ] )( 'stops a 3,689-route slow inventory near the deadline with %i admitted workers', concurrency => {
	const result = timedInventory( 3689, 127_000, concurrency );
	expect( result.now ).toBeLessThanOrEqual( DEFAULT_CAPTURE_TIME_BUDGET_MS );
	expect( result.now ).toBeGreaterThan( DEFAULT_CAPTURE_TIME_BUDGET_MS - 60_000 - 127_000 );
	expect( result.captured.length + result.diagnostics.length ).toBe( 3689 );
	expect( result.diagnostics.every( row => row.code === 'route_omitted_by_budget' && row.severity !== 'error' ) ).toBe( true );
	expect( result.captured ).toContain( 'https://example.com/3688' );
} );

it( 'keeps an explicit numeric route cap', () => {
	const result = timedInventory( 53, 1_000, 6, 7 );
	expect( result.captured ).toHaveLength( 7 );
	expect( result.omitted ).toHaveLength( 46 );
	expect( result.diagnostics ).toEqual( [] );
} );
