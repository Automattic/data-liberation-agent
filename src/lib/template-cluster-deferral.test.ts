import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { rankTemplateClusterRoutes } from './route-budget.js';
import { SourceRequestGovernors } from './source-request-governor.js';
import { TemplateClusterDeferral } from './template-cluster-deferral.js';

/**
 * The browser pass admits each cluster's representative and the verifier
 * route ranking seeds beside it; members come last. The deferral check must
 * start from that same pair, or a cluster whose seeded verifier is not the
 * alphabetically first member is never checked while the browser runs.
 */
const page = ( title: string ) => `<!doctype html><html><head><title>${ title }</title></head><body>
<header class="site-header"><nav><a href="/">Home</a></nav></header>
<main class="entry"><article class="post"><h1 class="post-title">${ title }</h1><p>Shared copy.</p></article></main>
</body></html>`;

let server: Server;
let origin = '';

beforeAll( async () => {
	server = createServer( ( request, response ) => {
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( page( ( request.url ?? '/' ).split( '?' )[ 0 ]! ) );
	} );
	await new Promise< void >( resolve => server.listen( 0, resolve ) );
	origin = `http://localtest.me:${ ( server.address() as { port: number } ).port }`;
} );

afterAll( () => new Promise< void >( resolve => server.close( () => resolve() ) ) );

it.each( [ 'unavailable', 'rejected' ] )( 'releases pending members after a %s check', async outcome => {
	const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'template-deferral-failure-' ) );
	const members = [ '/', '/verifier/', '/tail/' ].map( path => origin + path );
	const group = { size: members.length, representative: members[ 0 ]!, members };
	const deferral = new TemplateClusterDeferral( { sourceUrl: origin, outputDir, governors: new SourceRequestGovernors() }, () => [ group ] );
	let release!: () => void;
	const held = new Promise< void >( resolve => { release = resolve; } );
	vi.spyOn( deferral, 'document' ).mockImplementation( async () => {
		await held;
		if ( outcome === 'rejected' ) throw new Error( 'fixture check failure' );
		return { unavailable: 'fixture document unavailable' };
	} );
	try {
		writeFileSync( join( outputDir, 'seed.html' ), page( 'seed' ) );
		for ( const url of members.slice( 0, 2 ) ) deferral.routeCaptured( url, 'seed.html' );
		expect( deferral.pending( members[ 2 ]! ) ).toBe( true );
		const check = deferral.waitForCheck();
		expect( check ).toBeInstanceOf( Promise );
		release();
		await check;
		expect( deferral.pending( members[ 2 ]! ) ).toBe( false );
		expect( deferral.defers( members[ 2 ]! ) ).toBe( false );
		expect( deferral.waitForCheck() ).toBeUndefined();
	} finally {
		release();
		await deferral.close();
		rmSync( outputDir, { recursive: true, force: true } );
	}
} );

it.each( [
	{ name: 'seeded verifier sorts after the other members', members: [ '/product/rep/', '/product/sb-030/', '/product/alpha/', '/product/beta/' ] },
	{ name: 'seeded verifier sorts first', members: [ '/product/rep/', '/product/alpha/', '/product/sb-030/', '/product/zeta/' ] },
	{ name: 'representative sorts after its verifier', members: [ '/product/zz-rep/', '/product/mid/', '/product/aa/', '/product/ab/' ] },
] )( 'checks the cluster once its ranked seeds are captured: $name', async ( { members } ) => {
	const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'template-cluster-deferral-unit-' ) );
	const urls = members.map( path => `${ origin }${ path }` );
	const group = { size: urls.length, representative: urls[ 0 ]!, members: urls };
	const deferral = new TemplateClusterDeferral( { sourceUrl: `${ origin }/`, outputDir, governors: new SourceRequestGovernors() }, () => [ group ] );
	try {
		// The browser captures what ranking admits first: the cluster's two seeds.
		const seeds = rankTemplateClusterRoutes( [ `${ origin }/`, ...urls ], `${ origin }/`, [ group ], new Set() ).slice( 1, 3 );
		const tail = urls.filter( url => ! seeds.includes( url ) );
		expect( seeds.map( url => deferral.pending( url ) ) ).toEqual( [ false, false ] );
		expect( tail.map( url => deferral.pending( url ) ) ).toEqual( [ true, true ] );
		expect( deferral.waitForCheck() ).toBeUndefined();
		for ( const [ index, url ] of seeds.entries() ) {
			const path = `html/seed-${ index }.html`;
			mkdirSync( join( outputDir, 'html' ), { recursive: true } );
			writeFileSync( join( outputDir, path ), page( new URL( url ).pathname ) );
			deferral.routeCaptured( url, path );
		}
		expect( tail.map( url => deferral.pending( url ) ) ).toEqual( [ true, true ] );
		expect( deferral.waitForCheck() ).toBeInstanceOf( Promise );
		await deferral.close();
		expect( tail.map( url => deferral.defers( url ) ) ).toEqual( [ true, true ] );
		expect( tail.map( url => deferral.pending( url ) ) ).toEqual( [ false, false ] );
		expect( deferral.waitForCheck() ).toBeUndefined();
	} finally {
		rmSync( outputDir, { recursive: true, force: true } );
	}
} );
