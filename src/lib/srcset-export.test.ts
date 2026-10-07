import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';
import * as cheerio from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { exportWebsiteCapture } from './capture-export.js';
import { MediaStubStore } from './resume-state/index.js';
import { startStaticServer } from './replicate/local-site/static-server.js';
import { observePage } from './fidelity/check.js';
import { normalizeImageKey } from './fidelity/score.js';

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'srcset browser/export contract', () => {
	it( 'retains descriptorless comma paths, density/width selection and inline pixels through export', async () => {
		const directory = mkdtempSync( join( tmpdir(), 'dla-srcset-contract-' ) );
		const browser = await chromium.launch();
		let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
		try {
			for ( const folder of [ 'html', 'screenshots', 'media' ] ) mkdirSync( join( directory, folder ) );
			const source = 'https://srcset.test/';
			const images = new Map<string, Buffer>();
			const square = ( name: string, size: number ) => `/images/${ name }-${ size }x${ size }_scale,w_${ size }.png`;
			for ( const name of [ 'first', 'second' ] ) for ( const size of [ 720, 480, 320 ] ) {
				const png = new PNG( { width: size, height: size } );
				for ( let offset = 0; offset < png.data.length; offset += 4 ) {
					png.data[ offset ] = name === 'first' ? ( offset / 4 ) % 251 : 37;
					png.data[ offset + 1 ] = size % 251;
					png.data[ offset + 2 ] = name === 'second' ? ( offset / 4 ) % 239 : 71;
					png.data[ offset + 3 ] = 255;
				}
				images.set( square( name, size ), PNG.sync.write( png ) );
			}
			const inline = `data:image/png;base64,${ images.get( square( 'second', 320 ) )!.toString( 'base64' ) }`;
			const list = ( name: string ) => [ 720, 480, 320 ].map( size => square( name, size ) ).join( ', ' );
			const html = `<meta name="viewport" content="width=device-width"><style>body{margin:0}img{display:block;width:160px;height:auto}</style><main><img alt="First square" src="${ square( 'first', 320 ) }" srcset="${ list( 'first' ) }"><img alt="Second square" src="${ square( 'second', 320 ) }" srcset="${ list( 'second' ) }"><img alt="Density" src="${ square( 'first', 320 ) }" srcset="${ square( 'first', 320 ) }, ${ square( 'second', 720 ) } 2x"><img alt="Width" sizes="160px" srcset="${ square( 'first', 320 ) } 320w,${ square( 'second', 720 ) } 720w"><picture><source srcset="${ inline }, ${ square( 'first', 720 ) } 2x"><img alt="Inline" src="${ inline }"></picture><p>After images</p></main>`;
			writeFileSync( join( directory, 'html/home.html' ), html );
			writeFileSync( join( directory, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { [ source ]: { html: 'html/home.html' } } } ) );
			const media = MediaStubStore.load( directory );
			for ( const [ path, bytes ] of images ) {
				const file = join( directory, 'media', path.split( '/' ).at( -1 )!.replaceAll( ',', '-' ) );
				writeFileSync( file, bytes );
				media.markSuccess( new URL( path, source ).href, file );
			}
			media.flush();
			const sample = async ( page: Page ) => {
				await page.waitForFunction( () => document.images.length === 5 && Array.from( document.images ).every( image => image.complete && image.naturalWidth > 0 ), {}, { timeout: 5000 } );
				return page.evaluate( async () => {
					await Promise.all( Array.from( document.images, image => image.decode() ) );
					await new Promise<void>( resolve => requestAnimationFrame( () => requestAnimationFrame( () => resolve() ) ) );
					return Promise.all( Array.from( document.images, async image => {
						const bitmap = await createImageBitmap( image );
						const canvas = new OffscreenCanvas( bitmap.width, bitmap.height );
						const context = canvas.getContext( '2d' )!;
						context.drawImage( bitmap, 0, 0 ); bitmap.close();
						const pixels = context.getImageData( 0, 0, canvas.width, canvas.height ).data;
						const hash = Array.from( new Uint8Array( await crypto.subtle.digest( 'SHA-256', pixels ) ), byte => byte.toString( 16 ).padStart( 2, '0' ) ).join( '' );
						const rect = image.getBoundingClientRect();
						return { src: image.getAttribute( 'src' ), currentSrc: image.currentSrc, hash, natural: [ image.naturalWidth, image.naturalHeight ], rect: [ rect.x, rect.y, rect.width, rect.height ] };
					} ) );
				} );
			};
			const failures: string[] = [];
			for ( const [ width, density ] of [ [ 390, 3 ], [ 768, 1 ], [ 1440, 2 ] ] ) {
				const context = await browser.newContext( { viewport: { width, height: 900 }, deviceScaleFactor: density } );
				try {
					await context.route( `${ source }**`, route => {
						const path = new URL( route.request().url() ).pathname;
						return path === '/' ? route.fulfill( { contentType: 'text/html', body: html } ) : images.has( path ) ? route.fulfill( { contentType: 'image/png', body: images.get( path )! } ) : route.fulfill( { status: 404 } );
					} );
					const page = await context.newPage();
					await page.goto( source, { waitUntil: 'domcontentloaded' } );
					const before = await sample( page );
					expect( new URL( before[ 0 ].currentSrc ).pathname ).toBe( square( 'first', 720 ) );
					expect( new URL( before[ 1 ].currentSrc ).pathname ).toBe( square( 'second', 720 ) );
					if ( ! server ) {
						exportWebsiteCapture( { outputDir: directory, sourceUrl: source, platform: 'generic', summary: {}, failures: [] } );
						const diagnostics = JSON.parse( readFileSync( join( directory, 'diagnostics.json' ), 'utf8' ) );
						expect( diagnostics.unresolvedDependencies ).toEqual( [] );
						const $ = cheerio.load( readFileSync( join( directory, 'website/index.html' ), 'utf8' ) );
						expect( $( 'img' ).first().attr( 'srcset' ) ).toContain( '/media/first-720x720_scale-w_720.png,' );
						server = await startStaticServer( join( directory, 'website' ) );
					}
					page.on( 'response', response => { if ( ! response.ok() ) failures.push( response.url() ); } );
					await page.goto( server.url, { waitUntil: 'domcontentloaded' } );
					const after = await sample( page );
					expect( after.map( image => ( { hash: image.hash, natural: image.natural, rect: image.rect } ) ) ).toEqual( before.map( image => ( { hash: image.hash, natural: image.natural, rect: image.rect } ) ) );
					expect( after[ 0 ].src ).toContain( '/media/first-320x320_scale-w_320.png' );
					expect( new URL( after[ 0 ].currentSrc ).pathname ).toBe( '/media/first-720x720_scale-w_720.png' );
					// The observer uses the same tokens; no invented suffix is rendition evidence.
					const readiness = vi.spyOn( page, 'waitForLoadState' ).mockImplementation( async state => { if ( state === 'networkidle' ) throw new Error( 'No network-idle readiness in this fixture' ); } );
					try {
						const observation = await observePage( page, server.url, width, 0, null, undefined, undefined, true, true );
						expect( observation.images[ 0 ].renditions ).toEqual( [ normalizeImageKey( '/media/first-480x480_scale-w_480.png' ), normalizeImageKey( '/media/first-320x320_scale-w_320.png' ) ] );
					} finally { readiness.mockRestore(); }
				} finally { await context.close(); }
			}
			expect( failures ).toEqual( [] );
		} finally { await server?.close(); await browser.close(); rmSync( directory, { recursive: true, force: true } ); }
	}, 60_000 );
} );
