import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { captureWebsite } from './capture.js';

vi.mock( './media-fetch/safe-fetch.js', async () => {
	const actual = await vi.importActual< typeof import( './media-fetch/safe-fetch.js' ) >( './media-fetch/safe-fetch.js' );
	return { ...actual,
		safeFetch: vi.fn( async ( url: string ) => ( { finalUrl: url, status: 200, headers: new Headers(), body: Buffer.alloc( 0 ) } ) ),
		assertPublicHttpUrl( raw: string ) {
			const url = new URL( raw );
			return url.hostname === '127.0.0.1' ? url : actual.assertPublicHttpUrl( raw );
		},
	};
} );

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) )( 'entrypoint challenge diagnostics (real Chromium)', () => {
	it.each( [ false, true ] )( 'propagates rejected homepage evidence, challenge=%s', async ( challenge ) => {
		const server = createServer( ( _request, response ) => {
			response.writeHead( 403, {
				'content-type': 'text/html',
				'set-cookie': 'session=challenge-secret',
				...( challenge ? { 'cf-mitigated': 'challenge', 'x-challenge': 'x'.repeat( 200 ) } : {} ),
			} );
			response.end( '<html><body>VERIFICATION_DOCUMENT</body></html>' );
		} );
		await new Promise< void >( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
		const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
		mkdirSync( '.tmp-test', { recursive: true } );
		const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'entrypoint-challenge-' ) );
		try {
			const error = await captureWebsite( { url, outputDir, learnFluid: false }, {
				findAdapter: () => ( { id: 'generic', discover: async () => ( { urls: [], siteMeta: { title: 'Fixture' } } ) } ),
			} ).catch( ( thrown: unknown ) => thrown );
			expect( error ).toBeInstanceOf( Error );
			const message = ( error as Error ).message;
			expect( message ).toContain( `Source homepage ${ url } was not captured:` );
			expect( message ).toContain( 'HTTP 403' );
			if ( challenge ) {
				expect( message ).toContain( 'cf-mitigated=challenge' );
				expect( message ).toContain( `x-challenge=${ 'x'.repeat( 128 ) }` );
				expect( message ).not.toContain( 'x'.repeat( 129 ) );
			} else expect( message ).not.toContain( 'challenge:' );
			expect( message ).not.toContain( 'challenge-secret' );
			expect( message ).not.toContain( 'VERIFICATION_DOCUMENT' );
			expect( existsSync( join( outputDir, 'website' ) ) ).toBe( false );
			const failures = readFileSync( join( outputDir, 'screenshots/failures.json' ), 'utf8' );
			expect( failures ).not.toContain( 'challenge-secret' );
			if ( challenge ) expect( failures ).toContain( 'cf-mitigated=challenge' );
		} finally {
			server.closeAllConnections();
			await new Promise< void >( ( resolve ) => server.close( () => resolve() ) );
			rmSync( outputDir, { recursive: true, force: true } );
		}
	}, 60_000 );
} );
