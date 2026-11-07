import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';
import { imageSize } from 'image-size';
import * as cheerio from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { exportWebsiteCapture } from './capture-export.js';
import { MediaStubStore } from './resume-state/index.js';
import { startStaticServer } from './replicate/local-site/static-server.js';
import { observePage } from './fidelity/check.js';
import { normalizeImageKey } from './fidelity/score.js';
import { CapturedResourceStore } from './screenshot/resource-capture.js';
import { capture as adapterCapture } from '../adapters/wix/capture.js';

describe( 'selected same-path srcset export', () => {
	it( 'keeps profile renditions when the per-media-id map names only the phone image', async () => {
		const directory = mkdtempSync( join( tmpdir(), 'liberation-mapped-renditions-' ) );
		try {
			for ( const folder of [ 'html', 'html-mobile', 'screenshots', 'media' ] ) mkdirSync( join( directory, folder ) );
			const source = 'https://profiles.test/';
			const id = '123456_abcdef0123456789abcdef0123456789';
			const profiles = [
				{ name: 'desktop', width: 1920, height: 635, folder: 'html' },
				{ name: 'mobile', width: 1000, height: 331, folder: 'html-mobile' },
			].map( profile => {
				const url = `https://static.wixstatic.com/media/${ id }.png/v1/fill/w_${ profile.width },h_${ profile.height },al_c/${ id }.png`;
				const png = new PNG( { width: profile.width, height: profile.height } );
				png.data.fill( 255 );
				const bytes = PNG.sync.write( png );
				const file = join( directory, 'media', `${ profile.name }.png` );
				writeFileSync( file, bytes );
				writeFileSync( join( directory, profile.folder, 'home.html' ), `<html><body><main class="${ profile.name }"><h1>${ profile.name } layout</h1><img style="object-fit:none" src="${ url }">${ profile.name === 'mobile' ? '<nav>Phone navigation</nav>' : '' }</main></body></html>` );
				return { ...profile, url, bytes, file };
			} );
			// Use the adapter's actual per-media-id collector, as the mobile capture
			// does. The map has just one entry, not one entry per profile.
			const page = { evaluate: vi.fn().mockResolvedValue( [ profiles[ 1 ].url ] ) } as unknown as Page;
			const variants = await adapterCapture.responsiveImages!( page, { url: source, viewport: 'mobile' } );
			expect( variants ).toEqual( { [ id ]: profiles[ 1 ].url } );
			writeFileSync( join( directory, 'responsive-images.json' ), JSON.stringify( variants ) );
			// Both renditions are independently downloaded inventory records, unlike
			// srcset aliases backed by a single representative's resource manifest.
			const ordered = [ profiles.find( profile => profile.url === variants[ id ] )!, profiles[ 0 ] ];
			const media = MediaStubStore.load( directory );
			for ( const profile of ordered ) media.markSuccess( profile.url, profile.file );
			media.flush();
			writeFileSync( join( directory, 'image-assets.json' ), JSON.stringify( { images: ordered.map( profile => ( {
				kind: 'image', source_urls: [ profile.url ], resolved_original: profile.url, local_path: profile.file,
				references: [ { kind: 'content', document_url: source, location: 'image:0:src', source_url: profile.url } ],
				original: { source_url: profile.url, content_type: 'image/png', width: profile.width, height: profile.height, sha256: createHash( 'sha256' ).update( profile.bytes ).digest( 'hex' ) },
			} ) ) } ) );
			writeFileSync( join( directory, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { [ source ]: { slug: 'home', html: 'html/home.html' } } } ) );
			exportWebsiteCapture( { outputDir: directory, sourceUrl: source, platform: 'generic', summary: {}, failures: [] } );
			const $ = cheerio.load( readFileSync( join( directory, 'website/index.html' ), 'utf8' ) );
			for ( const profile of profiles ) {
				const path = $( `.${ profile.name } img` ).attr( 'src' )!;
				expect( path ).toMatch( /^\/media\// );
				const bytes = readFileSync( join( directory, 'website', path ) );
				expect( imageSize( bytes ) ).toMatchObject( { width: profile.width, height: profile.height } );
				expect( bytes ).toEqual( profile.bytes );
			}
		} finally { rmSync( directory, { recursive: true, force: true } ); }
	} );
	it( 'keeps each document’s painted rendition and natural dimensions', () => {
		const directory = mkdtempSync( join( tmpdir(), 'liberation-profile-renditions-' ) );
		try {
			for ( const folder of [ 'html', 'html-mobile', 'screenshots', 'media', 'resources' ] ) mkdirSync( join( directory, folder ) );
			const source = 'https://profiles.test/';
			const profiles = [
				{ name: 'desktop', width: 1920, height: 640, folder: 'html' },
				{ name: 'mobile', width: 990, height: 330, folder: 'html-mobile' },
			].map( profile => {
				const url = `${ source }hero.png?w=${ profile.width }&h=${ profile.height }`;
				const png = new PNG( { width: profile.width, height: profile.height } );
				png.data.fill( 255 );
				const bytes = PNG.sync.write( png );
				const path = `resources/${ profile.name }.png`;
				writeFileSync( join( directory, path ), bytes );
				writeFileSync( join( directory, profile.folder, 'home.html' ), `<html><body><main class="${ profile.name }"><h1>${ profile.name } layout</h1><img style="object-fit:none" src="${ url }">${ profile.name === 'mobile' ? '<nav>Phone navigation</nav>' : '' }</main></body></html>` );
				return { ...profile, url, path, bytes };
			} );
			const representative = profiles[ 1 ];
			const file = join( directory, 'media/hero.png' );
			writeFileSync( file, representative.bytes );
			const media = MediaStubStore.load( directory );
			for ( const profile of profiles ) media.markSuccess( profile.url, file );
			media.flush();
			writeFileSync( join( directory, 'resources/manifest.json' ), JSON.stringify( { version: 1, resources: Object.fromEntries( profiles.map( profile => [ profile.url, { path: profile.path, contentType: 'image/png' } ] ) ), failures: [] } ) );
			writeFileSync( join( directory, 'image-assets.json' ), JSON.stringify( { images: [ {
				kind: 'image', source_urls: profiles.map( profile => profile.url ), resolved_original: representative.url, local_path: file,
				references: profiles.map( profile => ( { kind: 'content', document_url: source, location: 'image:0:src', source_url: profile.url } ) ),
				original: { source_url: representative.url, content_type: 'image/png', width: representative.width, height: representative.height, sha256: createHash( 'sha256' ).update( representative.bytes ).digest( 'hex' ) },
			} ] } ) );
			writeFileSync( join( directory, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { [ source ]: { slug: 'home', html: 'html/home.html' } } } ) );
			exportWebsiteCapture( { outputDir: directory, sourceUrl: source, platform: 'generic', summary: {}, failures: [] } );
			const $ = cheerio.load( readFileSync( join( directory, 'website/index.html' ), 'utf8' ) );
			for ( const profile of profiles ) {
				const path = $( `.${ profile.name } img` ).attr( 'src' )!;
				expect( path ).toMatch( /^\/media\// );
				const bytes = readFileSync( join( directory, 'website', path ) );
				expect( imageSize( bytes ) ).toMatchObject( { width: profile.width, height: profile.height } );
				expect( bytes ).toEqual( profile.bytes );
			}
		} finally { rmSync( directory, { recursive: true, force: true } ); }
	} );
	it.each( [
		{ name: '1:1 crops', cropped: true },
		{ name: 'rounded 2:3 resizes', cropped: false },
	] )( 'exports selected $name linked to a 2:3 lightbox original', ( { cropped } ) => {
		const directory = mkdtempSync( join( tmpdir(), 'liberation-lightbox-srcset-' ) );
		try {
			for ( const folder of [ 'html', 'screenshots', 'media', 'resources' ] ) mkdirSync( join( directory, folder ) );
			const source = 'https://gallery.test/';
			const original = `${ source }photo-high.png`;
			const widths = [ 147, 226, 532 ];
			const urls = widths.map( width => `${ source }photo.png?crop=${ cropped ? '1:1' : '2:3' }&width=${ width }` );
			const pngBytes = ( width: number, height: number ) => {
				const png = new PNG( { width, height } );
				png.data.fill( width % 251 );
				return PNG.sync.write( png );
			};
			const bytes = widths.map( width => pngBytes( width, cropped ? width : Math.round( width * 1.5 ) ) );
			const resources = Object.fromEntries( urls.map( ( url, index ) => {
				const path = `resources/photo-${ widths[ index ] }.png`;
				writeFileSync( join( directory, path ), bytes[ index ] );
				return [ url, { path, contentType: 'image/png' } ];
			} ) );
			writeFileSync( join( directory, 'resources/manifest.json' ), JSON.stringify( { version: 1, resources, failures: [] } ) );
			const originalBytes = pngBytes( 800, 1200 );
			const file = join( directory, 'media/photo-high.png' );
			writeFileSync( file, originalBytes );
			const media = MediaStubStore.load( directory );
			for ( const url of [ original, ...urls ] ) media.markSuccess( url, file );
			media.flush();
			writeFileSync( join( directory, 'image-assets.json' ), JSON.stringify( { images: [ {
				kind: 'image', source_urls: [ original, ...urls ], resolved_original: original, local_path: file,
				references: urls.map( source_url => ( { kind: 'content', document_url: source, location: 'image:0:srcset', source_url } ) ),
				rendition_widths: Object.fromEntries( urls.map( ( url, index ) => [ url, widths[ index ] ] ) ),
				original: { source_url: original, content_type: 'image/png', width: 800, height: 1200, sha256: createHash( 'sha256' ).update( originalBytes ).digest( 'hex' ) },
			} ] } ) );
			writeFileSync( join( directory, 'html/home.html' ), `<a href="${ original }"><img src="${ urls[ 2 ] }" srcset="${ urls.map( ( url, index ) => `${ url } ${ widths[ index ] }w` ).join( ', ' ) }"></a>` );
			writeFileSync( join( directory, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { [ source ]: { html: 'html/home.html' } } } ) );
			exportWebsiteCapture( { outputDir: directory, sourceUrl: source, platform: 'generic', summary: {}, failures: [] } );
			const $ = cheerio.load( readFileSync( join( directory, 'website/index.html' ), 'utf8' ) );
			const candidates = $( 'img' ).attr( 'srcset' )!.split( ',' ).map( candidate => candidate.trim().split( /\s+/ ) );
			expect( candidates.map( ( [ , descriptor ] ) => descriptor ) ).toEqual( widths.map( width => `${ width }w` ) );
			const paths = candidates.map( ( [ path ] ) => path );
			expect( new Set( paths ).size ).toBe( widths.length );
			for ( const [ index, path ] of paths.entries() ) {
				expect( readFileSync( join( directory, 'website', path ) ) ).toEqual( bytes[ index ] );
				expect( path ).not.toBe( $( 'a' ).attr( 'href' ) );
			}
			expect( readFileSync( join( directory, 'website', $( 'a' ).attr( 'href' )! ) ) ).toEqual( originalBytes );
		} finally { rmSync( directory, { recursive: true, force: true } ); }
	} );
	it( 'exports only selected Jimdo-style files, once each at their intrinsic widths', () => {
		const directory = mkdtempSync( join( tmpdir(), 'liberation-query-srcset-' ) );
		try {
			for ( const folder of [ 'html', 'screenshots', 'media', 'resources' ] ) mkdirSync( join( directory, folder ) );
			const source = 'https://jimdo.test/';
			const widths = [ 96, 147, 347, 532, 816, 1252, 1920 ];
			const intrinsicWidths = [ 1280, 147, 347, 532, 816, 1000, 1280 ];
			const selected = [ 0, 2, 3, 4, 5, 6 ];
			const urls = widths.map( width => `${ source }photo.png?width=${ width }` );
			const bytes = intrinsicWidths.map( width => {
				const png = new PNG( { width, height: 10 } );
				png.data.fill( width % 251 );
				return PNG.sync.write( png );
			} );
			const resources = Object.fromEntries( selected.map( index => {
				const path = `resources/photo-${ widths[ index ] }.png`;
				writeFileSync( join( directory, path ), bytes[ index ] );
				return [ urls[ index ], { path, contentType: 'image/png' } ];
			} ) );
			writeFileSync( join( directory, 'resources/manifest.json' ), JSON.stringify( { version: 1, resources, failures: [] } ) );
			const original = urls.at( -1 )!;
			const file = join( directory, 'media/photo.png' );
			writeFileSync( file, bytes.at( -1 )! );
			const media = MediaStubStore.load( directory );
			for ( const url of urls ) media.markSuccess( url, file );
			media.flush();
			// Capture's identity inventory groups the URLs under the verified
			// representative, while the resource manifest retains selected bytes.
			writeFileSync( join( directory, 'image-assets.json' ), JSON.stringify( { images: [ {
				kind: 'image', source_urls: urls, resolved_original: original, local_path: file,
				references: urls.map( source_url => ( { kind: 'content', document_url: source, location: 'image:0:srcset', source_url } ) ),
				rendition_widths: Object.fromEntries( urls.map( ( url, index ) => [ url, widths[ index ] ] ) ),
				original: { source_url: original, content_type: 'image/png', width: 1280, height: 10, sha256: createHash( 'sha256' ).update( bytes.at( -1 )! ).digest( 'hex' ) },
			} ] } ) );
			writeFileSync( join( directory, 'html/home.html' ), `<img src="${ original }" srcset="${ urls.map( ( url, index ) => `${ url } ${ widths[ index ] }w` ).join( ', ' ) }">` );
			writeFileSync( join( directory, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { [ source ]: { html: 'html/home.html' } } } ) );
			exportWebsiteCapture( { outputDir: directory, sourceUrl: source, platform: 'generic', summary: {}, failures: [] } );
			const $ = cheerio.load( readFileSync( join( directory, 'website/index.html' ), 'utf8' ) );
			const candidates = $( 'img' ).attr( 'srcset' )!.split( ',' ).map( candidate => candidate.trim().split( /\s+/ ) );
			expect( candidates.map( ( [ , descriptor ] ) => descriptor ) ).toEqual( [ 1280, 347, 532, 816, 1000 ].map( width => `${ width }w` ) );
			expect( new Set( candidates.map( ( [ path ] ) => path ) ).size ).toBe( candidates.length );
			for ( const [ path, descriptor ] of candidates ) {
				expect( path ).toMatch( /^\/media\// );
				const content = readFileSync( join( directory, 'website', path ) );
				expect( content ).toEqual( bytes[ intrinsicWidths.indexOf( parseFloat( descriptor ) ) ] );
				expect( Math.abs( imageSize( content ).width! - parseFloat( descriptor ) ) ).toBeLessThanOrEqual( 0.5 );
			}
			expect( candidates.filter( ( [ path ] ) => path === $( 'img' ).attr( 'src' ) ) ).toHaveLength( 1 );
		} finally { rmSync( directory, { recursive: true, force: true } ); }
	} );
} );

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'srcset browser/export contract', () => {
	it( 'keeps selected lazy auto-sized width renditions byte-identical through capture and export', async () => {
		// One browser pass; normally under five seconds.
		const directory = mkdtempSync( join( tmpdir(), 'liberation-selected-srcset-' ) );
		const browser = await chromium.launch();
		let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
		try {
			const source = 'https://selected.test/';
			const images = new Map<string, Buffer>();
			for ( const width of [ 100, 200, 400, 800, 1600 ] ) {
				const png = new PNG( { width, height: 100 } );
				png.data.fill( width % 251 );
				images.set( `/photo-${ width }.png`, PNG.sync.write( png ) );
			}
			const html = `<meta name="viewport" content="width=device-width"><style>body{margin:0}img{width:50vw;height:auto}</style><img sizes="auto, 50vw" loading="lazy" src="/photo-1600.png" srcset="${ [ ...images.keys() ].map( path => `${ path } ${ path.match( /\d+/ )![ 0 ] }w` ).join( ', ' ) }">`;
			const context = await browser.newContext( { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } );
			const store = new CapturedResourceStore( directory, source, async url => ( {
				finalUrl: url, status: 200, headers: new Headers( { 'content-type': 'image/png' } ), body: images.get( new URL( url ).pathname )!,
			} ) );
			// A real source server is shared by the independent selection contexts.
			const { createServer } = await import( 'node:http' );
			const origin = createServer( ( request, response ) => {
				response.setHeader( 'content-type', request.url === '/' ? 'text/html' : 'image/png' );
				response.end( request.url === '/' ? html : images.get( request.url! ) );
			} );
			await new Promise<void>( resolve => origin.listen( 0, '127.0.0.1', resolve ) );
			const url = `http://127.0.0.1:${ ( origin.address() as { port: number } ).port }/`;
			try {
				const page = await context.newPage();
				store.observe( page );
				await page.goto( url );
				// Lazy images do not delay navigation's load event. Wait for the
				// selected candidate before decode(), which can reject while srcset
				// selection is still changing even though the PNG bytes are valid.
				const waitForImage = async ( target: Page ) => {
					await target.waitForFunction( () => {
						const image = document.querySelector( 'img' );
						return image?.complete && image.naturalWidth > 0;
					}, {}, { timeout: 5000 } );
					await target.locator( 'img' ).evaluate( image => ( image as HTMLImageElement ).decode() );
				};
				await waitForImage( page );
				await store.captureSelectedSrcsets( page );
				await store.captureDomDependencies( html, url );
				await store.settle( page );
				await store.flush();
				for ( const folder of [ 'html', 'screenshots' ] ) mkdirSync( join( directory, folder ) );
				writeFileSync( join( directory, 'html/home.html' ), html );
				writeFileSync( join( directory, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { [ url ]: { html: 'html/home.html' } } } ) );
				exportWebsiteCapture( { outputDir: directory, sourceUrl: url, platform: 'generic', summary: {}, failures: [] } );
				const $ = cheerio.load( readFileSync( join( directory, 'website/index.html' ), 'utf8' ) );
				expect( $( 'img' ).attr( 'sizes' ) ).toBe( 'auto, 50vw' );
				expect( $( 'img' ).attr( 'loading' ) ).toBe( 'lazy' );
				const manifest = JSON.parse( readFileSync( join( directory, 'resources/manifest.json' ), 'utf8' ) );
				expect( new Set( Object.values( manifest.resources ).map( ( entry: any ) => entry.path ) ).size ).toBe( 4 );
				expect( manifest.omissions.map( ( entry: { url: string } ) => new URL( entry.url ).pathname ) ).toEqual( [ '/photo-100.png' ] );
				server = await startStaticServer( join( directory, 'website' ) );
				for ( const width of [ 390, 1440 ] ) {
					const selected: Buffer[] = [];
					for ( const address of [ url, server.url ] ) {
						const fresh = await browser.newContext( { viewport: { width, height: 900 }, deviceScaleFactor: 1 } );
						try {
							const sample = await fresh.newPage();
							await sample.goto( address );
							await waitForImage( sample );
							const current = await sample.locator( 'img' ).evaluate( image => ( image as HTMLImageElement ).currentSrc );
							selected.push( Buffer.from( await ( await fetch( current ) ).arrayBuffer() ) );
						} finally { await fresh.close(); }
					}
					expect( selected[ 1 ] ).toEqual( selected[ 0 ] );
					expect( selected[ 0 ] ).toEqual( images.get( `/photo-${ width === 390 ? 200 : 800 }.png` ) );
				}
			} finally { origin.closeAllConnections(); await new Promise<void>( resolve => origin.close( () => resolve() ) ); }
		} finally { await server?.close(); await browser.close(); rmSync( directory, { recursive: true, force: true } ); }
	}, 30_000 );
	it( 'exports selected small-slot renditions from a below-the-fold lazy gallery', async () => {
		// One Chromium pass, normally under five seconds. Attribute dimensions
		// and auto sizes match the gallery that exposed #1221.
		const directory = mkdtempSync( join( tmpdir(), 'liberation-gallery-srcset-' ) );
		const browser = await chromium.launch();
		const { createServer } = await import( 'node:http' );
		const widths = [ 96, 147, 226, 347, 532, 816, 1252, 1920 ];
		const images = new Map( widths.map( width => {
			const png = new PNG( { width, height: width } );
			png.data.fill( width % 251 );
			return [ width, PNG.sync.write( png ) ] as const;
		} ) );
		const image = `<img width="800" height="800" sizes="auto, min(100vw, 300px), 100vw" loading="lazy" src="/photo.png?width=1920" srcset="${ widths.map( width => `/photo.png?width=${ width } ${ width }w` ).join( ', ' ) }">`;
		const html = `<meta name="viewport" content="width=device-width"><style>body{margin:0}.spacer{height:6000px}.gallery{display:grid;grid-template-columns:800px}.gallery.ready{grid-template-columns:repeat(2,171px)}img{width:100%;height:auto}@media(min-width:600px){.gallery.ready{grid-template-columns:repeat(5,133px)}}@media(min-width:1000px){.gallery.ready{grid-template-columns:repeat(8,148px)}}</style><div class="spacer"></div><div class="gallery">${ image.repeat( 16 ) }</div><script>new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)entry.target.classList.add('ready')}).observe(document.querySelector('.gallery'))</script>`;
		const origin = createServer( ( request, response ) => {
			const url = new URL( request.url!, 'http://fixture.test' );
			response.setHeader( 'content-type', url.pathname === '/' ? 'text/html' : 'image/png' );
			response.end( url.pathname === '/' ? html : images.get( Number( url.searchParams.get( 'width' ) ) ) );
		} );
		await new Promise<void>( resolve => origin.listen( 0, '127.0.0.1', resolve ) );
		const url = `http://127.0.0.1:${ ( origin.address() as { port: number } ).port }/`;
		try {
			const context = await browser.newContext( { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } );
			const page = await context.newPage();
			const store = new CapturedResourceStore( directory, url );
			store.observe( page );
			await page.goto( url );
			expect( await page.locator( 'img' ).first().evaluate( image => image.getBoundingClientRect().top ) ).toBeGreaterThan( 900 );
			await store.captureSelectedSrcsets( page );
			expect( page.viewportSize() ).toEqual( { width: 1440, height: 900 } );
			expect( await page.evaluate( () => ( { x: scrollX, y: scrollY } ) ) ).toEqual( { x: 0, y: 0 } );
			await store.captureDomDependencies( html, url );
			await store.settle( page );
			await store.flush();
			for ( const folder of [ 'html', 'screenshots' ] ) mkdirSync( join( directory, folder ) );
			writeFileSync( join( directory, 'html/home.html' ), html );
			writeFileSync( join( directory, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { [ url ]: { html: 'html/home.html' } } } ) );
			exportWebsiteCapture( { outputDir: directory, sourceUrl: url, platform: 'generic', summary: {}, failures: [] } );
			const $ = cheerio.load( readFileSync( join( directory, 'website/index.html' ), 'utf8' ) );
			const candidates = new Map( $( 'img' ).first().attr( 'srcset' )!.split( ',' ).map( candidate => {
				const [ path, descriptor ] = candidate.trim().split( /\s+/ );
				return [ Number( descriptor.slice( 0, -1 ) ), path ];
			} ) );
			expect( new Set( [ 147, 226, 1920 ].map( width => candidates.get( width ) ) ).size ).toBe( 3 );
			for ( const width of [ 147, 226 ] ) {
				const bytes = readFileSync( join( directory, 'website', candidates.get( width )! ) );
				expect( PNG.sync.read( bytes ).width ).toBe( width );
				expect( bytes ).toEqual( images.get( width ) );
			}
		} finally {
			origin.closeAllConnections();
			await new Promise<void>( resolve => origin.close( () => resolve() ) );
			await browser.close();
			rmSync( directory, { recursive: true, force: true } );
		}
	}, 30_000 );
	it( 'localizes padded single URL attributes without replacing registered source pixels with placeholders', async () => {
		const directory = mkdtempSync( join( tmpdir(), 'liberation-padded-url-contract-' ) );
		const browser = await chromium.launch();
		let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
		try {
			for ( const folder of [ 'html', 'screenshots', 'media' ] ) mkdirSync( join( directory, folder ) );
			const source = 'https://source.test/';
			const png = new PNG( { width: 88, height: 78 } );
			for ( let offset = 0; offset < png.data.length; offset += 4 ) {
				png.data[ offset ] = ( offset / 4 ) % 251;
				png.data[ offset + 1 ] = ( offset / 352 ) % 239;
				png.data[ offset + 2 ] = 71;
				png.data[ offset + 3 ] = 255;
			}
			const bytes = PNG.sync.write( png );
			const pixelHash = createHash( 'sha256' ).update( png.data ).digest( 'hex' );
			const inline = `data:image/png;base64,${ bytes.toString( 'base64' ) }`;
			const cases = [
				{ value: `${ source }photo.png`, padding: ' ', quote: '"' },
				{ value: `${ source }photo.png`, padding: '\t', quote: "'" },
				{ value: `${ source }photo.png`, padding: '\n', quote: '"' },
				{ value: `${ source }photo.png`, padding: '\r\n \t', quote: "'" },
				{ value: inline, padding: ' ', quote: '"' },
				{ value: inline, padding: '\t\n', quote: "'" },
			];
			const html = `<meta name="viewport" content="width=device-width"><style>body{margin:0}img{display:block;width:88px;height:auto}</style><main>${ cases.map( ( fixture, index ) => `<img alt="Padded image ${ index }" src=${ fixture.quote }${ fixture.padding }${ fixture.value }${ fixture.padding }${ fixture.quote }>` ).join( '' ) }<p>After retained images</p></main>`;
			writeFileSync( join( directory, 'html/home.html' ), html );
			writeFileSync( join( directory, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { [ source ]: { html: 'html/home.html' } } } ) );
			const file = join( directory, 'media/photo.png' );
			writeFileSync( file, bytes );
			const media = MediaStubStore.load( directory );
			media.markSuccess( `${ source }photo.png`, file ); media.flush();
			const requests: string[] = [];
			const sample = async ( page: Page ) => {
				await page.waitForFunction( () => document.images.length === 6 && Array.from( document.images ).every( image => image.complete && image.naturalWidth > 0 ), {}, { timeout: 5000 } );
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
						return { currentSrc: image.currentSrc, hash, natural: [ image.naturalWidth, image.naturalHeight ], rect: [ rect.x, rect.y, rect.width, rect.height ] };
					} ) );
				} );
			};
			for ( const width of [ 390, 768, 1440 ] ) {
				const context = await browser.newContext( { viewport: { width, height: 900 }, deviceScaleFactor: 1 } );
				try {
					await context.route( `${ source }**`, route => {
						const path = new URL( route.request().url() ).pathname;
						return path === '/' ? route.fulfill( { contentType: 'text/html', body: html } ) : path === '/photo.png' ? route.fulfill( { contentType: 'image/png', body: bytes } ) : route.fulfill( { status: 404 } );
					} );
					const page = await context.newPage();
					await page.goto( source, { waitUntil: 'domcontentloaded' } );
					const before = await sample( page );
					expect( before.every( image => image.hash === pixelHash && image.natural[ 0 ] === 88 && image.natural[ 1 ] === 78 ) ).toBe( true );
					if ( ! server ) {
						exportWebsiteCapture( { outputDir: directory, sourceUrl: source, platform: 'generic', summary: {}, failures: [] } );
						const diagnostics = JSON.parse( readFileSync( join( directory, 'diagnostics.json' ), 'utf8' ) );
						expect( diagnostics.unresolvedDependencies ).toEqual( [] );
						const $ = cheerio.load( readFileSync( join( directory, 'website/index.html' ), 'utf8' ) );
						expect( $( 'img' ).map( ( _, image ) => $( image ).attr( 'src' ) ).get() ).toEqual( cases.map( fixture => fixture.padding.replaceAll( '\r\n', '\n' ) + ( fixture.value.startsWith( 'data:' ) ? fixture.value : '/media/photo.png' ) + fixture.padding.replaceAll( '\r\n', '\n' ) ) );
						expect( readFileSync( join( directory, 'website/media/photo.png' ) ) ).toEqual( bytes );
						server = await startStaticServer( join( directory, 'website' ) );
					}
					page.on( 'request', request => requests.push( request.url() ) );
					await page.goto( server.url, { waitUntil: 'domcontentloaded' } );
					const after = await sample( page );
					expect( after.map( ( { currentSrc, ...image } ) => image ) ).toEqual( before.map( ( { currentSrc, ...image } ) => image ) );
					for ( const image of after.slice( 0, 4 ) ) expect( new URL( image.currentSrc ).pathname ).toBe( '/media/photo.png' );
					for ( const image of after.slice( 4 ) ) expect( image.currentSrc ).toBe( inline );
				} finally { await context.close(); }
			}
			expect( requests.some( url => url.startsWith( source ) ) ).toBe( false );
		} finally { await server?.close(); await browser.close(); rmSync( directory, { recursive: true, force: true } ); }
	}, 30_000 );
	it( 'retains descriptorless comma paths, density/width selection and inline pixels through export', async () => {
		const directory = mkdtempSync( join( tmpdir(), 'liberation-srcset-contract-' ) );
		let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
		try {
			for ( const folder of [ 'html', 'screenshots', 'media' ] ) mkdirSync( join( directory, folder ) );
			const source = 'https://srcset.test/';
			const images = new Map<string, Buffer>();
			const square = ( name: string, size: number ) => `/images/${ name }-${ size }x${ size }_scale,w_${ size }.png`;
			// Each responsive fixture owns its candidates. Chromium may satisfy a
			// selection from a higher-density candidate another image already loaded,
			// so a shared resource would make source and portable selection race.
			const names = [ 'first', 'second', 'density', 'width', 'picture' ];
			for ( const [ index, name ] of names.entries() ) for ( const size of [ 720, 480, 320 ] ) {
				const png = new PNG( { width: size, height: size } );
				for ( let offset = 0; offset < png.data.length; offset += 4 ) {
					png.data[ offset ] = index % 2 === 0 ? ( offset / 4 ) % 251 : 37 + index;
					png.data[ offset + 1 ] = size % 251;
					png.data[ offset + 2 ] = index % 2 === 1 ? ( offset / 4 ) % 239 : 71 + index;
					png.data[ offset + 3 ] = 255;
				}
				images.set( square( name, size ), PNG.sync.write( png ) );
			}
			const inline = `data:image/png;base64,${ images.get( square( 'second', 320 ) )!.toString( 'base64' ) }`;
			const list = ( name: string ) => [ 720, 480, 320 ].map( size => square( name, size ) ).join( ', ' );
			const html = `<meta name="viewport" content="width=device-width"><style>body{margin:0}img{display:block;width:160px;height:auto}</style><main><img alt="First square" src="${ square( 'first', 320 ) }" srcset="${ list( 'first' ) }"><img alt="Second square" src="${ square( 'second', 320 ) }" srcset="${ list( 'second' ) }"><img alt="Density" src="${ square( 'density', 320 ) }" srcset="${ square( 'density', 320 ) }, ${ square( 'density', 720 ) } 2x"><img alt="Width" sizes="160px" srcset="${ square( 'width', 320 ) } 320w,${ square( 'width', 720 ) } 720w"><picture><source srcset="${ inline }, ${ square( 'picture', 720 ) } 2x"><img alt="Inline" src="${ inline }"></picture><p>After images</p></main>`;
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
			// Chromium may satisfy srcset selection from an image it already holds,
			// including a candidate decoded by an earlier page or context in the same
			// browser. Each page load gets a fresh browser so selection reflects only
			// its own profile, matching an independent visitor.
			const isolatedPage = async <T>( width: number, density: number, use: ( page: Page ) => Promise<T> ): Promise<T> => {
				const browser = await chromium.launch();
				try {
					const context = await browser.newContext( { viewport: { width, height: 900 }, deviceScaleFactor: density } );
					await context.route( `${ source }**`, route => {
						const path = new URL( route.request().url() ).pathname;
						return path === '/' ? route.fulfill( { contentType: 'text/html', body: html } ) : images.has( path ) ? route.fulfill( { contentType: 'image/png', body: images.get( path )! } ) : route.fulfill( { status: 404 } );
					} );
					return await use( await context.newPage() );
				} finally { await browser.close(); }
			};
			for ( const [ width, density ] of [ [ 390, 3 ], [ 768, 1 ], [ 1440, 2 ] ] ) {
				const before = await isolatedPage( width, density, async page => {
					await page.goto( source, { waitUntil: 'domcontentloaded' } );
					return sample( page );
				} );
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
				const portableUrl = server.url;
				await isolatedPage( width, density, async page => {
					page.on( 'response', response => { if ( ! response.ok() ) failures.push( response.url() ); } );
					await page.goto( portableUrl, { waitUntil: 'domcontentloaded' } );
					const after = await sample( page );
					expect( after.map( image => ( { hash: image.hash, natural: image.natural, rect: image.rect } ) ) ).toEqual( before.map( image => ( { hash: image.hash, natural: image.natural, rect: image.rect } ) ) );
					expect( after[ 0 ].src ).toContain( '/media/first-320x320_scale-w_320.png' );
					expect( new URL( after[ 0 ].currentSrc ).pathname ).toBe( '/media/first-720x720_scale-w_720.png' );
					// The observer uses the same tokens; no invented suffix is rendition evidence.
					const readiness = vi.spyOn( page, 'waitForLoadState' ).mockImplementation( async state => { if ( state === 'networkidle' ) throw new Error( 'No network-idle readiness in this fixture' ); } );
					try {
						const observation = await observePage( page, portableUrl, width, 0, null, undefined, undefined, true, true );
						expect( observation.images[ 0 ].renditions ).toEqual( [ normalizeImageKey( '/media/first-480x480_scale-w_480.png' ), normalizeImageKey( '/media/first-320x320_scale-w_320.png' ) ] );
					} finally { readiness.mockRestore(); }
				} );
			}
			expect( failures ).toEqual( [] );
		} finally { await server?.close(); rmSync( directory, { recursive: true, force: true } ); }
	}, 60_000 );
} );
