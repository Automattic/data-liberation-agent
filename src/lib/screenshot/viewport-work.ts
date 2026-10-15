/**
 * Records the delayed work a viewport change scheduled, so readiness can end
 * on evidence instead of a fixed window.
 *
 * The caller arms the tracker immediately before it changes the viewport
 * (resizes or scrolls) and releases it once the rendering update that
 * dispatched the resulting events, with the media-query, ResizeObserver and
 * animation-frame callbacks it runs, has finished. Every timeout scheduled in
 * between is pending viewport work: a debounced resize handler is a timeout
 * set from a resize listener. A pending timeout's own callback may schedule
 * further timeouts (a debounce rescheduling its trailing call), which stay
 * pending for a bounded number of generations so a poller caught in the
 * window cannot hold readiness for long. Long timeouts are not readiness work.
 * Arming from outside the dispatch keeps listener registration order
 * irrelevant: no listener is added to the page.
 *
 * Install with `addInitScript` before the source runs, so sources that keep
 * their own reference to `setTimeout` are observed too. Read it through
 * `window[Symbol.for(VIEWPORT_WORK_KEY)]`. The function is self-contained and
 * idempotent, so a page without the init script can install it late; it then
 * observes timeouts scheduled through the global `setTimeout` only.
 */
export const VIEWPORT_WORK_KEY = 'data-liberation.viewport-work';

export interface ViewportWork {
	/** Timeouts scheduled from now until `release` are viewport work. */
	arm(): void;
	/** Stop attributing timeouts once the next rendering update has finished. */
	release(): Promise< void >;
	/** Viewport-work timeouts that have neither run nor been cleared. */
	pending(): number;
	/** Sleep without being counted as viewport work. */
	sleep( ms: number ): Promise< void >;
}

export function observeViewportWork(): void {
	const key = Symbol.for( 'data-liberation.viewport-work' );
	if ( key in window ) return;
	// Debounces outlast 250–500 ms; a multi-second timeout is not resize work.
	const MAX_DELAY_MS = 2000;
	const MAX_GENERATIONS = 4;
	type Schedule = ( handler: unknown, delay?: number, ...args: unknown[] ) => number;
	type Cancel = ( id?: number ) => void;
	const scope = window as unknown as { setTimeout: Schedule; clearTimeout: Cancel; clearInterval: Cancel };
	const nativeSet = scope.setTimeout;
	const nativeClear = scope.clearTimeout;
	const nativeClearInterval = scope.clearInterval;
	const pending = new Set< number >();
	// 0 outside viewport work; otherwise the generation of what is running.
	let generation = 0;
	scope.setTimeout = function ( handler, delay, ...args ) {
		if ( generation === 0 || typeof handler !== 'function' || ! ( ( Number( delay ) || 0 ) <= MAX_DELAY_MS ) ) {
			return nativeSet.call( window, handler, delay, ...args );
		}
		const next = generation >= MAX_GENERATIONS ? 0 : generation + 1;
		const id: number = nativeSet.call( window, function ( this: unknown, ...callArgs: unknown[] ) {
			pending.delete( id );
			const previous = generation;
			generation = next;
			try {
				return ( handler as ( ...values: unknown[] ) => unknown ).apply( this, callArgs );
			} finally {
				generation = previous;
			}
		}, delay, ...args );
		pending.add( id );
		return id;
	};
	scope.clearTimeout = function ( id ) {
		if ( id !== undefined ) pending.delete( id );
		return nativeClear.call( window, id );
	};
	// Timeout and interval ids share one pool; either clear cancels a timeout.
	scope.clearInterval = function ( id ) {
		if ( id !== undefined ) pending.delete( id );
		return nativeClearInterval.call( window, id );
	};
	const sleep = ( ms: number ) => new Promise< void >( resolve => { nativeSet.call( window, resolve, ms ); } );
	const work: ViewportWork = {
		arm() { if ( generation === 0 ) generation = 1; },
		async release() {
			// Resize and scroll events are dispatched before animation-frame
			// callbacks, and ResizeObserver callbacks after them in the same update.
			// The bound covers a page that renders no frames.
			const frame = () => new Promise< void >( resolve => requestAnimationFrame( () => resolve() ) );
			await Promise.race( [ frame().then( frame ), sleep( 200 ) ] );
			await sleep( 0 );
			generation = 0;
		},
		pending: () => pending.size,
		sleep,
	};
	Object.defineProperty( window, key, { configurable: true, value: work } );
}
