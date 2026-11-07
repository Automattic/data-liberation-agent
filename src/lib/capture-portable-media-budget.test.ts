import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { exportWebsiteCapture } from './capture-export.js';
import { MediaStubStore } from './resume-state/media-stubs.js';

it.each( [
	{ name: 'aggregate budget', width: 1600, height: 1600, raster: false, byteLimited: false, budget: 1000 },
	{ name: 'dimension ceiling', width: 4032, height: 3024, raster: true, byteLimited: false, budget: 1024 * 1024 },
	{ name: 'byte ceiling', width: 1600, height: 1600, raster: true, byteLimited: true, budget: 10000 },
] )( 'reserves displayed renditions above the $name and reports unavoidable blanking', ( { width, height, raster, byteLimited, budget } ) => {
	mkdirSync( '.tmp-test', { recursive: true } );
	const directory = mkdtempSync( join( process.cwd(), '.tmp-test/media-budget-' ) );
	const source = 'https://photos.example/';
	try {
		for ( const name of [ 'html', 'screenshots', 'resources' ] ) mkdirSync( join( directory, name ) );
		const stubs = MediaStubStore.load( directory );
		const resources: Record<string, { path: string; contentType: string }> = {};
		const images = Array.from( { length: 4 }, ( _, index ) => {
			const extension = raster ? 'png' : 'svg';
			const contentType = raster ? 'image/png' : 'image/svg+xml';
			const originalUrl = `${ source }original-${ index }.${ extension }`;
			const displayedUrl = `${ source }displayed-${ index }.${ extension }`;
			const svg = ( size: number, padding: number ) => `<svg xmlns="http://www.w3.org/2000/svg" width="${ size }" height="${ size }"><!--${ String( index ).repeat( padding ) }--><rect width="100%" height="100%" fill="red"/></svg>`;
			const png = ( w: number, h: number ) => {
				const image = new PNG( { width: w, height: h } );
				for ( let offset = 0; offset < image.data.length; offset += 4 ) {
					image.data[ offset ] = 100 + index;
					image.data[ offset + 3 ] = 255;
				}
				return PNG.sync.write( image );
			};
			const original = raster ? Buffer.concat( [ png( width, height ), Buffer.alloc( byteLimited ? 6 * 1024 * 1024 : 0 ) ] ) : Buffer.from( svg( width, 6000 ) );
			const displayed = raster ? Buffer.concat( [ png( 400, 400 * height / width ), Buffer.alloc( index === 3 ? budget : 0 ) ] ) : Buffer.from( svg( 400, index === 3 ? 3000 : 1 ) );
			for ( const [ url, bytes ] of [ [ originalUrl, original ], [ displayedUrl, displayed ] ] as const ) {
				const path = `resources/${ new URL( url ).pathname.slice( 1 ) }`;
				writeFileSync( join( directory, path ), bytes );
				resources[ url ] = { path, contentType };
				stubs.markSuccess( url, join( directory, resources[ originalUrl ].path ) );
			}
			return { kind: 'image', source_urls: [ originalUrl, displayedUrl ], resolved_original: originalUrl,
				local_path: join( directory, resources[ originalUrl ].path ),
				references: [ { route: source, kind: 'HTML', source_url: displayedUrl } ],
				original: { source_url: originalUrl, content_type: contentType, width, height,
					sha256: createHash( 'sha256' ).update( original ).digest( 'hex' ) } };
		} );
		stubs.flush();
		writeFileSync( join( directory, 'resources/manifest.json' ), JSON.stringify( { version: 1, resources, failures: [] } ) );
		writeFileSync( join( directory, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { [ source ]: { html: 'html/home.html' } } } ) );
		const html = ( count: number ) => `<!doctype html><html><head><title>Photos</title></head><body>${ images.slice( 0, count ).map( image => `<a href="${ image.source_urls[ 0 ] }"><img src="${ image.source_urls[ 1 ] }" width="400" height="400"></a>` ).join( '' ) }</body></html>`;
		// Three displayed renditions fit; originals exceed the budget or a portable limit.
		for ( const count of [ 3, 4 ] ) {
			writeFileSync( join( directory, 'image-assets.json' ), JSON.stringify( { version: 1, images: images.slice( 0, count ) } ) );
			writeFileSync( join( directory, 'html/home.html' ), html( count ) );
			exportWebsiteCapture( { outputDir: directory, sourceUrl: source, platform: 'generic', summary: {}, failures: [], limits: { portableMediaTotalBytes: budget } } );
			const $ = cheerio.load( readFileSync( join( directory, 'website/index.html' ), 'utf8' ) );
			const placeholders = $( 'img' ).toArray().filter( node => $( node ).attr( 'src' )!.startsWith( 'data:image/gif;' ) );
			expect( placeholders ).toHaveLength( count === 3 ? 0 : 1 );
			for ( const [ index, node ] of $( 'img' ).toArray().slice( 0, 3 ).entries() ) {
				const path = $( node ).attr( 'src' )!;
				expect( path ).toMatch( /^\/media\// );
				const written = readFileSync( join( directory, 'website', path ) );
				const captured = readFileSync( join( directory, resources[ images[ index ].source_urls[ 1 ] ].path ) );
				expect( written ).toEqual( captured );
			}
			const diagnostics = readFileSync( join( directory, 'diagnostics.json' ), 'utf8' );
			const writtenBytes = readdirSync( join( directory, 'website/media' ) ).reduce( ( sum, name ) => sum + statSync( join( directory, 'website/media', name ) ).size, 0 );
			expect( writtenBytes ).toBeGreaterThan( 0 );
			expect( JSON.parse( diagnostics ).portableMedia ).toMatchObject( { selected_bytes: writtenBytes, blanked_count: count === 3 ? 0 : 1 } );
			if ( count === 3 ) expect( diagnostics ).not.toContain( 'image_resource_unresolved' );
			else expect( diagnostics ).toMatch( /"code": "image_resource_unresolved",[\s\S]*?"reason": "blanked because the aggregate portable media limit was reached",[\s\S]*?"severity": "error"/ );
		}
	} finally {
		rmSync( directory, { recursive: true, force: true } );
	}
} );
