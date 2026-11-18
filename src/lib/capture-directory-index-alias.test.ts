import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureWebsite } from './capture.js';
import { readResolvedPage } from './site-includes.js';

const skipBrowser = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );

// Issue #2022: a static site serves its homepage at both `/` and `/index.html`,
// declares `/index.html` canonical, and links its navigation to
// `/index.html#home`. A head script runs only at `/`, so the two captures of
// the one document differ by capture node ids. Both addresses are one route,
// and every page's header links to it the same way.
const header = '<header><a href="/index.html#home">Home</a> <a href="/about.html">About</a></header>';
const page = ( title: string, canonical: string ) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${ title }</title>
<link rel="canonical" href="${ canonical }"><script>if(location.pathname==='/')document.head.appendChild(document.createElement('meta')).name='entry-hint';</script><style>body{margin:0;font:16px sans-serif}header{padding:16px;background:#123}header a{color:#fff}main{padding:16px;min-height:400px}</style></head>
<body>${ header }<main id="home"><h1>${ title }</h1><p>${ title } body copy.</p></main><footer><p>Neutral footer</p></footer></body></html>`;

it.skipIf( skipBrowser )( 'exports a homepage served at / and /index.html as one route with identical header links', async () => {
	const parent = join( process.cwd(), '.tmp-test' );
	mkdirSync( parent, { recursive: true } );
	const root = mkdtempSync( join( parent, 'issue-2022-' ) );
	const server = createServer( ( request, response ) => {
		const path = ( request.url ?? '/' ).split( '?' )[ 0 ];
		if ( path === '/robots.txt' ) { response.end( '' ); return; }
		response.setHeader( 'Content-Type', 'text/html' );
		if ( path === '/' || path === '/index.html' ) { response.end( page( 'Home', '/index.html' ) ); return; }
		if ( path === '/about.html' ) { response.end( page( 'About', '/about.html' ) ); return; }
		response.statusCode = 404;
		response.end( 'not found' );
	} );
	await new Promise< void >( resolve => server.listen( 0, resolve ) );
	const url = `http://localtest.me:${ ( server.address() as { port: number } ).port }/`;
	try {
		const outputDir = join( root, 'capture' );
		const captured = await captureWebsite( { url, outputDir } );
		expect( captured.summary.routesFailed ).toBe( 0 );
		const website = join( outputDir, 'website' );
		const pages = readdirSync( website ).filter( name => name.endsWith( '.html' ) ).sort();
		expect( pages, 'one home route' ).toEqual( [ 'about.html', 'index.html' ] );

		const links = ( file: string ) => cheerio.load( readResolvedPage( website, join( website, file ) ) )( 'header a' ).toArray().map( element => element.attribs.href );
		const homeLinks = links( 'index.html' );
		expect( homeLinks.some( href => /index-\d+\.html/.test( href ) ) ).toBe( false );
		expect( links( 'about.html' ) ).toEqual( homeLinks );
		const receipt = JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) ) as {
			routes: Array< { url: string; path: string } >; duplicateRoutes: Array< { url: string; canonicalUrl: string; path: string } >;
		};
		expect( receipt.routes.map( ( { path } ) => path ) ).toEqual( [ 'website/index.html', 'website/about.html' ] );
		expect( receipt.duplicateRoutes ).toEqual( [ { url: `${ url }index.html`, canonicalUrl: url, path: 'website/index.html' } ] );
	} finally {
		await new Promise< void >( resolve => server.close( () => resolve() ) );
		rmSync( root, { recursive: true, force: true } );
	}
}, 240_000 );
