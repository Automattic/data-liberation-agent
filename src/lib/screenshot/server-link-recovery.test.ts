import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';

it.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'discovers server links even when the entrypoint times out before serialization', async () => {
	const server = createServer( ( request, response ) => {
		response.setHeader( 'content-type', 'text/html' );
		response.end( request.url === '/' ? '<!doctype html><title>Home</title><main><a href="/linked">Linked document</a></main>' : '<!doctype html><title>Linked</title><main>Linked document</main>' );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test/server-link-recovery-' ) );
	try {
		const result = await captureScreenshots( {
			urls: [ `${ origin }/` ], primaryUrl: `${ origin }/`, outputDir,
			limit: 2, linkedPages: {}, routeDeadlineMs: 5_000, concurrency: 1,
			settleMs: 0, learnFluid: false, sharedChrome: false,
			viewports: [ { id: 'desktop', width: 1440, height: 900 } ],
			beforeSerialize: async ( page, context ) => {
				if ( context.url === `${ origin }/` ) await page.evaluate( () => new Promise<void>( () => {} ) );
			},
		} );
		expect( result.urls ).toContain( `${ origin }/linked` );
		expect( result ).toMatchObject( { captured: 1, failed: 1 } );
		expect( result.routeDiagnostics ).toEqual( expect.arrayContaining( [ expect.objectContaining( { code: 'route_capture_timeout', url: `${ origin }/` } ) ] ) );
	} finally {
		await new Promise<void>( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 15_000 );
