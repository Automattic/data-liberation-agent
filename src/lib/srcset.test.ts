import { describe, expect, it } from 'vitest';
import { srcsetCandidates, srcsetReferences } from './srcset.js';
import { preparePortableReplacements, removeDanglingMediaSource } from './portable-references.js';
import { rewriteMediaUrls } from './streaming/media-url-rewrite.js';

describe( 'shared srcset tokenization', () => {
	it( 'recognizes browser-trimmed single URLs while retaining quoted attribute whitespace', () => {
		const url = 'https://source.test/photo.png';
		const mapping = new Map( [ [ url, '/media/photo.png' ], [ 'photo.png', '/media/wrong.png' ] ] );
		for ( const padding of [ ' ', '\t', '\n', '\r\n \t', '\f' ] ) {
			const html = `<img src="${ padding }${ url }${ padding }" data-src='${ padding }${ url }${ padding }'><source src="${ padding }${ url }/:/larger${ padding }">`;
			const expected = `<img src="${ padding }/media/photo.png${ padding }" data-src='${ padding }/media/photo.png${ padding }'><source src="${ padding }${ url }/:/larger${ padding }">`;
			expect( preparePortableReplacements( mapping )( html ) ).toBe( expected );
			expect( rewriteMediaUrls( html, mapping ) ).toBe( expected );
		}
		// Non-ASCII whitespace is URL content rather than removable HTML padding.
		const nonAscii = `<img src="\u00a0${ url }\u00a0">`;
		expect( preparePortableReplacements( mapping )( nonAscii ) ).toBe( nonAscii );
	} );
	it( 'ends descriptorless candidates at trailing commas, not URL-internal commas', () => {
		const urls = [ 720, 480, 320 ].map( size => `/images/square-${ size }x${ size }_scale,w_${ size }.png` );
		expect( srcsetReferences( urls.join( ', ' ) ) ).toEqual( urls );
		expect( srcsetReferences( '/a,b.png,/c,d.png' ) ).toEqual( [ '/a,b.png,/c,d.png' ] );
		expect( srcsetReferences( '/a,b.png , /c,d.png\t2x,/e,f.png 3x' ) ).toEqual( [ '/a,b.png', '/c,d.png', '/e,f.png' ] );
	} );
	it( 'rewrites whole media URL tokens and leaves path prefixes and suffixes intact', () => {
		const first = '/images/square_scale,w_720.png';
		const next = '/images/square_scale,w_480.png';
		const html = `<img src="${ first }" data-srcset="${ first }, ${ next }" srcset="${ first }, ${ next }"><source srcset="${ first } 1x, ${ first }/:/resize,w_900 2x">`;
		const mapping = new Map( [ [ first, '/media/square.png' ], [ 'w_480.png', '/media/wrong.png' ] ] );
		const expected = `<img src="/media/square.png" data-srcset="/media/square.png, ${ next }" srcset="/media/square.png, ${ next }"><source srcset="/media/square.png 1x, ${ first }/:/resize,w_900 2x">`;
		expect( preparePortableReplacements( mapping )( html ) ).toBe( expected );
		expect( rewriteMediaUrls( html, mapping ) ).toBe( expected );
		expect( removeDanglingMediaSource( html, 'w_480.png', 'https://example.test/w_480.png', new Map() ) ).toBe( html );
	} );
	it( 'honors browser descriptor grammar and consumes invalid parenthesized descriptors as one candidate', () => {
		expect( srcsetCandidates( '/width.png 320w 180h, /density.png .5x, /exponent.png 1e1x, /zero.png 0x' ) ).toEqual( [
			{ url: '/width.png', size: 320, density: false },
			{ url: '/density.png', size: .5, density: true },
			{ url: '/exponent.png', size: 10, density: true },
			{ url: '/zero.png', size: 0, density: true },
		] );
		expect( srcsetReferences( '/bad.png (future, descriptor), /negative.png -1x, /duplicate.png 1x 2x, /empty.png 0w, /kept.png 2x' ) ).toEqual( [ '/kept.png' ] );
		expect( srcsetReferences( '/nonbreaking\u00a0space.png, /next.png' ) ).toEqual( [ '/nonbreaking\u00a0space.png', '/next.png' ] );
	} );
	it( 'preserves comma-bearing rendition URLs and width/density ordering', () => {
		const value = ' /photo.jpg/v1/fill/w_320,h_200/a.jpg 320w, /photo.jpg/v1/fill/w_1200,h_800/a.jpg 1200w, /icon.png 1.5x ';
		expect( srcsetCandidates( value ) ).toEqual( [
			{ url: '/photo.jpg/v1/fill/w_320,h_200/a.jpg', size: 320, density: false },
			{ url: '/photo.jpg/v1/fill/w_1200,h_800/a.jpg', size: 1200, density: false },
			{ url: '/icon.png', size: 1.5, density: true },
		] );
		expect( srcsetReferences( value ) ).toEqual( [
			'/photo.jpg/v1/fill/w_320,h_200/a.jpg', '/photo.jpg/v1/fill/w_1200,h_800/a.jpg', '/icon.png',
		] );
	} );
	it( 'keeps descriptorless data and escaped query tokens without normalizing their identity', () => {
		const value = 'data:image/png;base64,AAAA 1x, /image%20one.png?w=1&amp;h=2 2x';
		expect( srcsetReferences( value ) ).toEqual( [ 'data:image/png;base64,AAAA', '/image%20one.png?w=1&amp;h=2' ] );
		expect( srcsetCandidates( ',, /image?rs=w:1160,h:720,, ' ) ).toEqual( [
			{ url: '/image?rs=w:1160,h:720', size: 1, density: false },
		] );
		expect( srcsetCandidates( ' ,\t ' ) ).toEqual( [] );
	} );
} );
