import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { capture } from './capture.js';

/** Where a visitor following the captured target lands: its scroll position once scrolled into view. */
const landing = ( node: Element ): number => {
	( node as HTMLElement ).scrollIntoView( { block: 'start', behavior: 'instant' } );
	return Math.round( window.scrollY );
};

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
				expect( await page.locator( '#runtime-section' ).evaluate( landing ) ).toBe( 1000 );
				// The target lives inside the section the runtime scrolled to.
				expect( await page.locator( '#section-source > #runtime-section' ).count() ).toBe( 1 );
				expect( await page.locator( 'a' ).getAttribute( 'data-dla-anchor-unresolved' ) ).toBeNull();
			}
		} finally {
			await browser.close();
		}
	}, 20_000 );

	it( 'keeps the runtime landing offset and follows its section when content above it changes height', async () => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			await page.route( 'https://anchor.test/**', ( route ) => route.fulfill( {
				contentType: 'text/html',
				body: `<style>body{margin:0}header{position:fixed;top:0;z-index:5;height:60px}section{height:1000px}</style>
					<header><a href="#team">Team</a></header>
					<div id="banner" style="height:34px"></div><section>First</section><section id="team-source">Team</section><section>Last</section>
					<script>document.querySelector('a').addEventListener('click', event => {
						event.preventDefault();
						// The runtime keeps the section 16px clear of the viewport edge.
						if (event.isTrusted) window.scrollTo({ top: document.getElementById('team-source').offsetTop - 16, behavior: 'instant' });
					});</script>`,
			} ) );
			await page.goto( 'https://anchor.test/' );
			await capture.prepare!( page, { url: page.url(), viewport: 'desktop' } );
			expect( await page.locator( '#team' ).evaluate( landing ) ).toBe( 1034 - 16 );
			// The platform banner is removed and media above the section grows.
			await page.evaluate( () => {
				document.getElementById( 'banner' )!.remove();
				( document.querySelector( 'section' ) as HTMLElement ).style.height = '1300px';
			} );
			expect( await page.locator( '#team' ).evaluate( landing ) ).toBe( 1300 - 16 );
		} finally {
			await browser.close();
		}
	}, 20_000 );

	it( 'resolves every section link when the header hides after the first runtime scroll', async () => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			// A header that slides away once the page has scrolled, as many site
			// headers do: each link is only clickable from the top of the page.
			await page.route( 'https://anchor.test/**', ( route ) => route.fulfill( {
				contentType: 'text/html',
				body: `<style>body{margin:0}header{position:fixed;top:0;z-index:5;background:#fff}
					header.away{transform:translateY(-100%)}section{height:1000px}</style>
					<header><a href="#first-runtime">First</a> <a href="#second-runtime">Second</a> <a href="#third-runtime">Third</a></header>
					<section>Top</section><section>One</section><section>Two</section><section>Three</section><section>End</section>
					<script>
						addEventListener('scroll', () => document.querySelector('header').classList.toggle('away', scrollY > 0));
						document.querySelectorAll('header a').forEach((link, index) => link.addEventListener('click', event => {
							event.preventDefault();
							if (event.isTrusted) window.scrollTo({ top: 1000 * (index + 1), behavior: 'instant' });
						}));
					</script>`,
			} ) );
			await page.goto( 'https://anchor.test/' );
			await capture.prepare!( page, { url: page.url(), viewport: 'desktop' } );
			for ( const [ fragment, top ] of [ [ 'first-runtime', 1000 ], [ 'second-runtime', 2000 ], [ 'third-runtime', 3000 ] ] as const ) {
				expect( await page.locator( `#${ fragment }` ).count(), fragment ).toBe( 1 );
				expect( await page.locator( `#${ fragment }` ).evaluate( landing ), fragment ).toBe( top );
			}
		} finally {
			await browser.close();
		}
	}, 60_000 );

	it( 'marks a link whose trigger cannot be clicked instead of abandoning the remaining links', async () => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			await page.route( 'https://anchor.test/**', ( route ) => route.fulfill( {
				contentType: 'text/html',
				body: `<style>body{margin:0}header{position:fixed;top:0;z-index:5;background:#fff}section{height:1000px}
					#shield{position:fixed;top:0;left:0;width:60px;height:40px;z-index:9}</style>
					<header><a href="#blocked-runtime">Blocked</a> <a href="#open-runtime" style="margin-left:80px">Open</a></header>
					<div id="shield"></div>
					<section>Top</section><section>Blocked</section><section>Open</section><section>End</section>
					<script>document.querySelectorAll('header a').forEach((link, index) => link.addEventListener('click', event => {
						event.preventDefault();
						if (event.isTrusted) window.scrollTo({ top: 1000 * (index + 1), behavior: 'instant' });
					}));</script>`,
			} ) );
			await page.goto( 'https://anchor.test/' );
			await capture.prepare!( page, { url: page.url(), viewport: 'desktop' } );
			expect( await page.locator( 'a[href$="#blocked-runtime"]' ).getAttribute( 'data-dla-anchor-unresolved' ) ).toContain( 'click' );
			expect( await page.locator( '#open-runtime' ).count() ).toBe( 1 );
			expect( await page.locator( '#open-runtime' ).evaluate( landing ) ).toBe( 2000 );
		} finally {
			await browser.close();
		}
	}, 60_000 );

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
