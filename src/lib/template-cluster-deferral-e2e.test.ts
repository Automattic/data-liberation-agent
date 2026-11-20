import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { RouteTimeBudget } from './capture-time-budget.js';
import { captureWebsite } from './capture.js';

/**
 * #784: browser capture cost scales with templates, not pages. A neutral
 * site (no adapter content model, no flags) whose article pages share one
 * template at different route depths, authored with `<base href="/">` and
 * relative assets, plus pages of their own templates. The browser opens the
 * article template's representative and verification member only; every
 * other article derives from them, its relative slot media resolved against
 * the authored base.
 */
const articles = [ '/', '/archive/', '/journal/first/', '/journal/2024/second/', '/journal/2024/05/third/' ];
const singletons = [ '/about/', '/contact/', '/studio/', '/press/', '/careers/' ];
// Other templates are slow to serve, so the article verification member is
// on disk well before the browser reaches the remaining articles.
const SLOW_MS = 3_000;

const PIXEL = Buffer.from( 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64' );
const imageName = ( title: string ) => `${ title.replace( /[^a-z0-9]+/gi, '-' ).replace( /^-|-$/g, '' ) || 'home' }.png`;

const page = ( title: string, style = '' ) => `<!doctype html><html><head><base href="/"><title>${ title }</title><link rel="stylesheet" href="site.css">${ style }</head><body>
<header class="site-header"><nav class="menu"><a href="./">Home</a></nav></header>
<main class="entry"><article class="post"><h1 class="post-title">${ title }</h1><div class="copy"><img class="lead" src="media/${ imageName( title ) }" alt="${ title }"><p>Text of ${ title }.</p><p>More of ${ title }.</p></div></article></main>
<footer class="site-footer"><p>(c) Fixture</p></footer></body></html>`;

let server: Server;
let origin = '';

beforeAll( async () => {
	server = createServer( ( request, response ) => {
		const path = ( request.url ?? '/' ).split( '?' )[ 0 ]!;
		if ( path === '/site.css' ) { response.setHeader( 'Content-Type', 'text/css' ); response.end( 'body{margin:0;font:14px system-ui}.copy{max-width:40em}' ); return; }
		if ( /^\/media\/[a-z0-9-]+\.png$/.test( path ) ) { response.setHeader( 'Content-Type', 'image/png' ); response.end( PIXEL ); return; }
		const singleton = singletons.indexOf( path );
		if ( ! articles.includes( path ) && singleton < 0 ) { response.statusCode = 404; response.end( 'not found' ); return; }
		response.setHeader( 'Content-Type', 'text/html' );
		if ( singleton < 0 ) { response.end( page( path === '/' ? 'Home' : path ) ); return; }
		setTimeout( () => response.end( page( path, `<style>.post{border-top:${ singleton + 1 }px solid}</style>` ) ), SLOW_MS );
	} );
	await new Promise< void >( resolve => server.listen( 0, resolve ) );
	origin = `http://localtest.me:${ ( server.address() as { port: number } ).port }`;
} );

afterAll( () => new Promise< void >( resolve => server.close( () => resolve() ) ) );

it( 'opens one browser page per template plus its verification member and derives the other members (#784)', async () => {
	const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'template-cluster-deferral-' ) );
	const started = new Set< string >();
	const start = RouteTimeBudget.prototype.start;
	const startSpy = vi.spyOn( RouteTimeBudget.prototype, 'start' ).mockImplementation( function ( this: RouteTimeBudget, url ) {
		started.add( url ); start.call( this, url );
	} );
	try {
		const result = await captureWebsite( { url: `${ origin }/`, outputDir, timeBudgetMs: 600_000 }, {
			findAdapter: () => ( { id: 'neutral', detect: () => true, discover: async () => ( { urls: [ ...articles.slice( 1 ), ...singletons ].map( path => ( { url: `${ origin }${ path }`, type: 'page' } ) ) } ) } ),
		} );
		const receipt = JSON.parse( readFileSync( result.captureReceiptPath, 'utf8' ) );
		expect( receipt.templateClustersDecision ).toEqual( { enabled: true, source: 'default' } );
		const clusters = JSON.parse( readFileSync( join( outputDir, 'template-clusters.json' ), 'utf8' ) ).clusters;
		const cluster = clusters.find( ( cluster: { representative: string } ) => cluster.representative === `${ origin }/` );
		expect( cluster.verification ).toMatchObject( { url: `${ origin }/archive/`, captured: true, equal: true } );
		expect( articles.filter( path => started.has( `${ origin }${ path }` ) ) ).toEqual( [ '/', '/archive/' ] );
		for ( const path of singletons ) expect( started.has( `${ origin }${ path }` ) ).toBe( true );
		expect( cluster.derived.map( ( member: { url: string } ) => new URL( member.url ).pathname ).sort() ).toEqual( articles.slice( 2 ).sort() );
		expect( result.summary ).toMatchObject( { routesCaptured: articles.length + singletons.length, routesDerived: 3, routesOmitted: 0, routesFailed: 0 } );
		// Derived members' slot media resolves against `<base href="/">`, not the member's depth.
		const media = ( JSON.parse( readFileSync( join( outputDir, 'media-queue.json' ), 'utf8' ) ).entries as Array< { url: string } > ).map( entry => entry.url );
		for ( const path of articles.slice( 2 ) ) {
			expect( existsSync( join( outputDir, 'website', path, 'index.html' ) ) ).toBe( true );
			expect( media ).toContain( `${ origin }/media/${ imageName( path ) }` );
		}
		expect( media.filter( url => url.includes( '/journal/' ) ) ).toEqual( [] );
	} finally {
		startSpy.mockRestore();
		rmSync( outputDir, { recursive: true, force: true } );
	}
}, 240_000 );
