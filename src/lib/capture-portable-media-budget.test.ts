import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { expect, it } from 'vitest';
import { exportWebsiteCapture } from './capture-export.js';
import { MediaStubStore } from './resume-state/media-stubs.js';

it( 'reserves displayed renditions of linked originals and reports unavoidable blanking as a budget error', () => {
	mkdirSync( '.tmp-test', { recursive: true } );
	const directory = mkdtempSync( join( process.cwd(), '.tmp-test/media-budget-' ) );
	const source = 'https://photos.example/';
	try {
		for ( const name of [ 'html', 'screenshots', 'resources' ] ) mkdirSync( join( directory, name ) );
		const stubs = MediaStubStore.load( directory );
		const resources: Record<string, { path: string; contentType: string }> = {};
		const images = Array.from( { length: 4 }, ( _, index ) => {
			const originalUrl = `${ source }original-${ index }.svg`;
			const displayedUrl = `${ source }displayed-${ index }.svg`;
			const svg = ( size: number, padding: number ) => `<svg xmlns="http://www.w3.org/2000/svg" width="${ size }" height="${ size }"><!--${ String( index ).repeat( padding ) }--><rect width="100%" height="100%" fill="red"/></svg>`;
			const original = svg( 1600, 6000 );
			const displayed = svg( 400, index === 3 ? 3000 : 1 );
			for ( const [ url, bytes ] of [ [ originalUrl, original ], [ displayedUrl, displayed ] ] ) {
				const path = `resources/${ new URL( url ).pathname.slice( 1 ) }`;
				writeFileSync( join( directory, path ), bytes );
				resources[ url ] = { path, contentType: 'image/svg+xml' };
				stubs.markSuccess( url, join( directory, resources[ originalUrl ].path ) );
			}
			return { kind: 'image', source_urls: [ originalUrl, displayedUrl ], resolved_original: originalUrl,
				local_path: join( directory, resources[ originalUrl ].path ),
				references: [ { route: source, kind: 'HTML', source_url: displayedUrl } ],
				original: { source_url: originalUrl, content_type: 'image/svg+xml', width: 1600, height: 1600,
					sha256: createHash( 'sha256' ).update( original ).digest( 'hex' ) } };
		} );
		stubs.flush();
		writeFileSync( join( directory, 'resources/manifest.json' ), JSON.stringify( { version: 1, resources, failures: [] } ) );
		writeFileSync( join( directory, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { [ source ]: { html: 'html/home.html' } } } ) );
		const html = ( count: number ) => `<!doctype html><html><head><title>Photos</title></head><body>${ images.slice( 0, count ).map( image => `<a href="${ image.source_urls[ 0 ] }"><img src="${ image.source_urls[ 1 ] }" width="400" height="400"></a>` ).join( '' ) }</body></html>`;
		// Three small displayed renditions fit; their linked originals do not.
		for ( const count of [ 3, 4 ] ) {
			writeFileSync( join( directory, 'image-assets.json' ), JSON.stringify( { version: 1, images: images.slice( 0, count ) } ) );
			writeFileSync( join( directory, 'html/home.html' ), html( count ) );
			exportWebsiteCapture( { outputDir: directory, sourceUrl: source, platform: 'generic', summary: {}, failures: [], limits: { portableMediaTotalBytes: 1000 } } );
			const $ = cheerio.load( readFileSync( join( directory, 'website/index.html' ), 'utf8' ) );
			const placeholders = $( 'img' ).toArray().filter( node => $( node ).attr( 'src' )!.startsWith( 'data:image/gif;' ) );
			expect( placeholders ).toHaveLength( count === 3 ? 0 : 1 );
			for ( const node of $( 'img' ).toArray().slice( 0, 3 ) ) {
				const path = $( node ).attr( 'src' )!;
				expect( path ).toMatch( /^\/media\// );
				expect( readFileSync( join( directory, 'website', path ), 'utf8' ) ).toContain( 'width="400"' );
			}
			const diagnostics = readFileSync( join( directory, 'diagnostics.json' ), 'utf8' );
			if ( count === 3 ) expect( diagnostics ).not.toContain( 'image_resource_unresolved' );
			else expect( diagnostics ).toMatch( /"code": "image_resource_unresolved",[\s\S]*?"reason": "blanked because the aggregate portable media limit was reached",[\s\S]*?"severity": "error"/ );
		}
	} finally {
		rmSync( directory, { recursive: true, force: true } );
	}
} );
