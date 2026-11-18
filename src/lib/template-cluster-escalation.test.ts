import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { connectBrowser, createSourceContext } from './browser-kit/index.js';
import { describe, expect, it, vi } from 'vitest';
import { deriveTemplateClusterMembers } from './capture.js';
import * as fetching from './media-fetch/safe-fetch.js';
import { SourceRequestGovernors } from './source-request-governor.js';
import { templateFingerprint, TEMPLATE_GROUPING_LIMITS, TEMPLATE_GROUPS_SCHEMA } from './template-groups.js';

describe( 'failed template cluster HTTP fallback', () => {
	// One Chromium pass, no full route capture/fluid sweep (~3s).
	it( 'renders runtime-gated members with their own fill, but acquires structural failures over HTTP', async () => {
		const parent = join( process.cwd(), '.tmp-test' );
		mkdirSync( parent, { recursive: true } );
		const outputDir = mkdtempSync( join( parent, 'runtime-escalation-' ) );
		mkdirSync( join( outputDir, 'screenshots' ) );
		const requests: string[] = [];
		const page = ( id: string ) => `<!doctype html><html><head><title>Product</title><script>
		addEventListener('DOMContentLoaded', async () => {
		 const mount = document.querySelector('x-recs');
		 mount.innerHTML = await (await fetch('/recs?id=' + mount.dataset.productId)).text();
		});</script></head><body><article id="product"><h1>${ id }</h1><x-recs data-product-id="${ id === 'verification' ? 'representative' : id }"></x-recs></article></body></html>`;
		const server = createServer( ( req, res ) => {
			requests.push( req.url! );
			const url = new URL( req.url!, 'http://localhost' );
			res.setHeader( 'content-type', url.pathname === '/recs' ? 'text/plain' : 'text/html' );
			res.end( url.pathname === '/recs' ? `<p>Recommendations for ${ url.searchParams.get( 'id' ) }</p>` : url.pathname === '/structural' ? '<html><body><aside>Structural HTTP content</aside></body></html>' : page( url.pathname.slice( 1 ) ) );
		} );
		await new Promise< void >( done => server.listen( 0, '127.0.0.1', done ) );
		const origin = `http://localtest.me:${ ( server.address() as import('node:net').AddressInfo ).port }`;
		const urls = [ 'representative', 'verification', 'member-a', 'member-b', 'structural' ].map( id => `${ origin }/${ id }` );
		// The profile's preparation must survive: the live DOM never carries this marker.
		const prepared = ( id: string ) => page( id ).replace( '<title>Product</title>', '<title>Product</title><meta name="prepared">' );
		const browser = await connectBrowser( {} );
		try {
			const governors = new SourceRequestGovernors();
			const context = await createSourceContext( browser, {}, { governors, sourceUrl: origin } );
			const tab = await context.newPage();
			const entries: Record< string, unknown > = {};
			for ( const [ i, url ] of urls.slice( 0, 2 ).entries() ) {
				await tab.goto( url );
				await tab.waitForSelector( 'x-recs p' );
				writeFileSync( join( outputDir, `screenshots/${ i }.html` ), await tab.content() );
				entries[ url ] = { slug: `product-${ i }`, html: `screenshots/${ i }.html`, capturedAt: new Date().toISOString() };
			}
			await context.close();
			writeFileSync( join( outputDir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries } ) );
			const input: Parameters< typeof deriveTemplateClusterMembers >[ 0 ] = {
				sourceUrl: urls[ 0 ]!, outputDir, frontierUrls: [], governors,
				acquisition: { id: 'neutral-server', variants: [ { id: 'desktop' } ], prepare: ( html: string ) => ( { html: html.replace( '<title>Product</title>', '<title>Product</title><meta name="prepared">' ) } ) },
				report: {
					schema: TEMPLATE_GROUPS_SCHEMA, sourceUrl: urls[ 0 ]!, fingerprint: { version: 1, maxSkeletonDepth: 8 },
					limits: { ...TEMPLATE_GROUPING_LIMITS }, throttle: { events: 0 }, unfingerprinted: [],
					coverage: { routes: 5, fingerprinted: 5, unfingerprinted: 0, groups: 1, singletons: 0 },
					groups: [ { id: 't1', ...templateFingerprint( page( 'representative' ), urls[ 0 ]! ), representative: urls[ 0 ]!, size: 5, members: urls } ],
				},
			};
			// The late derivation rounds spend their whole 1ms budget; renders keep their own.
			const result = await deriveTemplateClusterMembers( { ...input, timeBudgetMs: 1, runtimeRenderBudgetMs: 20_000 } );
			expect( result.summary.httpAcquired ).toBe( 3 );
			const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots/manifest.json' ), 'utf8' ) );
			for ( const url of urls.slice( 2, 4 ) ) {
				const id = new URL( url ).pathname.slice( 1 );
				// Only the mount carries the live render; the rest is the prepared HTTP document.
				const shipped = readFileSync( join( outputDir, manifest.entries[ url ].html ), 'utf8' );
				expect( shipped ).toBe( prepared( id ).replace( `<x-recs data-product-id="${ id }"></x-recs>`, `<x-recs data-product-id="${ id }"><p>Recommendations for ${ id }</p></x-recs>` ) );
				expect( requests ).toContain( `/recs?id=${ id }` );
				expect( result.receipt.clusters[ 0 ]!.escalated ).toContainEqual( expect.objectContaining( { url, gate: 'runtime_mount_member_keyed', fallback: { acquired: true, reason: 'runtime mount observed through bounded browser render' } } ) );
			}
			expect( readFileSync( join( outputDir, manifest.entries[ urls[ 4 ]! ].html ), 'utf8' ) ).toContain( 'Structural HTTP content' );
			expect( requests ).not.toContain( '/recs?id=structural' );
			expect( result.receipt.clusters[ 0 ]!.escalated ).toContainEqual( expect.objectContaining( { url: urls[ 4 ], gate: 'cluster_key_mismatch', fallback: { acquired: true } } ) );

			// A spent budget preserves HTTP, but explicitly names the unobserved mount.
			writeFileSync( join( outputDir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries } ) );
			const exhausted = await deriveTemplateClusterMembers( { ...input, timeBudgetMs: 1, runtimeRenderBudgetMs: 1 } );
			const row = exhausted.receipt.clusters[ 0 ]!.escalated.find( member => member.url === urls[ 2 ] )!;
			expect( row.fallback?.reason ).toContain( 'unobserved runtime mount: runtime-filled mount at' );
			expect( exhausted.diagnostics ).toContainEqual( expect.objectContaining( { url: urls[ 2 ], reason: expect.stringContaining( row.fallback!.reason! ) } ) );
		} finally {
			await browser.close();
			await new Promise< void >( done => server.close( () => done() ) );
			rmSync( outputDir, { recursive: true, force: true } );
		}
	}, 30_000 );

	it.each( [ 'gate', 'comparison', 'missing', 'representative' ] )( 'acquires every uncaptured member after %s verification failure', async failure => {
		const parent = join( process.cwd(), '.tmp-test' );
		mkdirSync( parent, { recursive: true } );
		const outputDir = mkdtempSync( join( parent, 'cluster-escalation-' ) );
		mkdirSync( join( outputDir, 'screenshots' ) );
		const urls = [ 'representative', 'verification', 'member-a', 'member-b' ].map( slug => `https://fixture.example/${ slug }/` );
		const page = ( url: string ) => `<html><head><title>Fixture</title></head><body><article id="post"><h1>${ new URL( url ).pathname }</h1><p>Complete post content.</p></article></body></html>`;
		// `representative`: its capture failed, so the captured member stands in (#1868).
		const captured = failure === 'missing' ? urls.slice( 0, 1 ) : failure === 'representative' ? urls.slice( 1, 2 ) : urls.slice( 0, 2 );
		const entries = Object.fromEntries( captured.map( ( url, i ) => {
			// No mapped article anchor is left in the representative, or the
			// verification capture has different text from its server document.
			const html = failure === 'gate' && i === 0 ? '<html><body><aside>Runtime replaced the article</aside></body></html>'
				: failure === 'comparison' && i === 1 ? page( url ).replace( 'Complete post content.', 'Changed during capture.' ) : page( url );
			writeFileSync( join( outputDir, `screenshots/${ i }.html` ), html );
			return [ url, { slug: `post-${ i }`, html: `screenshots/${ i }.html`, capturedAt: new Date().toISOString() } ];
		} ) );
		writeFileSync( join( outputDir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries } ) );
		const fetch = vi.spyOn( fetching, 'safeFetch' ).mockImplementation( async url => ( {
			body: Buffer.from( page( String( url ) ) ), status: 200, finalUrl: String( url ), headers: new Headers( { 'content-type': 'text/html' } ),
		} ) );
		try {
			const result = await deriveTemplateClusterMembers( {
				sourceUrl: urls[ 0 ]!, outputDir, frontierUrls: [], governors: new SourceRequestGovernors(),
				acquisition: { id: 'neutral-server', variants: [ { id: 'desktop' } ], prepare: html => ( { html } ) },
				report: {
					schema: TEMPLATE_GROUPS_SCHEMA, sourceUrl: urls[ 0 ]!, fingerprint: { version: 1, maxSkeletonDepth: 8 },
					limits: { ...TEMPLATE_GROUPING_LIMITS }, throttle: { events: 0 }, unfingerprinted: [],
					coverage: { routes: 4, fingerprinted: 4, unfingerprinted: 0, groups: 1, singletons: 0 },
					groups: [ { id: 't1', ...templateFingerprint( page( urls[ 0 ]! ), urls[ 0 ]! ), representative: urls[ 0 ]!, size: 4, members: urls } ],
				},
			} );
			const omitted = urls.filter( url => ! captured.includes( url ) ).sort( ( a, b ) => a.localeCompare( b ) );
			expect( result.summary ).toMatchObject( { derived: 0, escalated: omitted.length, httpAcquired: omitted.length, unavailable: 0 } );
			expect( result.summary.httpAcquiredUrls ).toEqual( omitted );
			const gate = failure === 'missing' || failure === 'representative' ? 'cluster_verification_missing' : failure === 'comparison' ? 'cluster_verification_mismatch' : 'slot_anchor_unmapped';
			expect( result.receipt.clusters[ 0 ]!.escalated ).toEqual( omitted.map( url => expect.objectContaining( { url, gate, fallback: { acquired: true } } ) ) );
			const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots/manifest.json' ), 'utf8' ) );
			for ( const url of omitted ) {
				expect( manifest.entries[ url ].html ).toMatch( /^screenshots\/http\// );
				expect( readFileSync( join( outputDir, manifest.entries[ url ].html ), 'utf8' ) ).toContain( 'Complete post content.' );
			}
			expect( JSON.parse( readFileSync( join( outputDir, 'template-fallback/http-acquisition.json' ), 'utf8' ) ) ).toBeTruthy();
		} finally {
			fetch.mockRestore();
			rmSync( outputDir, { recursive: true, force: true } );
		}
	} );

	it( 'derives each member from every document the representative ships (#1814)', async () => {
		const parent = join( process.cwd(), '.tmp-test' );
		mkdirSync( parent, { recursive: true } );
		const outputDir = mkdtempSync( join( parent, 'cluster-documents-' ) );
		mkdirSync( join( outputDir, 'screenshots' ) );
		const urls = [ 'representative', 'verification', 'member' ].map( slug => `https://fixture.example/${ slug }/` );
		const page = ( url: string, layout = '' ) => `<html><head><title>Fixture</title></head><body><nav>${ layout }</nav><article id="post"><h1>${ new URL( url ).pathname }</h1><p>Complete post content.</p></article></body></html>`;
		const layouts = { desktop: '', mobile: 'phone', middle: 'tablet' } as const;
		const document = ( i: number, key: keyof typeof layouts ) => {
			writeFileSync( join( outputDir, `screenshots/${ i }.${ key }.html` ), page( urls[ i ]!, layouts[ key ] ) );
			return `screenshots/${ i }.${ key }.html`;
		};
		const profile = { viewport: { width: 1440, height: 900 } };
		const entries = {
			[ urls[ 0 ]! ]: { slug: 'post-0', html: document( 0, 'desktop' ), mobileHtml: document( 0, 'mobile' ), capturedAt: new Date().toISOString(), profiles: Object.fromEntries( ( [ 'desktop', 'mobile', 'middle' ] as const ).map( key => [ key, { ...profile, html: document( 0, key ) } ] ) ) },
			[ urls[ 1 ]! ]: { slug: 'post-1', html: document( 1, 'desktop' ), capturedAt: new Date().toISOString() },
		};
		writeFileSync( join( outputDir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries } ) );
		const fetch = vi.spyOn( fetching, 'safeFetch' ).mockImplementation( async url => ( {
			body: Buffer.from( page( String( url ) ) ), status: 200, finalUrl: String( url ), headers: new Headers( { 'content-type': 'text/html' } ),
		} ) );
		try {
			const result = await deriveTemplateClusterMembers( {
				sourceUrl: urls[ 0 ]!, outputDir, frontierUrls: [], governors: new SourceRequestGovernors(),
				report: {
					schema: TEMPLATE_GROUPS_SCHEMA, sourceUrl: urls[ 0 ]!, fingerprint: { version: 1, maxSkeletonDepth: 8 },
					limits: { ...TEMPLATE_GROUPING_LIMITS }, throttle: { events: 0 }, unfingerprinted: [],
					coverage: { routes: 3, fingerprinted: 3, unfingerprinted: 0, groups: 1, singletons: 0 },
					groups: [ { id: 't1', ...templateFingerprint( page( urls[ 0 ]! ), urls[ 0 ]! ), representative: urls[ 0 ]!, size: 3, members: urls } ],
				},
			} );
			expect( result.summary ).toMatchObject( { derived: 1, escalated: 0 } );
			const member = JSON.parse( readFileSync( join( outputDir, 'screenshots/manifest.json' ), 'utf8' ) ).entries[ urls[ 2 ]! ];
			const shipped = Object.fromEntries( Object.entries( member.profiles as Record< string, { html: string } > ).map( ( [ key, { html } ] ) => [ key, readFileSync( join( outputDir, html ), 'utf8' ) ] ) );
			expect( shipped ).toEqual( { desktop: page( urls[ 2 ]!, layouts.desktop ), mobile: page( urls[ 2 ]!, layouts.mobile ), middle: page( urls[ 2 ]!, layouts.middle ) } );
		} finally {
			fetch.mockRestore();
			rmSync( outputDir, { recursive: true, force: true } );
		}
	} );
} );
