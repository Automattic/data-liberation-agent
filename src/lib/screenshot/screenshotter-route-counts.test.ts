import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { IntegrityError } from '../failure-class.js';
import { captureScreenshots } from './screenshotter.js';

const skipBrowser = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );

it.skipIf( skipBrowser )( 'counts routes, not failure records, across viewports and retries', async () => {
	const server = createServer( ( request, response ) => {
		if ( request.url === '/unavailable' ) {
			// Retryable on every attempt, so each viewport retries before recording.
			response.writeHead( 503, { 'retry-after': '0' } );
			response.end();
			return;
		}
		if ( request.url === '/gone' ) {
			response.writeHead( 404 );
			response.end();
			return;
		}
		response.setHeader( 'content-type', 'text/html' );
		response.end( '<!doctype html><title>Home</title><p>Home</p>' );
	} );
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'route-counts-' ) );
	try {
		const result = await captureScreenshots( {
			urls: [ `${ origin }/`, `${ origin }/unavailable`, `${ origin }/gone` ],
			outputDir, concurrency: 1, settleMs: 0, learnFluid: false,
			viewports: [ { id: 'desktop', width: 1440, height: 900 }, { id: 'mobile', width: 390, height: 844 } ],
		} );
		const failures = JSON.parse( readFileSync( join( outputDir, 'screenshots/failures.json' ), 'utf8' ) ) as Array< { url: string; viewport: string; attempt: number } >;
		const unavailable = failures.filter( failure => failure.url === `${ origin }/unavailable` );
		// Per-attempt detail stays in failures.json: one record per viewport, after retries.
		expect( unavailable.map( failure => failure.viewport ).sort() ).toEqual( [ 'desktop', 'mobile' ] );
		expect( unavailable.every( failure => failure.attempt > 1 ) ).toBe( true );
		expect( result ).toMatchObject( { captured: 1, skipped: 1, failed: 1 } );
		expect( result.captured + result.skipped + result.failed ).toBeLessThanOrEqual( result.urls.length );
	} finally {
		await new Promise< void >( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );

it.skipIf( skipBrowser )( 'counts a route whose HTML was saved as captured when a stage fails on it', async () => {
	const server = createServer( ( request, response ) => {
		if ( request.url === '/degraded' && /Mobile/i.test( request.headers[ 'user-agent' ] ?? '' ) ) {
			// The phone profile never loads, but the desktop document is saved.
			response.writeHead( 503, { 'retry-after': '0' } );
			response.end();
			return;
		}
		response.setHeader( 'content-type', 'text/html' );
		response.end( '<!doctype html><title>Page</title><p>Page</p>' );
	} );
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'route-degraded-' ) );
	try {
		const result = await captureScreenshots( {
			urls: [ `${ origin }/`, `${ origin }/degraded` ],
			outputDir, concurrency: 1, settleMs: 0, learnFluid: false,
			viewports: [ { id: 'desktop', width: 1440, height: 900 }, { id: 'mobile', width: 390, height: 844 } ],
		} );
		const failures = JSON.parse( readFileSync( join( outputDir, 'screenshots/failures.json' ), 'utf8' ) ) as Array< { url: string; viewport: string } >;
		expect( failures.filter( failure => failure.url === `${ origin }/degraded` ).map( failure => failure.viewport ) ).toEqual( [ 'mobile' ] );
		const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots/manifest.json' ), 'utf8' ) ) as { entries: Record< string, { html?: string } > };
		expect( manifest.entries[ `${ origin }/degraded` ]?.html ).toBeTruthy();
		expect( result ).toMatchObject( { captured: 2, skipped: 0, failed: 0 } );
		expect( result.captured + result.skipped + result.failed ).toBeLessThanOrEqual( result.urls.length );
	} finally {
		await new Promise< void >( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );

it.skipIf( skipBrowser )( 'drops off-origin inventory URLs as findings and captures the rest', async () => {
	const requested: string[] = [];
	const server = createServer( ( request, response ) => {
		requested.push( `${ request.headers.host }${ request.url }` );
		response.setHeader( 'content-type', 'text/html' );
		response.end( '<!doctype html><title>Page</title><p>Page</p>' );
	} );
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const port = ( server.address() as { port: number } ).port;
	const origin = `http://127.0.0.1:${ port }`;
	// Served by the same server, so only the origin check keeps it out.
	const offOrigin = `http://localhost:${ port }/elsewhere`;
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'route-off-origin-' ) );
	try {
		const result = await captureScreenshots( {
			urls: [ `${ origin }/`, offOrigin, `${ origin }/about` ], primaryUrl: `${ origin }/`,
			outputDir, concurrency: 1, settleMs: 0, learnFluid: false, viewports: [ { id: 'desktop', width: 1440, height: 900 } ],
		} );
		expect( result.routeDiagnostics ).toEqual( [ {
			code: 'route_off_origin', url: offOrigin, reason: `discovered URL is outside the entry origin ${ origin }`, unit: 'route', severity: 'warning',
		} ] );
		expect( result.urls ).toEqual( [ `${ origin }/`, `${ origin }/about` ] );
		expect( result ).toMatchObject( { captured: 2, skipped: 0, failed: 0 } );
		expect( requested.some( request => request.startsWith( 'localhost' ) ) ).toBe( false );
	} finally {
		await new Promise< void >( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );

it( 'rejects an entry URL off the reference origin as an integrity failure before any browser starts', async () => {
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'route-off-origin-entry-' ) );
	try {
		const capture = captureScreenshots( { urls: [ 'https://other.test/', 'https://example.test/about' ], primaryUrl: 'https://example.test/', outputDir } );
		await expect( capture ).rejects.toBeInstanceOf( IntegrityError );
		await expect( capture ).rejects.toThrow( 'Same-origin violation — expected https://example.test, got: https://other.test/' );
		expect( existsSync( join( outputDir, 'screenshots' ) ) ).toBe( false );
	} finally {
		rmSync( outputDir, { recursive: true, force: true } );
	}
} );
