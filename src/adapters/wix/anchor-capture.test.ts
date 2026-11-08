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
	it.each( [
		{ delay: 0, position: 'fixed' },
		{ delay: 600, position: 'fixed' },
		{ delay: -1, position: 'fixed' },
		{ delay: 1000, position: 'static' },
	] )( 'observes scroll from a trusted click with delay $delay and $position trigger', async ( { delay, position } ) => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			await page.route( 'https://anchor.test/**', ( route ) => route.fulfill( {
				contentType: 'text/html',
				body: `<style>body{margin:0}nav{position:${ position };top:0;z-index:5;height:20px}section{height:1000px}</style>
					<nav><a href="#runtime-section">Section</a></nav>
					<section>First</section><section id="section-source">Destination</section><section>Last</section>
					<script>document.querySelector('a').addEventListener('click', event => {
						event.preventDefault();
						if (!event.isTrusted) return;
						document.querySelector('a').dataset.clicks = String(Number(document.querySelector('a').dataset.clicks || 0) + 1);
						if (${ delay } < 0) return;
						const move = () => window.scrollTo({top:document.getElementById('section-source').offsetTop,behavior:'instant'});
						if (${ delay } === 0) move(); else setTimeout(move, ${ delay });
					});</script>`,
			} ) );
			await page.goto( 'https://anchor.test/' );
			await capture.prepare!( page, { url: page.url(), viewport: 'desktop' } );
			if ( delay < 0 ) {
				expect( await page.locator( '#runtime-section' ).count() ).toBe( 0 );
				expect( await page.locator( 'a' ).getAttribute( 'data-blocks-engine-capture-anchor-unresolved' ) ).toContain( 'did not move' );
			} else {
				expect( await page.locator( 'a' ).getAttribute( 'data-clicks' ) ).toBe( '1' );
				expect( await page.locator( '#runtime-section' ).count() ).toBe( 1 );
				expect( await page.locator( '#runtime-section' ).evaluate( landing ) ).toBe( position === 'static' ? 1020 : 1000 );
				// The target lives inside the section the runtime scrolled to.
				expect( await page.locator( '#section-source > #runtime-section' ).count() ).toBe( 1 );
				expect( await page.locator( 'a' ).getAttribute( 'data-blocks-engine-capture-anchor-unresolved' ) ).toBeNull();
			}
		} finally {
			await browser.close();
		}
	}, 20_000 );

	it( 'resolves a short final section when the runtime scroll clamps at the document bottom', async () => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage( { viewport: { width: 1024, height: 800 } } );
			await page.route( 'https://anchor.test/**', ( route ) => route.fulfill( {
				contentType: 'text/html',
				body: `<style>body{margin:0}nav{position:fixed;top:0;z-index:5}section{height:1000px}#final-source{height:200px}</style>
					<nav><a href="#final-runtime">Contact</a></nav>
					<section>Introduction</section><section id="final-source">Contact details</section>
					<script>document.querySelector('a').addEventListener('click', event => {
						event.preventDefault();
						if (event.isTrusted) window.scrollTo({top:document.getElementById('final-source').offsetTop,behavior:'instant'});
					});</script>`,
			} ) );
			await page.goto( 'https://anchor.test/' );
			await capture.prepare!( page, { url: page.url(), viewport: 'desktop' } );
			expect( await page.locator( '#final-source > #final-runtime[data-blocks-engine-capture-anchor-target="final-runtime"]' ).count() ).toBe( 1 );
			expect( await page.locator( 'a' ).getAttribute( 'data-blocks-engine-capture-anchor-unresolved' ) ).toBeNull();
			expect( await page.locator( '#final-runtime' ).evaluate( landing ) ).toBe( 400 );
		} finally {
			await browser.close();
		}
	}, 20_000 );

	it.each( [ false, true ] )( 'resolves a fixed header fragment already at its top landing without changing a mid-page fragment (hide on scroll-down: %s)', async ( hideOnScrollDown ) => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			await page.route( 'https://anchor.test/**', ( route ) => route.fulfill( {
				contentType: 'text/html',
				body: `<style>body{margin:0}header{position:fixed;top:0;z-index:5}section{height:1000px}</style>
					<header><a href="#welcome">Welcome</a> <a href="#about">About</a></header>
					<section id="welcome-source">Welcome</section><section id="about-source">About</section><section>End</section>
					<script>document.querySelectorAll('header a').forEach((link, index) => link.addEventListener('click', event => {
						event.preventDefault();
						if (event.isTrusted) window.scrollTo({top:index * 1000,behavior:'instant'});
					}));
					if (${ hideOnScrollDown }) {
						let previousY = scrollY;
						addEventListener('scroll', () => {
							document.querySelector('header').style.transform = scrollY > previousY ? 'translateY(-100%)' : '';
							previousY = scrollY;
						});
					}</script>`,
			} ) );
			await page.goto( 'https://anchor.test/' );
			await capture.prepare!( page, { url: page.url(), viewport: 'desktop' } );
			for ( const [ fragment, top ] of [ [ 'welcome', 0 ], [ 'about', 1000 ] ] as const ) {
				expect( await page.locator( `#${ fragment }-source > #${ fragment }[data-blocks-engine-capture-anchor-target="${ fragment }"]` ).count() ).toBe( 1 );
				expect( await page.locator( `#${ fragment }` ).evaluate( landing ) ).toBe( top );
				expect( await page.locator( `a[href="#${ fragment }"],a[href="/#${ fragment }"]` ).getAttribute( 'data-blocks-engine-capture-anchor-unresolved' ) ).toBeNull();
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

	// A click whose landing never starts used to hold the full scroll bound
	// per fragment (#839): every drawer link on a wide mobile document paid
	// 3s of nothing. Once the document holds its scroll and height past the
	// no-move beat, the landing is not coming and the wait ends.
	it( 'gives up on a scroll that never starts without paying the whole bound per fragment', async () => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			await page.route( 'https://anchor.test/**', ( route ) => route.fulfill( {
				contentType: 'text/html',
				body: `<style>body{margin:0}header{position:fixed;top:0;z-index:5}section{height:800px}</style>
					<header><a href="#dead-one">One</a> <a href="#dead-two">Two</a></header>
					<section>Top</section><section>One</section><section>Two</section>
					<script>document.querySelectorAll('header a').forEach((link) => link.addEventListener('click', (event) => event.preventDefault()));</script>`,
			} ) );
			await page.goto( 'https://anchor.test/' );
			await capture.prepare!( page, { url: page.url(), viewport: 'mobile' } );
			expect( await page.locator( 'a[href$="#dead-one"]' ).getAttribute( 'data-blocks-engine-capture-anchor-unresolved' ) ).toContain( 'did not move' );
			expect( await page.locator( 'a[href$="#dead-two"]' ).getAttribute( 'data-blocks-engine-capture-anchor-unresolved' ) ).toContain( 'did not move' );
			// Timer bounds are checked with virtual time in anchor-scroll.test.ts;
			// browser scheduling and the preparation sweep are not part of that bound.
		} finally {
			await browser.close();
		}
	}, 30_000 );

	// A drawer keeps the body's scroll locked while it is open: waiting for the
	// landing with the drawer still up pays the full scroll bound on every
	// fragment and ships unresolved anchors that resolve in milliseconds once
	// the drawer is gone first.
	it( 'closes an opened menu before waiting for the runtime scroll behind its link', async () => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			await page.route( 'https://anchor.test/**', ( route ) => route.fulfill( {
				contentType: 'text/html',
				body: `<style>body{margin:0}button{position:fixed;top:0;z-index:9}section{height:1000px}
					#drawer{position:fixed;inset:0;z-index:5;background:#fff;display:none}</style>
					<button aria-label="menu" onclick="openDrawer()">Menu</button>
					<div id="drawer" role="dialog" data-hook="menu-root"><a href="https://anchor.test/#team" style="display:block;margin-top:220px">Team</a></div>
					<section>Top</section><section id="team-source">Team</section><section>End</section>
					<script>
						function lock( locked ) { document.documentElement.style.overflow = locked ? 'hidden' : ''; }
						function openDrawer() { document.getElementById('drawer').style.display = 'block'; lock( true ); }
						function closeDrawer() { document.getElementById('drawer').style.display = 'none'; lock( false ); }
						// The drawer's runtime does not follow the link itself: closing
						// the drawer is what releases the navigation it queued.
						addEventListener('keydown', ( event ) => {
							if ( event.key !== 'Escape' ) return;
							closeDrawer();
							setTimeout( () => window.scrollTo( { top: 1000, behavior: 'instant' } ), 50 );
						});
						document.querySelector('#drawer a').addEventListener('click', ( event ) => event.preventDefault());
					</script>`,
			} ) );
			await page.goto( 'https://anchor.test/' );
			await capture.prepare!( page, { url: page.url(), viewport: 'mobile' } );
			// The navigation the visitor asked for happened once the drawer was
			// gone: a real target stands behind the fragment.
						expect( await page.locator( '#team' ).count() ).toBe( 1 );
			expect( await page.locator( '#team-source > #team' ).count() ).toBe( 1 );
			expect( await page.locator( '#team' ).evaluate( landing ) ).toBe( 1000 );
			expect( await page.locator( 'a[href$="#team"]' ).getAttribute( 'data-blocks-engine-capture-anchor-unresolved' ) ).toBeNull();
			// The capture records the closed page.
			expect( await page.locator( '#drawer' ).evaluate( ( drawer ) => getComputedStyle( drawer as HTMLElement ).display ) ).toBe( 'none' );
		} finally {
			await browser.close();
		}
	}, 60_000 );

	it.each( [ 'popup', 'controls', 'label', 'none', 'unrelated' ] )( 'resolves collapsed phone navigation with a %s opener', async ( kind ) => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage( { viewport: { width: 390, height: 768 } } );
			const button = kind === 'none' ? '' : `<button ${ kind === 'label' ? 'aria-label="Menu"' : `aria-expanded="false" ${ kind === 'controls' ? 'aria-controls="site-nav"' : 'aria-haspopup="true"' }` }>Open</button>`;
			await page.route( 'https://anchor.test/**', ( route ) => route.fulfill( {
				contentType: 'text/html',
				body: `<style>body{margin:0}nav,button{position:fixed;top:0;z-index:5}#links{display:none;margin-top:40px}section{height:1000px}</style>
					${ kind === 'controls' || kind === 'unrelated' ? button : '' }
					<nav id="site-nav" aria-label="Site">${ kind === 'controls' || kind === 'unrelated' ? '' : button }
					<div id="links"><a href="#team">Team</a><a href="#contact">Contact</a></div></nav>
					<section>Top</section><section id="team-source">Team</section><section id="contact-source">Contact</section><section>End</section>
					<script>
						document.querySelector('button')?.addEventListener('click', () => {
							document.getElementById('links').style.display = 'block';
							document.querySelector('button').setAttribute('aria-expanded', 'true');
						});
						document.querySelectorAll('a').forEach((link, index) => link.addEventListener('click', event => {
							event.preventDefault();
							if (!event.isTrusted) return;
							document.getElementById('links').style.display = 'none';
							document.querySelector('button')?.setAttribute('aria-expanded', 'false');
							window.scrollTo({top:1000 * (index + 1),behavior:'instant'});
						}));
					</script>`,
			} ) );
			await page.goto( 'https://anchor.test/' );
			await capture.prepare!( page, { url: page.url(), viewport: 'mobile' } );
			for ( const fragment of [ 'team', 'contact' ] ) {
				const link = page.locator( `a[href$="#${ fragment }"]` );
				if ( kind === 'none' || kind === 'unrelated' ) {
					expect( await link.getAttribute( 'data-blocks-engine-capture-anchor-unresolved' ) ).toBe( 'no rendered fragment trigger' );
					expect( await page.locator( `#${ fragment }` ).count() ).toBe( 0 );
				} else {
					expect( await link.getAttribute( 'data-blocks-engine-capture-anchor-unresolved' ) ).toBeNull();
					expect( await link.getAttribute( 'href' ) ).toBe( `/#${ fragment }` );
					expect( await page.locator( `#${ fragment }-source > #${ fragment }[data-blocks-engine-capture-anchor-target="${ fragment }"]` ).count() ).toBe( 1 );
				}
			}
		} finally {
			await browser.close();
		}
	}, 30_000 );

	it( 'closes an opened menu when it contains no rendered fragment trigger', async () => {
		const browser = await chromium.launch( { headless: true } );
		try {
			const page = await browser.newPage();
			await page.route( 'https://anchor.test/**', ( route ) => route.fulfill( {
				contentType: 'text/html',
				body: `<style>nav{display:none}#drawer{display:none;position:fixed;inset:0;background:#fff}</style>
					<nav><a href="#pricing">Pricing</a><a href="#faq">FAQ</a></nav>
					<button aria-label="Menu" onclick="document.getElementById('drawer').style.display = 'block'">Menu</button>
					<div id="drawer" role="dialog"><a href="https://anchor.test/about">About</a></div>
					<script>addEventListener('keydown', ( event ) => {
						if (event.key === 'Escape') document.getElementById('drawer').style.display = 'none';
					});</script>`,
			} ) );
			await page.goto( 'https://anchor.test/' );
			await capture.prepare!( page, { url: page.url(), viewport: 'mobile' } );
			for ( const fragment of [ 'pricing', 'faq' ] ) {
				expect( await page.locator( `nav a[href="#${ fragment }"]` ).getAttribute( 'data-blocks-engine-capture-anchor-unresolved' ) ).toBe( 'no rendered fragment trigger' );
			}
			expect( await page.locator( '#drawer' ).evaluate( ( drawer ) => getComputedStyle( drawer ).display ) ).toBe( 'none' );
		} finally {
			await browser.close();
		}
	}, 30_000 );

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
			expect( await page.locator( 'a[href$="#blocked-runtime"]' ).getAttribute( 'data-blocks-engine-capture-anchor-unresolved' ) ).toContain( 'click' );
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
			expect( await link.getAttribute( 'data-blocks-engine-capture-anchor-fragment' ) ).toBe(
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
			expect( await page.locator( '[data-blocks-engine-capture-anchor-target]' ).count() ).toBe( 0 );
			expect( await link.getAttribute( 'data-blocks-engine-capture-anchor-unresolved' ) ).toBeNull();
			expect( page.url() ).toBe( 'https://anchor.test/project' );
		} finally {
			await browser.close();
		}
	}, 20_000 );
} );
