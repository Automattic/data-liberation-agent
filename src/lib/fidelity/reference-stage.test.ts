import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect } from 'vitest';
import { it } from '../../../test/browser.js';
import { captureWebsite } from '../../index.js';
import type { findAdapter as FindAdapter } from '../../adapters/index.js';
import { checkFidelity } from './check.js';
import { runReferenceStage } from './reference-stage.js';
import { createReferenceCollector, type FidelityReference, type ReferenceHandoff } from './reference.js';

// Three reference cells, no capture pipeline (~5s).
it.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'replaces a retried route observation before running the deferred reference stage', async ({ serve, newPage }) => {
	mkdirSync( '.tmp-test', { recursive: true } );
	const directory = mkdtempSync( join( process.cwd(), '.tmp-test/reference-retry-' ) );
	const { origin } = await serve( ( _request, response ) => {
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main><h1>Recovered route</h1></main>' );
	} );
	const url = `${ origin }/`;
	try {
		const collector = createReferenceCollector( directory, url, [ url ], { defer: true, trustedOrigins: [ origin ] } );
		const page = await newPage();
		const profile = { id: 'desktop', width: 1440, height: 900, referenceWidths: [ 390, 768, 1440 ] };
		const browserProfile = { isMobile: false, hasTouch: false };
		await collector.observe( page, url, 'desktop', [ 'superseded capture failure' ], browserProfile, profile );
		await collector.observe( page, url, 'desktop', [], browserProfile, profile );
		const receipt = join( directory, 'capture-receipt.json' );
		writeFileSync( receipt, JSON.stringify( { source: { url }, routes: [] } ) );
		collector.finalize( receipt );

		await runReferenceStage( directory );
		const reference = JSON.parse( readFileSync( join( directory, 'fidelity-reference.json' ), 'utf8' ) ) as FidelityReference;
		expect( reference.entries.map( entry => [ entry.sourceUrl, entry.profile, entry.viewport, entry.state ] ).sort() ).toEqual(
			[ 390, 768, 1440 ].map( width => [ url, 'desktop', width, 'baseline' ] ).sort(),
		);
		expect( reference.entries.every( entry => entry.readiness.ready ) ).toBe( true );
		const handoff = JSON.parse( readFileSync( join( directory, 'reference-stage.json' ), 'utf8' ) ) as ReferenceHandoff;
		expect( handoff.jobs ).toHaveLength( 1 );
		expect( handoff.jobs[ 0 ].errors ).toEqual( [] );
	} finally {
		rmSync( directory, { recursive: true, force: true } );
	}
}, 60_000 );

