import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { resolveDocumentReferences } from './document-resource-base.js';
import { assembleResponsiveCapture } from './responsive-assembly.js';
import { correspondenceMerge, RESPONSIVE_MOBILE_ONLY_CLASS } from './viewport-correspondence.js';

describe( 'viewport URL correspondence', () => {
	it( 'does not let stable ids collapse different browser-base destinations', () => {
		const html = '<html><head></head><body><main id="main"><h1>Shared</h1><a id="next" href="next">Next</a></main></body></html>';
		const desktop = resolveDocumentReferences( html, 'https://source.test/albums/', 'https://source.test/assets/' );
		const mobile = resolveDocumentReferences( html, 'https://source.test/albums/', 'https://source.test/phone-assets/' );
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml: desktop, rawMobileHtml: mobile,
			portableDesktopHtml: desktop, portableMobileHtml: mobile,
		} );
		const $ = cheerio.load( assembly.html );
		expect( $( 'a' ).map( ( _, node ) => $( node ).attr( 'href' ) ).get() ).toEqual( [
			'https://source.test/assets/next', 'https://source.test/phone-assets/next',
		] );
	} );

	it( 'keeps destinations resolved against distinct browser bases unique, even when children match', () => {
		const html = '<html><body><h1>Shared</h1><a href="next"><span>Next</span></a></body></html>';
		const desktop = resolveDocumentReferences( html, 'https://source.test/albums/', 'https://source.test/assets/' );
		const mobile = resolveDocumentReferences( html, 'https://source.test/albums/', 'https://source.test/phone-assets/' );
		// A wrapper holding matched content cannot safely merge different destinations.
		expect( correspondenceMerge( desktop, mobile, 767 ) ).toBeUndefined();
	} );

	it( 'does not positionally pair links with different resolved destinations', () => {
		const html = '<html><body><h1>Shared</h1><a href="next">Next</a></body></html>';
		const desktop = resolveDocumentReferences( html, 'https://source.test/albums/', 'https://source.test/assets/' );
		const mobile = resolveDocumentReferences( html, 'https://source.test/albums/', 'https://source.test/phone-assets/' );
		const merged = correspondenceMerge( desktop, mobile, 767 );
		expect( merged ).toBeDefined();
		const $ = cheerio.load( merged!.body );
		expect( $( 'a' ).map( ( _, node ) => $( node ).attr( 'href' ) ).get() ).toEqual( [
			'https://source.test/assets/next', 'https://source.test/phone-assets/next',
		] );
		expect( $( `a.${ RESPONSIVE_MOBILE_ONLY_CLASS }` ).length ).toBe( 1 );
	} );

	it( 'places phone-only siblings after matching chrome, ignoring inert source scripts', () => {
		const desktop = '<body><h1>Home</h1><a href="/second/">Second</a><script>/* source runtime */</script><footer><a href="/footer/">Footer</a></footer></body>';
		const mobile = desktop.replace( '</body>', '<a href="/phone/">Phone</a></body>' );
		const merged = correspondenceMerge( desktop, mobile, 767 );
		expect( merged ).toBeDefined();
		const $ = cheerio.load( merged!.body );
		expect( $( 'body' ).children().map( ( _, node ) => node.tagName ).get() ).toEqual( [ 'h1', 'a', 'script', 'footer', 'a' ] );
		expect( $( 'footer' ).next().attr( 'href' ) ).toBe( '/phone/' );
	} );
} );
