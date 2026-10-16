// src/adapters/wix/capture.ts
//
// Wix-specific capture knowledge. None of this belongs in the shared capture
// path: recognising a platform's CDN is exactly what an adapter is for.
//
import type { LiberationHooks } from '../page-actions.js';
import { resolveEventFormRedirect } from './event-forms.js';
import { providerCreditRules } from '../../lib/source-cleanup.js';
import type { Locator, Page } from 'playwright';
import { canonicalizeWixCapturedHtml } from './instance-ids.js';
import { wixDocumentSelection, wixAdditionalProfiles } from './document-selection.js';
import { preserveWixCollections } from './collections.js';
import { markMemberLoginControls, MEMBER_LOGIN_ATTRIBUTE, MEMBER_LOGIN_CLASS_PREFIX } from '../../lib/member-login.js';
import { markEngagementStats, ENGAGEMENT_STATS_ATTRIBUTE, ENGAGEMENT_STATS_CLASS_PREFIX } from '../../lib/engagement-stats.js';
import { portWixRuntimeEmbeds } from './embeds.js';
import { normalizeWixImageGeometry } from './image-geometry.js';

/**
 * The Wix Blog per-post counters (views, comments). The server document holds
 * only a skeleton there; the viewer fetches the numbers after load.
 */
export const WIX_ENGAGEMENT_STATS = {
	provider: 'wix',
	selector: '[data-hook="post-stats"]',
};

/**
 * Wix Members sign-in entry points: the login bar's button, which opens the
 * members dialog removed by `wix-members-dialog`, and links into the members
 * area, which a visitor only reaches through that login.
 */
export const WIX_MEMBER_LOGIN = {
	provider: 'wix',
	controls: '.wixui-login-social-bar [data-testid="handle-button"]',
};

/**
 * Where the Wix members area lives for a captured route. A connected domain
 * serves it at `/account/`; a free `<user>.wixsite.com/<site>/` serves the
 * whole site under its first path segment, members area included.
 */
export function wixMemberPaths( url: string ): string[] {
	try {
		const parsed = new URL( url );
		const site = parsed.pathname.split( '/' ).filter( Boolean )[ 0 ];
		if ( /(?:^|\.)wixsite\.com$/i.test( parsed.hostname ) && site ) return [ `/${ site }/account/` ];
	} catch {
		/* fall through to the connected-domain layout */
	}
	return [ '/account/' ];
}

/** Wix media ids look like `8e80e7_a1b2…`, stable across crops of one asset. */
const WIX_MEDIA_ID = /([a-z0-9]{4,12}_[a-z0-9]{24,48})/i;
/** Only `/fill/w_,h_` URLs are the runtime-swapped per-viewport crops. */
const WIX_FILL_VARIANT = /static\.wixstatic\.com\/.+\/fill\/w_\d+,h_\d+/;

/**
 * Recognise a Wix responsive image variant, returning its stable media id and
 * the variant URL.
 *
 * Pure, so the URL shape this depends on is testable without a browser.
 */
export function wixStaticMediaUrl(
	uri: string,
	size?: { width: number; height: number }
): string {
	if ( /^https?:/i.test( uri ) ) return uri;
	if ( ! size ) return `https://static.wixstatic.com/media/${ uri }`;
	const file = uri.split( '/' ).pop() || uri;
	return `https://static.wixstatic.com/media/${ uri }/v1/fill/w_${ Math.max( 1, Math.round( size.width ) ) },h_${ Math.max( 1, Math.round( size.height ) ) },al_c,q_85,enc_avif,quality_auto/${ file }`;
}

function escapeAttr( value: string ): string {
	return value.replace( /&/g, '&amp;' ).replace( /"/g, '&quot;' ).replace( /</g, '&lt;' );
}

export function stripShowcaseMarkup(
	items: Array< { uri: string; alt?: string; title?: string } >,
	size: { width: number; height: number }
): { html: string; css: string } {
	const count = Math.max( items.length, 1 );
	const height = Math.max( 1, Math.round( size.height ) );
	const width = Math.max( 1, Math.round( size.width ) );
	const imgs = items
		.map( ( item ) => {
			const alt = escapeAttr( item.alt || item.title || '' );
			return `<img src="${ escapeAttr( wixStaticMediaUrl( item.uri, { width, height } ) ) }" alt="${ alt }">`;
		} )
		.join( '' );
	const html = `<div class="data-blocks-engine-capture-slideshow"><div class="data-blocks-engine-capture-slideshow-track">${ imgs }</div></div>`;
	const step = 100 / count;
	const hold = step * 0.8;
	let frames = '';
	for ( let index = 0; index < count; index++ ) {
		const start = index * step;
		frames += `${ start }%{transform:translateX(-${ index * 100 }%)}`;
		frames += `${ start + hold }%{transform:translateX(-${ index * 100 }%)}`;
	}
	frames += '100%{transform:translateX(0)}';
	const css =
		'.data-blocks-engine-capture-slideshow{overflow:hidden;width:100%;height:100%;position:relative}' +
		`.data-blocks-engine-capture-slideshow-track{display:flex;height:100%;animation:data-blocks-engine-capture-slideshow ${ count * 2 }s infinite}` +
		'.data-blocks-engine-capture-slideshow-track img{flex:0 0 100%;width:100%;height:100%;object-fit:cover}' +
		`@keyframes data-blocks-engine-capture-slideshow{${ frames }}` +
		'@media (prefers-reduced-motion:reduce){.data-blocks-engine-capture-slideshow{overflow-x:auto;scroll-snap-type:x mandatory}.data-blocks-engine-capture-slideshow-track{animation:none}.data-blocks-engine-capture-slideshow-track img{scroll-snap-align:start}}';
	return { html, css };
}

export function wixMediaVariant( url: string ): { id: string; url: string } | null {
	if ( ! WIX_FILL_VARIANT.test( url ) ) return null;
	const match = WIX_MEDIA_ID.exec( url );
	return match ? { id: match[ 1 ]!.toLowerCase(), url } : null;
}

export const WIX_CAPTURE_CHROME_SELECTOR =
	'[id="WIX_ADS"], [id$="-hiddenA11ySubMenuIndication"]';

const WIX_SLIDESHOW_CLASS = 'wixui-slideshow';
const WIX_SLIDESHOW_SELECTOR = `.${ WIX_SLIDESHOW_CLASS }`;
const WIX_SLIDESHOW_LIMIT = 4;
const WIX_SLIDE_LIMIT = 6;
const WIX_SLIDE_SETTLE_MILLISECONDS = 10_000;
/** Bound on yielding to a slideshow transition before confirming a slide change. */
const WIX_SLIDE_TRANSITION_MILLISECONDS = 1_500;
const WIX_SLIDESHOW_REVEAL_WAIT_MILLISECONDS = 2_000;
export const WIX_ANCHOR_SCROLL_MAX_MILLISECONDS = 3_000;
/** 2.5× the largest documented delayed navigation (600ms in anchor-capture.test): a landing that follows a trusted click moves within this beat of the click (#839). */
const WIX_ANCHOR_NO_MOVE_MILLISECONDS = 1_500;

/**
 * In-page: visit the whole scroll-reactive layout so Wix's runtime wires
 * section navigation and mounts late widgets. Only worth running when runtime
 * anchor resolution or a late widget actually needs the visit: one 80 ms beat
 * per 600 px of document height establishes nothing for a document whose
 * anchors already resolve to authored targets, and the visit itself was
 * already made by the capture's lazy-load sweep.
 */
async function wixScrollSweep( settleTail: boolean ): Promise< void > {
	const step = 600;
	const max = Math.min( document.documentElement.scrollHeight, 12_000 );
	for ( let top = 0; top <= max; top += step ) {
		window.scrollTo( { top, left: 0, behavior: 'instant' } );
		await new Promise( ( resolve ) => setTimeout( resolve, 80 ) );
	}
	window.scrollTo( { top: 0, left: 0, behavior: 'instant' } );
	if ( settleTail ) await new Promise( ( resolve ) => setTimeout( resolve, 500 ) );
}

/**
 * In-page: remove platform chrome, mark every same-page anchor link with its
 * fragment, rewrite cross-route anchors to their target path, and report the
 * same-page fragments plus whether any of them lacks an authored target —
 * the only anchors the scroll sweep can still help resolve.
 */
function collectWixAnchorFragments( chromeSelector: string ): { fragments: string[]; needsRuntimeResolution: boolean } {
	for ( const chrome of document.querySelectorAll( chromeSelector ) ) chrome.remove();

	const fragments = new Set< string >();
	for ( const link of document.querySelectorAll< HTMLAnchorElement >( 'a[href]' ) ) {
		let target: URL;
		try {
			target = new URL( link.href, location.href );
		} catch {
			continue;
		}
		if ( target.origin !== location.origin ) continue;

		const declaredIntent = link.getAttribute( 'data-anchor' ) ?? '';
		const encodedFragment = target.hash ? target.hash.slice( 1 ) : declaredIntent;
		if ( ! encodedFragment ) continue;
		let fragment: string;
		try {
			fragment = decodeURIComponent( encodedFragment );
		} catch {
			continue;
		}
		// eslint-disable-next-line no-control-regex -- fragment IDs must not carry controls.
		if ( ! fragment || fragment.length > 128 || /[\u0000-\u001f\u007f]/.test( fragment ) )
			continue;
		link.dataset.blocksEngineCaptureAnchorFragment = fragment;
		if ( target.pathname !== location.pathname ) {
			// The declared section lives on another captured route, where
			// this page's runtime cannot resolve it. Keep the intent in
			// the href — `<target page>#<fragment>` — and let cross-route
			// self-consistency verify the target document. Never resolve
			// it here: clicking would navigate away from this page.
			link.href = `${ target.pathname }#${ encodeURIComponent( fragment ) }`;
			continue;
		}
		fragments.add( fragment );
	}
	const needsRuntimeResolution = [ ...fragments ].some( ( fragment ) =>
		! [ ...document.querySelectorAll< HTMLElement >( '[id],a[name]' ) ].some(
			( element ) => element.id === fragment || element.getAttribute( 'name' ) === fragment
		)
	);
	return { fragments: [ ...fragments ], needsRuntimeResolution };
}

/**
 * Wix mounts only the active slide. Replace that transient state with the
 * distinct states observed through its authored next control before serializing.
 */
export function preserveWixSlideshowSlides(
	{ slideshowIndex, slides }: { slideshowIndex: number; slides: string[] }
): void {
	const slideshow = document.querySelectorAll< HTMLElement >( '.wixui-slideshow' )[ slideshowIndex ];
	const wrapper = slideshow?.querySelector< HTMLElement >( '[data-testid="slidesWrapper"]' );
	if ( ! slideshow || ! wrapper || slides.length < 2 ) return;

	const fragment = document.createDocumentFragment();
	// Runs inside the page: index the array rather than rely on
	// Array.prototype.entries, which a page library may have replaced.
	for ( let index = 0; index < slides.length; index++ ) {
		const html = slides[ index ]!;
		const template = document.createElement( 'template' );
		template.innerHTML = html;
		const slide = template.content.firstElementChild;
		if ( ! slide ) continue;
		slide.setAttribute( 'data-blocks-engine-capture-captured-slide', String( index ) );
		fragment.append( slide );
	}
	if ( fragment.childElementCount < 2 ) return;

	wrapper.replaceChildren( fragment );
	slideshow.dataset.blocksEngineCaptureCapturedSlideshow = 'true';
	if ( ! document.getElementById( 'data-blocks-engine-capture-wix-captured-slideshow-css' ) ) {
		const style = document.createElement( 'style' );
		style.id = 'data-blocks-engine-capture-wix-captured-slideshow-css';
		style.textContent =
			'.wixui-slideshow[data-blocks-engine-capture-captured-slideshow="true"] [data-testid="slidesWrapper"]>[data-blocks-engine-capture-captured-slide]{display:none!important}' +
			'.wixui-slideshow[data-blocks-engine-capture-captured-slideshow="true"] [data-testid="slidesWrapper"]>[data-blocks-engine-capture-captured-slide="0"]{display:block!important}';
		document.head.append( style );
	}
}

function snapshotWixSlide(
	page: Page,
	slideshowIndex: number
): Promise< { html: string; key: string } | null > {
	return page.evaluate( ( index ) => {
		const slideshow = document.querySelectorAll< HTMLElement >( '.wixui-slideshow' )[ index ];
		const slide = slideshow?.querySelector< HTMLElement >( '[data-testid="slidesWrapper"] > *' );
		if ( ! slide ) return null;
		const media = [ ...slide.querySelectorAll< HTMLImageElement >( 'img' ) ].map(
			( image ) => image.currentSrc || image.src
		);
		const drawings = [ ...slide.querySelectorAll( 'svg' ) ].map( ( node ) => node.innerHTML );
		const text = slide.textContent?.replace( /\s+/g, ' ' ).trim() ?? '';
		return {
			html: slide.outerHTML,
			key: `${ text }\n${ media.join( '\n' ) }\n${ drawings.join( '\n' ) }`,
		};
	}, slideshowIndex );
}

function slideshowExpectedStateCount( page: Page, slideshowIndex: number ): Promise< number | null > {
	return page.evaluate( ( index ) => {
		const slideshow = document.querySelectorAll< HTMLElement >( '.wixui-slideshow' )[ index ];
		const controls = slideshow?.querySelectorAll( 'nav[aria-label] a[href]' ) ?? [];
		const destinations = new Set(
			[ ...controls ]
				.map( ( control ) => control.getAttribute( 'href' ) ?? '' )
				.filter( Boolean )
		);
		return destinations.size || null;
	}, slideshowIndex );
}

/**
 * In-page predicate: true once the mounted slide's identity key differs from
 * the previous one. Wix swaps the slide element at the START of its
 * transition, so after the key changes, yield to the slideshow's remaining
 * movement (bounded, and never held by an ambient infinite animation) before
 * confirming: a control clicked mid-transition is queued by the runtime and
 * lands seconds late.
 */
function wixSlideKeyChanged( {
	index, previousKey, transitionBound,
}: { index: number; previousKey: string; transitionBound: number } ): boolean | Promise< boolean > {
	const slideshow = document.querySelectorAll< HTMLElement >( '.wixui-slideshow' )[ index ];
	const slide = slideshow?.querySelector< HTMLElement >( '[data-testid="slidesWrapper"] > *' );
	if ( ! slide ) return false;
	const media = [ ...slide.querySelectorAll< HTMLImageElement >( 'img' ) ].map(
		( image ) => image.currentSrc || image.src
	);
	const drawings = [ ...slide.querySelectorAll( 'svg' ) ].map( ( node ) => node.innerHTML );
	const text = slide.textContent?.replace( /\s+/g, ' ' ).trim() ?? '';
	if ( `${ text }\n${ media.join( '\n' ) }\n${ drawings.join( '\n' ) }` === previousKey ) return false;
	const movement = slideshow && typeof slideshow.getAnimations === 'function'
		? slideshow.getAnimations( { subtree: true } ).filter( ( animation ) => {
				try {
					if ( animation.playState !== 'running' ) return false;
					return ( animation.effect?.getTiming?.().iterations ?? 1 ) !== Infinity;
				} catch {
					return false;
				}
			} ).map( ( animation ) => animation.finished.catch( () => undefined ) )
		: [];
	if ( movement.length === 0 ) return true;
	return Promise.race( [
		Promise.all( movement ).then( () => true ),
		new Promise< boolean >( ( resolve ) => setTimeout( () => resolve( true ), transitionBound ) ),
	] );
}

/**
 * Wait on the observed condition — the slide key changing — instead of
 * polling from Node: one wait under the same settle bound, no per-poll round
 * trip and no fixed interval.
 */
export async function waitForWixSlideChange(
	page: Page,
	slideshowIndex: number,
	previousKey: string
): Promise< { html: string; key: string } | null > {
	const changed = await page
		.waitForFunction(
			wixSlideKeyChanged,
			{ index: slideshowIndex, previousKey, transitionBound: WIX_SLIDE_TRANSITION_MILLISECONDS },
			{ timeout: WIX_SLIDE_SETTLE_MILLISECONDS }
		)
		.catch( () => null );
	if ( ! changed ) return null;
	return snapshotWixSlide( page, slideshowIndex );
}

export async function collectWixSlideshowSlides( page: Page ): Promise< void > {
	const count = await page.locator( WIX_SLIDESHOW_SELECTOR ).count();
	for ( let slideshowIndex = 0; slideshowIndex < Math.min( count, WIX_SLIDESHOW_LIMIT ); slideshowIndex++ ) {
		const slideshow = page.locator( WIX_SLIDESHOW_SELECTOR ).nth( slideshowIndex );
		const next = slideshow.locator( 'button[data-testid="nextButton"]' );
		if ( await next.count() !== 1 ) continue;
		await slideshow.scrollIntoViewIfNeeded?.();

		const initial = await snapshotWixSlide( page, slideshowIndex );
		if ( ! initial ) continue;
		const expected = await slideshowExpectedStateCount( page, slideshowIndex );
		const slides = [ initial ];
		const seen = new Set( [ initial.key ] );
		let failure = '';
		const controls: Locator[] = [ next ];
		const previous = slideshow.locator( 'button[data-testid="prevButton"]' );
		if ( await previous.count() === 1 ) controls.push( previous );
		const dots = slideshow.locator( 'nav[aria-label] a[href]' );
		for ( let index = 0; index < Math.min( await dots.count(), WIX_SLIDE_LIMIT - 1 ); index++ ) {
			controls.push( dots.nth( index ) );
		}
		for ( const control of controls ) {
			try {
				await control.click();
			} catch ( error ) {
				failure ||= `slideshow control could not be activated: ${ error instanceof Error ? error.message : String( error ) }`;
				continue;
			}
			const snapshot = await waitForWixSlideChange( page, slideshowIndex, slides.at( -1 )!.key );
			if ( ! snapshot ) {
				continue;
			}
			if ( seen.has( snapshot.key ) ) continue;
			seen.add( snapshot.key );
			slides.push( snapshot );
			if ( expected !== null && slides.length >= expected ) break;
		}

		if ( expected !== null && slides.length !== expected ) {
			failure ||= `observed ${ slides.length } of ${ expected } states declared by slideshow navigation`;
		}
		if ( slides.length > 1 ) {
			await page.evaluate( preserveWixSlideshowSlides, {
				slideshowIndex,
				slides: slides.map( ( slide ) => slide.html ),
			} );
			continue;
		}
		await page.evaluate( ( { index, message, observed, expectedStates } ) => {
			const slideshow = document.querySelectorAll< HTMLElement >( '.wixui-slideshow' )[ index ];
			if ( ! slideshow ) return;
			slideshow.dataset.blocksEngineCaptureCapturedSlideshow = 'false';
			slideshow.dataset.blocksEngineCaptureCapturedSlideCount = String( observed );
			if ( expectedStates !== null ) slideshow.dataset.blocksEngineCaptureExpectedSlideCount = String( expectedStates );
			slideshow.dataset.blocksEngineCaptureCaptureError = message || 'fewer than two distinct slideshow states observed';
		}, { index: slideshowIndex, message: failure, observed: slides.length, expectedStates: expected } );
	}
}

/**
 * Open a collapsed menu through its visible "Menu" button with trusted input,
 * and wait until one of its links renders. Returns whether it opened.
 */
async function openCollapsedMenu( page: Page ): Promise< boolean > {
	for ( const candidate of await page.locator( 'button[aria-label]' ).filter( { visible: true } ).all() ) {
		if ( ! /^\s*menu\s*$/i.test( ( await candidate.getAttribute( 'aria-label' ) ) ?? '' ) ) continue;
		try {
			await candidate.click( { timeout: WIX_ANCHOR_SCROLL_MAX_MILLISECONDS } );
			await page.waitForFunction(
				() => [ ...document.querySelectorAll< HTMLElement >( 'a[data-blocks-engine-capture-anchor-fragment]' ) ].some(
					( link ) => link.getBoundingClientRect().width > 0 && link.getBoundingClientRect().height > 0
				),
				undefined,
				{ timeout: WIX_ANCHOR_SCROLL_MAX_MILLISECONDS }
			);
			return true;
		} catch {
			return false;
		}
	}
	return false;
}

/** Record each element's interaction state attributes before the capture interacts with the page. */
export function snapshotInteractionAttributes(): void {
	const names = [ 'data-animation-name', 'data-animation-state', 'data-open', 'data-hovered', 'data-focused' ];
	const store = new Map< Element, Record< string, string | null > >();
	for ( const element of document.querySelectorAll( '[data-part="menu-item"], [data-animation-name], [data-animation-state]' ) ) {
		const values: Record< string, string | null > = {};
		for ( const name of names ) values[ name ] = element.getAttribute( name );
		store.set( element, values );
	}
	( window as unknown as { __dlaInteractionAttributes?: typeof store } ).__dlaInteractionAttributes = store;
}

/**
 * Put back the interaction state attributes the capture's own clicks changed,
 * and drop the ones they added, so the page is captured at rest.
 */
export function restoreInteractionAttributes(): void {
	const names = [ 'data-animation-name', 'data-animation-state', 'data-open', 'data-hovered', 'data-focused' ];
	const store = ( window as unknown as { __dlaInteractionAttributes?: Map< Element, Record< string, string | null > > } ).__dlaInteractionAttributes;
	if ( ! store ) return;
	for ( const [ element, values ] of store ) {
		if ( ! element.isConnected ) continue;
		for ( const name of names ) {
			const value = values[ name ];
			if ( value === null || value === undefined ) element.removeAttribute( name );
			else element.setAttribute( name, value );
		}
	}
	delete ( window as unknown as { __dlaInteractionAttributes?: unknown } ).__dlaInteractionAttributes;
}

/** Close a menu opened for anchor observation, so the capture records the closed page. */
async function closeOpenedMenu( page: Page ): Promise< void > {
	const opened = () =>
		page.evaluate( () =>
			[ ...document.querySelectorAll< HTMLElement >( '[role="dialog"]' ) ].some(
				( dialog ) => dialog.getBoundingClientRect().width > 0 && getComputedStyle( dialog ).visibility !== 'hidden'
			)
		);
	if ( ! ( await opened() ) ) return;
	await page.keyboard.press( 'Escape' );
	await page.waitForFunction(
		() => ! [ ...document.querySelectorAll< HTMLElement >( '[role="dialog"]' ) ].some(
			( dialog ) => dialog.getBoundingClientRect().width > 0 && getComputedStyle( dialog ).visibility !== 'hidden'
		),
		undefined,
		{ timeout: WIX_ANCHOR_SCROLL_MAX_MILLISECONDS }
	).catch( () => undefined );
}

/**
 * Reveal slideshows whose hydration waits for the scroll-reactive layout to
 * visit the page, then collect their slides.
 *
 * A mounted slideshow proves the runtime has already hydrated this document,
 * so the sweep is skipped: re-visiting the layout would redo work whose
 * result is established. Otherwise sweep and wait on the widget appearing —
 * the observed condition — instead of a fixed beat, never waiting after the
 * last pass; a sweep that reveals nothing after the previous sweep and its
 * hydration window also revealed nothing has confirmed the document's
 * answer, so the loop stops before its third pass.
 *
 * Wix server-renders every slideshow, including one it later unmounts until
 * it is in view, so a route whose server document has none has nothing to
 * reveal and skips the sweep. Without the server document, sweep as before.
 */
export async function revealAndCollectWixSlideshows( page: Page, serverHtml?: string ): Promise< void > {
	const mounted = () => page.locator( WIX_SLIDESHOW_SELECTOR ).count().catch( () => 0 );
	const declared = serverHtml === undefined || serverHtml.includes( WIX_SLIDESHOW_CLASS );
	let emptyPasses = 0;
	for ( let pass = 0; declared && pass < 3 && emptyPasses < 2 && ( await mounted() ) === 0; pass++ ) {
		await page.evaluate( wixScrollSweep, false ).catch( () => undefined );
		if ( ( await mounted() ) > 0 ) break;
		emptyPasses++;
		if ( emptyPasses < 2 ) {
			await page
				.waitForFunction(
					() => document.querySelector( '.wixui-slideshow' ) !== null,
					undefined,
					{ timeout: WIX_SLIDESHOW_REVEAL_WAIT_MILLISECONDS }
				)
				.catch( () => undefined );
		}
	}
	await collectWixSlideshowSlides( page );
}

/**
 * Return the document to its at-top state after capture-time scrolling.
 *
 * A builder hides or compresses a sticky header while the reader scrolls, and
 * it recomputes that state on a scroll EVENT rather than on position alone. A
 * bare restore therefore leaves the hidden-state class on the header, and the
 * freeze records a page whose header is translated out of view. Scroll to the
 * top, tell the handler, then let its transition run back.
 */
export async function settleScrollReactiveChrome( page: Page ): Promise< void > {
	await page
		.evaluate( () => {
			const root = document.documentElement;
			const behavior = root.style.scrollBehavior;
			root.style.scrollBehavior = 'auto';
			window.scrollTo( { top: 0, left: 0, behavior: 'instant' } );
			root.style.scrollBehavior = behavior;
			const scrolled = document.createEvent( 'Event' );
			scrolled.initEvent( 'scroll', false, false );
			window.dispatchEvent( scrolled );
		} )
		.catch( () => undefined );
	// The handler is throttled, so its transition starts a beat after the event.
	await page.waitForTimeout( 400 );
	await page
		.evaluate( async () => {
			// Ambient motion such as a spinner never finishes, so each wait is
			// bounded and the restore transition is the only thing worth awaiting.
			const settled = document.getAnimations().map( ( animation ) =>
				Promise.race( [
					animation.finished.catch( () => undefined ),
					new Promise( ( resolve ) => setTimeout( resolve, 600 ) ),
				] )
			);
			await Promise.all( settled );
		} )
		.catch( () => undefined );
}

/**
 * Wix's own logging endpoints: BI events and performance marks
 * (`frog.wix.com`) and runtime monitoring batches
 * (`panorama.wixapps.net`). The runtime streams POSTs to them for the life of
 * the page, and on ketatov.com every one observed ended `net::ERR_ABORTED` —
 * no response ever reached the document — while one was almost always
 * pending, holding network quiet to its bound.
 */
const WIX_TELEMETRY_HOSTS = new Set( [ 'frog.wix.com', 'panorama.wixapps.net' ] );

export function isWixTelemetryRequest( url: string ): boolean {
	try {
		const parsed = new URL( url );
		return parsed.protocol === 'https:' && WIX_TELEMETRY_HOSTS.has( parsed.hostname );
	} catch {
		return false;
	}
}

export const capture: LiberationHooks = {
	documentSelection: wixDocumentSelection,
	additionalProfiles: wixAdditionalProfiles,
	referenceWidths: [ 390, 768, 1440 ],
  resolveClientRedirect: resolveEventFormRedirect,
  canonicalizeHtml: ( html ) => canonicalizeWixCapturedHtml( preserveWixCollections( html ) ),
  cleanupRules: [
    // Wix publishes the measured height of its own banner into these, and its
    // layout reads them from the sticky header, the page root and the pinned
    // menu layer. The value is live-session state, not the owner's design.
    { id: 'wix-free-banner', category: 'source-attribution', selector: '#WIX_ADS',
      reclaimVariables: ['--wix-ads-height', '--wix-ads-top-height', '--sticky-offset'] },
    ...providerCreditRules('wix', ['wix.com'], 'Wix'),
    // Wix Members login. It only works against Wix's own member accounts, so a
    // copy can only ship it as a dead form. On a members-only page the runtime
    // replaces the whole site container with it behind a blocking layer: that
    // route is gated, not empty. Elsewhere the same dialog opens as a pop-up
    // from the "Sign In" control. The gate is listed first so a blocking gate
    // is recorded as the gate rather than as the dialog inside it.
    { id: 'wix-members-gate', category: 'provider-service',
      selector: '[data-testid="siteMembersDialogBlockingLayer"]', accessGate: { provider: 'Wix' } },
    { id: 'wix-members-dialog', category: 'provider-service', selector: '[data-testid="siteMembersDialogLayout"]' },
    // Wix mirrors its response headers into <meta http-equiv="X-Wix-…">: the
    // owner's metaSiteId, the app instance id and the published revision. They
    // are Wix account identifiers, not page metadata, and a copy would publish
    // them on every page (and in the importer's report).
    { id: 'wix-site-identifiers', category: 'source-attribution', selector: 'meta[http-equiv^="X-Wix-" i]' },
  ],
	telemetryRequest: isWixTelemetryRequest,
	removeSelectors: [ '[id="WIX_ADS"]', '[id$="-hiddenA11ySubMenuIndication"]' ],
	/**
	 * Wix resolves same-page anchors in its click runtime rather than with
	 * authored `id` targets, so a captured copy has nowhere to scroll to once
	 * that runtime is stripped. Observe where the live page settles for each
	 * fragment and leave a real target behind.
	 */
	prepare: async ( page, ctx ) => {
		// Keep the runtime-owned overflow control and resting link visibility.
		// Generic interaction capture observes its panel after baseline artifacts
		// are complete and portable dialog wiring replays that observed state.
		await page.evaluate( () => {
			// Classic Wix's keyboard-focusable More control declares a popup but
			// omits its button role and uses the legacy "true" menu alias. Expose
			// that platform contract to the generic interaction observer without
			// opening the panel or inventing an expanded/readiness state.
			for ( const trigger of document.querySelectorAll( 'li[id$="__more__"] [data-testid="linkElement"][aria-haspopup="true"][tabindex]' ) ) {
				if ( ! trigger.hasAttribute( 'role' ) ) trigger.setAttribute( 'role', 'button' );
				trigger.setAttribute( 'aria-haspopup', 'menu' );
			}
		} );
		let collected = await page.evaluate( collectWixAnchorFragments, WIX_CAPTURE_CHROME_SELECTOR );
		if ( collected.needsRuntimeResolution ) {
			// Wix only wires some section navigation after its scroll-reactive
			// layout has visited the page. This bounded sweep makes anchor
			// readiness explicit instead of relying on whichever lazy-load phase
			// happened to run first. A document whose same-page anchors all
			// resolve to authored targets skips it: the sweep would only redo
			// the visit the capture's lazy-load already made.
			await page.evaluate( wixScrollSweep, true ).catch( () => undefined );
			// The sweep can lazy-load sections that carry more anchor links.
			collected = await page.evaluate( collectWixAnchorFragments, WIX_CAPTURE_CHROME_SELECTOR );
		}
		const fragments = collected.fragments;

		const originalScroll = await page.evaluate( () => ( { x: scrollX, y: scrollY } ) );
		// Observing an anchor hovers and clicks its link, and Wix records that
		// interaction on the menu item (`data-animation-name`/`-state`). The
		// capture must keep the resting page, so remember those attributes now.
		await page.evaluate( snapshotInteractionAttributes );
		const restoreScroll = () => page.evaluate( ( originalScroll ) => {
			const root = document.documentElement;
			const scrollBehavior = root.style.scrollBehavior;
			root.style.scrollBehavior = 'auto';
			window.scrollTo( originalScroll.x, originalScroll.y );
			root.style.scrollBehavior = scrollBehavior;
		}, originalScroll );
		for ( const [ index, fragment ] of fragments.entries() ) {
			// Each observation starts from where the page was: the previous
			// runtime scroll can leave its trigger somewhere unclickable (a header
			// that hides once the page has scrolled).
			await restoreScroll();
			const trigger = await page.evaluate( ( { fragment, index } ) => {
				// Cross-page links share the marker but not this page's runtime:
				// their href already names the target route, and clicking one
				// here would navigate away mid-capture.
				const samePage = ( link: HTMLAnchorElement ) => {
					try {
						return new URL( link.href, location.href ).pathname === location.pathname;
					} catch {
						return false;
					}
				};
				const links = [ ...document.querySelectorAll< HTMLAnchorElement >(
					`a[data-blocks-engine-capture-anchor-fragment="${ CSS.escape( fragment ) }"]`
				) ].filter( samePage );
				const markUnresolved = ( reason: string ) => {
					for ( const link of links ) link.dataset.blocksEngineCaptureAnchorUnresolved = reason;
				};
				if ( index >= 32 ) {
					markUnresolved( 'runtime fragment target limit reached' );
					return null;
				}
				const authoredTargets = [
					...document.querySelectorAll< HTMLElement >( '[id],a[name]' ),
				].filter(
					( element ) => element.id === fragment || element.getAttribute( 'name' ) === fragment
				);
				if ( authoredTargets.length === 1 ) {
					authoredTargets[ 0 ]!.dataset.blocksEngineCaptureAnchorTarget = fragment;
					for ( const link of links ) link.href = `${ location.pathname }#${ encodeURIComponent( fragment ) }`;
					return null;
				}
				if ( authoredTargets.length > 1 ) {
					markUnresolved( 'multiple authored fragment targets' );
					return null;
				}

				const trigger = links.find( ( link ) => {
					const rect = link.getBoundingClientRect();
					const style = getComputedStyle( link );
					return (
						rect.width > 0 &&
						rect.height > 0 &&
						style.display !== 'none' &&
						style.visibility !== 'hidden' &&
						style.opacity !== '0'
					);
				} );
				if ( ! trigger ) {
					// A link inside a collapsed menu becomes clickable once the
					// visitor opens that menu; anything else has no trigger.
					const menuLink = links.find( ( link ) => link.closest( 'nav,[role="navigation"],[data-hook="menu-root"]' ) );
					const menuButton = [ ...document.querySelectorAll< HTMLElement >( 'button[aria-label]' ) ].find(
						( button ) => /^\s*menu\s*$/i.test( button.getAttribute( 'aria-label' ) ?? '' ) && button.getClientRects().length > 0
					);
					if ( ! menuLink || ! menuButton ) {
						markUnresolved( 'no rendered fragment trigger' );
						return null;
					}
					return {
						index: [ ...document.querySelectorAll( 'a[data-blocks-engine-capture-anchor-fragment]' ) ].indexOf( menuLink ),
						menu: true,
					};
				}
				return {
					index: [ ...document.querySelectorAll( 'a[data-blocks-engine-capture-anchor-fragment]' ) ].indexOf( trigger ),
					menu: false,
				};
			}, { fragment, index } );
			if ( ! trigger ) continue;

			// Use Playwright's trusted input: Wix ignores synthetic `.click()` for
			// this navigation on some desktop pages.
			let link = page.locator( 'a[data-blocks-engine-capture-anchor-fragment]' ).nth( trigger.index );
			// On a phone layout the menu's links render only once its collapsed
			// menu opens, exactly as a visitor sees them: tap the menu button and
			// follow the same destination from the opened menu, which renders its
			// own copy of the link.
			if ( trigger.menu && ( await openCollapsedMenu( page ) ) ) {
				link = page.locator( `a[href$="#${ encodeURIComponent( fragment ) }"]` ).filter( { visible: true } ).first();
			} else if ( trigger.menu ) {
				await page.evaluate( ( fragment ) => {
					for ( const anchor of document.querySelectorAll< HTMLAnchorElement >(
						`a[data-blocks-engine-capture-anchor-fragment="${ CSS.escape( fragment ) }"]`
					) ) {
						anchor.dataset.blocksEngineCaptureAnchorUnresolved = 'no rendered fragment trigger';
					}
				}, fragment );
				continue;
			}
			let initialScroll: number;
			try {
				await link.scrollIntoViewIfNeeded( { timeout: WIX_ANCHOR_SCROLL_MAX_MILLISECONDS } );
				// Record before the trusted click: an instant handler can finish scrolling
				// before Playwright returns. Its own visibility scroll is already complete.
				initialScroll = await page.evaluate( () => scrollY );
				await link.click( { timeout: WIX_ANCHOR_SCROLL_MAX_MILLISECONDS } );
			} catch {
				// One unclickable trigger must not abandon the remaining links, or
				// the rest of this hook: record why this fragment has no target.
				if ( trigger.menu ) await closeOpenedMenu( page );
				await page.evaluate( ( fragment ) => {
					for ( const anchor of document.querySelectorAll< HTMLAnchorElement >(
						`a[data-blocks-engine-capture-anchor-fragment="${ CSS.escape( fragment ) }"]`
					) ) {
						anchor.dataset.blocksEngineCaptureAnchorUnresolved = 'runtime trigger click failed';
					}
				}, fragment );
				continue;
			}
			// A drawer keeps the body's scroll locked while it is open, so the
			// link's own navigation cannot move the document until the drawer is
			// gone. Close it before waiting for the landing (when the click itself
			// closed the menu, as the collapsed-menu runtime usually does on
			// layouts where the drawer is not scroll-locking, this is a no-op).
			if ( trigger.menu ) await closeOpenedMenu( page );
			await page.evaluate( async ( { fragment, maxWait, noMoveMs, initialScroll } ) => {
				const links = [ ...document.querySelectorAll< HTMLAnchorElement >(
					`a[data-blocks-engine-capture-anchor-fragment="${ CSS.escape( fragment ) }"]`
				) ].filter( ( link ) => {
					try {
						return new URL( link.href, location.href ).pathname === location.pathname;
					} catch {
						return false;
					}
				} );
				const markUnresolved = ( reason: string ) => {
					for ( const link of links ) link.dataset.blocksEngineCaptureAnchorUnresolved = reason;
				};
				let previous = scrollY;
				const startHeight = document.documentElement.scrollHeight;
				let moved = false;
				let stableFrames = 0;
				// Bounds are measured time, not iterations: a throttled timer would
				// otherwise stretch every bound by its own lateness.
				const waitStarted = performance.now();
				while ( performance.now() - waitStarted < maxWait && ( ! moved || stableFrames < 4 ) ) {
					await new Promise( ( resolve ) => setTimeout( resolve, 50 ) );
					if ( Math.abs( scrollY - initialScroll ) >= 1 ) moved = true;
					if ( Math.abs( scrollY - previous ) < 1 ) stableFrames++;
					else stableFrames = 0;
					previous = scrollY;
					// Stability keeps the full bound: a runtime that scrolls at all
					// moves within this beat of the click, so once the document has
					// held scroll and height past the beat without moving, the
					// click's landing is not coming, and continuing to the full bound
					// only spends the wait (#839: every drawer link that never
					// scrolled paid the whole bound on the mobile profile).
					if ( ! moved && performance.now() - waitStarted >= noMoveMs && document.documentElement.scrollHeight === startHeight ) break;
				}
				if ( ! moved ) {
					markUnresolved( 'runtime scroll did not move before timeout' );
					return false;
				}

				const targetTop = scrollY;
				const candidates = [
					...document.querySelectorAll< HTMLElement >(
						'section,article,main,footer,[role="region"],[role="contentinfo"],[data-testid="section-container"]'
					),
				]
					.filter( ( element ) => element.getClientRects().length > 0 )
					.map( ( element ) => ( {
						element,
						top: element.getBoundingClientRect().top + scrollY,
					} ) )
					.sort(
						( left, right ) => Math.abs( left.top - targetTop ) - Math.abs( right.top - targetTop )
					);
				const resolved = candidates[ 0 ];
				const headerOffset = document.querySelector< HTMLElement >( 'header' )?.getBoundingClientRect().height ?? 0;
				if ( ! resolved || Math.abs( resolved.top - targetTop ) > Math.max( 4, Math.ceil( headerOffset ) + 8 ) ) {
					markUnresolved( 'runtime scroll did not resolve to a section boundary' );
					return false;
				}

				// The target lives inside the section it resolved to, not at a page
				// coordinate: content above it can still change height (late media,
				// removed platform banners), and the section moves with it. The
				// runtime's landing offset from the section edge (it keeps the
				// section clear of pinned chrome) is replayed as scroll-margin.
				const marker = document.createElement( 'span' );
				marker.id = fragment;
				marker.dataset.blocksEngineCaptureAnchorTarget = fragment;
				if ( resolved.element.id ) marker.dataset.blocksEngineCaptureAnchorSourceId = resolved.element.id;
				marker.setAttribute( 'aria-hidden', 'true' );
				// Absolutely positioned without offsets, the marker sits at its
				// static position, the section's start, and stays out of the
				// section's own (often grid) layout.
				marker.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
				resolved.element.prepend( marker );
				const margin = Math.round( resolved.top - targetTop );
				if ( margin > 0 ) marker.style.scrollMarginTop = `${ margin }px`;
				for ( const link of links ) link.href = `${ location.pathname }#${ encodeURIComponent( fragment ) }`;
				return true;
			}, { fragment, maxWait: WIX_ANCHOR_SCROLL_MAX_MILLISECONDS, noMoveMs: WIX_ANCHOR_NO_MOVE_MILLISECONDS, initialScroll } );
		}

		await restoreScroll();
		await page.mouse.move( 0, 0 );
		await page.evaluate( restoreInteractionAttributes );

		const galleries = await page.evaluate( async () => {
			const urls = [
				...new Set(
					performance
						.getEntriesByType( 'resource' )
						.map( ( entry ) => entry.name )
						.filter( ( name ) => name.includes( '/pages/thunderbolt' ) )
				),
			];
			const itemsByComp: Record< string, Array< { uri: string; alt?: string; title?: string } > > =
				{};
			for ( const url of urls ) {
				try {
					const data = ( await ( await fetch( url ) ).json() ) as {
						props?: { tpa?: { tpaGalleriesImageItems?: Record< string, unknown > } };
					};
					const items = data.props?.tpa?.tpaGalleriesImageItems;
					if ( ! items ) continue;
					for ( const [ id, value ] of Object.entries( items ) ) {
						if ( ! Array.isArray( value ) ) continue;
						itemsByComp[ id ] = value.flatMap( ( entry ) => {
							if ( ! entry || typeof entry !== 'object' ) return [];
							const uri = ( entry as { uri?: unknown } ).uri;
							if ( typeof uri !== 'string' || ! uri ) return [];
							const alt = ( entry as { alt?: unknown } ).alt;
							const title = ( entry as { title?: unknown } ).title;
							return [
								{
									uri,
									...( typeof alt === 'string' ? { alt } : {} ),
									...( typeof title === 'string' ? { title } : {} ),
								},
							];
						} );
					}
				} catch {
					/* thunderbolt payloads that are not gallery JSON are ignored */
				}
			}
			return itemsByComp;
		} );

		for ( const [ id, items ] of Object.entries( galleries ) ) {
			if ( items.length === 0 ) continue;
			const size = await page.evaluate( ( compId: string ) => {
				const host = document.getElementById( compId );
				if ( ! host ) return { width: 1340, height: 486 };
				const box = host.getBoundingClientRect();
				return {
					width: Math.max( 1, Math.round( box.width ) ),
					height: Math.max( 1, Math.round( box.height ) ),
				};
			}, id );
			const { html, css } = stripShowcaseMarkup( items, size );
			await page.evaluate(
				( { compId, markup, stylesheet } ) => {
					const host = document.getElementById( compId );
					if ( ! host ) return;
					if ( ! document.getElementById( 'data-blocks-engine-capture-slideshow-css' ) ) {
						const style = document.createElement( 'style' );
						style.id = 'data-blocks-engine-capture-slideshow-css';
						style.textContent = stylesheet;
						document.head.append( style );
					}
					const wrap = document.createElement( 'div' );
					wrap.innerHTML = markup;
					const slideshow = wrap.firstElementChild;
					if ( ! slideshow ) return;
					const frame = host.querySelector( 'iframe, wix-iframe' );
					if ( frame ) frame.replaceWith( slideshow );
					else host.replaceChildren( slideshow );
				},
				{ compId: id, markup: html, stylesheet: css }
			);
		}
	},

	/**
	 * Image boxes the runtime sizes to their container are declared on the
	 * host, so the copy carries that relationship and the sweep skips them
	 * (see image-geometry.ts).
	 */
	beforeFluid: async ( page ) => {
		await normalizeWixImageGeometry( page );
	},

	/**
	 * Fluid learning resizes the page after prepare. Collect slideshows on the
	 * DOM that is about to be frozen so a late-hydrated widget is not lost.
	 */
	beforeSerialize: async ( page, ctx ) => {
		await revealAndCollectWixSlideshows( page, ctx.serverHtml );
		// Maps and App Market widgets only work inside Wix's viewer (see embeds.ts).
		await portWixRuntimeEmbeds( page ).catch( () => undefined );
		// Revealing a slideshow scrolls, so the chrome is settled after it.
		await settleScrollReactiveChrome( page );
		// The members dialog is gone, so the controls that opened it are marked
		// for the destination to point at its own login (see member-login.ts).
		// Last of all, so a scroll-driven rerender cannot drop the marker
		// before the freeze.
		// Post counters are the destination's feature, not content (see
		// engagement-stats.ts); emptied last, after any scroll-driven rerender.
		await page.evaluate( markEngagementStats, {
			...WIX_ENGAGEMENT_STATS, attribute: ENGAGEMENT_STATS_ATTRIBUTE, classPrefix: ENGAGEMENT_STATS_CLASS_PREFIX,
		} ).catch( () => 0 );
		await page.evaluate( markMemberLoginControls, {
			...WIX_MEMBER_LOGIN, memberPaths: wixMemberPaths( ctx.url ),
			attribute: MEMBER_LOGIN_ATTRIBUTE, classPrefix: MEMBER_LOGIN_CLASS_PREFIX,
		} ).catch( () => 0 );
	},

	/**
	 * At narrow viewports Wix's `<wow-image>` runtime swaps each image for a
	 * mobile-cropped CDN variant. Recording {media id → variant URL} lets the
	 * export serve that crop via `<picture>` with no JavaScript.
	 */
	async responsiveImages( page ) {
		// The browser step stays generic — read the URLs the runtime settled on.
		// Deciding which are Wix variants happens here, where it can be tested.
		const urls = await page.evaluate( () =>
			[ ...document.querySelectorAll( 'img' ) ].map(
				( image ) => ( image as HTMLImageElement ).currentSrc || ( image as HTMLImageElement ).src || ''
			)
		);
		const variants: Record< string, string > = {};
		for ( const url of urls ) {
			const variant = wixMediaVariant( url );
			if ( variant ) variants[ variant.id ] = variant.url;
		}
		return variants;
	},
};
