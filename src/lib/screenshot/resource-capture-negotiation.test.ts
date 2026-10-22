import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportWebsiteCapture } from '../capture-export.js';
import { BROWSER_IMAGE_ACCEPT } from '../media-fetch/media.js';
import type { SafeFetchOpts } from '../media-fetch/safe-fetch.js';
import { CapturedResourceStore, resourceRequestHeaders } from './resource-capture.js';

// The negotiation server listens on loopback, which safeFetch's SSRF guard
// rightly refuses to fetch directly. The proxy fetch below is substituted
// AFTER safeFetch has validated the public test origin and assembled its
// request headers, so the request that reaches the local server carries
// exactly the headers resource-capture chose — Accept included — and the
// stored bytes are whatever that server negotiated for them.
const negotiationServer = vi.hoisted( () => ( { address: '' } ) );

vi.mock( '../media-fetch/safe-fetch.js', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import( '../media-fetch/safe-fetch.js' ) >();
	return {
		...actual,
		safeFetch: ( url: string, opts?: SafeFetchOpts ) =>
			actual.safeFetch( url, {
				...opts,
				fetchImpl: ( input, init ) =>
					fetch(
						String( input ).replace( /^https:\/\/cdn\.example\//, negotiationServer.address ),
						init
					),
			} ),
	};
} );

const pngBytes = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=',
	'base64'
);
const webpBytes = Buffer.concat( [
	Buffer.from( 'RIFF' ),
	Buffer.from( [ 0x24, 0, 0, 0 ] ),
	Buffer.from( 'WEBPVP8L negotiated webp fixture bytes' ),
] );
const cssBody = 'body{color:#333}';

interface ServedRequest {
	url: string;
	accept: string;
}

const served: ServedRequest[] = [];
let server: Server;
const dirs: string[] = [];

beforeAll( async () => {
	server = createServer( ( request, response ) => {
		const accept = String( request.headers.accept ?? '' );
		served.push( { url: request.url ?? '', accept } );
		if ( ( request.url ?? '' ).startsWith( '/css/' ) ) {
			response.writeHead( 200, { 'content-type': 'text/css' } );
			response.end( cssBody );
			return;
		}
		// A format=auto image CDN: the legacy PNG for a client that does not
		// negotiate, WebP for one whose Accept includes it.
		if ( accept.includes( 'image/webp' ) ) {
			response.writeHead( 200, { 'content-type': 'image/webp' } );
			response.end( webpBytes );
		} else {
			response.writeHead( 200, { 'content-type': 'image/png' } );
			response.end( pngBytes );
		}
	} );
	await new Promise< void >( ( ready ) => server.listen( 0, '127.0.0.1', ready ) );
	negotiationServer.address = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
} );

afterAll( async () => {
	await new Promise< void >( ( closed ) => server.close( () => closed() ) );
	server.closeAllConnections?.();
} );

afterEach( () => {
	served.length = 0;
	for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } );
} );

function stageRoute( sourceUrl: string, html: string ): string {
	const outputDir = mkdtempSync( join( tmpdir(), 'liberation-negotiation-' ) );
	dirs.push( outputDir );
	mkdirSync( join( outputDir, 'html' ) );
	mkdirSync( join( outputDir, 'screenshots' ) );
	writeFileSync( join( outputDir, 'html', 'home.html' ), html );
	writeFileSync(
		join( outputDir, 'screenshots', 'manifest.json' ),
		JSON.stringify( { version: 1, entries: { [ sourceUrl ]: { html: 'html/home.html' } } } )
	);
	return outputDir;
}

function readManifest( outputDir: string ): {
	resources: Record< string, { path: string; contentType: string } >;
} {
	return JSON.parse( readFileSync( join( outputDir, 'resources', 'manifest.json' ), 'utf8' ) );
}

describe( 'CapturedResourceStore direct fetch negotiation', () => {
	it( 'negotiates like the browser for a srcset candidate and stores the served format', async () => {
		const sourceUrl = 'https://example.com/';
		const photo = 'https://cdn.example/img/photo.png';
		// The browser never loads this srcset candidate at the captured
		// viewport, so only the direct fetch in captureUrl can bring it in.
		const outputDir = stageRoute(
			sourceUrl,
			`<html><body><img srcset="${ photo } 2800w" sizes="100vw" alt=""></body></html>`
		);

		const store = new CapturedResourceStore( outputDir, sourceUrl );
		await store.captureDomDependencies(
			readFileSync( join( outputDir, 'html', 'home.html' ), 'utf8' ),
			sourceUrl
		);
		await store.flush();

		// The direct fetch reached the CDN with the browser image Accept header…
		expect( served ).toEqual( [ { url: '/img/photo.png', accept: BROWSER_IMAGE_ACCEPT } ] );
		// …so the CDN's WebP was stored — under the served format's name, not
		// the URL's .png — and the manifest keys it to the referenced url.
		const entry = readManifest( outputDir ).resources[ photo ];
		expect( entry.contentType ).toBe( 'image/webp' );
		expect( entry.path ).toMatch( /img\/photo\.webp$/ );
		expect( readFileSync( join( outputDir, entry.path ) ) ).toEqual( webpBytes );

		// The portable copy references the same consistently-named bytes.
		exportWebsiteCapture( { outputDir, sourceUrl, platform: 'generic', summary: { routesFailed: 0 }, failures: [] } );
		const $ = cheerio.load( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) );
		const local = ( $( 'img' ).attr( 'srcset' ) ?? '' ).replace( /\s+2800w$/, '' );
		expect( local ).toMatch( /^\/.*img\/photo\.webp$/ );
		expect( readFileSync( join( outputDir, 'website', decodeURIComponent( local ) ) ) ).toEqual(
			webpBytes
		);
	} );

	it( 'keeps the image Accept header off a stylesheet candidate fetch', async () => {
		const sourceUrl = 'https://example.com/';
		const sheet = 'https://cdn.example/css/theme.css';
		const outputDir = stageRoute(
			sourceUrl,
			`<html><head><link rel="stylesheet" href="${ sheet }"></head><body><h1>Home</h1></body></html>`
		);

		const store = new CapturedResourceStore( outputDir, sourceUrl );
		await store.captureDomDependencies(
			readFileSync( join( outputDir, 'html', 'home.html' ), 'utf8' ),
			sourceUrl
		);
		await store.flush();

		// No Accept override (undici's own default only): a negotiation-happy
		// server must not be able to turn a stylesheet into an image.
		expect( served ).toEqual( [ { url: '/css/theme.css', accept: expect.not.stringMatching( /image\// ) } ] );
		const entry = readManifest( outputDir ).resources[ sheet ];
		expect( entry ).toEqual( {
			path: expect.stringMatching( /external\/[0-9a-f]{16}\/css\/theme\.css$/ ),
			contentType: 'text/css',
		} );
		expect( readFileSync( join( outputDir, entry.path ), 'utf8' ) ).toBe( cssBody );
	} );

	it( 'classifies Accept negotiation from the url alone', () => {
		// Media extensions negotiate; stylesheet/font extensions do not; an
		// extension-less url may be a stylesheet (`/css2?family=…`), so it
		// does not either.
		expect( resourceRequestHeaders( 'https://cdn.example/img/photo.png' ) ).toEqual( {
			accept: BROWSER_IMAGE_ACCEPT,
		} );
		expect( resourceRequestHeaders( 'https://cdn.example/fonts/main.woff2' ) ).toBeUndefined();
		expect( resourceRequestHeaders( 'https://cdn.example/render?style=main' ) ).toBeUndefined();
	} );
} );
