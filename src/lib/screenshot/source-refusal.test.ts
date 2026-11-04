import { createServer } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SourceRequestGovernors } from '../source-request-governor.js';
import { captureScreenshots } from './screenshotter.js';

// Four small browser passes, normally ~30 seconds total.
it( 'bounds requests after a persistent cross-route refusal, but preserves healthy and recovered coverage', async () => {
	for ( const mode of [ 'healthy', 'blocked', 'burst', 'window' ] as const ) {
		let requests = 0;
		let firstRefusal = 0;
		let resets = 0;
		let refusedAt = 0;
		const server = createServer( ( request, response ) => {
			requests++;
			if ( mode !== 'healthy' && requests > 2 && ( mode === 'blocked' || (mode === 'burst' ? resets < 3 : !refusedAt || Date.now() - refusedAt < 4500) ) ) {
				firstRefusal ||= requests;
				refusedAt ||= Date.now();
				resets++;
				request.socket.resetAndDestroy();
				return;
			}
			response.writeHead( 200, { 'content-type': 'text/html' } );
			response.end( '<!doctype html><html><head><title>Fixture</title></head><body><main><h1>Local route</h1><p>A neutral capture fixture with stable content.</p></main></body></html>' );
		} );
		await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
		const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
		const outputDir = join( process.cwd(), '.tmp-test', `source-refusal-${ mode }` );
		await mkdir( outputDir, { recursive: true } );
		const started = Date.now();
		try {
			const result = await captureScreenshots( {
				governors: new SourceRequestGovernors({ refusalProbeAtMs: [100, 500, 2000, 5500] }),
				urls: Array.from( { length: 8 }, ( _, i ) => `${ origin }/route-${ i }` ),
				outputDir, concurrency: 2, viewports: [ { id: 'desktop', width: 900, height: 600 } ],
				learnFluid: false, referenceWidths: [],
			} );
			process.stderr.write( JSON.stringify( { mode, requests, afterFirstRefusal: firstRefusal ? requests - firstRefusal + 1 : 0, captured: result.captured, wallMs: Date.now() - started } ) + '\n' );
			if ( mode === 'blocked' ) {
				expect( result.routeDiagnostics ).toContainEqual( expect.objectContaining( {
					code: 'source_blocked_client', requestsBeforeFirstRefusal: expect.any( Number ), firstRefusalAt: expect.any( String ),
					reason: expect.stringContaining( 'retry later or from another network' ),
				} ) );
				expect( requests - firstRefusal + 1 ).toBeLessThanOrEqual( 10 );
			} else {
				expect( result.captured ).toBe( 8 );
				expect( result.routeDiagnostics ?? [] ).not.toContainEqual( expect.objectContaining( { code: 'source_blocked_client' } ) );
			}
		} finally {
			server.closeAllConnections();
			await new Promise<void>( resolve => server.close( () => resolve() ) );
			await rm( outputDir, { recursive: true, force: true } );
		}
	}
}, 180_000 );
