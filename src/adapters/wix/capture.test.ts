import { load } from 'cheerio';
// @ts-expect-error jsdom is already a test dependency but publishes no declarations here.
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
	capture,
	preserveWixSlideshowSlides,
	stripShowcaseMarkup,
	wixMediaVariant,
	wixStaticMediaUrl,
	WIX_CAPTURE_CHROME_SELECTOR,
} from './capture.js';
import { wixAdapter } from './index.js';

const variant =
	'https://static.wixstatic.com/media/8e80e7_e9cc2e6993d7493ca165d9fa3e8f503d~mv2.jpg/v1/fill/w_390,h_844,al_c/8e80e7_e9cc2e6993d7493ca165d9fa3e8f503d~mv2.jpg';

describe( 'wixMediaVariant', () => {
	it( 'recognises a runtime-swapped crop and keys it by stable media id', () => {
		expect( wixMediaVariant( variant ) ).toEqual( {
			id: '8e80e7_e9cc2e6993d7493ca165d9fa3e8f503d',
			url: variant,
		} );
	} );

	it( 'keys crops of the same asset identically, so viewports can be paired', () => {
		const desktop = variant.replace( 'w_390,h_844', 'w_1440,h_940' );
		expect( wixMediaVariant( desktop )?.id ).toBe( wixMediaVariant( variant )?.id );
	} );

	it( 'ignores a Wix URL that is not a fill variant', () => {
		expect(
			wixMediaVariant(
				'https://static.wixstatic.com/media/8e80e7_e9cc2e6993d7493ca165d9fa3e8f503d~mv2.jpg'
			)
		).toBeNull();
	} );

	it( 'ignores images from other hosts', () => {
		expect( wixMediaVariant( 'https://cdn.example.com/v1/fill/w_390,h_844/photo.jpg' ) ).toBeNull();
	} );

	it( 'ignores empty and local URLs', () => {
		expect( wixMediaVariant( '' ) ).toBeNull();
		expect( wixMediaVariant( '/media/local.avif' ) ).toBeNull();
	} );
} );

describe( 'stripShowcaseMarkup', () => {
	it( 'builds an inner CSS slideshow that fills the captured TPA host box', () => {
		expect( wixStaticMediaUrl( '648e62_abc~mv2.jpg' ) ).toBe(
			'https://static.wixstatic.com/media/648e62_abc~mv2.jpg'
		);
		const { html, css } = stripShowcaseMarkup(
			[
				{ uri: '648e62_one.jpg', title: 'One' },
				{ uri: '648e62_two.jpg', alt: 'Two' },
			],
			{ width: 1340, height: 486 }
		);
		expect( html ).toContain(
			'<img src="https://static.wixstatic.com/media/648e62_one.jpg/v1/fill/w_1340,h_486'
		);
		expect( html ).toContain(
			'<img src="https://static.wixstatic.com/media/648e62_two.jpg/v1/fill/w_1340,h_486'
		);
		expect( html ).toContain( 'alt="One"' );
		expect( html ).toContain( 'alt="Two"' );
		expect( html ).toContain( 'class="dla-slideshow"' );
		expect( html ).toMatch( /^<div class="dla-slideshow">/ );
		expect( html ).not.toContain( '<iframe' );
		expect( html ).not.toMatch( /style="[^"]*(?:width|height):\d+px/ );
		expect( css ).toContain(
			'.dla-slideshow{overflow:hidden;width:100%;height:100%;position:relative}'
		);
		expect( css ).toContain(
			'.dla-slideshow-track{display:flex;height:100%;animation:dla-slideshow'
		);
		expect( css ).toContain( '@keyframes dla-slideshow' );
	} );
} );

describe( 'WIX_CAPTURE_CHROME_SELECTOR', () => {
	it( 'removes Wix overflow and accessibility helpers while preserving authored More controls', () => {
		const $ = load( `
			<nav>
				<button id="authored-more">More</button>
				<li id="menu__more__" aria-hidden="true"><p id="menu__more__label">More</p></li>
				<span id="menu-hiddenA11ySubMenuIndication">Use tab to navigate</span>
			</nav>
			<div id="WIX_ADS">Built with Wix</div>
		` );

		$( WIX_CAPTURE_CHROME_SELECTOR ).remove();

		expect( $( '#menu__more__' ) ).toHaveLength( 0 );
		expect( $( '#menu-hiddenA11ySubMenuIndication' ) ).toHaveLength( 0 );
		expect( $( '#WIX_ADS' ) ).toHaveLength( 0 );
		expect( $( '#authored-more' ).text() ).toBe( 'More' );
	} );
} );

describe( 'preserveWixSlideshowSlides', () => {
	it( 'keeps complete content from two runtime-mounted slideshow states in static HTML', () => {
		const dom = new JSDOM( `<!doctype html><html><head></head><body>
			<div class="wixui-slideshow"><button data-testid="nextButton">Next</button><div data-testid="slidesWrapper"><article><h2>First review</h2><p>First complete testimonial.</p><img src="first.jpg" alt="First"></article></div></div>
		</body></html>` );
		const originalDocument = globalThis.document;
		Object.defineProperty( globalThis, 'document', { configurable: true, value: dom.window.document } );
		try {
			preserveWixSlideshowSlides( {
				slideshowIndex: 0,
				slides: [
					'<article><h2>First review</h2><p>First complete testimonial.</p><img src="first.jpg" alt="First"></article>',
					'<article><h2>Second review</h2><p>Second complete testimonial.</p><img src="second.jpg" alt="Second"></article>',
				],
			} );

			const slides = dom.window.document.querySelectorAll( '[data-dla-captured-slide]' );
			expect( slides ).toHaveLength( 2 );
			expect( slides[ 0 ]?.textContent ).toContain( 'First complete testimonial.' );
			expect( slides[ 1 ]?.textContent ).toContain( 'Second complete testimonial.' );
			expect( slides[ 1 ]?.querySelector( 'img' )?.getAttribute( 'src' ) ).toBe( 'second.jpg' );
			expect( slides[ 0 ]?.getAttribute( 'role' ) ).toBe( 'listitem' );
			expect( dom.window.document.querySelector( '[data-testid="slidesWrapper"]' )?.getAttribute( 'role' ) ).toBe( 'list' );
			expect( dom.window.document.querySelector( '.wixui-slideshow' )?.getAttribute( 'data-dla-captured-slideshow' ) ).toBe( 'true' );
			expect( dom.window.document.querySelector( '#dla-wix-captured-slideshow-css' )?.textContent ).toContain( 'display:none!important' );
		} finally {
			Object.defineProperty( globalThis, 'document', { configurable: true, value: originalDocument } );
		}
	} );
} );

describe( 'wix capture', () => {
	it( 'declares platform chrome removal selectors', () => {
		expect( capture.removeSelectors ).toEqual( [
			'[id="WIX_ADS"]',
			'[id$="-hiddenA11ySubMenuIndication"]',
		] );
	} );

	it( 'is attached to the adapter', () => {
		expect( wixAdapter.liberation ).toBe( capture );
	} );
} );
