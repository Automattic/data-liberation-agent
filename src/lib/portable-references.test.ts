import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { localizeMetadataImageReferences, preparePortableReplacements } from './portable-references.js';

describe( 'localizeMetadataImageReferences', () => {
	it( 'localizes Squarespace lazy galleries and product variants without bypassing ordinary image rewrites', () => {
		const documentUrl = 'https://shop.example.test/products/sticker';
		const gallery = 'https://images.squarespace-cdn.com/content/gallery.jpg';
		const normal = 'https://images.squarespace-cdn.com/content/normal.jpg';
		const large = 'https://images.squarespace-cdn.com/content/normal-large.jpg';
		const variant = 'https://images.squarespace-cdn.com/content/variant.jpg';
		const paths = new Map( [
			[ gallery, 'website/media/gallery.webp' ],
			[ normal, 'website/media/normal.webp' ],
			[ large, 'website/media/normal-large.webp' ],
			[ variant, 'website/media/variant.webp' ],
		] );
		const rewrite = preparePortableReplacements( new Map(
			[ ...paths ].map( ( [ source, path ] ) => [ source, `/${ path.slice( 'website/'.length ) }` ] )
		) );
		const html = `<html><body>
			<img class="product-gallery-slides-item-image" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" data-src="${ gallery }" data-image="${ gallery }">
			<img id="normal" src="${ normal }" srcset="${ normal } 400w, ${ large } 800w">
			<script type="application/ld+json">${ JSON.stringify( {
				'@context': 'https://schema.org', '@type': 'ProductGroup',
				hasVariant: [ { '@type': 'Product', image: variant } ],
			} ) }</script>
		</body></html>`;
		const $ = cheerio.load( localizeMetadataImageReferences(
			html, documentUrl, paths, content => rewrite( content, documentUrl )
		) );
		const lazy = $( '.product-gallery-slides-item-image' );
		for ( const attribute of [ 'data-src', 'data-image', 'src' ] ) {
			expect( lazy.attr( attribute ) ).toBe( '/media/gallery.webp' );
		}
		expect( $( '#normal' ).attr( 'src' ) ).toBe( '/media/normal.webp' );
		expect( $( '#normal' ).attr( 'srcset' ) ).toBe( '/media/normal.webp 400w, /media/normal-large.webp 800w' );
		expect( JSON.parse( $( 'script' ).text() ).hasVariant[ 0 ].image ).toBe( '/media/variant.webp' );
	} );
} );

describe( 'preparePortableReplacements', () => {
	it( 'resolves URL attributes to captured identities while preserving fragments', () => {
		const rewrite = preparePortableReplacements( new Map( [
			[ 'https://example.test/icons/sprite.svg?v=1&theme=dark', '/assets/sprite.svg' ],
		] ) );
		const html = '<svg><use href="../icons/sprite.svg?v=1&amp;theme=dark#a"/><use xlink:href="https://example.test/icons/sprite.svg?v=1&amp;theme=dark#b"/><use href="#inline"/><use href="https://other.test/icons/sprite.svg?v=1&amp;theme=dark#a"/><use href="../icons/sprite.svg?v=2#a"/></svg>';
		expect( rewrite( html, 'https://example.test/news/' ) ).toBe(
			'<svg><use href="/assets/sprite.svg#a"/><use xlink:href="/assets/sprite.svg#b"/><use href="#inline"/><use href="https://other.test/icons/sprite.svg?v=1&amp;theme=dark#a"/><use href="../icons/sprite.svg?v=2#a"/></svg>'
		);
	} );
} );
