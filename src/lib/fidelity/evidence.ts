// src/lib/fidelity/evidence.ts
//
// Optional PNG pair + diff for a human looking at a compare failure.
// The pixel score is never a pass/fail input — that is how 0.98 blessed the freeze.
//
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export interface PixelEvidence {
	score: number;
	sourcePath: string;
	liberatedPath: string;
	diffPath: string;
}

export function writePixelEvidence(
	directory: string,
	sourcePng: Buffer,
	liberatedPng: Buffer
): PixelEvidence | { error: string } {
	mkdirSync( directory, { recursive: true } );
	const sourcePath = join( directory, 'source.png' );
	const liberatedPath = join( directory, 'liberated.png' );
	const diffPath = join( directory, 'diff.png' );
	writeFileSync( sourcePath, sourcePng );
	writeFileSync( liberatedPath, liberatedPng );

	const source = PNG.sync.read( sourcePng );
	const liberated = PNG.sync.read( liberatedPng );
	// Preserve full originals; the diff and score describe their overlapping area.
	const width = Math.min( source.width, liberated.width );
	const height = Math.min( source.height, liberated.height );
	const crop = ( image: PNG ): Buffer => {
		const bytes = Buffer.alloc( width * height * 4 );
		for ( let y = 0; y < height; y++ ) image.data.copy( bytes, y * width * 4, y * image.width * 4, ( y * image.width + width ) * 4 );
		return bytes;
	};

	const diff = new PNG( { width, height } );
	const diffPixels = pixelmatch(
		crop( source ),
		crop( liberated ),
		diff.data,
		width,
		height,
		{ threshold: 0.1 }
	);
	writeFileSync( diffPath, PNG.sync.write( diff ) );
	const score = 1 - diffPixels / ( width * height );
	return { score, sourcePath, liberatedPath, diffPath };
}

/** Four-connected 48px tiles; small paint noise never becomes a blocker. */
export function pixelRegionFailures( sourcePng: Buffer, candidatePng: Buffer ): string[] {
	const source = PNG.sync.read( sourcePng ), candidate = PNG.sync.read( candidatePng );
	const width = Math.min( source.width, candidate.width ), height = Math.min( source.height, candidate.height );
	const size = 48, columns = Math.ceil( width / size ), rows = Math.ceil( height / size );
	const mismatched = new Set<number>();
	for ( let ty = 0; ty < rows; ty++ ) for ( let tx = 0; tx < columns; tx++ ) {
		let changed = 0, total = 0;
		for ( let y = ty * size; y < Math.min( height, ( ty + 1 ) * size ); y++ ) {
			for ( let x = tx * size; x < Math.min( width, ( tx + 1 ) * size ); x++ ) {
				const a = ( y * source.width + x ) * 4, b = ( y * candidate.width + x ) * 4;
				const luminance = ( data: Buffer, i: number ) => ( 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]! ) * data[i + 3]! / 255 + 255 - data[i + 3]!;
				if ( Math.abs( luminance( source.data, a ) - luminance( candidate.data, b ) ) > 40 ) changed++;
				total++;
			}
		}
		if ( changed / total > 0.1 ) mismatched.add( ty * columns + tx );
	}
	const failures: string[] = [];
	for ( const seed of mismatched ) {
		const queue = [ seed ];
		mismatched.delete( seed );
		let minX = width, minY = height, maxX = 0, maxY = 0;
		for ( let index = 0; index < queue.length; index++ ) {
			const tile = queue[index]!, x = tile % columns, y = Math.floor( tile / columns );
			minX = Math.min( minX, x * size ); minY = Math.min( minY, y * size );
			maxX = Math.max( maxX, Math.min( width, ( x + 1 ) * size ) ); maxY = Math.max( maxY, Math.min( height, ( y + 1 ) * size ) );
			for ( const [ nx, ny ] of [ [ x - 1, y ], [ x + 1, y ], [ x, y - 1 ], [ x, y + 1 ] ] ) {
				if ( nx! < 0 || nx! >= columns || ny! < 0 || ny! >= rows ) continue;
				const next = ny! * columns + nx!;
				if ( mismatched.delete( next ) ) queue.push( next );
			}
		}
		failures.push( `pixel region ${ minX },${ minY } ${ maxX - minX }x${ maxY - minY } (${ queue.length } tiles)` );
	}
	return failures;
}
