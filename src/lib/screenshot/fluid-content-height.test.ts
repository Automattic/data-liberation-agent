import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { learnAndApplyFluidGeometry } from './fluid-capture.js';

// One browser pass, approximately 10 seconds. Wrapping changes irregularly
// within a column regime: unlike a fixed-height grid this cannot fit every run.
it( 'bounds unfitted content heights to their observed widths instead of freezing desktop', async () => {
	const browser = await chromium.launch();
	try {
		const source = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		await source.setContent( await readFile( new URL( './fixtures/content-fitted-height.html', import.meta.url ), 'utf8' ) );
		const widths = [ 390, 768, 1440 ];
		const expected = new Map<number, number>();
		for ( const width of widths ) {
			await source.setViewportSize( { width, height: 900 } );
			await source.waitForFunction( () => Math.abs( document.querySelector( '.wrap' )!.getBoundingClientRect().height - document.querySelector( '.grid' )!.getBoundingClientRect().height ) < 1 );
			expected.set( width, await source.locator( 'footer' ).evaluate( node => node.getBoundingClientRect().top ) );
		}
		const result = await learnAndApplyFluidGeometry( source, { settleMs: 10 } );
		expect( result.unmodelled ).toBe( 0 );
		expect( await source.locator( '.wrap' ).evaluate( node => ( node as HTMLElement ).style.height ) ).toBe( '' );
		await source.locator( 'script' ).evaluateAll( nodes => nodes.forEach( node => node.remove() ) );
		const copy = await browser.newPage( { javaScriptEnabled: false } );
		await copy.setContent( await source.content() );
		for ( const width of widths ) {
			await copy.setViewportSize( { width, height: 900 } );
			expect( await copy.locator( 'footer' ).evaluate( node => node.getBoundingClientRect().top ) ).toBeCloseTo( expected.get( width )!, 0 );
			expect( await copy.locator( '.wrap' ).evaluate( node => node.getBoundingClientRect().height - node.firstElementChild!.getBoundingClientRect().height ) ).toBeCloseTo( 0, 0 );
		}
	} finally { await browser.close(); }
}, 30_000 );
