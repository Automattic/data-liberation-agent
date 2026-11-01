import { describe, expect, it } from 'vitest';
import { isPlatformDefaultIconLink, platformDefaultIcon, withoutPlatformDefaultIcons } from './platform-default-icons.js';

describe( 'platformDefaultIcon', () => {
	it( 'recognizes the default icons builders serve when the owner set none', () => {
		// Free *.wixsite.com address, e.g. ellenbauer37.wixsite.com/my-site-2.
		expect( platformDefaultIcon( 'https://www.wix.com/favicon.ico' ) ).toBe( 'wix' );
		expect( platformDefaultIcon( '//www.wix.com/favicon.ico', 'https://ellenbauer37.wixsite.com/my-site-2' ) ).toBe( 'wix' );
		expect( platformDefaultIcon( 'https://wix.com/favicon.ico?v=2' ) ).toBe( 'wix' );
		// Premium / custom-domain Wix site without a custom favicon.
		expect( platformDefaultIcon( 'https://static.parastorage.com/client/pfavico.ico' ) ).toBe( 'wix' );
		expect( platformDefaultIcon( 'https://assets.squarespace.com/universal/default-favicon.ico' ) ).toBe( 'squarespace' );
	} );

	it( 'keeps owner-uploaded icons and same-named icons on the site itself', () => {
		for ( const href of [
			'https://static.wixstatic.com/media/c168cb_c77720d3c05749e98d353649a6071c07%7Emv2.png/v1/fill/w_192%2Ch_192%2Clg_1%2Cusm_0.66_1.00_0.01/c168cb_c77720d3c05749e98d353649a6071c07%7Emv2.png',
			'https://images.squarespace-cdn.com/content/v1/5eeec8df68ff731f41b309d7/1595661589006-TA44GLBBEKV0TBM6LBX2/favicon.ico?format=100w',
			'https://static.parastorage.com/services/some-app/favicon.ico',
			'https://www.wix.com.example.org/favicon.ico',
			'/favicon.ico',
			'data:image/x-icon;base64,AA',
			'not a url',
		] ) expect( platformDefaultIcon( href, 'https://example.wixsite.com/site' ) ).toBeUndefined();
	} );
} );

describe( 'isPlatformDefaultIconLink', () => {
	it( 'matches every icon relation Wix emits and nothing that is not an icon', () => {
		for ( const rel of [ 'icon', 'shortcut icon', 'apple-touch-icon', 'mask-icon', 'ICON' ] )
			expect( isPlatformDefaultIconLink( rel, 'https://www.wix.com/favicon.ico' ) ).toBe( true );
		expect( isPlatformDefaultIconLink( 'preload', 'https://www.wix.com/favicon.ico' ) ).toBe( false );
		expect( isPlatformDefaultIconLink( 'icon', undefined ) ).toBe( false );
	} );
} );

describe( 'withoutPlatformDefaultIcons', () => {
	it( 'removes every default icon link from a captured Wix document and leaves others byte-identical', () => {
		const html = '<html><head><link rel="icon" sizes="192x192" href="https://www.wix.com/favicon.ico" type="image/x-icon"><link rel="shortcut icon" href="https://www.wix.com/favicon.ico" type="image/x-icon"><link rel="apple-touch-icon" href="https://www.wix.com/favicon.ico" type="image/x-icon"><link rel="mask-icon" href="https://www.wix.com/favicon.ico"><!-- <link rel="mask-icon" href="https://www.wix.com/favicon.ico"> --><!-- Segmenter Polyfill --><link rel="stylesheet" href="https://static.parastorage.com/site.css"></head><body><a href="https://www.wix.com/favicon.ico">x</a></body></html>';
		const result = withoutPlatformDefaultIcons( html, 'https://ellenbauer37.wixsite.com/my-site-2' );
		expect( result ).not.toMatch( /<link[^>]*favicon/ );
		expect( result ).not.toContain( '<!-- <link' );
		expect( result ).toContain( '<!-- Segmenter Polyfill -->' );
		expect( result ).toContain( 'rel="stylesheet"' );
		expect( result ).toContain( '<a href="https://www.wix.com/favicon.ico">' );
		const custom = '<html><head><link rel="icon" href="https://static.wixstatic.com/media/c168cb_c777%7Emv2.png"></head><body></body></html>';
		expect( withoutPlatformDefaultIcons( custom, 'https://www.example.com/' ) ).toBe( custom );
		const relative = '<html><head><link rel="icon" href="/favicon.ico"></head><body>wix.com</body></html>';
		expect( withoutPlatformDefaultIcons( relative, 'https://www.example.com/' ) ).toBe( relative );
	} );
} );
