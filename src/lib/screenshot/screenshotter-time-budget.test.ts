import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { exportWebsiteCapture } from '../capture-export.js';
import { buildCaptureFindings } from '../capture-findings.js';
import { CAPTURE_BUDGET_DRAIN_MS } from '../capture-time-budget.js';
import { isUsableCapture, missingRoutes } from '../capture-usability.js';
import { captureScreenshots } from './screenshotter.js';
import type { ScreenshotResult } from './types.js';

const skipBrowser = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );

async function site( slow: Set< string > = new Set() ): Promise< { origin: string; server: Server; requested: string[] } > {
	const requested: string[] = [];
	const server = createServer( ( request, response ) => {
		requested.push( request.url ?? '' );
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
	const summary = { routesDiscovered: result.urls.length, routesCaptured: result.captured, routesSkipped: result.skipped, routesFailed: result.failed, routesOmitted: 0, durationMs: result.durationMs };
	const startedAt = Date.now();
	exportWebsiteCapture( { outputDir, sourceUrl, platform: 'generic', summary, failures, discoveryDiagnostics: result.routeDiagnostics ?? [] } );
	const exportMs = Date.now() - startedAt;
	const receipt = JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) );
	const missing = missingRoutes( receipt.discoveryDiagnostics );
	const complete = receipt.summary.complete as boolean;
	const usable = isUsableCapture( { complete, entrypointCaptured: true, missingRoutes: missing, summary } );
	const findings = buildCaptureFindings( { complete, entrypointCaptured: true, summary: { ...summary, ...receipt.summary }, unresolvedAnchors: [], discoveryDiagnostics: receipt.discoveryDiagnostics } );
	return { receipt, missing, complete, usable, findings, exportMs };
}

const viewports = [ { id: 'desktop', width: 1440, height: 900 } ];

it.skipIf( skipBrowser )( 'starts the entrypoint first and skips routes not started once admission has closed', async () => {
	const { origin, server, requested } = await site();
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'time-budget-closed-' ) );
	try {
		const now = Date.now();
		// The entrypoint is listed last: the budget still captures it, first.
		const result = await captureScreenshots( {
			urls: [ `${ origin }/about`, `${ origin }/contact`, `${ origin }/` ], primaryUrl: `${ origin }/`,
			outputDir, settleMs: 0, learnFluid: false, viewports,
			timeBudget: { timeBudgetMs: 1, admitUntil: now - 1, abandonAt: now - 1 },
		} );
		expect( result.urls[ 0 ] ).toBe( `${ origin }/` );
		expect( result ).toMatchObject( { captured: 1, skipped: 0, failed: 2 } );
		expect( result.captured + result.skipped + result.failed ).toBeLessThanOrEqual( result.urls.length );
		expect( result.routeDiagnostics?.map( row => [ row.code, row.url, row.unit ] ) ).toEqual( [
			[ 'route_capture_skipped_budget', `${ origin }/about`, 'route' ],
			[ 'route_capture_skipped_budget', `${ origin }/contact`, 'route' ],
		] );
		// Skipped routes were never requested, and no linked wave was expanded.
		expect( requested.filter( url => url !== '/' && ! /\.(?:ico|png)$/.test( url ) ) ).toEqual( [] );

		const { receipt, missing, complete, findings } = exportCapture( outputDir, `${ origin }/`, result );
		expect( receipt.routes.map( ( route: { url: string } ) => route.url ) ).toEqual( [ `${ origin }/` ] );
		expect( existsSync( join( outputDir, 'website', 'index.html' ) ) ).toBe( true );
		expect( complete ).toBe( false );
		expect( missing.map( route => route.code ) ).toEqual( [ 'route_capture_skipped_budget', 'route_capture_skipped_budget' ] );
		expect( findings.findings.filter( finding => finding.code === 'route_capture_skipped_budget' ) ).toHaveLength( 2 );
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
		expect( findings ).toMatchObject( { complete: false, usable: true, missing_routes: [ { code: 'route_capture_skipped_budget' } ] } );
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
