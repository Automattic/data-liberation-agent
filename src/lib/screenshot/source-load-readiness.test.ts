import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { captureScreenshots } from './screenshotter.js';
import { SOURCE_LOAD_INCOMPLETE, SOURCE_NAVIGATION_LIMITS, SOURCE_NAVIGATION_SLOW } from '../source-navigation.js';

// A slow but healthy origin: the document arrives, one subresource does not.
// Held responses are released only when the server closes. `requests` counts
// document requests per path, so tests can check how often capture asked.
function slowOrigin( requests = new Map< string, number >() ): Server {
	return createServer( ( request, response ) => {
		requests.set( request.url ?? '', ( requests.get( request.url ?? '' ) ?? 0 ) + 1 );
		response.setHeader( 'content-type', 'text/html' );
		if ( request.url === '/held-image.png' || request.url === '/never' ) return;
		if ( request.url === '/slower-than-budget' ) {
			// Consistently slower than the (shrunk) budget, as a cold
			// server-rendered origin is under parallel capture.
			setTimeout( () => response.end( '<!doctype html><html><head><title>Slower than budget</title></head><body><h1>Slower than budget</h1></body></html>' ), 4_000 );
			return;
		}
		if ( request.url === '/slow-document' ) {
			setTimeout( () => response.end( '<!doctype html><html><head><title>Slow document</title></head><body><h1>Slow document</h1></body></html>' ), 7_000 );
			return;
		}
		setTimeout( () => response.end( `<!doctype html><html><head><title>Slow origin</title></head><body>
			<h1>Delivered document</h1><img width="32" height="32" src="/held-image.png">
			<div style="height:1200px">Preserved text</div></body></html>` ), 1_000 );
	} );
}