// Two captures, one deferred reference stage and two compares (~60s).
it.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'defers reference cells to a resumable stage that compare accepts', async ({ serve }) => {
	mkdirSync( '.tmp-test', { recursive: true } );
	const root = mkdtempSync( join( process.cwd(), '.tmp-test/reference-stage-' ) );
	const page = ( title: string ) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ title }</title></head><body><header><nav><a href="/">Home</a> <a href="/about">About</a></nav></header><main><h1>${ title }</h1><p>Static fixture content.</p></main></body></html>`;
	const { origin } = await serve( ( request, response ) => {
		if ( request.url === '/robots.txt' ) { response.end( '' ); return; }
		if ( request.url !== '/' && request.url !== '/about' ) { response.writeHead( 404 ).end(); return; }
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( page( request.url === '/' ? 'Home' : 'About' ) );
	} );
	const url = `${ origin }/`;
	const adapter: NonNullable< ReturnType< typeof FindAdapter > > = { id: 'reference-stage-fixture', discover: async () => ( { urls: [ { url }, { url: `${ url }about` } ] } ) };
	const findAdapter = () => adapter;
	const cellKeys = ( reference: FidelityReference ) => ( reference.scope.cells ?? [] ).map( cell => `${ cell.sourceUrl } ${ cell.profile } ${ cell.viewport } ${ cell.state }` ).sort();
	try {
		const immediateDir = join( root, 'immediate' );
		const deferredDir = join( root, 'deferred' );
		const options = { url, captureImages: false, trustedOrigins: [ url ], learnFluid: false };
		await captureWebsite( { ...options, outputDir: immediateDir }, { findAdapter } );
		const started = Date.now();
		const deferred = await captureWebsite( { ...options, outputDir: deferredDir, deferReference: true }, { findAdapter } );
		process.stderr.write( `[timing] deferred capture ${ Date.now() - started }ms\n` );

		expect( deferred.reference ).toEqual( { status: 'pending' } );
		expect( existsSync( join( deferredDir, 'website/index.html' ) ) ).toBe( true );
		expect( existsSync( join( deferredDir, 'website/about/index.html' ) ) || existsSync( join( deferredDir, 'website/about.html' ) ) ).toBe( true );
		expect( existsSync( join( deferredDir, 'fidelity-reference.json' ) ) ).toBe( false );
		expect( existsSync( join( deferredDir, 'reference' ) ) ).toBe( false );
		const handoff = JSON.parse( readFileSync( join( deferredDir, 'reference-stage.json' ), 'utf8' ) ) as ReferenceHandoff;
		expect( handoff.status ).toBe( 'pending' );
		expect( handoff.entries ).toEqual( [] );
		expect( handoff.jobs.length ).toBeGreaterThan( 0 );
		expect( JSON.parse( readFileSync( deferred.captureReceiptPath, 'utf8' ) ).reference ).toEqual( { status: 'pending' } );

		const stageStarted = Date.now();
		const stage = await runReferenceStage( deferredDir, { findAdapter } );
		expect( stage.status, readFileSync( join( deferredDir, 'reference-stage.json' ), 'utf8' ) ).toBe( 'complete' );
		process.stderr.write( `[timing] reference stage ${ Date.now() - stageStarted }ms\n` );
		expect( JSON.parse( readFileSync( deferred.captureReceiptPath, 'utf8' ) ).reference ).toEqual( { status: 'complete' } );

		const immediateReference = JSON.parse( readFileSync( join( immediateDir, 'fidelity-reference.json' ), 'utf8' ) ) as FidelityReference;
		const deferredReference = JSON.parse( readFileSync( join( deferredDir, 'fidelity-reference.json' ), 'utf8' ) ) as FidelityReference;
		expect( cellKeys( deferredReference ) ).toEqual( cellKeys( immediateReference ) );
		expect( deferredReference.scope.sourceUrls.sort() ).toEqual( immediateReference.scope.sourceUrls.sort() );
		expect( deferredReference.entries.every( entry => entry.readiness.ready ) ).toBe( true );

		const [ immediateReport, deferredReport ] = [ await checkFidelity( { directory: immediateDir, settleMs: 0 } ), await checkFidelity( { directory: deferredDir, settleMs: 0 } ) ];
		expect( deferredReport.pending ).toEqual( [] );
		expect( deferredReport.pass ).toBe( true );
		expect( deferredReport.pass ).toBe( immediateReport.pass );
		expect( deferredReport.status ).toBe( immediateReport.status );
		// A completed stage is idempotent.
		expect( ( await runReferenceStage( deferredDir, { findAdapter } ) ).status ).toBe( 'complete' );
	} finally {
		rmSync( root, { recursive: true, force: true } );
	}
}, 300_000 );

it.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'compare freezes a pending reference stage before comparing', async ({ serve }) => {
	mkdirSync( '.tmp-test', { recursive: true } );
	const root = mkdtempSync( join( process.cwd(), '.tmp-test/reference-compare-' ) );
	const { origin } = await serve( ( request, response ) => {
		if ( request.url !== '/' ) { response.writeHead( 404 ).end(); return; }
		response.setHeader( 'Content-Type', 'text/html' );
		response.end( '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Home</title></head><body><main><h1>Home</h1><p>Static fixture content.</p></main></body></html>' );
	} );
	try {
		const url = `${ origin }/`;
		await captureWebsite( { url, outputDir: root, captureImages: false, trustedOrigins: [ url ], learnFluid: false, deferReference: true } );
		expect( existsSync( join( root, 'fidelity-reference.json' ) ) ).toBe( false );
		const report = await checkFidelity( { directory: root, settleMs: 0 } );
		expect( report.pending ).toEqual( [] );
		expect( JSON.parse( readFileSync( join( root, 'reference-stage.json' ), 'utf8' ) ).status ).toBe( 'complete' );
	} finally {
		rmSync( root, { recursive: true, force: true } );
	}
}, 180_000 );
