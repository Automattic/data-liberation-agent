import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { deriveTemplateClusterMembers } from './capture.js';
import { SourceRequestGovernors } from './source-request-governor.js';
import { templateFingerprint, TEMPLATE_GROUPING_LIMITS, TEMPLATE_GROUPS_SCHEMA } from './template-groups.js';

// Template-cluster derivation shares the capture's source request governor (#1685). No browser (~2s).
describe( 'template cluster derivation under source throttling', () => {
	const page = ( path: string ) => `<html><head><title>Fixture</title></head><body><article id="post"><h1>${ path }</h1><p>Complete post content.</p></article></body></html>`;

	async function derive( respond: ( path: string, attempt: number ) => { status: number; headers?: Record< string, string > } ) {
		const parent = join( process.cwd(), '.tmp-test' );
		mkdirSync( parent, { recursive: true } );
		const outputDir = mkdtempSync( join( parent, 'cluster-governor-' ) );
		mkdirSync( join( outputDir, 'screenshots' ) );
		const attempts = new Map< string, number >();
		const server = createServer( ( req, res ) => {
			const path = new URL( req.url!, 'http://localhost' ).pathname;
			const attempt = ( attempts.get( path ) ?? 0 ) + 1;
			attempts.set( path, attempt );
			const { status, headers } = respond( path, attempt );
			res.writeHead( status, { 'content-type': 'text/html', ...headers } );
			res.end( status === 200 ? page( path ) : 'Too Many Requests' );
		} );
		await new Promise< void >( done => server.listen( 0, '127.0.0.1', done ) );
		const origin = `http://localtest.me:${ ( server.address() as import('node:net').AddressInfo ).port }`;
		const urls = [ 'representative', 'verification', 'member-a', 'member-b' ].map( slug => `${ origin }/${ slug }/` );
		const entries = Object.fromEntries( urls.slice( 0, 2 ).map( ( url, i ) => {
			writeFileSync( join( outputDir, `screenshots/${ i }.html` ), page( new URL( url ).pathname ) );
			return [ url, { slug: `post-${ i }`, html: `screenshots/${ i }.html`, capturedAt: new Date().toISOString() } ];
		} ) );
		writeFileSync( join( outputDir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries } ) );
		const governors = new SourceRequestGovernors();
		try {
			const result = await deriveTemplateClusterMembers( {
				sourceUrl: urls[ 0 ]!, outputDir, frontierUrls: [], governors,
				report: {
					schema: TEMPLATE_GROUPS_SCHEMA, sourceUrl: urls[ 0 ]!, fingerprint: { version: 1, maxSkeletonDepth: 8 },
					limits: { ...TEMPLATE_GROUPING_LIMITS }, throttle: { events: 0 }, unfingerprinted: [],
					coverage: { routes: 4, fingerprinted: 4, unfingerprinted: 0, groups: 1, singletons: 0 },
					groups: [ { id: 't1', ...templateFingerprint( page( '/representative/' ), urls[ 0 ]! ), representative: urls[ 0 ]!, size: 4, members: urls } ],
				},
			} );
			return { result, urls, attempts, governor: governors.forOrigin( origin ) };
		} finally {
			await new Promise< void >( done => server.close( () => done() ) );
			rmSync( outputDir, { recursive: true, force: true } );
		}
	}

	it( 'retries a throttled representative and member, then derives the cluster', async () => {
		const { result, urls, attempts, governor } = await derive( ( _path, attempt ) => attempt === 1 ? { status: 429, headers: { 'retry-after': '0' } } : { status: 200 } );
		expect( result.summary ).toMatchObject( { derived: 2, escalated: 0, unavailable: 0 } );
		expect( result.receipt.clusters[ 0 ]!.derived.map( member => member.url ) ).toEqual( urls.slice( 2 ) );
		for ( const path of [ '/representative/', '/verification/', '/member-a/', '/member-b/' ] ) expect( attempts.get( path ) ).toBeGreaterThanOrEqual( 2 );
		// The run's own governor paced every throttle, attributed to derivation.
		expect( governor.throttleEvents ).toBe( 4 );
		expect( governor.attribution().totals ).toMatchObject( { 'unattributed/template-clusters not_routed': expect.any( Number ) } );
	}, 30_000 );

	it( 'lets verification Retry-After outlast the per-attempt timeout without losing the cluster', async () => {
		const { result, attempts } = await derive( ( path, attempt ) => path === '/verification/' && attempt === 1
			? { status: 429, headers: { 'retry-after': '16' } }
			: { status: 200 } );
		expect( attempts.get( '/verification/' ) ).toBeGreaterThanOrEqual( 2 );
		expect( result.summary ).toMatchObject( { derived: 2, escalated: 0, unavailable: 0 } );
	}, 30_000 );

	it( 'reports a representative the source keeps refusing as source-unavailable, not a template gate', async () => {
		const { result, urls } = await derive( path => path === '/representative/' ? { status: 404 } : { status: 200 } );
		const cluster = result.receipt.clusters[ 0 ]!;
		expect( result.summary ).toMatchObject( { derived: 0, escalated: 0, unavailable: 2 } );
		expect( cluster.escalated ).toEqual( [] );
		expect( cluster.unavailable ).toEqual( urls.slice( 2 ).map( url => ( { url, reason: expect.stringContaining( 'source unavailable: representative HTTP 404' ) } ) ) );
		expect( result.diagnostics.some( diagnostic => /slot_anchor_unmapped/.test( diagnostic.reason ) ) ).toBe( false );
	}, 30_000 );
} );
