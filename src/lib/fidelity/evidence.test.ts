import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { pixelRegionFailures, writePixelEvidence } from './evidence.js';

const dirs: string[] = [];
afterEach( () => {
	for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } );
} );

function png( width: number, height: number, fill: [ number, number, number, number ] ): Buffer {
	const image = new PNG( { width, height } );
	for ( let i = 0; i < image.data.length; i += 4 ) {
		image.data[ i ] = fill[ 0 ]!;
		image.data[ i + 1 ] = fill[ 1 ]!;
		image.data[ i + 2 ] = fill[ 2 ]!;
		image.data[ i + 3 ] = fill[ 3 ]!;
	}
	return PNG.sync.write( image );
}

describe( 'pixel regions', () => {
	it( 'finds separate below-fold defects despite an almost identical full page and differing heights', () => {
		const source = png( 1440, 6200, [ 255, 255, 255, 255 ] );
		const candidate = PNG.sync.read( png( 1440, 6300, [ 255, 255, 255, 255 ] ) );
		for ( const [ left, top, width, height ] of [ [ 48, 1008, 96, 48 ], [ 720, 5808, 48, 96 ] ] ) {
			for ( let y = top!; y < top! + height!; y++ ) for ( let x = left!; x < left! + width!; x++ ) {
				const i = ( y * candidate.width + x ) * 4;
				candidate.data.fill( 0, i, i + 3 );
			}
		}
		expect( pixelRegionFailures( source, source ) ).toEqual( [] );
		const changed = PNG.sync.write( candidate );
		expect( pixelRegionFailures( source, changed ) ).toEqual( [
			'pixel region 48,1008 96x48 (2 tiles)',
			'pixel region 720,5808 48x96 (2 tiles)',
		] );
		const dir = mkdtempSync( join( tmpdir(), 'liberation-evidence-' ) ); dirs.push( dir );
		const result = writePixelEvidence( dir, source, changed );
		expect( 'score' in result && result.score ).toBeGreaterThan( 0.99 );
		expect( PNG.sync.read( readFileSync( join( dir, 'diff.png' ) ) ).height ).toBe( 6200 );
	} );

	it( 'ignores low contrast and sparse pixel noise', () => {
		expect( pixelRegionFailures( png( 48, 48, [ 0, 0, 0, 255 ] ), png( 48, 48, [ 40, 40, 40, 255 ] ) ) ).toEqual( [] );
	} );
} );

describe( 'writePixelEvidence', () => {
	it( 'writes the pair and a diff, and scores identical shots as 1', () => {
		const dir = mkdtempSync( join( tmpdir(), 'liberation-evidence-' ) );
		dirs.push( dir );
		const shot = png( 8, 8, [ 0, 0, 0, 255 ] );
		const result = writePixelEvidence( dir, shot, shot );
		expect( result ).toMatchObject( { score: 1 } );
		if ( 'diffPath' in result ) expect( readFileSync( result.diffPath ).length ).toBeGreaterThan( 0 );
	} );

	it( 'scores a total mismatch below 1 without throwing', () => {
		const dir = mkdtempSync( join( tmpdir(), 'liberation-evidence-' ) );
		dirs.push( dir );
		const result = writePixelEvidence(
			dir,
			png( 8, 8, [ 0, 0, 0, 255 ] ),
			png( 8, 8, [ 255, 255, 255, 255 ] )
		);
		expect( 'score' in result && result.score ).toBeLessThan( 1 );
	} );
} );
