import type { Page } from 'playwright';
import * as cheerio from 'cheerio';

export const VIEWPORT_ENTRANCE_ATTRIBUTE = 'data-dla-viewport-entrance';

interface EntranceState {
	attributes: Record<string, { before: string | null; after: string | null }>;
	rootMargin: string;
	threshold: number[];
	repeat: boolean;
}

/** Install before hydration. Observe the source's own viewport trigger rather than guessing selectors. */
export function observeViewportEntrances(): void {
	const named = globalThis as typeof globalThis & { __name?: ( fn: unknown ) => unknown };
	named.__name ??= fn => fn;
	const scope = window as typeof window & { __dlaEntrances?: {
		stamp(): void;
		transitions: string[];
	} };
	if ( scope.__dlaEntrances || ! window.IntersectionObserver ) return;
	const native = window.IntersectionObserver;
	const targets = new Map<Element, {
		before: Record<string, string>;
		state: EntranceState;
		entered: boolean;
		confirmed: boolean;
		supported: boolean;
	}>();
	const transitions = new Map<Element, Map<string, string>>();
	const attributes = ( element: Element ) => Object.fromEntries(
		Array.from( element.attributes ).filter( attribute =>
			/^(class|style|data-.+)$/.test( attribute.name ) && ! attribute.name.startsWith( 'data-dla-' )
		).map( attribute => [ attribute.name, attribute.value ] )
	);
	window.IntersectionObserver = class extends native {
		constructor( callback: IntersectionObserverCallback, options?: IntersectionObserverInit ) {
			super( ( entries, observer ) => {
				for ( const entry of entries ) {
					const target = targets.get( entry.target );
					if ( target ) target.entered = entry.isIntersecting;
				}
				callback( entries, observer );
			}, options );
		}
		observe( element: Element ): void {
			const style = getComputedStyle( element );
			// An initially transparent target with finite authored transitions is an
			// entrance candidate; only an actual viewport-triggered transition confirms it.
			if ( ! targets.has( element ) && Number( style.opacity ) === 0 && style.transitionDuration.split( ',' ).some( value => parseFloat( value ) > 0 ) ) {
				targets.set( element, { before: attributes( element ), entered: false, confirmed: false, supported: this.root === null,
					state: { attributes: {}, rootMargin: this.rootMargin, threshold: [ ...this.thresholds ], repeat: false } } );
			}
			super.observe( element );
		}
	};
	const captureState = ( element: Element ) => {
		const target = targets.get( element );
		if ( ! target ) return;
		const after = attributes( element );
		if ( ! target.entered ) {
			if ( target.confirmed && Object.keys( target.state.attributes ).every( key =>
				( after[ key ] ?? null ) === target.state.attributes[ key ].before
			) ) target.state.repeat = true;
			return;
		}
		if ( target.confirmed ) return;
		for ( const name of new Set( [ ...Object.keys( target.before ), ...Object.keys( after ) ] ) ) {
			if ( ( target.before[ name ] ?? null ) !== ( after[ name ] ?? null ) ) {
				target.state.attributes[ name ] = { before: target.before[ name ] ?? null, after: after[ name ] ?? null };
			}
		}
	};
	new MutationObserver( mutations => {
		for ( const mutation of mutations ) if ( mutation.target instanceof Element ) captureState( mutation.target );
	} ).observe( document, { subtree: true, attributes: true } );
	document.addEventListener( 'transitionrun', event => {
		const element = event.target;
		if ( ! ( element instanceof Element ) || event.pseudoElement ) return;
		const target = targets.get( element );
		if ( ! target?.entered ) return;
		captureState( element );
		if ( Object.keys( target.state.attributes ).length === 0 ) return;
		for ( const effect of element.getAnimations() ) {
			if ( ! ( effect instanceof CSSTransition ) || effect.transitionProperty !== event.propertyName ) continue;
			const timing = effect.effect?.getTiming();
			if ( ! timing ) continue;
			target.confirmed = true;
			const text = ( element.textContent ?? '' ).replace( /\s+/g, ' ' ).trim().slice( 0, 120 );
			const observed = transitions.get( element ) ?? new Map<string, string>();
			if ( ! observed.has( effect.transitionProperty ) ) observed.set( effect.transitionProperty,
				JSON.stringify( [ text, effect.transitionProperty, timing.duration, timing.delay, timing.easing,
					( effect.effect as KeyframeEffect | null )?.getKeyframes().map( frame => frame[ effect.transitionProperty ] ) ] ) );
			transitions.set( element, observed );
		}
	} );
	scope.__dlaEntrances = {
		get transitions() { return Array.from( transitions.values() ).flatMap( observed => Array.from( observed.values() ) ).sort(); },
		stamp() {
			for ( const [ element, target ] of targets ) {
				// Custom scroll roots remain measured losses until their identity is portable.
				if ( element.isConnected && target.confirmed && target.supported ) element.setAttribute( 'data-dla-viewport-entrance', JSON.stringify( target.state ) );
			}
		},
	};
}

