import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as cheerio from 'cheerio';
import { expect, it } from 'vitest';
import { exportWebsiteCapture } from './capture-export.js';
import { MediaStubStore } from './resume-state/index.js';

it.each( [
	{ format: '500w', lazy: true },
	{ format: '300w)', lazy: false },
] )( 'localizes lazy=$lazy background URL format=$format in all three capture documents', ( { format, lazy } ) => {
	const directory = mkdtempSync( join( tmpdir(), 'lazy-background-export-' ) );
	try {
		for ( const folder of [ 'html', 'html-mobile', 'html-middle', 'screenshots', 'media', 'resources' ] ) mkdirSync( join( directory, folder ) );
		const source = 'https://example.test/';
		const url = `https://cdn.test/banner.png?format=${ format }`;
		const bytes = Buffer.from( 'captured image' );
		const imagePath = join( directory, 'media/banner.png' );
		writeFileSync( imagePath, bytes );
		const media = MediaStubStore.load( directory );
		// Older acquisition can also inventory the prefix without the final ')'.
		// That prefix is a different URL; it must never consume the whole token.
		media.markSuccess( lazy ? url : url.slice( 0, -1 ), imagePath );
		media.flush();
		writeFileSync( join( directory, 'resources/banner.png' ), bytes );
		writeFileSync( join( directory, 'resources/manifest.json' ), JSON.stringify( { version: 1, failures: [], resources: { [ url ]: { path: 'resources/banner.png', contentType: 'image/png' } } } ) );
		const entrance = JSON.stringify( { attributes: { style: { before: '', after: `background-image: url("${ url }");` } }, rootMargin: '0px', threshold: [ 0 ], repeat: false } ).replace( /&/g, '&amp;' ).replace( /"/g, '&quot;' );
		for ( const profile of [ 'desktop', 'mobile', 'middle' ] ) {
			const folder = profile === 'desktop' ? 'html' : `html-${ profile }`;
			writeFileSync( join( directory, folder, 'home.html' ), `<html><body class="${ profile }"><main>${ profile === 'mobile' ? '<nav>Phone menu</nav>' : '' }<h1>${ profile }</h1><div data-bg="${ url }" style="background-image: url(&quot;${ url }&quot;)" ${ lazy ? `data-blocks-engine-capture-viewport-entrance="${ entrance }"` : '' }></div></main></body></html>` );
		}
		writeFileSync( join( directory, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { [ source ]: { slug: 'home', html: 'html/home.html', profiles: { middle: { html: 'html-middle/home.html' } }, deviceMode: { mode: 'dual', switchWidth: 767, middleLayout: { minWidth: 768, maxWidth: 1279 } } } } } ) );
		exportWebsiteCapture( { outputDir: directory, sourceUrl: source, platform: 'wix', summary: {}, failures: [] } );
		const html = readFileSync( join( directory, 'website/index.html' ), 'utf8' );
		const $ = cheerio.load( html );
		expect( $( '[data-bg]' ) ).toHaveLength( 3 );
		$( '[data-bg]' ).each( ( _, element ) => {
			const local = $( element ).attr( 'data-bg' )!;
			expect( local ).toMatch( /^\/media\// );
			expect( $( element ).attr( 'style' ) ).toContain( `url("${ local }")` );
			expect( existsSync( join( directory, 'website', local ) ) ).toBe( true );
			expect( readFileSync( join( directory, 'website', local ) ) ).toEqual( bytes );
		} );
	} finally { rmSync( directory, { recursive: true, force: true } ); }
} );
