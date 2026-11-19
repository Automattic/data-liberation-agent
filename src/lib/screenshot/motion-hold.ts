/**
 * Holds source motion so a serialized document and a reference screenshot
 * describe one moment (#2007).
 *
 * An autoplaying carousel advances on its own timers. Capture serializes the
 * document that becomes `website/` on one page load; the frozen fidelity
 * reference is taken on another. Without a shared moment the two can show
 * different slides, and parity reports the difference as a pixel region no
 * export change can fix.
 *
 * `observeMotionHold` is installed with `addInitScript` before source scripts.
 * While held, callbacks of timeouts, intervals and animation frames the page
 * registered before the hold do not run: timeouts and frames are deferred until
 * release, interval ticks are skipped. Callbacks the source's own scripts
 * register during the hold (a component re-arming its autoplay interval after a
 * re-render or a mouseleave) are held too: a registration whose call stack runs
 * through a page script URL is source work. Probe code awaiting its own timer
 * has no such frame and runs normally. The source's state is never rewritten;
 * its clock is paused. In-flight CSS transitions are settled before a held
 * document is read or screenshotted, so a slide fading in paints its end state.
 *
 * Capture holds around its baseline serialization and records which text and
 * images are painted in that document, plus what changed on its own while the
 * capture page was alive. The reference holds before it reads its document and
 * screenshots; when a rotating token disagrees with capture, it releases and
 * re-holds until the source reaches the captured state or the bound ends. At
 * capture's own width, text or images that capture painted and the reference
 * only holds hidden (and the reverse) count as rotating too, so a carousel
 * slower than either page's own readings is still aligned. At any other width
 * such a swap is only a candidate, because responsive content legitimately
 * differs by width: the reference releases its page for a bounded window, and
 * only a candidate that changes on its own there is rotation and aligned.
 */
import type { Page } from 'playwright';
import { orElse } from '../failure-class.js';

export const MOTION_HOLD_KEY = 'data-liberation.motion-hold';
/** Upper bound for a reference cell to wait for the captured rotation state. */
export const MOTION_ALIGN_TIMEOUT_MS = 30_000;
const MOTION_ALIGN_POLL_MS = 100;
/**
 * Upper bound for a reference cell at a width other than capture's to watch a
 * hidden/painted swap against capture change on its own before treating it as
 * responsive content. Only cells with such a candidate wait.
 */
export const MOTION_CONFIRM_TIMEOUT_MS = 10_000;
/** In-flight CSS transitions settle within this bound before tokens are read. */
const TRANSITION_SETTLE_MS = 1_000;

export interface SourceMotion {
	/** Painted text/image tokens of the serialized capture document. */
	painted: string[];
	/** Tokens observed rotating (one appeared while another disappeared) on the capture page. */
	rotating: string[];
	/** Tokens present in the serialized document but not painted (hidden slides). */
	latent?: string[];
	/** Viewport width the capture document was read at. */
	width?: number;
}

/** One reading of a page: what paints, what is present but hidden, at which width. */
export interface PaintReading {
	painted: string[];
	latent: string[];
	width: number;
}

