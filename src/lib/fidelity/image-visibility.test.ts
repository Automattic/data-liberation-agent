import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { observePage } from './check.js';
import { scoreViewport } from './score.js';

const skipped = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );
describe.skipIf( skipped )( 'lazy rail image readiness', () => {
	it( 'ignores parked cards, including cards clipped inside the viewport, but detects a visible decode regression', async () => {
		const browser = await chromium.launch();
		const page = await browser.newPage( { viewport: { width: 390, height: 900 } } );
		try {
			await page.route( 'https://fixture.test/**', route => route.fulfill( { status: 404, body: '' } ) );
			const card = ( name: string, sized: boolean ) => `<img loading="lazy" src="https://fixture.test/${ name }.png" ${ sized ? 'width="100" height="100"' : '' }>`;
			await page.setContent( `<style>
				body{margin:0} .rail{width:180px;display:flex;overflow-x:auto}
				.spacer{flex:0 0 300px} img{flex:none} .far{margin-left:552px}
			</style><img id="hero" width="100" height="100" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3C/svg%3E">
			<div class="rail"><div class="spacer"></div>${ card( 'clipped', true ) }</div>
			<div class="rail"><div class="spacer far"></div>${ card( 'far', true ) }${ card( 'intrinsic', false ) }</div>` );
			const observe = () => observePage( page, page.url(), 390, 0, null, undefined, undefined, true, true );
			const source = await observe();
			expect( source.images ).toHaveLength( 1 );
			expect( source.images[ 0 ].decoded ).toBe( true );
			expect( await page.locator( '.far + img' ).evaluate( ( image: HTMLImageElement ) => image.naturalWidth ) ).toBe( 0 );
			// Materialization can leave lazy cards without intrinsic boxes. They
			// must not become missing images when neither side paints the rail.
			await page.locator( '.rail img' ).evaluateAll( images => images.forEach( image => {
				image.removeAttribute( 'width' ); image.removeAttribute( 'height' );
			} ) );
			const copy = await observe();
			expect( scoreViewport( source, copy ).pass ).toBe( true );
			await page.locator( '#hero' ).evaluate( ( image: HTMLImageElement ) => { image.src = 'https://fixture.test/broken.png'; } );
			const broken = await observe();
			expect( broken.images ).toHaveLength( 1 );
			expect( scoreViewport( source, broken ).failures ).toContain( 'images 1 visible image(s) pending or failed decoding' );
			expect( scoreViewport( broken, broken ).pass ).toBe( true );
		} finally { await browser.close(); }
	}, 30_000 );
} );
