import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { it } from '../../test/browser.js';
import { captureWebsite } from '../index.js';

// One public capture/export (~20 seconds). Inject the hydration miss only at
// serialization, so device detection and other visits cannot consume the retry.
it.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) )( 'retries empty linked renders and counts an exhausted retry as a capture failure', async ( { serve } ) => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const root = mkdtempSync( join( parent, 'empty-render-' ) );
	const attempts = new Map<string, number>();
	const { server } = await serve( ( request, response ) => {
		if ( request.url === '/robots.txt' ) { response.end( '' ); return; }
		if ( request.url?.includes( 'sitemap' ) ) { response.statusCode = 404; response.end(); return; }
		if ( ! [ '/', '/transient', '/empty', '/missing' ].includes( request.url ?? '' ) ) { response.statusCode = 404; response.end( 'Not found' ); return; }
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( `<!doctype html><html><body><h1>Content ${ request.url }</h1><a href="/transient">Transient</a><a href="/empty">Empty</a><a href="/missing">Missing</a></body></html>` );
	} );
	const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
	try {
		const result = await captureWebsite( { url, outputDir: root, trustedOrigins: [ url ], captureImages: false, learnFluid: false, deferReference: true, templateClusters: false }, {
			findAdapter: () => ( {
				id: 'hydration-fixture', detect: () => true,
				discover: async () => ( { urls: [ '', 'transient', 'empty', 'missing' ].map( path => ( { url: url + path } ) ) } ),
				liberation: {
					beforeSerialize: async page => {
						const path = new URL( page.url() ).pathname;
						const attempt = ( attempts.get( path ) ?? 0 ) + 1;
						attempts.set( path, attempt );
						if ( path === '/empty' || ( path === '/transient' && attempt === 1 ) ) {
							await page.evaluate( () => { document.body.innerHTML = ''; } );
						} else if ( path === '/missing' ) {
							await page.evaluate( () => { document.body.innerHTML = '<h1>404</h1>'; } );
						}
					},
				},
			} ),
		} );
		expect( attempts.get( '/transient' ) ).toBe( 2 );
		expect( attempts.get( '/empty' ) ).toBe( 2 );
		expect( result.summary ).toMatchObject( { routesCaptured: 3, routesFailed: 1 } );
		const receipt = JSON.parse( readFileSync( result.captureReceiptPath, 'utf8' ) );
		expect( receipt.routes.map( ( route: { url: string } ) => route.url ) ).toContain( url + 'transient' );
		expect( readFileSync( join( root, 'website/transient/index.html' ), 'utf8' ) ).toContain( 'Content /transient' );
		expect( existsSync( join( root, 'website/empty/index.html' ) ) ).toBe( false );
		expect( receipt.excludedRoutes ).toEqual( [ url + 'missing' ] );
		expect( receipt.discoveryDiagnostics ).toContainEqual( expect.objectContaining( {
			code: 'route_capture_failed', url: url + 'empty', reason: expect.stringContaining( 'rendered document is empty' ),
		} ) );
		expect( receipt.discoveryDiagnostics ).toContainEqual( expect.objectContaining( { code: 'route_not_found', url: url + 'missing' } ) );
	} finally {
		rmSync( root, { recursive: true, force: true } );
	}
}, 180_000 );
