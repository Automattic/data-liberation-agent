/**
 * Records whether the source can produce width-dependent inline geometry.
 *
 * An inline declaration served in the markup only changes when script
 * rewrites it; media queries never touch the `style` attribute. Script can
 * rewrite it at load (observed as a `style` mutation, or as a node inserted
 * after DOMContentLoaded) or later, in response to a viewport change. The
 * second case is detected by observing every registration that can react to a
 * viewport change: window and visualViewport `resize`/`orientationchange`
 * listeners and handlers, `ResizeObserver`, and media query change listeners.
 *
 * Install with `addInitScript` before the source runs and read it through
 * `window[Symbol.for(RUNTIME_STYLE_WRITES_KEY)]`. When the tracker is absent,
 * callers must assume every inline style is runtime-written.
 */
export const RUNTIME_STYLE_WRITES_KEY = 'data-liberation.runtime-style-writes';

export interface RuntimeStyleWrites {
	/** Script wrote this element's inline style or created the element. */
	written( element: Element ): boolean;
	/** Script registered something that can react to a viewport change. */
	viewportReactive(): boolean;
}

export function observeRuntimeStyleWrites(): void {
	const key = Symbol.for( 'data-liberation.runtime-style-writes' );
	if ( key in window ) return;
	const styled = new WeakSet< Node >();
	const inserted = new WeakSet< Node >();
	let reactive = false;
	let ready = document.readyState !== 'loading';
	const record = ( mutations: MutationRecord[] ) => {
		for ( const mutation of mutations ) {
			if ( mutation.type === 'attributes' ) styled.add( mutation.target );
			else if ( ready ) mutation.addedNodes.forEach( node => inserted.add( node ) );
		}
	};
	const observer = new MutationObserver( record );
	observer.observe( document, { subtree: true, childList: true, attributes: true, attributeFilter: [ 'style' ] } );
	document.addEventListener( 'DOMContentLoaded', () => { record( observer.takeRecords() ); ready = true; }, { once: true } );

	const watchListeners = ( target: EventTarget | null | undefined, types: RegExp ) => {
		if ( ! target ) return;
		const add = target.addEventListener;
		Object.defineProperty( target, 'addEventListener', {
			configurable: true,
			writable: true,
			value( this: EventTarget, type: string, ...rest: unknown[] ) {
				if ( types.test( type ) ) reactive = true;
				return ( add as ( ...args: unknown[] ) => void ).call( this, type, ...rest );
			},
		} );
	};
	watchListeners( window, /^(resize|orientationchange)$/ );
	watchListeners( window.visualViewport, /^resize$/ );
	watchListeners( MediaQueryList.prototype, /^change$/ );
	const addListener = MediaQueryList.prototype.addListener;
	MediaQueryList.prototype.addListener = function ( this: MediaQueryList, ...args ) {
		reactive = true;
		return addListener.apply( this, args );
	};
	if ( window.ResizeObserver ) {
		const Native = window.ResizeObserver;
		window.ResizeObserver = class extends Native {
			constructor( callback: ResizeObserverCallback ) {
				reactive = true;
				super( callback );
			}
		};
	}

	const tracker: RuntimeStyleWrites = {
		written( element ) {
			record( observer.takeRecords() );
			if ( styled.has( element ) ) return true;
			for ( let node: Node | null = element; node; node = node.parentNode ) if ( inserted.has( node ) ) return true;
			return false;
		},
		viewportReactive() {
			// Handler properties read as null (or undefined where unsupported) until set.
			return reactive || window.onresize != null || window.onorientationchange != null ||
				window.visualViewport?.onresize != null;
		},
	};
	Object.defineProperty( window, key, { configurable: true, value: tracker } );
}
