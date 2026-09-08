import { load } from 'cheerio';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	capture,
	settleWixNavigation,
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

describe( 'wix capture', () => {
	it( 'declares platform chrome removal selectors', () => {
		expect( capture.removeSelectors ).toEqual( [
			'[id="WIX_ADS"]',
			'[id$="-hiddenA11ySubMenuIndication"]',
		] );
	} );

	it( 'settles generated desktop overflow into reachable navigation links', async () => {
		const dom = new JSDOM( `
			<header><ul>
				<li><a href="/">Home</a></li>
				<li id="menu__more__"><div data-testid="linkElement">More</div></li>
				<li aria-hidden="true" style="height:0;overflow:hidden;position:absolute"><a href="/contact/"><span tabindex="-1">Contact</span></a></li>
			</ul></header>
		` );
		vi.stubGlobal( 'document', dom.window.document );
		vi.stubGlobal( 'getComputedStyle', dom.window.getComputedStyle.bind( dom.window ) );
		vi.stubGlobal( 'requestAnimationFrame', ( callback: FrameRequestCallback ) => setTimeout( callback, 0 ) as unknown as number );
		vi.spyOn( dom.window.HTMLElement.prototype, 'getBoundingClientRect' ).mockReturnValue(
			{ width: 10, height: 10 } as DOMRect
		);
		await settleWixNavigation( 'desktop' );

		const contact = dom.window.document.querySelector( 'a[href="/contact/"]' )!;
		expect( dom.window.document.querySelector( '#menu__more__' ) ).toBeNull();
		expect( contact.closest( 'li' )?.getAttribute( 'aria-hidden' ) ).toBeNull();
		expect( contact.closest( 'li' )?.getAttribute( 'style' ) ).toBe( '' );
		expect( contact.querySelector( '[tabindex]' ) ).toBeNull();
	} );

	it( 'settles the mobile drawer into reachable navigation links', async () => {
		const dom = new JSDOM( `
			<header>
				<button id="MENU_AS_CONTAINER_TOGGLE">Menu</button>
				<ul><li aria-hidden="true" style="display:none"><a href="/contact/"><span tabindex="-1">Contact</span></a></li></ul>
			</header>
		` );
		const toggle = dom.window.document.querySelector< HTMLButtonElement >( '#MENU_AS_CONTAINER_TOGGLE' )!;
		const click = vi.spyOn( toggle, 'click' );
		vi.stubGlobal( 'document', dom.window.document );
		vi.stubGlobal( 'getComputedStyle', dom.window.getComputedStyle.bind( dom.window ) );
		vi.stubGlobal( 'requestAnimationFrame', ( callback: FrameRequestCallback ) => setTimeout( callback, 0 ) as unknown as number );
		vi.spyOn( dom.window.HTMLElement.prototype, 'getBoundingClientRect' ).mockReturnValue(
			{ width: 10, height: 10 } as DOMRect
		);
		await settleWixNavigation( 'mobile' );

		const contact = dom.window.document.querySelector( 'a[href="/contact/"]' )!;
		expect( click ).toHaveBeenCalledOnce();
		expect( dom.window.document.querySelector( '#MENU_AS_CONTAINER_TOGGLE' ) ).toBeNull();
		expect( contact.closest( 'li' )?.getAttribute( 'aria-hidden' ) ).toBeNull();
		expect( contact.closest( 'li' )?.getAttribute( 'style' ) ).toBe( '' );
		expect( contact.querySelector( '[tabindex]' ) ).toBeNull();
	} );

	it( 'is attached to the adapter', () => {
		expect( wixAdapter.liberation ).toBe( capture );
	} );
} );

afterEach( () => vi.unstubAllGlobals() );
