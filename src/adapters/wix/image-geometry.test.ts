import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { learnAndApplyFluidGeometry } from '../../lib/screenshot/fluid-capture.js';
import { wixAdapter } from './index.js';
import { wixImageGeometry } from './image-geometry.js';

const info = ( displayMode: string, alignType = 'center' ) =>
	JSON.stringify( { containerId: 'comp-a', alignType, displayMode, targetWidth: 980, targetHeight: 715, imageData: { width: 3658, height: 1446, uri: 'a.jpg', displayMode } } );

describe( 'wixImageGeometry', () => {
	it( 'maps the display modes whose image fills its container', () => {
		expect( wixImageGeometry( info( 'fill' ) ) ).toEqual( { objectFit: 'cover', objectPosition: '50% 50%' } );
		expect( wixImageGeometry( info( 'fit', 'top_left' ) ) ).toEqual( { objectFit: 'contain', objectPosition: '0% 0%' } );
	} );

	it( 'declines modes, alignments and declarations it cannot prove', () => {
		expect( wixImageGeometry( info( 'tile' ) ) ).toBeNull();
		expect( wixImageGeometry( info( 'fill', 'custom' ) ) ).toBeNull();
		expect( wixImageGeometry( JSON.stringify( { alignType: 'center', displayMode: 'fill', imageData: { displayMode: 'fit' } } ) ) ).toBeNull();
		expect( wixImageGeometry( 'not json' ) ).toBeNull();
		expect( wixImageGeometry( null ) ).toBeNull();
	} );
} );

/**
 * The runtime as measured on a live Wix page: a `<wow-image>` host whose
 * resize observer writes its box onto the `<img>` in whole pixels, with the
 * fit and position its declaration stands for, until `unobserveResize()`.
 */
const page = ( displayMode: string ) => `<style>body{margin:0}section{width:100%}wow-image{display:block;width:100%;height:40vw}</style>
	<section id="comp-a"><wow-image id="img_comp-a" data-image-info='${ info( displayMode ) }'><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></wow-image></section>
	<script>
		const fit = { fill: 'cover', fit: 'contain', tile: 'none' };
		customElements.define( 'wow-image', class extends HTMLElement {
			connectedCallback() { this.observer = new ResizeObserver( () => this.reLayout() ); this.observer.observe( this ); this.reLayout(); }
			unobserveResize() { this.observer.disconnect(); }
			reLayout() {
				const box = this.getBoundingClientRect();
				const mode = JSON.parse( this.dataset.imageInfo ).displayMode;
				this.querySelector( 'img' ).setAttribute( 'style', 'width:' + Math.round( box.width ) + 'px;height:' + Math.round( box.height ) + 'px;object-fit:' + fit[ mode ] + ';object-position:50% 50%' );
			}
		} );
	</script>`;

describe( 'wix beforeFluid image geometry', () => {
	let browser: Browser;
	beforeAll( async () => { browser = await chromium.launch(); } );
	afterAll( async () => { await browser.close(); } );

	it( 'carries a declared fill image as container-relative CSS the width sweep has nothing to learn from', async () => {
		const tab = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await tab.setContent( page( 'fill' ) );
			await tab.waitForFunction( () => document.querySelector( 'img' )?.style.width === `${ innerWidth }px` );
			await wixAdapter.liberation!.beforeFluid!( tab, { url: 'https://example.com/', viewport: 'desktop' } );
			const learned = await learnAndApplyFluidGeometry( tab, { settleMs: 10 } );
			expect( learned.sampledWidths ).toEqual( [] );
			expect( await tab.locator( 'img' ).getAttribute( 'style' ) ).toBe( 'width: 100%; height: 100%; object-fit: cover; object-position: 50% 50%;' );
			for ( const width of [ 390, 768, 1440 ] ) {
				await tab.setViewportSize( { width, height: 900 } );
				const [ image, host ] = await tab.evaluate( () => [ 'img', 'wow-image' ].map( selector => {
					const box = document.querySelector( selector )!.getBoundingClientRect();
					return [ box.x, box.y, box.width, box.height ];
				} ) );
				image!.forEach( ( value, index ) => expect( Math.abs( value - host![ index ]! ) ).toBeLessThanOrEqual( 1 ) );
			}
			expect( await tab.locator( 'img' ).getAttribute( 'style' ) ).toContain( 'width: 100%' );
		} finally {
			await tab.close();
		}
	}, 30_000 );

	it( 'leaves an image whose declared mode is not provably container-relative to the sweep', async () => {
		const tab = await browser.newPage( { viewport: { width: 1440, height: 900 } } );
		try {
			await tab.setContent( page( 'tile' ) );
			await tab.waitForFunction( () => document.querySelector( 'img' )?.style.width === `${ innerWidth }px` );
			const before = await tab.locator( 'img' ).getAttribute( 'style' );
			await wixAdapter.liberation!.beforeFluid!( tab, { url: 'https://example.com/', viewport: 'desktop' } );
			expect( await tab.locator( 'img' ).getAttribute( 'style' ) ).toBe( before );
		} finally {
			await tab.close();
		}
	}, 30_000 );
} );