export async function stampViewportEntrances( page: Page ): Promise<void> {
	await page.evaluate( () => {
		( window as typeof window & { __dlaEntrances?: { stamp(): void } } ).__dlaEntrances?.stamp();
	} );
}

/** Replay the observed state switch; authored CSS owns time, easing and reduced motion. */
function replayViewportEntrances(): void {
	const named = globalThis as typeof globalThis & { __name?: ( fn: unknown ) => unknown };
	named.__name ??= fn => fn;
	const reduced = matchMedia( '(prefers-reduced-motion: reduce)' );
	for ( const element of document.querySelectorAll( '[data-dla-viewport-entrance]' ) ) {
		const state = JSON.parse( element.getAttribute( 'data-dla-viewport-entrance' )! ) as EntranceState;
		const apply = ( pose: 'before' | 'after' ) => {
			for ( const [ name, values ] of Object.entries( state.attributes ) ) {
				const value = values[ pose ];
				if ( value === null ) element.removeAttribute( name );
				else element.setAttribute( name, value );
			}
		};
		if ( reduced.matches || ! window.IntersectionObserver ) { apply( 'after' ); continue; }
		apply( 'before' );
		const inline = ( element as HTMLElement ).style;
		const transition = inline.getPropertyValue( 'transition' );
		const priority = inline.getPropertyPriority( 'transition' );
		inline.setProperty( 'transition', 'none', 'important' );
		// Establish the pending pose before the observer can switch it; this creates
		// real CSS transitions even for entrances already in the initial viewport.
		getComputedStyle( element ).opacity;
		if ( transition ) inline.setProperty( 'transition', transition, priority );
		else inline.removeProperty( 'transition' );
		const observer = new IntersectionObserver( entries => {
			for ( const entry of entries ) {
				if ( entry.isIntersecting ) {
					apply( 'after' );
					if ( ! state.repeat ) observer.unobserve( element );
				} else if ( state.repeat ) apply( 'before' );
			}
		}, { rootMargin: state.rootMargin, threshold: state.threshold } );
		observer.observe( element );
		reduced.addEventListener( 'change', event => {
			if ( event.matches ) { observer.disconnect(); apply( 'after' ); }
		} );
	}
}

export function withViewportEntrances( html: string ): string {
	if ( ! html.includes( VIEWPORT_ENTRANCE_ATTRIBUTE ) ) return html;
	const $ = cheerio.load( html );
	let count = 0;
	$( `[${ VIEWPORT_ENTRANCE_ATTRIBUTE }]` ).each( ( _, element ) => {
		const node = $( element );
		try {
			const state: EntranceState = JSON.parse( node.attr( VIEWPORT_ENTRANCE_ATTRIBUTE )! );
			if ( typeof state.rootMargin !== 'string' || ! /^-?\d+(?:\.\d+)?(?:px|%)(?:\s+-?\d+(?:\.\d+)?(?:px|%)){0,3}$/.test( state.rootMargin ) || ! Array.isArray( state.threshold ) || ! state.threshold.length ||
				state.threshold.some( value => typeof value !== 'number' || value < 0 || value > 1 ) ||
				typeof state.repeat !== 'boolean' || ! state.attributes || Object.keys( state.attributes ).length === 0 ||
				Object.entries( state.attributes ).some( ( [ name, values ] ) =>
					! /^(class|style|data-[a-z0-9_.:-]+)$/.test( name ) || name.startsWith( 'data-dla-' ) ||
					! values || [ values.before, values.after ].some( value => value !== null && ( typeof value !== 'string' ||
						( name === 'style' && /expression\s*\(|-moz-binding|url\s*\(\s*["']?\s*(?:javascript|vbscript|data:text\/html)/i.test( value ) ) ) )
				) ) throw new Error( 'Invalid viewport entrance evidence' );
			count++;
			for ( const [ name, values ] of Object.entries( state.attributes ) ) {
				if ( values.after === null ) node.removeAttr( name );
				else node.attr( name, values.after );
			}
		} catch { node.removeAttr( VIEWPORT_ENTRANCE_ATTRIBUTE ); }
	} );
	if ( count ) $( 'body' ).append( `<script data-dla-viewport-entrances>(${ replayViewportEntrances.toString() })();</script>` );
	return $.html();
}
