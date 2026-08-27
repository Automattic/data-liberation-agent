import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { checkFidelity, checkWidthsFor, resolveCheckDirectory } from './check.js';
import type { LayoutObservation } from './score.js';

const dirs: string[] = [];
afterEach( () => {
	for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } );
} );

function liberatedRun(): string {
	const dir = mkdtempSync( join( tmpdir(), 'dla-check-' ) );
	dirs.push( dir );
	mkdirSync( join( dir, 'website' ), { recursive: true } );
	writeFileSync( join( dir, 'website', 'index.html' ), '<h1>Home</h1>' );
	writeFileSync(
		join( dir, 'capture-receipt.json' ),
		JSON.stringify( { source: { url: 'https://example.com/' }, websiteRoot: 'website' } )
	);
	return dir;
}

const obs = ( viewport: number, extra: Partial< LayoutObservation > = {} ): LayoutObservation => ( {
	viewport,
	title: 'Home',
	textChars: 10,
	widestImage: viewport,
	docWidth: viewport,
	overflow: false,
	externalHosts: [],
	hashTargets: [],
	internalMissing: [],
	...extra,
} );

describe( 'resolveCheckDirectory', () => {
	it( 'accepts the run directory printed by liberation', () => {
		const run = liberatedRun();
		expect( resolveCheckDirectory( run ).websiteDir ).toBe( join( run, 'website' ) );
	} );

	it( 'accepts the website directory itself', () => {
		const run = liberatedRun();
		expect( resolveCheckDirectory( join( run, 'website' ) ).receiptPath ).toBe(
			join( run, 'capture-receipt.json' )
		);
	} );

	it( 'rejects a directory with no receipt', () => {
		const dir = mkdtempSync( join( tmpdir(), 'dla-check-' ) );
		dirs.push( dir );
		expect( () => resolveCheckDirectory( dir ) ).toThrow( /capture-receipt/ );
	} );
} );

describe( 'checkWidthsFor', () => {
	it( 'drops widths the sweep already sampled', () => {
		expect( checkWidthsFor( [ 1440, 1600, 1920 ] ) ).toEqual( [ 1728 ] );
	} );
} );

describe( 'checkFidelity', () => {
	it( 'scores injected observations at each unsampled width', async () => {
		const seen: number[] = [];
		const report = await checkFidelity( {
			directory: liberatedRun(),
			observe: async ( _source, _local, viewport ) => {
				seen.push( viewport );
				return { source: obs( viewport ), liberated: obs( viewport ) };
			},
		} );
		expect( seen ).toEqual( [ 1600, 1728 ] );
		expect( report.pass ).toBe( true );
		expect( report.sourceUrl ).toBe( 'https://example.com/' );
	} );

	it( 'fails the report when any viewport freezes', async () => {
		const report = await checkFidelity( {
			directory: liberatedRun(),
			widths: [ 1600 ],
			observe: async ( _source, _local, viewport ) => ( {
				source: obs( viewport ),
				liberated: obs( viewport, { widestImage: 1440 } ),
			} ),
		} );
		expect( report.pass ).toBe( false );
		expect( report.failed ).toBe( 1 );
	} );

	it( 'records a pixel score as evidence without letting it fail the gate', async () => {
		const black = new PNG( { width: 4, height: 4 } );
		const white = new PNG( { width: 4, height: 4 } );
		for ( let i = 0; i < black.data.length; i += 4 ) {
			black.data[ i + 3 ] = 255;
			white.data[ i ] = 255;
			white.data[ i + 1 ] = 255;
			white.data[ i + 2 ] = 255;
			white.data[ i + 3 ] = 255;
		}
		const report = await checkFidelity( {
			directory: liberatedRun(),
			widths: [ 1600 ],
			observe: async ( _source, _local, viewport ) => ( {
				source: obs( viewport ),
				liberated: obs( viewport ),
				sourcePng: PNG.sync.write( black ),
				liberatedPng: PNG.sync.write( white ),
			} ),
		} );
		expect( report.pass ).toBe( true );
		expect( report.scores[ 0 ]?.notes.join( ' ' ) ).toMatch( /evidence, not a gate/ );
	} );
} );
