import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import type { CapturePhase } from './phase-ledger.js';

// One local route / desktop profile, approximately 5 seconds with Chromium.
it( 'closes lazy-load before baseline and geometry work in the profile ledger (#1629)', async () => {
	const server = createServer( ( _, response ) => {
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( '<!doctype html><title>Phase fixture</title><main><h1>Baseline</h1><p>A small local page.</p></main>' );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test/pre-observe-phases-' ) );
	try {
		const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
		const result = await captureScreenshots( {
			urls: [ url ], outputDir, concurrency: 1, settleMs: 0,
			viewports: [ { id: 'desktop', width: 800, height: 600 } ],
		} );
		expect( result.captured ).toBe( 1 );
		const entry = JSON.parse( readFileSync( result.manifestPath, 'utf8' ) ).entries[ url ];
		const phases: CapturePhase[] = entry.profiles.desktop.phases;
		const names = phases.map( row => row.phase );
		const expected = [ 'lazy-load', 'baseline', 'layout-geometry', 'root-class', 'script-motion', 'baseline-snapshot', 'observe-source' ];
		const start = names.indexOf( 'lazy-load' );
		expect( start ).toBeGreaterThanOrEqual( 0 );
		// Ledger entries close on the next enter; this contiguous sequence proves
		// baseline and geometry are no longer charged to the lazy-load interval.
		expect( names.slice( start, start + expected.length ) ).toEqual( expected );
		for ( const phase of phases.slice( start, start + expected.length ) ) {
			expect( phase.ms ).toBeGreaterThanOrEqual( 0 );
			expect( phase.count ).toBeUndefined();
		}
		process.stderr.write( `[test] pre-observe phases ${ JSON.stringify( phases.slice( start, start + expected.length ) ) }\n` );
	} finally {
		server.closeAllConnections();
		await new Promise<void>( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 30_000 );
