import { describe, expect } from 'vitest';
import { it } from '../../../test/browser.js';

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

	it( 'carries a declared fill image as container-relative CSS the width sweep has nothing to learn from', async ({ newPage }) => {
		const tab = await newPage( { viewport: { width: 1440, height: 900 } } );
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

	it( 'restores missing Wix image sources without changing hydrated images', async ({ newPage }) => {
		const tab = await newPage();
		try {
			await tab.setContent('<!doctype html><html><body><main><a href="/post/"><div><wow-image data-image-info="{&quot;displayMode&quot;:&quot;fill&quot;,&quot;targetWidth&quot;:450,&quot;targetHeight&quot;:253,&quot;imageData&quot;:{&quot;width&quot;:1200,&quot;height&quot;:750,&quot;uri&quot;:&quot;9820c7_ead8a9bee4d04fc7bd3ef3a50ff53949~mv2.png&quot;,&quot;displayMode&quot;:&quot;fill&quot;}}"><img alt="Thumb"></wow-image></div></a><wow-image data-image-info="{}"><img src="kept.png"></wow-image></main></body></html>');
			await wixAdapter.liberation!.beforeFluid!( tab, { url: 'https://example.com/', viewport: 'desktop' } );
			expect( await tab.locator( 'wow-image img' ).first().getAttribute( 'src' ) ).toMatch( /^https:\/\/static\.wixstatic\.com\/media\/9820c7_ead8a9bee4d04fc7bd3ef3a50ff53949~mv2\.png/ );
			expect( await tab.locator( 'wow-image img' ).first().getAttribute( 'width' ) ).toBe( '450' );
			expect( await tab.locator( 'wow-image img' ).nth( 1 ).getAttribute( 'src' ) ).toBe( 'kept.png' );
		} finally { await tab.close(); }
	}, 30_000 );

	it( 'replaces a slide still on its blurred placeholder with its declared source before serialization', async ({ newPage }) => {
		const tab = await newPage();
		try {
			const media = 'a1b2c3_0123456789abcdef0123456789abcdef~mv2.jpg';
			const blur = `https://static.wixstatic.com/media/${ media }/v1/fill/w_78,h_52,al_c,q_80,usm_0.66_1.00_0.01,blur_2,enc_avif,quality_auto/${ media }`;
			const sharp = `https://static.wixstatic.com/media/${ media }/v1/fill/w_1440,h_348,al_c,q_85,enc_avif,quality_auto/${ media }`;
			const declared = JSON.stringify( { containerId: 'comp-a', alignType: 'center', displayMode: 'fill', targetWidth: 1189, targetHeight: 348, isLQIP: true, imageData: { width: 6000, height: 4000, uri: media, displayMode: 'fill' } } ).replace( /"/g, '&quot;' );
			await tab.setContent( `<!doctype html><html><body><main><div data-blocks-engine-capture-captured-slide="1"><wow-image data-image-info="${ declared }"><img src="${ blur }" width="1189" height="348" alt="Slide"></wow-image></div><wow-image data-image-info="${ declared }"><img src="${ sharp }" alt="Hydrated"></wow-image></main></body></html>` );
			await wixAdapter.liberation!.beforeSerialize!( tab, { url: 'https://example.com/', viewport: 'desktop', serverHtml: '<html></html>' } );
			expect( await tab.locator( 'img[alt="Slide"]' ).getAttribute( 'src' ) ).toBe( `https://static.wixstatic.com/media/${ media }/v1/fill/w_1189,h_348,al_c,q_85,enc_avif,quality_auto/${ media }` );
			expect( await tab.locator( 'img[alt="Hydrated"]' ).getAttribute( 'src' ) ).toBe( sharp );
		} finally { await tab.close(); }
	}, 30_000 );

	it( 'leaves an image whose declared mode is not provably container-relative to the sweep', async ({ newPage }) => {
		const tab = await newPage( { viewport: { width: 1440, height: 900 } } );
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

describe( 'serialized Wix image sources', () => {
	const media = 'a1b2c3_0123456789abcdef0123456789abcdef~mv2.jpg';
	const blur = `https://static.wixstatic.com/media/${ media }/v1/fill/w_147,h_82,al_c,q_80,usm_0.66_1.00_0.01,blur_2,enc_avif,quality_auto/${ media }`;
	const sharp = `https://static.wixstatic.com/media/${ media }/v1/fill/w_700,h_391,al_c,q_80,enc_avif,quality_auto/${ media }`;
	const attr = ( value: object ) => JSON.stringify( value ).replace( /"/g, '&quot;' );
	// A gallery widget re-rendered after the live normalization: its images are
	// back on their placeholders when the document is serialized.
	const remounted = attr( { displayMode: 'fit', isLQIP: true, encoding: 'AVIF', imageData: { width: 2752, height: 1536, uri: media, name: '', displayMode: 'fit' } } );
	const targeted = attr( { displayMode: 'fill', alignType: 'center', targetWidth: 700, targetHeight: 391, isLQIP: true, imageData: { width: 2752, height: 1536, uri: media, displayMode: 'fill' } } );
	const canonicalize = ( html: string ) => wixAdapter.liberation!.canonicalizeHtml!( html );

	it( 'points a declared image still on its blurred placeholder at its declared source', () => {
		const html = `<main><wow-image class="image" data-image-info="${ remounted }" data-has-ssr-src=""><img src="${ blur }" alt="Item" style="width: 700px; height: 391px; object-fit: contain;"></wow-image>`
			+ `<wow-image data-image-info="${ targeted }"><img src="${ blur.replace( /&/g, '&amp;' ) }" alt="Cover"></wow-image></main>`;
		const out = canonicalize( html );
		expect( out ).not.toContain( 'blur_2' );
		expect( out ).toContain( `<img src="https://static.wixstatic.com/media/${ media }" alt="Item" style="width: 700px; height: 391px; object-fit: contain;">` );
		expect( out ).toContain( `<img src="https://static.wixstatic.com/media/${ media }/v1/fill/w_700,h_391,al_c,q_85,enc_avif,quality_auto/${ media }" alt="Cover">` );
	} );

	it( 'leaves hydrated, undeclared and unnamed images unchanged', () => {
		const unnamed = attr( { displayMode: 'fill', imageData: { width: 10, height: 10 } } );
		const html = `<main><wow-image data-image-info="${ remounted }"><img src="${ sharp }" alt="Hydrated"></wow-image>`
			+ `<div><img src="${ blur }" alt="Undeclared"></div>`
			+ `<wow-image data-image-info="${ unnamed }"><img src="${ blur }" alt="Unnamed"></wow-image></main>`;
		expect( canonicalize( html ) ).toBe( html );
	} );
} );