export function observeMotionHold(): void {
	const named = globalThis as typeof globalThis & { __name?: ( fn: unknown ) => unknown };
	named.__name ??= fn => fn;
	const key = Symbol.for( 'data-liberation.motion-hold' );
	if ( key in window ) return;
	type Schedule = ( handler: unknown, delay?: number, ...args: unknown[] ) => number;
	type Cancel = ( id?: number ) => void;
	type Frame = ( callback: FrameRequestCallback ) => number;
	const scope = window as unknown as { setTimeout: Schedule; setInterval: Schedule; clearTimeout: Cancel; clearInterval: Cancel; requestAnimationFrame: Frame; cancelAnimationFrame: Cancel };
	const nativeSet = scope.setTimeout;
	const nativeInterval = scope.setInterval;
	const nativeClear = scope.clearTimeout;
	const nativeClearInterval = scope.clearInterval;
	const nativeFrame = scope.requestAnimationFrame;
	const nativeCancelFrame = scope.cancelAnimationFrame;
	const NativeError = Error;
	let sequence = 0;
	// 0 while running; otherwise callbacks registered before this sequence are held.
	let heldFrom = 0;
	const held = ( registered: number ) => heldFrom !== 0 && registered < heldFrom;
	// Page scripts carry their URL in stack frames; probe code evaluated through
	// DevTools and init scripts are anonymous.
	const sourceFrame = /^\s*at .*\b(?:https?|file):\/\//m;
	const fromSource = (): boolean => {
		try {
			const stack: unknown = new NativeError().stack;
			return typeof stack === 'string' && sourceFrame.test( stack );
		} catch { return false; }
	};
	// A source registration during a hold is stamped as pre-existing, so it is held.
	const stamp = () => heldFrom !== 0 && fromSource() ? 0 : ++sequence;
	const timeouts = new Map<number, () => void>();
	const frames = new Map<number, FrameRequestCallback>();
	scope.setTimeout = function ( handler, delay, ...args ) {
		if ( typeof handler !== 'function' ) return nativeSet.call( window, handler, delay, ...args );
		const registered = stamp();
		const run = () => ( handler as ( ...values: unknown[] ) => unknown ).apply( window, args );
		const id: number = nativeSet.call( window, () => {
			if ( held( registered ) ) { timeouts.set( id, run ); return; }
			run();
		}, delay );
		return id;
	};
	scope.setInterval = function ( handler, delay, ...args ) {
		if ( typeof handler !== 'function' ) return nativeInterval.call( window, handler, delay, ...args );
		const registered = stamp();
		return nativeInterval.call( window, () => {
			if ( ! held( registered ) ) ( handler as ( ...values: unknown[] ) => unknown ).apply( window, args );
		}, delay );
	};
	// Timeout and interval ids share one pool; either clear cancels a deferred timeout.
	scope.clearTimeout = function ( id ) {
		if ( id !== undefined ) timeouts.delete( id );
		return nativeClear.call( window, id );
	};
	scope.clearInterval = function ( id ) {
		if ( id !== undefined ) timeouts.delete( id );
		return nativeClearInterval.call( window, id );
	};
	if ( typeof nativeFrame === 'function' ) {
		scope.requestAnimationFrame = function ( callback ) {
			if ( typeof callback !== 'function' ) return nativeFrame.call( window, callback );
			const registered = stamp();
			const id: number = nativeFrame.call( window, time => {
				if ( held( registered ) ) { frames.set( id, callback ); return; }
				callback( time );
			} );
			return id;
		};
		scope.cancelAnimationFrame = function ( id ) {
			if ( id !== undefined ) frames.delete( id );
			return nativeCancelFrame.call( window, id );
		};
	}
	Object.defineProperty( window, key, { configurable: true, value: {
		hold(): boolean {
			if ( heldFrom === 0 ) heldFrom = ++sequence;
			return true;
		},
		release(): void {
			if ( heldFrom === 0 ) return;
			heldFrom = 0;
			// One task or frame per deferred callback, so a throwing callback cannot
			// starve the others; a clear issued before it runs still cancels it.
			for ( const [ id, run ] of [ ...timeouts ] ) nativeSet.call( window, () => {
				if ( timeouts.get( id ) !== run ) return;
				timeouts.delete( id );
				run();
			}, 0 );
			for ( const [ id, callback ] of [ ...frames ] ) nativeFrame.call( window, time => {
				if ( frames.get( id ) !== callback ) return;
				frames.delete( id );
				callback( time );
			} );
		},
	} } );
}

type MotionHold = { hold(): boolean; release(): void };

/** Pause the source's own timers. False when the page has no hold installed. */
export async function holdSourceMotion( page: Page ): Promise<boolean> {
	return await page.evaluate( key => ( window as unknown as Record<symbol, MotionHold | undefined> )[ Symbol.for( key ) ]?.hold() ?? false, MOTION_HOLD_KEY ).catch( orElse( false ) ) === true;
}

