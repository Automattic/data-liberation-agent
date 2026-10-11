import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

// Fluid learning is an optimization: when it throws, the route keeps its
// frozen copy and the failure is a diagnostic, not a failed route (#763).
vi.mock( './fluid-capture.js', () => ( {
	learnAndApplyFluidGeometry: async () => {
		throw new TypeError( "Cannot read properties of undefined (reading 'nodeType')" );
	},
} ) );

it( 'records a fluid-learning exception as a diagnostic and keeps the frozen route', async () => {
	const { captureScreenshots } = await import( './screenshotter.js' );
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'issue-763-fluid-' ) );
	const server = createServer( ( _request, response ) => {
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( '<!doctype html><html><head><title>T</title></head><body><h1 style="width:600px">Frozen</h1></body></html>' );
	} );
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
	try {
		const result = await captureScreenshots( { urls: [ url ], outputDir, concurrency: 1, settleMs: 0, learnFluid: true } );
		expect( result.failed ).toBe( 0 );
		expect( existsSync( join( outputDir, 'screenshots', 'failures.json' ) ) ).toBe( false );
		const entry = JSON.parse( readFileSync( result.manifestPath, 'utf8' ) ).entries[ url ];
		expect( readFileSync( join( outputDir, entry.html ), 'utf8' ) ).toContain( 'Frozen' );
		expect( entry.fluid ).toMatchObject( { applied: 0, diagnostic: expect.stringContaining( 'fluid learning failed' ) } );
	} finally {
		await new Promise( resolve => server.close( resolve ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );
