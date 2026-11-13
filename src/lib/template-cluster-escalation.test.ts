import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { deriveTemplateClusterMembers } from './capture.js';
import * as fetching from './media-fetch/safe-fetch.js';
import { SourceRequestGovernors } from './source-request-governor.js';
import { templateFingerprint, TEMPLATE_GROUPING_LIMITS, TEMPLATE_GROUPS_SCHEMA } from './template-groups.js';

describe( 'failed template cluster HTTP fallback', () => {
	it.each( [ 'gate', 'comparison', 'missing' ] )( 'acquires every uncaptured member after %s verification failure', async failure => {
		const parent = join( process.cwd(), '.tmp-test' );
		mkdirSync( parent, { recursive: true } );
		const outputDir = mkdtempSync( join( parent, 'cluster-escalation-' ) );
		mkdirSync( join( outputDir, 'screenshots' ) );
		const urls = [ 'representative', 'verification', 'member-a', 'member-b' ].map( slug => `https://fixture.example/${ slug }/` );
		const page = ( url: string ) => `<html><head><title>Fixture</title></head><body><article id="post"><h1>${ new URL( url ).pathname }</h1><p>Complete post content.</p></article></body></html>`;
		const captured = failure === 'missing' ? urls.slice( 0, 1 ) : urls.slice( 0, 2 );
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
			const gate = failure === 'missing' ? 'cluster_verification_missing' : failure === 'comparison' ? 'cluster_verification_mismatch' : 'slot_anchor_unmapped';
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
} );