export async function releaseSourceMotion( page: Page ): Promise<void> {
	await page.evaluate( key => { ( window as unknown as Record<symbol, MotionHold | undefined> )[ Symbol.for( key ) ]?.release(); }, MOTION_HOLD_KEY ).catch( orElse( undefined ) );
}

/**
 * Let in-flight CSS transitions finish, then complete any still running at the
 * bound. A transition only animates towards styles the document already has, so
 * finishing it never changes the document; it makes the paint match it.
 */
export async function settleTransitions( page: Page ): Promise<void> {
	const deadline = Date.now() + TRANSITION_SETTLE_MS;
	const running = () => page.evaluate( () => document.getAnimations().some( animation => typeof CSSTransition !== 'undefined' && animation instanceof CSSTransition && animation.playState === 'running' ) ).catch( orElse( false ) );
	while ( await running() === true ) {
		if ( Date.now() >= deadline ) {
			await page.evaluate( () => {
				for ( const animation of document.getAnimations() ) {
					if ( typeof CSSTransition !== 'undefined' && animation instanceof CSSTransition && animation.playState === 'running' ) {
						try { animation.finish(); } catch { /* an unfinishable transition keeps painting as is */ }
					}
				}
			} ).catch( orElse( undefined ) );
			return;
		}
		await new Promise( resolve => setTimeout( resolve, 50 ) );
	}
}

/**
 * Text and image tokens that paint: visible, not fully transparent (on the
 * element or any ancestor), and inside every clipping ancestor. Off-screen
 * content still paints; a slide parked outside its carousel's clip, hidden,
 * `visibility: hidden` or at opacity 0 does not. In-flight CSS transitions are
 * settled first.
 */
export async function readPaintedTokens( page: Page ): Promise<string[]> {
	return ( await readPaintState( page ) ).painted;
}

/** Painted tokens plus the tokens present in the document that do not paint. */
export async function readPaintState( page: Page ): Promise<PaintReading> {
	await settleTransitions( page );
	const reading: unknown = await page.evaluate( () => {
		type Box = { left: number; top: number; right: number; bottom: number };
		const unbounded: Box = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
		const clips = new Map<Element, Box>();
		const clipOf = ( element: Element | null ): Box => {
			if ( ! element || element === document.documentElement ) return unbounded;
			const known = clips.get( element );
			if ( known ) return known;
			const parent = clipOf( element.parentElement );
			const style = getComputedStyle( element );
			let clip = parent;
			if ( style.overflowX !== 'visible' || style.overflowY !== 'visible' ) {
				const rect = element.getBoundingClientRect();
				clip = { left: Math.max( parent.left, rect.left ), top: Math.max( parent.top, rect.top ), right: Math.min( parent.right, rect.right ), bottom: Math.min( parent.bottom, rect.bottom ) };
			}
			clips.set( element, clip );
			return clip;
		};
		const visible = new Map<Element, boolean>();
		// Opacity is inherited by paint, not by computed style: an opacity-0
		// ancestor hides its whole subtree (checkVisibility already walks them).
		const transparent = ( element: Element | null ): boolean => {
			for ( let current = element; current; current = current.parentElement ) if ( Number.parseFloat( getComputedStyle( current ).opacity ) === 0 ) return true;
			return false;
		};
		const shows = ( element: Element ): boolean => {
			const known = visible.get( element );
			if ( known !== undefined ) return known;
			const result = typeof element.checkVisibility === 'function'
				? element.checkVisibility( { checkOpacity: true, checkVisibilityCSS: true } )
				: getComputedStyle( element ).visibility !== 'hidden' && element.getClientRects().length > 0 && ! transparent( element );
			visible.set( element, result );
			return result;
		};
		const paints = ( rect: DOMRect, clip: Box ) => rect.width > 0 && rect.height > 0 &&
			Math.min( rect.right, clip.right ) - Math.max( rect.left, clip.left ) > 0.5 &&
			Math.min( rect.bottom, clip.bottom ) - Math.max( rect.top, clip.top ) > 0.5;
		const tokens = new Set<string>();
		const latent = new Set<string>();
		const width = window.innerWidth;
		if ( ! document.body ) return { painted: [], latent: [], width };
		const walker = document.createTreeWalker( document.body, NodeFilter.SHOW_TEXT );
		const range = document.createRange();
		for ( let node = walker.nextNode(); node && tokens.size < 20_000; node = walker.nextNode() ) {
			const parent = node.parentElement;
			const text = node.textContent?.replace( /\s+/g, ' ' ).trim().slice( 0, 160 );
			if ( ! parent || ! text || parent.closest( 'script,style,noscript,template' ) ) continue;
			const token = `text:${ text }`;
			if ( ! shows( parent ) ) { latent.add( token ); continue; }
			range.selectNodeContents( node );
			( paints( range.getBoundingClientRect(), clipOf( parent ) ) ? tokens : latent ).add( token );
		}
		for ( const image of Array.from( document.images ) ) {
			const source = image.currentSrc || image.getAttribute( 'src' ) || '';
			if ( ! source || source.startsWith( 'data:' ) ) continue;
			const token = `image:${ source.replace( /[?#].*$/, '' ).split( '/' ).pop() }`;
			( shows( image ) && paints( image.getBoundingClientRect(), clipOf( image.parentElement ) ) ? tokens : latent ).add( token );
		}
		return { painted: [ ...tokens ].sort(), latent: [ ...latent ].filter( token => ! tokens.has( token ) ).sort(), width };
	} ).catch( orElse( undefined ) );
	const strings = ( value: unknown ) => Array.isArray( value ) ? value.filter( ( token ): token is string => typeof token === 'string' ) : [];
	const record = reading && typeof reading === 'object' ? reading as Record<string, unknown> : {};
	return { painted: strings( record.painted ), latent: strings( record.latent ), width: typeof record.width === 'number' ? record.width : 0 };
}

