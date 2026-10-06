import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="red"/></svg>';
const listen = ( server: Server ) => new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
const close = ( server: Server ) => new Promise<void>( resolve => server.close( () => resolve() ) );

it.skipIf( !!process.env.SKIP_BROWSER_TESTS ).each( [ false, true ] )(
	'exports redirected documents using their browser base (authored base: %s)',
	async authoredBase => {
		const root = join( process.cwd(), '.tmp-test' );
		mkdirSync( root, { recursive: true } );
		const outputDir = mkdtempSync( join( root, 'rendered-base-' ) );
		const requests: string[] = [];
		const server = createServer( ( req, res ) => {
			const path = req.url!;
			requests.push( path );
			if ( path === '/albums' ) {
				res.writeHead( 301, { Location: '/albums/' } ); res.end(); return;
			}
			if ( path === '/albums/' ) {
				const mobile = /Mobile/.test( req.headers[ 'user-agent' ] ?? '' );
				const base = authoredBase ? `<base href="../${ mobile ? 'phone-assets' : 'assets' }/">` : '';
				res.writeHead( 200, { 'Content-Type': 'text/html' } );
				res.end( `<!doctype html><html><head>${ base }<link rel="stylesheet" href="res/styles/black.css"><script src="res/app.js"></script></head><body><h1>Albums</h1><img src="res/thumb.svg"><div class="tile"></div><a id="next" href="next">Next</a><a id="fragment" href="#heading">Heading</a><h2 id="heading">Photos</h2></body></html>` );
				return;
			}
			if ( /^\/(albums|assets|phone-assets)\/res\//.test( path ) ) {
				if ( path.endsWith( '.css' ) ) {
					res.writeHead( 200, { 'Content-Type': 'text/css' } );
					res.end( 'body{background:#000;color:#fff}img,.tile{display:block;width:40px;height:30px}.tile{background-image:url(../tile.svg)}' );
				} else if ( path.endsWith( '.js' ) ) {
					res.writeHead( 200, { 'Content-Type': 'application/javascript' } ); res.end( 'window.albumLoaded=true;' );
				} else {
					res.writeHead( 200, { 'Content-Type': 'image/svg+xml' } ); res.end( svg );
				}
				return;
			}
			res.writeHead( 404 ); res.end( 'Missing' );
		} );
		await listen( server );
		const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
		const requestedUrl = `${ origin }/albums`;
		let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
		let portable: Server | undefined;
		try {
			await captureScreenshots( { urls: [ requestedUrl ], primaryUrl: `${ origin }/`, outputDir, settleMs: 0, learnFluid: false } );
			exportWebsiteCapture( { outputDir, sourceUrl: requestedUrl, platform: 'generic', summary: {}, failures: [] } );
			const receipt = JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) );
			expect( receipt.routes ).toHaveLength( 1 );
			expect( receipt.routes[ 0 ].url ).toBe( requestedUrl );
			const cssPath = `${ origin }/${ authoredBase ? 'assets' : 'albums' }/res/styles/black.css`;
			expect( receipt.assets ).toContainEqual( expect.objectContaining( { sourceUrl: cssPath } ) );
			expect( requests ).not.toContain( '/res/styles/black.css' );
			expect( requests ).toContain( `/${ authoredBase ? 'assets' : 'albums' }/next` );
			expect( requests ).not.toContain( '/next' );
			const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) );
			expect( Object.keys( manifest.entries ).filter( url => manifest.entries[ url ].html ) ).toEqual( [ requestedUrl ] );
			for ( const device of [ 'desktop', 'mobile' ] ) {
				expect( manifest.entries[ requestedUrl ].documents[ device ] ).toEqual( {
					url: `${ origin }/albums/`,
					baseUrl: `${ origin }/${ authoredBase ? device === 'mobile' ? 'phone-assets' : 'assets' : 'albums' }/`,
				} );
			}
			const captured = readFileSync( join( outputDir, manifest.entries[ requestedUrl ].html ), 'utf8' );
			expect( captured ).toContain( 'src="res/app.js"' );
			// The portable page must work after the origin is gone, at every acceptance width.
			await close( server );
			portable = createServer( ( req, res ) => {
				try {
					const path = req.url === '/' ? receipt.routes[ 0 ].path : `website${ req.url }`;
					res.setHeader( 'Content-Type', path.endsWith( '.css' ) ? 'text/css' : path.endsWith( '.svg' ) ? 'image/svg+xml' : 'text/html' );
					res.end( readFileSync( join( outputDir, path ) ) );
				} catch { res.writeHead( 404 ); res.end(); }
			} );
			await listen( portable );
			browser = await chromium.launch( { headless: true } );
			const page = await browser.newPage();
			for ( const width of [ 390, 768, 1440 ] ) {
				await page.setViewportSize( { width, height: 900 } );
				await page.goto( `http://127.0.0.1:${ ( portable.address() as { port: number } ).port }/` );
				const visible = await page.locator( 'img:visible' ).first().evaluate( image => ( {
					decoded: ( image as HTMLImageElement ).naturalWidth,
					width: image.getBoundingClientRect().width,
					background: getComputedStyle( image.closest( 'body' )! ).backgroundColor,
				} ) );
				expect( visible ).toEqual( { decoded: 40, width: 40, background: 'rgb(0, 0, 0)' } );
				const background = await page.locator( '.tile:visible' ).first().evaluate( async element => {
					const url = getComputedStyle( element ).backgroundImage.slice( 5, -2 );
					const image = new Image(); image.src = url; await image.decode();
					return { local: new URL( url ).origin === location.origin, decoded: image.naturalWidth };
				} );
				expect( background ).toEqual( { local: true, decoded: 40 } );
				expect( await page.locator( '#next:visible' ).getAttribute( 'href' ) ).toBe( `${ origin }/${ authoredBase ? width < 768 ? 'phone-assets' : 'assets' : 'albums' }/next` );
				expect( await page.locator( '#fragment:visible' ).getAttribute( 'href' ) ).toBe( authoredBase
					? `${ origin }/${ width < 768 ? 'phone-assets' : 'assets' }/#heading`
					: '#heading' );
			}
		} finally {
			await browser?.close();
			if ( portable ) await close( portable );
			if ( server.listening ) await close( server );
			rmSync( outputDir, { recursive: true, force: true } );
		}
	}, 120_000
);
