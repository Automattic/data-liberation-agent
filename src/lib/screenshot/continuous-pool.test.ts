import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it, vi } from 'vitest';
import { captureScreenshots } from './screenshotter.js';

// One browser pass, approximately 20 seconds. The slow response keeps one slot
// occupied while the other must expand and capture the fast branch.
it.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'expands finished grouped routes without draining the pool', async () => {
	const starts = new Map<string, number>();
	const finishes = new Map<string, number>();
	const grouped = vi.fn( async ( urls: string[] ) => {
		for ( const url of urls ) expect( starts.has( new URL( url ).pathname ) ).toBe( false );
		return [];
	} );
	const server = createServer( ( request, response ) => {
		const path = request.url ?? '/';
		if ( ! starts.has( path ) ) starts.set( path, Date.now() );
		if ( ! [ '/', '/slow', '/fast-a', '/fast-b', '/child' ].includes( path ) ) {
			response.writeHead( 404 ).end( 'Not found' );
			return;
		}
		const links = path === '/' ? [ '/slow', '/fast-a', '/fast-b' ] : path === '/fast-a' ? [ '/child' ] : [];
		const send = () => {
			response.setHeader( 'content-type', 'text/html' );
			response.end( `<!doctype html><title>Pool fixture</title><main><h1>${ path }</h1>${ links.map( href => `<a href="${ href }">${ href }</a>` ).join( '' ) }</main>` );
		};
		if ( path === '/slow' ) setTimeout( send, 12_000 );
		else send();
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'continuous-pool-' ) );
	try {
		const result = await captureScreenshots( {
			urls: [ origin + '/' ], primaryUrl: origin + '/', outputDir,
			concurrency: 2, settleMs: 0, learnFluid: false, sharedChrome: true,
			viewports: [ { id: 'desktop', width: 1440, height: 900 } ],
			linkedPages: { maxPages: 8, maxDepth: 3, timeoutMs: 90_000 },
			groupLinkedRoutes: grouped, prioritizePendingRoutes: urls => urls,
			onProgress: ( _completed, _total, url ) => finishes.set( new URL( url ).pathname, Date.now() ),
		} );
		expect( result.captured ).toBe( 5 );
		// A lazy, one-route inventory must establish chrome before admitting
		// successors, without turning their continuous pool back into waves.
		expect( result.sharedChrome?.profiles.desktop.status ).toBe( 'captured' );
		expect( result.sharedChrome?.routes.probedInPlace ).not.toContainEqual(
			expect.objectContaining( { reason: expect.stringContaining( 'not probed' ) } ),
		);
		expect( grouped ).toHaveBeenCalledWith( [ origin + '/child' ] );
		expect( starts.get( '/slow' ) ).toBeGreaterThanOrEqual( finishes.get( '/' )! );
		expect( starts.get( '/child' ) ).toBeGreaterThanOrEqual( finishes.get( '/fast-a' )! );
		expect( starts.get( '/child' ) ).toBeLessThan( finishes.get( '/slow' )! );
	} finally {
		await new Promise<void>( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 90_000 );