/**
 * Tokens that changed between two readings of one page, when the change is a
 * rotation: something appeared while something else disappeared. Lazy content
 * appearing or an entrance finishing changes in one direction only.
 */
export function motionChanges( before: readonly string[], after: readonly string[] ): string[] {
	const was = new Set( before );
	const now = new Set( after );
	const appeared = after.filter( token => ! was.has( token ) );
	const disappeared = before.filter( token => ! now.has( token ) );
	return appeared.length && disappeared.length ? [ ...appeared, ...disappeared ].sort() : [];
}

/**
 * Tokens that swapped between capture and an observation at the same width:
 * something capture painted is only present hidden now, while something hidden
 * at capture paints now. Static content does not swap at one width; a slide does.
 */
export function capturedSwaps( captured: SourceMotion, observed: PaintReading ): string[] {
	if ( ! captured.width || captured.width !== observed.width ) return [];
	return swaps( captured, observed );
}

/**
 * The same swap observed at a width other than capture's. Responsive content
 * can swap that way too, so it is a candidate: rotation only once the observed
 * page changes those tokens on its own.
 */
export function swapCandidates( captured: SourceMotion, observed: PaintReading ): string[] {
	if ( ! captured.width || ! observed.width || captured.width === observed.width ) return [];
	return swaps( captured, observed );
}

function swaps( captured: SourceMotion, observed: PaintReading ): string[] {
	if ( ! captured.latent ) return [];
	const wasPainted = new Set( captured.painted );
	const wasLatent = new Set( captured.latent );
	const shown = observed.painted.filter( token => wasLatent.has( token ) );
	const hidden = observed.latent.filter( token => wasPainted.has( token ) );
	return shown.length && hidden.length ? [ ...shown, ...hidden ].sort() : [];
}

/** Rotating tokens whose painted state differs between capture and the observed page. */
export function motionDisagreement( captured: readonly string[], observed: readonly string[], rotating: Iterable<string> ): string[] {
	const expected = new Set( captured );
	const actual = new Set( observed );
	return [ ...new Set( rotating ) ].filter( token => expected.has( token ) !== actual.has( token ) ).sort();
}

/**
 * One moment per route: the first profile to serialize a route sets it, and
 * later profiles of that route wait for the source to reach it before they
 * serialize, so an export that ships one document for every width still
 * agrees with every reference cell.
 */
