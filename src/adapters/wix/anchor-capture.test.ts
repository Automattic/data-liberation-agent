import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { capture } from './capture.js';

describe.skipIf( ! existsSync( chromium.executablePath() ) )( 'Wix runtime anchor capture', () => {
	it.each( [ 0, 600, -1 ] )( 'observes scroll from a trusted click with delay %i', async ( delay ) => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			await page.route( 'https://anchor.test/**', ( route ) => route.fulfill( {
				contentType: 'text/html',
				body: `<style>body{margin:0}nav{position:fixed;top:0;z-index:5}section{height:1000px}</style>
					<nav><a href="#runtime-section">Section</a></nav>
					<section>First</section><section id="section-source">Destination</section><section>Last</section>
					<script>document.querySelector('a').addEventListener('click', event => {
						event.preventDefault();
						if (!event.isTrusted || ${ delay } < 0) return;
						const move = () => window.scrollTo({top:1000,behavior:'instant'});
						if (${ delay } === 0) move(); else setTimeout(move, ${ delay });
					});</script>`,
			} ) );
			await page.goto( 'https://anchor.test/' );
			await capture.prepare!( page, { url: page.url(), viewport: 'desktop' } );
			if ( delay < 0 ) {
				expect( await page.locator( '#runtime-section' ).count() ).toBe( 0 );
				expect( await page.locator( 'a' ).getAttribute( 'data-dla-anchor-unresolved' ) ).toContain( 'did not move' );
			} else {
				expect( await page.locator( '#runtime-section' ).count() ).toBe( 1 );
				expect( await page.locator( '#runtime-section' ).evaluate( ( node ) => ( node as HTMLElement ).style.top ) ).toBe( '1000px' );
				expect( await page.locator( 'a' ).getAttribute( 'data-dla-anchor-unresolved' ) ).toBeNull();
			}
		} finally {
			await browser.close();
		}
	}, 20_000 );

	it( 'keeps a cross-page data-anchor intent in the href instead of dropping it', async () => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			await page.route( 'https://anchor.test/**', ( route ) => {
				const url = new URL( route.request().url() );
				if ( url.pathname !== '/project' )
					return route.fulfill( { contentType: 'text/html', body: '<main>Home</main>' } );
				return route.fulfill( {
					contentType: 'text/html',
					body: '<nav><a href="https://anchor.test/" data-anchor="dataItem-home-section">Expertise</a></nav>',
				} );
			} );
			await page.goto( 'https://anchor.test/project' );
			await capture.prepare!( page, { url: page.url(), viewport: 'desktop' } );

			const link = page.locator( 'nav a' );
			expect( await link.getAttribute( 'data-dla-anchor-fragment' ) ).toBe(
				'dataItem-home-section'
			);
			// The href now names the target page and its section, so a reader
			// landing there from a project page reaches the section, not the top.
			const resolved = new URL(
				( await link.evaluate( ( el ) => ( el as HTMLAnchorElement ).href ) )!
			);
			expect( `${ resolved.pathname }${ resolved.hash }` ).toBe(
				'/#dataItem-home-section'
			);
			// The target lives on the other route: nothing is resolved locally,
			// and observing it must not navigate away from the captured page.
			expect( await page.locator( '[data-dla-anchor-target]' ).count() ).toBe( 0 );
			expect( await link.getAttribute( 'data-dla-anchor-unresolved' ) ).toBeNull();
			expect( page.url() ).toBe( 'https://anchor.test/project' );
		} finally {
			await browser.close();
		}
	}, 20_000 );
} );
