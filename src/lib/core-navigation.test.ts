import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { captureTriggeredDialogs } from './screenshot/interaction-capture.js';
import { wireCapturedDialogs } from './static-dialogs.js';

// One browser pass (~2 seconds): real WP render, source probing, portable replay.
it( 'preserves core-navigation inline resting state and phone overlay behavior', async () => {
	const root = new URL( '../../test/fixtures/core-navigation/', import.meta.url );
	const server = createServer( async ( request, response ) => {
		const name = request.url === '/' ? 'index.html' : request.url!.slice( 1 );
		try {
			const content = await readFile( new URL( name, root ) );
			response.setHeader( 'Content-Type', name.endsWith( '.js' ) ? 'text/javascript' : name.endsWith( '.css' ) ? 'text/css' : 'text/html' );
			response.end( content );
		} catch { response.writeHead( 404 ).end(); }
	} );
	await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
	const address = server.address() as { port: number };
	const url = `http://127.0.0.1:${ address.port }/`;
	const browser = await chromium.launch( { headless: true } );
	try {
		const page = await browser.newPage( { viewport: { width: 390, height: 900 } } );
		await page.goto( url );
		await page.waitForFunction( () => !!document.querySelector( '.wp-block-navigation__responsive-dialog' ) );
		// Let the actual core Interactivity API hydrate before source probing.
		await page.waitForTimeout( 200 );
		const sourceGeometry = new Map<number, { x: number; y: number; width: number; height: number }[]>();
		for ( const width of [ 1440, 768, 390 ] ) {
			await page.setViewportSize( { width, height: 900 } );
			expect( await page.locator( '.wp-block-navigation__responsive-container-open' ).isVisible() ).toBe( width === 390 );
			if ( width !== 390 ) sourceGeometry.set( width, await page.locator( 'nav a' ).evaluateAll( links => links.map( link => {
				const { x, y, width, height } = link.getBoundingClientRect();
				return { x, y, width, height };
			} ) ) );
		}
		const html = await page.content();
		const report = await captureTriggeredDialogs( page, url );
		expect( report.states ).toEqual( expect.arrayContaining( [ expect.objectContaining( {
			status: 'captured', dialog: expect.objectContaining( { restingInline: true } ),
		} ) ] ) );
		const withoutRuntime = html.replace( /<script\b[^>]*>[\s\S]*?<\/script>/gi, '' );
		const portable = wireCapturedDialogs( withoutRuntime, report.states );
		await page.route( '**/copy', route => route.fulfill( { contentType: 'text/html', body: portable } ) );
		await page.goto( `${ url }copy` );
		const open = page.locator( '.wp-block-navigation__responsive-container-open' );
		const links = page.locator( 'nav a' );
		expect( await links.count() ).toBe( 4 );
		for ( const width of [ 1440, 768, 390, 1440, 390 ] ) {
			await page.setViewportSize( { width, height: 900 } );
			await expect.poll( () => open.isVisible() ).toBe( width === 390 );
			for ( const link of await links.all() ) await expect.poll( () => link.isVisible() ).toBe( width !== 390 );
			if ( width !== 390 ) {
				expect( await links.evaluateAll( links => links.map( link => {
					const { x, y, width, height } = link.getBoundingClientRect();
					return { x, y, width, height };
				} ) ) ).toEqual( sourceGeometry.get( width ) );
				expect( await links.first().evaluate( element => {
					for ( let node: Element | null = element; node && node.tagName !== 'NAV'; node = node.parentElement ) {
						if ( [ 'fixed', 'absolute' ].includes( getComputedStyle( node ).position ) ) return false;
					}
					return true;
				} ) ).toBe( true );
			} else {
				await open.click();
				for ( const link of await links.all() ) expect( await link.isVisible() ).toBe( true );
				await page.keyboard.press( 'Escape' );
				for ( const link of await links.all() ) expect( await link.isVisible() ).toBe( false );
			}
		}
	} finally {
		await browser.close();
		await new Promise<void>( ( resolve, reject ) => server.close( error => error ? reject( error ) : resolve() ) );
	}
}, 30_000 );