export class RouteMotionEvidence {
	private readonly routes = new Map<string, SourceMotion>();
	get( url: string ): SourceMotion | undefined { return this.routes.get( url ); }
	claim( url: string, motion: SourceMotion ): void { if ( ! this.routes.has( url ) ) this.routes.set( url, motion ); }
}

const recorded = new WeakMap<Page, SourceMotion>();

/** Capture records the motion state of the document it serialized on this page. */
export function recordSourceMotion( page: Page, motion: SourceMotion ): void {
	recorded.set( page, motion );
}

export function recordedSourceMotion( page: Page ): SourceMotion | undefined {
	return recorded.get( page );
}

export interface MotionAlignment {
	/** Whether the page's timers are actually held. */
	held: boolean;
	/** Rotating tokens still disagreeing with capture when the bound ended. */
	disagreement: string[];
	release(): Promise<void>;
}

/**
 * Hold the page at a moment that agrees with `captured` on every rotating token.
 * `earlier` are previous readings of this page, oldest first; rotation between
 * them, and since the last of them, counts too. The page is left held: the caller reads its document and
 * screenshots, then releases.
 */
export async function alignSourceMotion( page: Page, captured: SourceMotion | undefined, earlier: readonly ( readonly string[] )[] = [], timeoutMs = MOTION_ALIGN_TIMEOUT_MS, confirmMs = MOTION_CONFIRM_TIMEOUT_MS ): Promise<MotionAlignment> {
	const rotating = new Set( captured?.rotating ?? [] );
	for ( let index = 1; index < earlier.length; index++ ) for ( const token of motionChanges( earlier[ index - 1 ]!, earlier[ index ]! ) ) rotating.add( token );
	const start = Date.now();
	const deadline = start + timeoutMs;
	const confirmDeadline = start + Math.min( confirmMs, timeoutMs );
	// Cross-width swaps against capture: rotation once one changes on its own.
	const candidates = new Set<string>();
	const unconfirmed = () => candidates.size > 0 && ! [ ...candidates ].some( token => rotating.has( token ) );
	let previous = earlier.at( -1 );
	const observe = async (): Promise<string[]> => {
		const reading = await readPaintState( page );
		if ( previous ) for ( const token of motionChanges( previous, reading.painted ) ) rotating.add( token );
		if ( captured ) for ( const token of capturedSwaps( captured, reading ) ) rotating.add( token );
		if ( captured ) for ( const token of swapCandidates( captured, reading ) ) candidates.add( token );
		previous = reading.painted;
		return reading.painted;
	};
	for ( ;; ) {
		const held = await holdSourceMotion( page );
		// Without capture evidence there is nothing to agree with: hold and let
		// in-flight transitions reach the state the document already has.
		if ( ! captured ) {
			await settleTransitions( page );
			return { held, disagreement: [], release: () => releaseSourceMotion( page ) };
		}
		const disagreement = motionDisagreement( captured.painted, await observe(), rotating );
		if ( ! disagreement.length && held && unconfirmed() && Date.now() < confirmDeadline ) {
			// Watch the candidates, unheld: rotation changes them on its own,
			// responsive content never does and stays as this width renders it.
			await releaseSourceMotion( page );
			while ( Date.now() < confirmDeadline && unconfirmed() ) {
				await new Promise( resolve => setTimeout( resolve, MOTION_ALIGN_POLL_MS ) );
				await observe();
			}
			continue;
		}
		if ( ! disagreement.length || ! held || Date.now() >= deadline ) return { held, disagreement, release: () => releaseSourceMotion( page ) };
		// Let the source run, unheld, until it shows the captured state: a held
		// page skips its interval ticks, so polling under a hold never advances.
		await releaseSourceMotion( page );
		while ( Date.now() < deadline ) {
			await new Promise( resolve => setTimeout( resolve, MOTION_ALIGN_POLL_MS ) );
			if ( ! motionDisagreement( captured.painted, await observe(), rotating ).length ) break;
		}
	}
}
