import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { wixAdapter } from './index.js';
import { captureTriggeredDialogs } from '../../lib/screenshot/interaction-capture.js';
import { captureSelectableSetStates } from '../../lib/screenshot/selectable-set-capture.js';
import { captureTypedSearchStates } from '../../lib/screenshot/typed-search-capture.js';
import { PROBE_REGION_EXCLUDED, probeExclusionSkip, resolveProbeExclusions } from '../../lib/screenshot/probe-exclusions.js';

const skipBrowserTests = Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() );

// A reduced Wix Blog post footer: the comments widget and the post's
// engagement actions, recognised only by their `data-hook` markers, beside an
// authored popup that probing must still drive.
const FIXTURE = `<!doctype html><html><body><main>
<button id="authored" aria-haspopup="dialog" onclick="document.getElementById('authored-panel').hidden = false">Details</button>
<div id="authored-panel" role="dialog" hidden>Authored details</div>
<button onclick="document.getElementById('comments').scrollIntoView()"><span data-hook="ratings-display is-ready">Rated</span></button>
<div data-hook="post-main-actions__stats"><button aria-label="Like post" aria-haspopup="dialog" onclick="this.ariaPressed = 'true'"><span data-hook="like-button"></span></button></div>
<footer data-hook="post-footer"><button aria-label="Like post" aria-haspopup="dialog"><span data-hook="like-button-with-count__like-count"><span data-hook="like-button"></span></span></button></footer>
<section id="comments" data-hook="wc-root 66b64fce9402632b809c76f1">
	<div data-hook="wc-sorting-selector wc-header-scope">
		<button data-hook="floating-dropdown-button" aria-haspopup="listbox" onclick="document.getElementById('sort').hidden = false">Newest</button>
		<ul id="sort" role="listbox" hidden><li role="option">Newest</li><li role="option">Oldest</li></ul>
	</div>
	<div data-hook="ratings-input-container">
		<button data-hook="ratings-input-rating-star" onclick="document.getElementById('rating').textContent = 'One'">1</button>
		<button data-hook="ratings-input-rating-star" onclick="document.getElementById('rating').textContent = 'Two'">2</button>
		<button data-hook="ratings-input-rating-star" onclick="document.getElementById('rating').textContent = 'Three'">3</button>
	</div>
	<p data-hook="ratings-input-label" id="rating">None</p>
	<div data-hook="comment-box-placeholder"><input type="text" placeholder="Write a comment"></div>
</section>
</main></body></html>`;

const exclusions = wixAdapter.liberation!.probeExclusions!;

describe( 'Wix probe exclusions', () => {
	it( 'declares the Blog comments widget and engagement actions by data-hook', () => {
		expect( exclusions.map( ( exclusion ) => exclusion.id ) ).toEqual( [ 'wix-blog-comments', 'wix-blog-engagement' ] );
		expect( probeExclusionSkip( [] ) ).toBeUndefined();
	} );

	describe.skipIf( skipBrowserTests )( 'in a browser', () => {
		let browser: Browser;
		beforeAll( async () => { browser = await chromium.launch( { headless: true } ); } );
		afterAll( async () => { await browser?.close(); } );

		const fresh = async (): Promise< Page > => {
			const page = await browser.newPage( { viewport: { width: 1280, height: 900 } } );
			await page.setContent( FIXTURE );
			return page;
		};
		// Every widget element sits under a `data-hook`; the authored controls do not.
		const insideWidget = ( page: Page, selectors: string[] ) => page.evaluate(
			( list ) => list.filter( ( selector ) => document.querySelector( selector )?.closest( '[data-hook]' ) ),
			selectors
		);

		it( 'keeps every probe out of the widget and records the skipped regions', async () => {
			// Without the declaration, probing drives the widget's controls.
			const unskipped = await fresh();
			const dialogsBefore = await captureTriggeredDialogs( unskipped, 'https://example.com/post/a' );
			const selectableBefore = await captureSelectableSetStates( unskipped, { settleMs: 50 } );
			expect( await insideWidget( unskipped, [ ...dialogsBefore.states, ...selectableBefore ].map( ( state ) => state.trigger.selector ) ) ).not.toEqual( [] );
			await unskipped.close();

			const page = await fresh();
			const before = await page.content();
			const { skip, diagnostics } = await resolveProbeExclusions( page, exclusions );
			expect( diagnostics.map( ( diagnostic ) => diagnostic.code ) ).toEqual( [ PROBE_REGION_EXCLUDED, PROBE_REGION_EXCLUDED ] );
			expect( diagnostics[ 0 ]!.reason ).toMatch( /^wix-blog-comments: 2 region\(s\)/ );
			expect( diagnostics[ 1 ]!.reason ).toMatch( /^wix-blog-engagement: 2 region\(s\)/ );
			const dialogs = await captureTriggeredDialogs( page, 'https://example.com/post/a', { skip } );
			const selectable = await captureSelectableSetStates( page, { settleMs: 50, skip } );
			const typed = await captureTypedSearchStates( page, selectable, { skip } );
			const probed = [ ...dialogs.states, ...selectable, ...typed ].map( ( state ) => state.trigger.selector );
			expect( await insideWidget( page, probed ) ).toEqual( [] );
			// Authored controls outside the region are still probed.
			expect( dialogs.states.some( ( state ) => state.trigger.selector === '#authored' && state.status === 'captured' ) ).toBe( true );
			// The resting widget markup is not touched by resolving the exclusions.
			expect( await page.evaluate( () => document.querySelector( '[data-hook~="wc-root"]' )?.outerHTML ) ).toBe(
				before.match( /<section id="comments" data-hook="wc-root[\s\S]*?<\/section>/ )![ 0 ]
			);
			await page.close();
		} );

		it( 'records nothing on a route without the widget', async () => {
			const page = await browser.newPage();
			await page.setContent( '<main><button>Plain</button></main>' );
			expect( await resolveProbeExclusions( page, exclusions ) ).toEqual( { diagnostics: [] } );
			await page.close();
		} );
	} );
} );
