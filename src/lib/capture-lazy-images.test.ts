import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { expect, it } from 'vitest';
import { captureWebsite } from './capture.js';
import { readResolvedPage } from './site-includes.js';

// One browser capture for all four reductions in #1710 (about 30 seconds).
it( 'localizes relative, protocol-relative and absolute lazy image candidates', async () => {
	const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
	const rows = [
		{ id: 'relative', attributes: `data-src="${ gif }"`, candidate: () => 'relative.svg' },
		{ id: 'protocol-missing', attributes: `data-src="${ gif }"`, candidate: ( origin: string ) => `${ origin.replace( /^http:/, '' ) }/protocol-missing.svg` },
		{ id: 'protocol-placeholder', attributes: `src="${ gif }"`, candidate: ( origin: string ) => `${ origin.replace( /^http:/, '' ) }/protocol-placeholder.svg` },
		{ id: 'absolute', attributes: `src="${ gif }"`, candidate: ( origin: string ) => `${ origin }/absolute.svg` },
	];
	const server = createServer( ( request, response ) => {
		if ( request.url?.endsWith( '.svg' ) ) {
			response.setHeader( 'Content-Type', 'image/svg+xml' );
			response.end( `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text y="30">${ request.url }</text></svg>` );
			return;
		}
		if ( request.url !== '/' ) { response.statusCode = 404; response.end(); return; }
		const origin = `http://${ request.headers.host }`;
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( `<!doctype html><html><body><h1>Lazy images</h1><div style="height:3000px"></div>${ rows.map( row => `<img id="${ row.id }" width="100" height="100" ${ row.attributes } data-srcset="${ row.candidate( origin ) } 1920w">` ).join( '' ) }</body></html>` );
	} );
	await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
	mkdirSync( '.tmp-test', { recursive: true } );
	const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'lazy-images-' ) );
	try {
		const result = await captureWebsite( { url, outputDir, trustedOrigins: [ url ], learnFluid: false }, {
			findAdapter: () => ( { id: 'fixture', discover: async () => ( { urls: [ { url } ] } ) } ),
		} );
		expect( result.summary.routesFailed ).toBe( 0 );
		const website = join( outputDir, 'website' );
		const $ = cheerio.load( readResolvedPage( website, join( website, 'index.html' ) ) );
		for ( const row of rows ) {
			const images = $( `#${ row.id }` );
			expect( images.length, row.id ).toBeGreaterThan( 0 );
			images.each( ( _, image ) => {
				const src = $( image ).attr( 'src' );
				expect( src, row.id ).toMatch( /^\/media\// );
				expect( existsSync( join( website, src! ) ), row.id ).toBe( true );
			} );
		}
	} finally {
		server.closeAllConnections();
		await new Promise< void >( resolve => server.close( () => resolve() ) );
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 180_000 );
