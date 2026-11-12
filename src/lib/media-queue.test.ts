import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fetching from './media-fetch/safe-fetch.js';
import { enqueueMedia, readMediaQueue, runMediaQueue } from './media-queue.js';

const PNG = Buffer.from( [ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3 ] );
const response = ( url: string, status: number, headers: Record< string, string > = {}, body = PNG ) =>
	( { status, finalUrl: url, headers: new Headers( headers ), body } );

let outputDir: string;
beforeEach( () => {
	outputDir = mkdtempSync( join( tmpdir(), 'media-queue-' ) );
	mkdirSync( join( outputDir, 'website' ) );
	writeFileSync( join( outputDir, 'capture-receipt.json' ), JSON.stringify( { discoveryDiagnostics: [ { code: 'route_template_derived', url: 'https://source.example/a' } ] } ) );
} );
afterEach( () => { vi.restoreAllMocks(); rmSync( outputDir, { recursive: true, force: true } ); } );

describe( 'media queue job', () => {
	it.each( [
		{ name: '429 with Retry-After, then 200', url: 'https://cdn.example/a/photo.png', responses: [ [ 429, { 'retry-after': '7' } ], [ 200, { 'content-type': 'image/png' } ] ], status: 'done', waits: [ 7000 ], requests: 2 },
		{ name: 'persistent 500', url: 'https://cdn.example/a/broken.png', responses: [ [ 500, {} ] ], status: 'failed', waits: [ 1000, 2000 ], requests: 3 },
		{ name: 'extensionless URL takes its extension from the content type', url: 'https://cdn.example/img/AVvXsE=s0', responses: [ [ 200, { 'content-type': 'image/png' } ] ], status: 'done', waits: [], requests: 1 },
	] as const )( '$name', async ( { url, responses, status, waits, requests } ) => {
		enqueueMedia( outputDir, [ url ] );
		const provisional = readMediaQueue( outputDir ).entries[ 0 ]!.path;
		writeFileSync( join( outputDir, 'website', 'index.html' ), `<img src="/${ provisional }">` );
		let call = 0;
		const fetch = vi.spyOn( fetching, 'safeFetch' ).mockImplementation( async requested => {
			const [ code, headers ] = responses[ Math.min( call++, responses.length - 1 ) ]!;
			return response( String( requested ), code, headers );
		} );
		const sleep = vi.fn( async ( _ms: number ) => {} );
		const report = await runMediaQueue( outputDir, { maxAttempts: 3, sleep } );

		expect( fetch ).toHaveBeenCalledTimes( requests );
		expect( fetch.mock.calls[ 0 ]![ 1 ] ).toMatchObject( { category: 'asset-original' } );
		expect( fetch.mock.calls[ 0 ]![ 1 ]!.governors ).toBeDefined();
		expect( sleep.mock.calls.map( ( [ ms ] ) => ms ) ).toEqual( waits );
		const [ entry ] = readMediaQueue( outputDir ).entries;
		expect( entry ).toMatchObject( { url, status, attempts: requests } );
		const receipt = JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) );
		expect( receipt.discoveryDiagnostics[ 0 ].code ).toBe( 'route_template_derived' );
		if ( status === 'done' ) {
			expect( entry!.path ).toMatch( /\.png$/ );
			expect( readFileSync( join( outputDir, entry!.path ) ) ).toEqual( PNG );
			expect( readFileSync( join( outputDir, 'website', entry!.path ) ) ).toEqual( PNG );
			expect( readFileSync( join( outputDir, 'website', 'index.html' ), 'utf8' ) ).toBe( `<img src="/${ entry!.path }">` );
			expect( report ).toMatchObject( { done: 1, failed: 0, failures: [] } );
		} else {
			expect( existsSync( join( outputDir, entry!.path ) ) ).toBe( false );
			expect( report.failures ).toEqual( [ { url, status: 500, reason: 'HTTP 500' } ] );
			expect( receipt.media ).toMatchObject( { total: 1, failed: 1, failures: report.failures } );
			expect( receipt.discoveryDiagnostics ).toContainEqual( { code: 'media_download_failed', url, reason: 'HTTP 500', unit: 'asset', severity: 'error', metrics: { status: 500 } } );
		}
	} );

	it( 'resumes after an interruption without downloading completed files again', async () => {
		const urls = [ 1, 2, 3 ].map( i => `https://cdn.example/p/${ i }.png` );
		// Renditions of one original share its file.
		enqueueMedia( outputDir, [ ...urls, 'https://cdn.example/p/1-small.png' ], url => url.endsWith( '-small.png' ) ? url.replace( '-small', '' ) : undefined );
		const controller = new AbortController();
		const first = vi.spyOn( fetching, 'safeFetch' ).mockImplementation( async url => {
			if ( String( url ).endsWith( '/2.png' ) ) { controller.abort(); throw new Error( 'aborted' ); }
			return response( String( url ), 200, { 'content-type': 'image/png' } );
		} );
		await runMediaQueue( outputDir, { concurrencyPerOrigin: 1, signal: controller.signal } );
		expect( first.mock.calls.map( ( [ url ] ) => String( url ) ) ).toEqual( [ urls[ 0 ], urls[ 1 ] ] );
		expect( readMediaQueue( outputDir ).entries.map( entry => entry.status ) ).toEqual( [ 'done', 'pending', 'pending', 'done' ] );
		first.mockRestore();

		const second = vi.spyOn( fetching, 'safeFetch' ).mockImplementation( async url => response( String( url ), 200, { 'content-type': 'image/png' } ) );
		const report = await runMediaQueue( outputDir );
		expect( second.mock.calls.map( ( [ url ] ) => String( url ) ).sort() ).toEqual( [ urls[ 1 ], urls[ 2 ] ] );
		expect( report ).toMatchObject( { total: 4, done: 4, pending: 0, failed: 0, downloaded: 2 } );
	} );
} );
