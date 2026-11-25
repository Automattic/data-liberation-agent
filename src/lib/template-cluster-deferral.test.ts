import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { rankTemplateClusterRoutes } from './route-budget.js';
import { SourceRequestGovernors } from './source-request-governor.js';
import { TemplateClusterDeferral } from './template-cluster-deferral.js';
import { INTERACTION_STATES_SCHEMA, type InteractionStatesReport } from './screenshot/interaction-capture.js';

/**
 * The browser pass admits each cluster's representative and the verifier
 * route ranking seeds beside it; members come last. The deferral check must
 * start from that same pair, or a cluster whose seeded verifier is not the
 * alphabetically first member is never checked while the browser runs.
 */
const page = ( title: string ) => `<!doctype html><html><head><title>${ title }</title></head><body>
<header class="site-header"><nav><a href="/">Home</a></nav><button class="menu-toggle" type="button" aria-haspopup="true">Menu</button></header>
<main class="entry"><article class="post"><h1 class="post-title">${ title }</h1><p>Shared copy.</p><button class="gallery-next" type="button">Next</button></article></main>
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

/** A content gallery state, which the tail's own markup does not carry. */
const galleryState: InteractionStatesReport = {
	schema: INTERACTION_STATES_SCHEMA, sourceUrl: origin, viewport: { width: 1440, height: 900 }, capturedAt: '2026-01-01T00:00:00.000Z',
	states: [ { status: 'captured', kind: 'gallery', trigger: { selector: 'main .gallery-next', tag: 'button', label: 'Next', ariaHaspopup: '', dataBindings: {} } } ],
};

it( 'verifies an interactive cluster from light renders and renders the members it keeps in browser capture (#2232)', async () => {
	const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'template-deferral-interactive-render-' ) );
	const views = new Map( [ [ '/', 3 ], [ '/verifier/', 5 ], [ '/tail/', 4 ] ] );
	const members = [ ...views.keys() ].map( path => origin + path );
	const group = { size: members.length, representative: members[ 0 ]!, members };
	// The runtime pads the server's gallery counter: `1 / 3` is served, `01 / 03` rendered.
	const counter = ( url: string, source: 'server' | 'rendered' ) => {
		const count = views.get( new URL( url ).pathname )!;
		const text = source === 'server' ? `1 / ${ count }` : `01 / 0${ count }`;
		return page( 'Product' ).replace( '<p>Shared copy.</p>', `<p>Shared copy.</p><span class="count">${ text }</span>` );
	};
	const deferral = new TemplateClusterDeferral( { sourceUrl: origin, outputDir, governors: new SourceRequestGovernors() }, () => [ group ] );
	const document = vi.spyOn( deferral, 'document' ).mockImplementation( async ( url, source ) => ( { html: counter( url, source ) } ) );
	try {
		for ( const [ index, url ] of members.slice( 0, 2 ).entries() ) {
			writeFileSync( join( outputDir, `seed-${ index }.html` ), counter( url, 'rendered' ) );
			deferral.routeCaptured( url, `seed-${ index }.html`, index === 0 ? galleryState : undefined );
		}
		await deferral.waitForCheck();
		expect( deferral.pending( members[ 2 ]! ) ).toBe( false );
		expect( deferral.defers( members[ 2 ]! ) ).toBe( false );
		await deferral.close();
		// Post-capture derivation finds the tail's light render if the browser budget omits it.
		expect( document ).toHaveBeenCalledWith( members[ 2 ], 'rendered' );
	} finally {
		await deferral.close();
		rmSync( outputDir, { recursive: true, force: true } );
	}
} );

/** Content gallery states in each post's body, which `chromeInteractionStates` does not carry. */
const contentState = ( label: string ) => ( {
	status: 'captured' as const, kind: 'gallery' as const,
	trigger: { selector: 'main .gallery-next', tag: 'button', ariaHaspopup: '', label, dataBindings: {} },
} );
const report = ( url: string, labels: string[] ): InteractionStatesReport => ( { schema: INTERACTION_STATES_SCHEMA, sourceUrl: url, viewport: { width: 1440, height: 900 }, capturedAt: new Date().toISOString(), states: labels.map( contentState ) } );

it.each( [
	{ name: 'defers members when the projected content states match the verifier', verifierStates: [ 'Next' ], deferred: true },
	{ name: 'keeps browser capture when the verifier captured another state', verifierStates: [ 'Next', 'Share' ], deferred: false },
] )( '$name', async ( { verifierStates, deferred } ) => {
	const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'template-deferral-interactions-' ) );
	const urls = [ '/post/rep/', '/post/alpha/', '/post/beta/', '/post/gamma/' ].map( path => origin + path );
	const group = { size: urls.length, representative: urls[ 0 ]!, members: urls };
	const deferral = new TemplateClusterDeferral( { sourceUrl: `${ origin }/`, outputDir, governors: new SourceRequestGovernors() }, () => [ group ] );
	try {
		const seeds = rankTemplateClusterRoutes( [ `${ origin }/`, ...urls ], `${ origin }/`, [ group ], new Set() ).slice( 1, 3 );
		mkdirSync( join( outputDir, 'html' ), { recursive: true } );
		for ( const [ index, url ] of seeds.entries() ) {
			writeFileSync( join( outputDir, `html/seed-${ index }.html` ), page( new URL( url ).pathname ) );
			deferral.routeCaptured( url, `html/seed-${ index }.html`, report( url, url === group.representative ? [ 'Next' ] : verifierStates ) );
		}
		await deferral.close();
		const tail = urls.filter( url => ! seeds.includes( url ) );
		expect( tail.map( url => deferral.defers( url ) ) ).toEqual( tail.map( () => deferred ) );
		expect( tail.map( url => deferral.pending( url ) ) ).toEqual( tail.map( () => false ) );
	} finally {
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

// A deferred member skips the browser, so the check applies the adapter's
// derivation contract that post-capture derivation will: a declared runtime
// island the representative's capture cannot map fails closed in both.
it.each( [
	{ name: 'without a declared island', contract: {}, deferred: true },
	{ name: 'with a declared island the capture cannot map', contract: { runtimeWidgetSelectors: [ '.gallery-next' ] }, deferred: false },
] )( 'derives under the adapter contract $name', async ( { contract, deferred } ) => {
	const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
	const outputDir = mkdtempSync( join( parent, 'template-deferral-contract-' ) );
	const urls = [ '/post/rep/', '/post/alpha/', '/post/beta/', '/post/gamma/' ].map( path => origin + path );
	const group = { size: urls.length, representative: urls[ 0 ]!, members: urls };
	const deferral = new TemplateClusterDeferral( { sourceUrl: `${ origin }/`, outputDir, governors: new SourceRequestGovernors(), ...contract }, () => [ group ] );
	try {
		const seeds = rankTemplateClusterRoutes( [ `${ origin }/`, ...urls ], `${ origin }/`, [ group ], new Set() ).slice( 1, 3 );
		mkdirSync( join( outputDir, 'html' ), { recursive: true } );
		for ( const [ index, url ] of seeds.entries() ) {
			writeFileSync( join( outputDir, `html/seed-${ index }.html` ), page( new URL( url ).pathname ).replace( '<button class="gallery-next" type="button">Next</button>', '' ) );
			deferral.routeCaptured( url, `html/seed-${ index }.html` );
		}
		await deferral.close();
		const tail = urls.filter( url => ! seeds.includes( url ) );
		expect( tail.map( url => deferral.defers( url ) ) ).toEqual( tail.map( () => deferred ) );
	} finally {
		rmSync( outputDir, { recursive: true, force: true } );
	}
} );
