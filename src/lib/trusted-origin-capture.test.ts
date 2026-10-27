//
// End-to-end proof for the caller-vouched capture origin (#1003): a site
// served on this machine (127.0.0.1) is refused by the SSRF guard until the
// caller names its origin, and the same capture then succeeds.
//
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureWebsite, type CaptureDependencies } from './capture.js';
import { SsrfBlockedError } from './media-fetch/safe-fetch.js';

// One static route is the whole fixture; detection stays out of the way so
// the test exercises the guard and the capture, not a platform adapter.
const GENERIC_DEPENDENCIES: CaptureDependencies = {
	findAdapter: () => ( {
		id: 'generic',
		discover: async () => ( { urls: [], siteMeta: { title: 'Local fixture' } } ),
	} ),
};

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) )( 'capture of a caller-vouched local origin (real Chromium)', () => {
	it( 'captures a site served on 127.0.0.1 only when its origin is vouched', async () => {
		const server = createServer( ( _request, response ) => {
			response.writeHead( 200, { 'content-type': 'text/html; charset=utf-8' } );
			response.end(
				'<!doctype html><html lang="en"><head><title>Local fixture</title></head>' +
				'<body><h1>LOCAL SOURCE</h1><p>Vouched-origin capture fixture.</p></body></html>'
			);
		} );
		await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
		const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
		mkdirSync( '.tmp-test', { recursive: true } );
		const outputBase = mkdtempSync( join( process.cwd(), '.tmp-test', 'trusted-origin-' ) );
		try {
			// Without a vouched origin, the guard refuses the local source before
			// discovery or any browser starts.
			const blocked = await captureWebsite(
				{ url, outputDir: join( outputBase, 'blocked' ), learnFluid: false },
				GENERIC_DEPENDENCIES
			).catch( ( thrown: unknown ) => thrown );
			expect( blocked ).toBeInstanceOf( SsrfBlockedError );
			expect( existsSync( join( outputBase, 'blocked', 'website' ) ) ).toBe( false );

			// Naming the origin lets the same capture run against this machine.
			const result = await captureWebsite(
				{ url, outputDir: join( outputBase, 'trusted' ), learnFluid: false, trustedOrigins: [ url ] },
				GENERIC_DEPENDENCIES
			);
			expect( result.complete ).toBe( true );
			expect( existsSync( join( outputBase, 'trusted', 'website', 'index.html' ) ) ).toBe( true );
		} finally {
			server.closeAllConnections();
			await new Promise< void >( ( resolve ) => server.close( () => resolve() ) );
			rmSync( outputBase, { recursive: true, force: true } );
		}
	}, 120_000 );
} );
