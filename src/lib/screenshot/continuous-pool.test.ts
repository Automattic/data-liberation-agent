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
		expect( starts.get( '/child' ) ).toBeGreaterThanOrEqual( finishes.get( '/fast-a' )! );
		expect( starts.get( '/child' ) ).toBeLessThan( finishes.get( '/slow' )! );
	} finally {
		await new Promise<void>( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 90_000 );

// One browser pass, approximately 10 seconds. The entrypoint holds its fluid
// phase until a successor is requested, so a pool that waits for the whole
// entry route only admits that successor after the hold times out.
it.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'admits successors once the entrypoint has published its rendered links', async () => {
	const starts = new Map<string, number>();
	const finishes = new Map<string, number>();
	const order: string[] = [];
	let successorRequested: () => void = () => {};
	const requested = new Promise<void>( resolve => { successorRequested = resolve; } );
	const grouped = vi.fn( async () => {
		expect( order ).toEqual( [] );
		return [];
	} );
	const server = createServer( ( request, response ) => {
		const path = request.url ?? '/';
		if ( ! [ '/', '/a', '/b', '/c' ].includes( path ) ) {
			response.writeHead( 404 ).end( 'Not found' );
			return;
		}
		if ( ! starts.has( path ) ) {
			starts.set( path, Date.now() );
			if ( path !== '/' ) { order.push( path ); successorRequested(); }
		}
		const links = path === '/' ? [ '/a', '/b', '/c' ] : [];
		response.setHeader( 'content-type', 'text/html' );
		// Runtime links are absent from the server document's anchor tree.
		response.end( `<!doctype html><title>Entry fixture</title><main><h1>${ path }</h1></main><script>for (const href of ${ JSON.stringify( links ) }) { const a = document.createElement('a'); a.href = href; a.textContent = href; document.querySelector('main').append(a); }</script>` );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'entry-admission-' ) );
	try {
		const result = await captureScreenshots( {
			urls: [ origin + '/' ], primaryUrl: origin + '/', outputDir,
			concurrency: 2, settleMs: 0, learnFluid: true, fluidWidths: [ 1440, 1200 ], sharedChrome: false,
			viewports: [ { id: 'desktop', width: 1440, height: 900 } ],
			linkedPages: { maxPages: 8, maxDepth: 2, timeoutMs: 60_000 },
			groupLinkedRoutes: grouped,
			// Descending: pending order is the ranking, not discovery order.
			prioritizePendingRoutes: urls => [ ...urls ].sort().reverse(),
			beforeFluid: async ( _page, { url } ) => {
				if ( new URL( url ).pathname === '/' ) await Promise.race( [ requested, new Promise( resolve => setTimeout( resolve, 8_000 ) ) ] );
			},
			onProgress: ( _completed, _total, url ) => finishes.set( new URL( url ).pathname, Date.now() ),
		} );
		expect( result.captured ).toBe( 4 );
		expect( grouped ).toHaveBeenCalledWith( [ origin + '/a', origin + '/b', origin + '/c' ] );
		expect( starts.get( '/c' ) ).toBeLessThan( finishes.get( '/' )! );
		expect( order ).toEqual( [ '/c', '/b', '/a' ] );
	} finally {
		await new Promise<void>( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 60_000 );