async function listen( server: Server ): Promise< string > {
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	return `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
}

async function close( server: Server ): Promise< void > {
	server.closeAllConnections();
	await new Promise< void >( resolve => server.close( () => resolve() ) );
}

function tempOutput( name: string ): string {
	mkdirSync( '.tmp-test', { recursive: true } );
	return mkdtempSync( join( process.cwd(), '.tmp-test', `${ name }-` ) );
}

describe.skipIf( !! process.env.SKIP_BROWSER_TESTS || ! existsSync( chromium.executablePath() ) )( 'source navigation readiness (real Chromium)', () => {
	it( 'captures a delivered document whose subresource outlives the navigation budget', async () => {
		// Shrink the navigation budget so the held image outlives it without a
		// real 30 s wait; the module constant is the only budget capture reads.
		const limits = SOURCE_NAVIGATION_LIMITS as { timeoutMs: number };
		const budget = limits.timeoutMs;
		limits.timeoutMs = 3_000;
		const server = slowOrigin();
		const origin = await listen( server );
		const outputDir = tempOutput( 'source-load-incomplete' );
		try {
			const url = `${ origin }/product`;
			const started = Date.now();
			const result = await captureScreenshots( { urls: [ url ], primaryUrl: url, outputDir, concurrency: 1, learnFluid: false, settleMs: 0 } );
			const elapsed = Date.now() - started;
			expect( result.failed ).toBe( 0 );
			expect( result.captured ).toBe( 1 );
			// One navigation plus bounded readiness, not four navigation attempts.
			expect( elapsed ).toBeLessThan( 4 * limits.timeoutMs + 30_000 );
			const failuresPath = join( outputDir, 'screenshots', 'failures.json' );
			expect( existsSync( failuresPath ) ? JSON.parse( readFileSync( failuresPath, 'utf8' ) ) : [] ).toEqual( [] );
			const entry = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) ).entries[ url ];
			for ( const [ profile, path ] of [ [ 'desktop', entry.html ], [ 'mobile', entry.mobileHtml ] ] ) {
				expect( readFileSync( join( outputDir, path ), 'utf8' ) ).toContain( 'Delivered document' );
				expect( entry.profiles[ profile ].diagnostics ).toEqual( [ { code: SOURCE_LOAD_INCOMPLETE, reason: expect.stringContaining( 'load event did not fire' ) } ] );
			}
		} finally {
			limits.timeoutMs = budget;
			await close( server );
			rmSync( outputDir, { recursive: true, force: true } );
		}
	}, 120_000 );

	it( 'captures a document that takes longer than 5 s to arrive within the navigation budget', async () => {
		const server = slowOrigin();
		const origin = await listen( server );
		const outputDir = tempOutput( 'source-slow-document' );
		try {
			const url = `${ origin }/slow-document`;
			const result = await captureScreenshots( { urls: [ url ], primaryUrl: url, outputDir, concurrency: 1, learnFluid: false, settleMs: 0, viewports: [ { id: 'desktop', width: 1440, height: 900 } ] } );
			const failuresPath = join( outputDir, 'screenshots', 'failures.json' );
			expect( existsSync( failuresPath ) ? JSON.parse( readFileSync( failuresPath, 'utf8' ) ) : [] ).toEqual( [] );
			expect( result.failed ).toBe( 0 );
			expect( result.captured ).toBe( 1 );
			const entry = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) ).entries[ url ];
			expect( readFileSync( join( outputDir, entry.html ), 'utf8' ) ).toContain( 'Slow document' );
		} finally {
			await close( server );
			rmSync( outputDir, { recursive: true, force: true } );
		}
	}, 120_000 );

	it( 'retries a document slower than the navigation budget once, with a longer budget, and records it', async () => {
		// The document takes 4 s and the budget is 3 s, on every request. The
		// same budget again would time out again; the one longer retry lands.
		const limits = SOURCE_NAVIGATION_LIMITS as { timeoutMs: number };
		const budget = limits.timeoutMs;
		limits.timeoutMs = 3_000;
		const requests = new Map< string, number >();
		const server = slowOrigin( requests );
		const origin = await listen( server );
		const outputDir = tempOutput( 'source-slower-than-budget' );
		try {
			const url = `${ origin }/slower-than-budget`;
			const result = await captureScreenshots( { urls: [ url ], primaryUrl: url, outputDir, concurrency: 1, learnFluid: false, settleMs: 0 } );
			const failuresPath = join( outputDir, 'screenshots', 'failures.json' );
			expect( existsSync( failuresPath ) ? JSON.parse( readFileSync( failuresPath, 'utf8' ) ) : [] ).toEqual( [] );
			expect( result.failed ).toBe( 0 );
			expect( result.captured ).toBe( 1 );
			const entry = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) ).entries[ url ];
			// Desktop and the phone pass both arrive, each with the retry on record.
			for ( const [ profile, path ] of [ [ 'desktop', entry.html ], [ 'mobile', entry.mobileHtml ] ] ) {
				expect( readFileSync( join( outputDir, path ), 'utf8' ) ).toContain( 'Slower than budget' );
				expect( entry.profiles[ profile ].diagnostics ).toEqual( [ {
					code: SOURCE_NAVIGATION_SLOW,
					reason: expect.stringMatching( /within the 3000ms navigation budget \(.*Timeout \d+ms exceeded.*\); one retry with a 6000ms budget delivered it in \d+ms/ ),
				} ] );
			}
			// Polite: per viewport pass, one timed-out request and one retry
			// (plus the session-harvest visit).
			expect( requests.get( '/slower-than-budget' ) ).toBeLessThanOrEqual( 5 );
		} finally {
			limits.timeoutMs = budget;
			await close( server );
			rmSync( outputDir, { recursive: true, force: true } );
		}
	}, 120_000 );

	it( 'still fails and retries a route whose document never arrives', async () => {
		// Each attempt spends the whole navigation budget; shrink it so four
		// attempts stay short.
		const limits = SOURCE_NAVIGATION_LIMITS as { timeoutMs: number };
		const budget = limits.timeoutMs;
		limits.timeoutMs = 6_000;
		const requests = new Map< string, number >();
		const server = slowOrigin( requests );
		const origin = await listen( server );
		const outputDir = tempOutput( 'source-document-never' );
		try {
			const url = `${ origin }/never`;
			const started = Date.now();
			const result = await captureScreenshots( { urls: [ url ], primaryUrl: url, outputDir, concurrency: 1, learnFluid: false, settleMs: 0, viewports: [ { id: 'desktop', width: 1440, height: 900 } ] } );
			expect( result.failed ).toBe( 1 );
			expect( result.captured ).toBe( 0 );
			const failures = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'failures.json' ), 'utf8' ) );
			// A timeout is retried once, with the longer slow-source budget, and
			// then recorded: a dead origin is asked twice, not four times.
			expect( failures ).toEqual( [ expect.objectContaining( { url, viewport: 'desktop', stage: 'goto', error: expect.stringMatching( /Timeout \d+ms exceeded/ ), attempt: 2 } ) ] );
			// Plus the session-harvest visit, which is not a capture attempt.
			expect( requests.get( '/never' ) ).toBeLessThanOrEqual( 3 );
			// Two bounded attempts plus backoff and the session-harvest visit; no hang.
			expect( Date.now() - started ).toBeLessThan( 60_000 );
		} finally {
			limits.timeoutMs = budget;
			await close( server );
			rmSync( outputDir, { recursive: true, force: true } );
		}
	}, 120_000 );
} );
