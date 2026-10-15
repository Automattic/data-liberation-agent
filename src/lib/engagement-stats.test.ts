import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { WIX_ENGAGEMENT_STATS } from '../adapters/wix/capture.js';
import { ENGAGEMENT_STATS_ATTRIBUTE, ENGAGEMENT_STATS_CLASS_PREFIX, markEngagementStats } from './engagement-stats.js';

const MARK = `${ ENGAGEMENT_STATS_CLASS_PREFIX }wix`;

// Shape of a hydrated Wix Blog post footer: the counter container the viewer
// filled after load, next to the like button that stays.
const HYDRATED_POST = `<!doctype html><body>
	<div data-hook="post-main-actions__stats">
		<div data-hook="post-stats" class="TAdeda"><div class="OiMXGB"><div aria-label="87 views" role="status"><svg></svg>87</div><span class="FyJQDJ">87 views</span></div></div>
		<button aria-label="Like post" data-hook="like-button">Like</button>
	</div>
	<p id="body">Post body</p>
</body>`;

function withDocument< T >( html: string, run: ( document: Document ) => T ): T {
	const dom = new JSDOM( html );
	const prior = Object.getOwnPropertyDescriptor( globalThis, 'document' );
	Object.defineProperty( globalThis, 'document', { configurable: true, value: dom.window.document } );
	try {
		return run( dom.window.document );
	} finally {
		if ( prior ) Object.defineProperty( globalThis, 'document', prior );
		else delete ( globalThis as { document?: Document } ).document;
	}
}

it( 'empties and marks the Wix post counters, keeping the element and everything around it', () => {
	withDocument( HYDRATED_POST, ( document ) => {
		const marked = markEngagementStats( { ...WIX_ENGAGEMENT_STATS, attribute: ENGAGEMENT_STATS_ATTRIBUTE, classPrefix: ENGAGEMENT_STATS_CLASS_PREFIX } );
		const stats = document.querySelector( '[data-hook="post-stats"]' )!;
		expect( marked ).toBe( 1 );
		expect( stats.textContent ).toBe( '' );
		expect( stats.querySelector( '[aria-label]' ) ).toBeNull();
		expect( stats.classList.contains( MARK ) ).toBe( true );
		expect( stats.classList.contains( 'TAdeda' ) ).toBe( true );
		expect( stats.getAttribute( ENGAGEMENT_STATS_ATTRIBUTE ) ).toBe( 'wix' );
		expect( document.querySelector( '[data-hook="like-button"]' )!.textContent ).toBe( 'Like' );
		expect( document.querySelector( '#body' )!.textContent ).toBe( 'Post body' );
	} );
} );

it( 'leaves two posts of one template identical where their counters differ', () => {
	const capture = ( views: number ) => withDocument( HYDRATED_POST.replaceAll( '87', String( views ) ), ( document ) => {
		markEngagementStats( { ...WIX_ENGAGEMENT_STATS, attribute: ENGAGEMENT_STATS_ATTRIBUTE, classPrefix: ENGAGEMENT_STATS_CLASS_PREFIX } );
		return document.body.innerHTML;
	} );
	expect( capture( 260 ) ).toBe( capture( 87 ) );
} );
