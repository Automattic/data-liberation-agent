// src/lib/fidelity/evidence.ts
//
// Optional PNG pair + diff for a human looking at a compare failure.
// The pixel score is never a pass/fail input — that is how 0.98 blessed the freeze.
//
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Page } from 'playwright';

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

interface PixelTile { x: number; y: number; width: number; height: number }
interface PixelRegion { bounds: PixelTile; tiles: PixelTile[] }

/** Four-connected 48px tiles; small paint noise never becomes a blocker. */
function pixelRegions( sourcePng: Buffer, candidatePng: Buffer ): PixelRegion[] {
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
	const regions: PixelRegion[] = [];
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
		regions.push( { bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY }, tiles: queue.map( tile => {
			const x = tile % columns * size, y = Math.floor( tile / columns ) * size;
			return { x, y, width: Math.min( size, width - x ), height: Math.min( size, height - y ) };
		} ) } );
	}
	return regions;
}

function regionFailure( region: PixelRegion, descriptor = 'page' ): string {
	const { x, y, width, height } = region.bounds;
	return `pixel region ${ x },${ y } ${ width }x${ height } (${ region.tiles.length } tiles) in ${ descriptor }`;
}

/** Without a candidate DOM, attribution is explicitly page-level. */
export function pixelRegionFailures( sourcePng: Buffer, candidatePng: Buffer ): string[] {
	return pixelRegions( sourcePng, candidatePng ).map( region => regionFailure( region ) );
}

/** Attribute full-page screenshot tiles without scrolling or changing the candidate. */
export async function attributedPixelRegionFailures( page: Page, sourcePng: Buffer, candidatePng: Buffer ): Promise<string[]> {
	const regions = pixelRegions( sourcePng, candidatePng );
	if ( ! regions.length ) return [];
	const descriptors = await page.evaluate( ( { regions, screenshotWidth } ) => {
		// Full-page evidence is normalized to the emulated screen width, which
		// can differ from CSS pixels on pages with a source-selected viewport.
		const scale = screenshotWidth / ( window.visualViewport?.width ?? innerWidth );
		// DOM order visits parents before children. Retain the deepest containing
		// element, not a viewport hit-test (most tiles can be below the fold).
		const elements = [ ...document.querySelectorAll( 'body, body *' ) ].map( element => {
			const rect = element.getBoundingClientRect();
			let depth = 0;
			for ( let parent = element.parentElement; parent; parent = parent.parentElement ) depth++;
			return { element, depth, x: ( rect.left + scrollX ) * scale, y: ( rect.top + scrollY ) * scale, width: rect.width * scale, height: rect.height * scale };
		} ).filter( item => item.width > 0 && item.height > 0 && getComputedStyle( item.element ).visibility !== 'hidden' );
		return regions.map( region => {
			let common: Element | null = null;
			for ( const tile of region.tiles ) {
				let owner: Element = document.body, depth = -1;
				for ( const item of elements ) {
					if ( item.depth > depth && item.x <= tile.x && item.y <= tile.y && item.x + item.width >= tile.x + tile.width && item.y + item.height >= tile.y + tile.height ) {
						owner = item.element; depth = item.depth;
					}
				}
				if ( ! common ) common = owner;
				else while ( common && ! common.contains( owner ) ) common = common.parentElement;
			}
			if ( ! common || common === document.body || common === document.documentElement ) return 'page';
			for ( let ancestor: Element | null = common; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement ) {
				// Layout state classes (`wp-block-group-is-layout-flex`) name a variant, not the block.
				const block = [ ...ancestor.classList ].find( token => /^wp-block-[a-z0-9]+(?:-[a-z0-9]+)*$/.test( token ) && ! token.includes( '-is-layout-' ) );
				if ( block ) return `core/${ block.slice( 'wp-block-'.length ) }`;
			}
			return common.tagName.toLowerCase();
		} );
	}, { regions, screenshotWidth: page.viewportSize()!.width } );
	return regions.map( ( region, index ) => regionFailure( region, descriptors[ index ] ) );
}
