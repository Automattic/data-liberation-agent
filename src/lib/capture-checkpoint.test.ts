import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it, vi } from 'vitest';
import { captureWebsite } from './capture.js';

// Three small browser passes, approximately 45 seconds on a warm machine.
it.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'chains budget checkpoints, reuses pages without reserve and exports only the completed capture', async () => {
	const server = createServer( ( req, res ) => {
		if ( ! [ '/', '/one/', '/two/', '/three/' ].includes( req.url ?? '' ) ) {
			res.writeHead( 404 ); res.end(); return;
		}
		res.setHeader( 'Content-Type', 'text/html' );
		res.end( `<!doctype html><html><head><title>Checkpoint</title></head><body><main><h1>Page ${ req.url }</h1><p>Portable checkpoint fixture.</p></main></body></html>` );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'checkpoint-' ) );
	// Keep wall-clock browser work real, but model time spent before export
	// without making this fixture wait for minutes.
	const now = Date.now.bind( Date );
	let elapsed = 0;
	const clock = vi.spyOn( Date, 'now' ).mockImplementation( () => now() + elapsed );
	const options = {
		url, outputDir, trustedOrigins: [ new URL( url ).origin ], checkpoint: true,
		routeLimit: 'all' as const, timeBudgetMs: 600_000, routeReserveMs: 140_000,
		onProgress: ( progress: { phase: string; current?: number } ) => {
			if ( progress.phase === 'finalizing' && progress.current ) elapsed = 100_000;
		},
		captureImages: false, learnFluid: false, deviceMode: 'reflow-only' as const,
	};
	const deps = { findAdapter: () => ( { id: 'checkpoint-fixture', detect: () => true,
		discover: async () => ( { urls: [ 'one/', 'two/', 'three/' ].map( path => ( { url: new URL( path, url ).href } ) ) } ),
	} ) };
	try {
		// Reserve closes admission after three routes without a wall-clock sleep.
		const first = await captureWebsite( options, deps );
		expect( first.checkpoint ).toBe( true );
		expect( first.summary.routesCaptured ).toBe( 3 );
		expect( first.missingRoutes ).toHaveLength( 1 );
		expect( first.missingRoutes.every( row => row.code === 'route_capture_skipped_budget' ) ).toBe( true );
		expect( JSON.parse( readFileSync( first.captureReceiptPath, 'utf8' ) ) ).toMatchObject( { checkpoint: true, resumable: true, complete: false, summary: first.summary } );
		expect( existsSync( join( outputDir, 'website' ) ) ).toBe( false );

		elapsed = 0;
		const second = await captureWebsite( { ...options, resume: true }, deps );
		expect( second.checkpoint ).toBe( true );
		expect( second.summary.routesSkipped ).toBe( 3 );
		expect( second.summary.routesCaptured ).toBe( 1 );
		expect( second.complete ).toBe( false );
		expect( second.resumable ).toBe( true );
		expect( second.missingRoutes ).toHaveLength( 0 );
		expect( JSON.parse( readFileSync( second.captureReceiptPath, 'utf8' ) ) ).toMatchObject( {
			checkpoint: true, resumable: true, complete: false, exportPending: true, missingRoutes: [],
		} );
		expect( existsSync( join( outputDir, 'website' ) ) ).toBe( false );

		// With no new browser routes, the unchanged budget now fits a full export.
		elapsed = 0;
		const final = await captureWebsite( { ...options, resume: true }, deps );
		expect( final.checkpoint ).not.toBe( true );
		expect( final.complete ).toBe( true );
		expect( final.summary.routesSkipped ).toBe( 4 );
		expect( final.summary.routesCaptured ).toBe( 0 );
		for ( const path of [ 'index.html', 'one/index.html', 'two/index.html', 'three/index.html' ] ) {
			expect( existsSync( join( outputDir, 'website', path ) ), path ).toBe( true );
		}
	} finally {
		clock.mockRestore();
		server.closeAllConnections();
		await new Promise<void>( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 180_000 );
