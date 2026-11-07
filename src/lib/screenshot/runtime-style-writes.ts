import type { Page } from 'playwright';

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
 * It also keeps each source `<style>`'s text as the runtime left it at load,
 * read at the first viewport change before any page handler runs, and notes
 * every `<style>` inserted while the viewport was away from the load width.
 * A runtime whose output depends on resize history (a fitter that only ever
 * shrinks) cannot reproduce its load-time sheets once capture probes have
 * resized the page.
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
	/**
	 * Source sheet text at load and the width it was written for; null before
	 * the first resize. A sheet inserted at another width reads as empty.
	 */
	loadSheets(): { width: number; sheets: Array< [ HTMLStyleElement, string ] > } | null;
}

export function observeRuntimeStyleWrites(): void {
	const key = Symbol.for( 'data-liberation.runtime-style-writes' );
	if ( key in window ) return;
	const styled = new WeakSet< Node >();
	const inserted = new WeakSet< Node >();
	let reactive = false;
	let ready = document.readyState !== 'loading';
	// Registered before any page script, so it runs before their resize handlers.
	const loadWidth = innerWidth;
	let loadSheets: Array< [ HTMLStyleElement, string ] > | null = null;
	const bornElsewhere = new Set< HTMLStyleElement >();
	window.addEventListener( 'resize', () => {
		loadSheets ??= [ ...document.querySelectorAll( 'style' ) ].map( style => [ style, style.textContent ?? '' ] );
	}, { once: true } );
	const record = ( mutations: MutationRecord[] ) => {
		for ( const mutation of mutations ) {
			if ( innerWidth !== loadWidth ) {
				mutation.addedNodes.forEach( node => { if ( node instanceof HTMLStyleElement ) bornElsewhere.add( node ); } );
			}
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
		loadSheets() {
			record( observer.takeRecords() );
			return loadSheets && { width: loadWidth, sheets: [ ...loadSheets, ...[ ...bornElsewhere ].map( style => [ style, '' ] as [ HTMLStyleElement, string ] ) ] };
		},
	};
	Object.defineProperty( window, key, { configurable: true, value: tracker } );
}

/**
 * Put source sheets back to the text the runtime wrote for this width at load.
 *
 * Capture probes resize the page before the document is serialized. A runtime
 * that rewrites its sheet on resize may not return to its load-time text at
 * the capture width (a fitter that only shrinks stays at the narrowest size it
 * visited), or may have created a sheet for a probe width that a visitor at
 * this width never gets. Applies only at the load width and to source sheets;
 * returns how many were restored.
 */
export async function restoreLoadTimeSheets( page: Page ): Promise< number > {
	return page.evaluate( key => {
		const record = ( window as unknown as Record< symbol, RuntimeStyleWrites | undefined > )[ Symbol.for( key ) ]?.loadSheets();
		if ( ! record || innerWidth !== record.width ) return 0;
		let restored = 0;
		for ( const [ style, text ] of record.sheets ) {
			if ( ! style.isConnected || style.textContent === text ) continue;
			// Capture's own sheets (constructed-sheet copies, learned rules) are not source state.
			if ( style.getAttributeNames().some( name => name.startsWith( 'data-blocks-engine-capture-' ) ) ) continue;
			style.textContent = text;
			restored++;
		}
		return restored;
	}, RUNTIME_STYLE_WRITES_KEY );
}
