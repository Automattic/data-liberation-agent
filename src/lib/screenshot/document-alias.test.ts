import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';

describe.skipIf( !!process.env.SKIP_BROWSER_TESTS || !existsSync( chromium.executablePath() ) )( 'document aliases', () => {
	it( 'aliases an identical directory index, but captures a distinct index document', async () => {
		let distinct = false;
		const source = createServer( ( request, response ) => {
			if ( request.url !== '/' && request.url !== '/index.html' ) { response.writeHead( 404 ); response.end( 'Not found' ); return; }
			response.writeHead( 200, { 'content-type': 'text/html' } );
			response.end( '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><h1 id="home">' +
				( distinct && request.url === '/index.html' ? 'Different document' : 'Home' ) + '</h1><a href="/index.html#home">Home</a>' );
		} );
		await new Promise<void>( resolve => source.listen( 0, '127.0.0.1', resolve ) );
		const root = `http://127.0.0.1:${ ( source.address() as { port: number } ).port }/`;
		mkdirSync( '.tmp-test', { recursive: true } );
		const output = mkdtempSync( join( process.cwd(), '.tmp-test/document-alias-' ) );
		try {
			const results = [];
			for ( const different of [ false, true ] ) {
				distinct = different;
				const aliases: string[][] = [];
				const outputDir = join( output, String( different ) );
				const started = Date.now();
				const result = await captureScreenshots( { urls: [ root, `${root}index.html` ], primaryUrl: root, outputDir,
					concurrency: 1, settleMs: 0, learnFluid: false, deviceMode: 'reflow-only',
					viewports: [ { id: 'desktop', width: 1440, height: 900 } ], referenceWidths: [ 390 ],
					onRouteAlias: ( from, to ) => { aliases.push( [ from, to ] ); } } );
				process.stderr.write( JSON.stringify( { different, captured: result.captured, captureMs: Date.now() - started } ) + '\n' );
				const receiptPath = exportWebsiteCapture( { outputDir, sourceUrl: root, platform: 'default', summary: { routesFailed: result.failed }, failures: [] } );
				const receipt = JSON.parse( readFileSync( receiptPath, 'utf8' ) );
				results.push( { different, result, aliases, receipt, outputDir } );
			}
			for ( const { different, result, aliases, receipt, outputDir } of results ) {
				expect( result.failed ).toBe( 0 );
				expect( result.captured ).toBe( different ? 2 : 1 );
				expect( aliases ).toEqual( different ? [] : [ [ `${root}index.html`, root ] ] );
				expect( receipt.routes ).toHaveLength( different ? 2 : 1 );
				if ( !different ) expect( readFileSync( join( outputDir, receipt.routes[0].path ), 'utf8' ) ).toContain( 'href="/index.html#home"' );
			}
		} finally {
			source.closeAllConnections();
			await new Promise<void>( resolve => source.close( () => resolve() ) );
			rmSync( output, { recursive: true, force: true } );
		}
	}, 120_000 );
} );
