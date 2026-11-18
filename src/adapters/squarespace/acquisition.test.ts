import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { squarespaceAdapter } from './index.js';
import { squarespaceAcquisition } from './acquisition.js';

const context = { url: 'https://fixture.squarespace.com/blog/post', finalUrl: 'https://fixture.squarespace.com/blog/post', variant: 'desktop' };

describe( 'Squarespace server acquisition', () => {
	it( 'declares a desktop profile and retains full editorial content without runtime execution', async () => {
		expect( squarespaceAdapter.acquisition ).toBe( squarespaceAcquisition );
		expect( squarespaceAcquisition.exportVariants?.desktop ).toBe( 'desktop' );
		expect( squarespaceAcquisition.variants[ 0 ]!.headers?.[ 'User-Agent' ] ).not.toMatch( /Mobile/ );
		const result = await squarespaceAcquisition.prepare( `<html><head><title>Post title</title>
			<script>var SQUARESPACE_CONTEXT = {};</script><script src="/runtime.js"></script>
			<script type="application/ld+json">{"name":"Post title"}</script>
			<script type="application/json">invalid</script></head><body>
			<main><article><h1>Post title</h1><div class="sqs-html-content"><p>Full post body</p>
			<img src="/placeholder.gif" data-src="https://images.squarespace-cdn.com/photo.jpg" onload="run()">
			<a href="/blog/next" onclick="navigate()">Next post</a></div></article></main></body></html>`, context );
		expect( result ).toBeDefined();
		const $ = cheerio.load( result!.html );
		expect( $( 'article' ).text() ).toContain( 'Full post body' );
		expect( $( 'script' ) ).toHaveLength( 1 );
		expect( JSON.parse( $( 'script' ).text() ) ).toEqual( { name: 'Post title' } );
		expect( $( '[onclick], [onload]' ) ).toHaveLength( 0 );
		expect( $( 'img' ).attr( 'src' ) ).toBe( 'https://images.squarespace-cdn.com/photo.jpg' );
		expect( $( 'a' ).attr( 'href' ) ).toBe( '/blog/next' );
		expect( result!.metadata ).toMatchObject( { rendering: 'unverified', interactions: 'unverified', variant: 'desktop' } );
	} );

	it( 'declines foreign, empty and runtime-only documents', async () => {
		for ( const html of [ '<main>Foreign document</main>', '<script>SQUARESPACE_CONTEXT={}</script><main></main>', '<script>SQUARESPACE_CONTEXT={}</script><main><script>mount()</script></main>' ] ) {
			expect( await squarespaceAcquisition.prepare( html, context ) ).toBeUndefined();
		}
	} );
} );
