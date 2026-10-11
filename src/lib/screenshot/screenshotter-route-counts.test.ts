import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
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
