import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';

// One browser pass for all three outcomes; approximately 15 seconds locally.
it.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'rejects only corroborated soft-404 renders before saving HTML', async () => {
	const probes: string[] = [];
	const server = createServer( ( request, response ) => {
		const path = request.url ?? '/';
		if ( path.includes( 'liberation-absent-' ) ) probes.push( path );
		response.setHeader( 'content-type', 'text/html' );
		if ( path.startsWith( '/real/liberation-absent-' ) ) response.statusCode = 404;
		const text = path === '/' ? 'Home' : path === '/events/private' || path.startsWith( '/real/' ) ? 'Access Denied' : 'ページがありません';
		// Render in script, not server HTML, like a client-routed SPA.
		response.end( `<!doctype html><title>Fixture</title><header>Navigation</header><main></main><footer>Shared</footer><script>document.querySelector('main').innerHTML = '<h1>${ text }</h1>';</script>` );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'absent-sibling-' ) );
	try {
		const result = await captureScreenshots( {
			urls: [ '/', '/events/broken', '/events/private', '/real/child' ].map( path => origin + path ),
			primaryUrl: origin + '/', outputDir, concurrency: 1, settleMs: 0, learnFluid: false,
			viewports: [ { id: 'desktop', width: 1440, height: 900 } ],
		} );
		const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots/manifest.json' ), 'utf8' ) );
		expect( manifest.entries[ origin + '/events/broken' ]?.html ).toBeFalsy();
		expect( manifest.entries[ origin + '/events/private' ]?.html ).toBeTruthy();
		expect( manifest.entries[ origin + '/real/child' ]?.html ).toBeTruthy();
		const failures = JSON.parse( readFileSync( join( outputDir, 'screenshots/failures.json' ), 'utf8' ) );
		expect( failures ).toContainEqual( expect.objectContaining( { url: origin + '/events/broken', error: 'HTTP 404 (render matches absent nonce sibling)' } ) );
		expect( result ).toMatchObject( { captured: 3, skipped: 1, failed: 0 } );
		expect( probes.filter( path => path.startsWith( '/events/' ) ) ).toHaveLength( 1 );
		expect( probes.filter( path => path.startsWith( '/real/' ) ) ).toHaveLength( 1 );
	} finally {
		await new Promise<void>( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 90_000 );
