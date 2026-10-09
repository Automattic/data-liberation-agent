import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { captureScreenshots } from './screenshotter.js';

// Run in a real constrained runtime, not with invented available-memory values:
// docker run --memory=2g --cpus=4 ... npx vitest run <this file> --maxWorkers=1
it.skipIf( ! process.env.DLA_MEMORY_ADMISSION_REGRESSION ).each( [ 'inventory', 'linked-waves' ] )( 'admits %s routes with their live reference pages inside the runtime budget', async ( mode ) => {
	expect( process.constrainedMemory() ).toBe( 2 * 1024 ** 3 );
	const server = createServer( ( request, response ) => {
		const route = Number( request.url?.match( /^\/route-(\d)$/ )?.[ 1 ] );
		const children = mode === 'linked-waves' && route < 3 ? [ 2 * route + 1, 2 * route + 2 ] : [];
		const links = children.map( index => `<a href="/route-${ index }">Route ${ index }</a>` ).join( '' );
		response.writeHead( 200, { 'Content-Type': 'text/html' } );
		response.end( `<!doctype html><html><head><title>Neutral memory fixture</title></head><body>
			<h1>${ request.url }</h1><img width="32" height="32" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' fill='red'/%3E%3C/svg%3E">
			<div style="height:2000px">Preserved geometry and text</div>${ links }
			<script>globalThis.retained = new Uint8Array(192 * 1024 * 1024); for(let i=0;i<retained.length;i+=4096)retained[i]=1;</script>
			</body></html>` );
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'memory-admission-' ) );
	const urls = Array.from( { length: 7 }, ( _, index ) => `${ origin }/route-${ index }` );
	let active = 0;
	let peak = 0;
	const references: string[] = [];
	try {
		const result = await captureScreenshots( {
			urls: mode === 'linked-waves' ? urls.slice( 0, 1 ) : urls,
			outputDir, force: true, settleMs: 0, learnFluid: false,
			...( mode === 'linked-waves' ? { linkedPages: { maxPages: 7, maxDepth: 2, timeoutMs: 120_000 }, browserRestartEvery: 2 } : {} ),
			viewports: [ { id: 'desktop', width: 1440, height: 900 } ],
			prepareCapture: async () => { peak = Math.max( peak, ++active ); },
			observeSource: async ( page, url ) => {
				const reference = await page.context().newPage();
				try {
					await reference.goto( url );
					await reference.waitForTimeout( 300 );
					expect( await reference.locator( 'h1' ).textContent() ).toBe( new URL( url ).pathname );
					expect( await reference.locator( 'img' ).evaluate( ( image: HTMLImageElement ) => image.complete && image.naturalWidth > 0 ) ).toBe( true );
					expect( await reference.locator( 'div' ).evaluate( element => element.getBoundingClientRect().height ) ).toBe( 2000 );
					references.push( url );
				} finally { await reference.close(); active--; }
			},
		} );
		console.log( JSON.stringify( { event: 'neutral-memory-regression', mode, result, peakActiveRoutes: peak, references: references.length } ) );
		expect( result.captured ).toBe( 7 );
		expect( result.failed ).toBe( 0 );
		expect( references.sort() ).toEqual( [ ...urls ].sort() );
		expect( peak ).toBeLessThanOrEqual( 2 );
		if ( mode === 'linked-waves' ) {
			expect( result.urls ).toEqual( urls );
			expect( result.browserRestarts ).toBe( 3 );
			expect( result.linkedPageCoverage?.requiredUrls ).toEqual( urls );
			expect( result.linkedPageCoverage?.diagnostics ).toEqual( [] );
		}
		for ( let index = 0; index < urls.length; index++ ) {
			expect( readFileSync( join( outputDir, 'html', `route-${ index }.html` ), 'utf8' ) ).toContain( 'Preserved geometry and text' );
		}
	} finally {
		await new Promise<void>( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 600_000 );
