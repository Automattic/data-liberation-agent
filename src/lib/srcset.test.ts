import { describe, expect, it } from 'vitest';
import { srcsetCandidates, srcsetReferences } from './srcset.js';

describe( 'shared srcset tokenization', () => {
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
