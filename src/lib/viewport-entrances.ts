import type { Page } from 'playwright';
import * as cheerio from 'cheerio';
import { withEvaluateTimeout } from './screenshot/page-helpers.js';

export const VIEWPORT_ENTRANCE_ATTRIBUTE = 'data-dla-viewport-entrance';

interface EntranceState {
	attributes: Record<string, { before: string | null; after: string | null }>;
	rootMargin: string;
	threshold: number[];
	repeat: boolean;
	/** Native CSS owns frames/time; the witness owns only play and terminal attributes. */
	cssAnimations?: Array<{ name: string; timing: EffectTiming; frames: ComputedKeyframe[] }>;
	startupContexts?: Array<{ width: number; height: number; started: boolean }>;
}

/** Install before hydration. Observe the source's own viewport trigger rather than guessing selectors. */
export function observeViewportEntrances(): void {
	const named = globalThis as typeof globalThis & { __name?: ( fn: unknown ) => unknown };
	named.__name ??= fn => fn;
	const scope = window as typeof window & { __dlaEntrances?: {
		stamp(): void;
		transitions: string[];
		startup: Array<{ id: string; started: boolean }>;
		losses: Array<{ id: string; reason: string }>;
		startupContexts?: Record<string, EntranceState['startupContexts']>;
	} };
	if ( scope.__dlaEntrances || ! window.IntersectionObserver ) return;
	const native = window.IntersectionObserver;
	const targets = new Map<Element, {
		before: Record<string, string>;
		state: EntranceState;
		entered: boolean;
		ratio: number;
		qualified: boolean;
		cssStarted: boolean;
		cssComplete: boolean;
		cssCandidate: boolean;
		effects: Set<Animation>;
		finished: Set<Animation>;
		startup: boolean;
		loss?: string;
		confirmed: boolean;
		supported: boolean;
	}>();
	const transitions = new Map<Element, Map<string, string>>();
	let navigationalPose = true;
	addEventListener( 'scroll', () => { if ( scrollX !== 0 || scrollY !== 0 ) navigationalPose = false; } );
	// Ignore hydration's layout-viewport changes: only requested viewport changes
	// end startup. The source can transiently qualify before its viewport settles.
	const initialOuter = { width: outerWidth, height: outerHeight };
	addEventListener( 'resize', () => { if ( outerWidth !== initialOuter.width || outerHeight !== initialOuter.height ) navigationalPose = false; } );
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
					if ( target ) {
						target.entered = entry.isIntersecting;
						target.ratio = entry.intersectionRatio;
						// A callback may schedule play asynchronously; a later nonmatching
						// hydration entry must not erase the actual qualifying witness.
						if ( entry.isIntersecting && entry.intersectionRatio >= this.thresholds[ 0 ] ) target.qualified = true;
					}
				}
				callback( entries, observer );
			}, options );
		}
		observe( element: Element ): void {
			const style = getComputedStyle( element );
			const cssPending = element.getAnimations().some( animation => animation instanceof CSSAnimation &&
				animation.timeline === document.timeline && animation.playState === 'paused' && animation.currentTime === 0 &&
				animation.effect?.getComputedTiming().iterations !== Infinity );
			const existing = targets.get( element );
			if ( existing && ( existing.state.rootMargin !== this.rootMargin || JSON.stringify( existing.state.threshold ) !== JSON.stringify( this.thresholds ) || existing.supported !== ( this.root === null ) ) ) {
				existing.loss = 'Multiple viewport observers have ambiguous lifecycle ownership';
			}
			// An initially transparent target with finite authored transitions is an
			// entrance candidate; only an actual viewport-triggered transition confirms it.
			if ( ! targets.has( element ) && ( cssPending || Number( style.opacity ) === 0 && style.transitionDuration.split( ',' ).some( value => parseFloat( value ) > 0 ) ) ) {
				targets.set( element, { before: attributes( element ), entered: false, ratio: 0, qualified: false, cssStarted: false, cssComplete: false, cssCandidate: cssPending, effects: new Set(), finished: new Set(), startup: false, confirmed: false, supported: this.root === null,
					state: { attributes: {}, rootMargin: this.rootMargin, threshold: [ ...this.thresholds ], repeat: false } } );
			}
			super.observe( element );
		}
	};
	const play = Animation.prototype.play;
	Animation.prototype.play = function(): void {
		try {
			const effect = this.effect;
			const element = effect instanceof KeyframeEffect ? effect.target : null;
			const target = element ? targets.get( element ) : undefined;
			if ( this instanceof CSSAnimation && target && this.playState === 'paused' && effect?.getComputedTiming().iterations !== Infinity ) {
				if ( ! target.qualified || ! target.supported || target.state.threshold.length !== 1 || this.timeline !== document.timeline ||
					( effect as KeyframeEffect ).pseudoElement || this.currentTime !== 0 || this.playbackRate !== 1 ) {
					target.loss = 'CSS play lacks a supported viewport witness or starts from an unproven phase';
				} else {
					if ( target.cssComplete ) { target.state.repeat = true; target.cssComplete = false; target.cssStarted = false; target.state.cssAnimations = []; target.effects.clear(); target.finished.clear(); }
					if ( ! target.cssStarted ) { target.before = attributes( element! ); target.startup = navigationalPose; }
					target.cssStarted = true;
					const frames = ( effect as KeyframeEffect ).getKeyframes();
					if ( frames.some( frame => Object.entries( frame ).some( ([ key, value ]) => ! [ 'offset', 'computedOffset', 'easing', 'composite' ].includes( key ) &&
						( typeof value !== 'string' || /url\(|var\(/i.test( value ) ) ) ) ) target.loss = 'CSS keyframes contain unresolved or resource-dependent values';
					if ( ! target.effects.has( this ) ) {
						target.effects.add( this );
						( target.state.cssAnimations ??= [] ).push( { name: this.animationName, timing: effect!.getTiming(), frames } );
						void this.finished.then( () => {
							target.finished.add( this ); queueMicrotask( () => captureState( element! ) );
						}, () => { target.loss = 'Source CSS animation was cancelled before completion'; } );
					}
				}
			}
		} catch { /* Observing never changes the source operation. */ }
		return play.call( this );
	};
	const captureState = ( element: Element ) => {
		const target = targets.get( element );
		if ( ! target ) return;
		const after = attributes( element );
		if ( target.cssStarted ) {
			const changed = Object.fromEntries( [ ...new Set( [ ...Object.keys( target.before ), ...Object.keys( after ) ] ) ]
				.filter( name => ( target.before[ name ] ?? null ) !== ( after[ name ] ?? null ) )
				.map( name => [ name, { before: target.before[ name ] ?? null, after: after[ name ] ?? null } ] ) );
			const unfinished = target.finished.size !== target.effects.size;
			if ( target.cssComplete && ! target.entered && Object.keys( target.state.attributes ).every( name =>
				( after[ name ] ?? null ) === target.state.attributes[ name ].before ) ) target.state.repeat = true;
			if ( ! unfinished && Object.keys( changed ).length ) { target.state.attributes = changed; target.cssComplete = true; target.confirmed = true; }
			return;
		}
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
	document.addEventListener( 'animationend', event => {
		if ( event.target instanceof Element && ! event.pseudoElement ) queueMicrotask( () => captureState( event.target as Element ) );
	} );
	document.addEventListener( 'transitionrun', event => {
		const element = event.target;
		if ( ! ( element instanceof Element ) || event.pseudoElement ) return;
		const target = targets.get( element );
		if ( ! target?.entered || target.cssStarted ) return;
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
		get startup() { return Array.from( targets ).filter( ([ element, target ]) => element.isConnected && element.id && target.cssCandidate &&
			Array.from( document.querySelectorAll( '[id]' ) ).filter( node => node.id === element.id ).length === 1 )
			.map( ([ element, target ]) => ( { id: element.id, started: target.cssStarted && target.startup } ) ); },
		get losses() { return Array.from( targets ).filter( ([ element, target ]) => element.isConnected && ( target.loss || target.cssStarted && ! target.cssComplete ) )
			.map( ([ element, target ]) => ( { id: element.id, reason: target.loss ?? 'CSS entrance has no observed terminal attribute switch' } ) ); },
		stamp() {
			for ( const [ element, target ] of targets ) {
				if ( ! element.isConnected ) continue;
				captureState( element );
				if ( target.loss || target.cssCandidate && ! target.cssComplete ) {
					element.setAttribute( 'data-dla-viewport-entrance-loss', target.loss ?? ( target.cssStarted ? 'CSS entrance has no observed terminal attribute switch' : 'CSS viewport lifecycle was not observed' ) );
					continue;
				}
				const previousLoss = element.getAttribute( 'data-dla-viewport-entrance-loss' );
				if ( previousLoss === 'CSS viewport lifecycle was not observed' || previousLoss === 'CSS entrance has no observed terminal attribute switch' ) element.removeAttribute( 'data-dla-viewport-entrance-loss' );
				else if ( previousLoss ) continue;
				if ( target.state.cssAnimations ) target.state.startupContexts = scope.__dlaEntrances?.startupContexts?.[ element.id ] ?? [ { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight, started: target.startup } ];
				// Custom scroll roots remain measured losses until their identity is portable.
				if ( element.isConnected && target.confirmed && target.supported ) element.setAttribute( 'data-dla-viewport-entrance', JSON.stringify( target.state ) );
			}
		},
	};
}

export async function stampViewportEntrances( page: Page, evaluateTimeoutMs = 5_000 ): Promise<void> {
	await withEvaluateTimeout( page.evaluate( () => {
		( window as typeof window & { __dlaEntrances?: { stamp(): void } } ).__dlaEntrances?.stamp();
	} ), evaluateTimeoutMs );
}

/** Independent source navigations prove startup at each actual profile/canvas.
 * Stable source IDs are a bounded binding; ambiguous/unidentified targets do not
 * gain startup evidence. Session credentials never enter the portable payload.
 */
export async function collectViewportEntranceStartup( source: Page, capture: Page, evaluateTimeoutMs = 5_000 ): Promise<void> {
	const snapshot = await withEvaluateTimeout( source.evaluate( () => ( { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight,
		states: ( window as typeof window & { __dlaEntrances?: { startup: Array<{ id: string; started: boolean }> } } ).__dlaEntrances?.startup ?? [],
	} ) ), evaluateTimeoutMs );
	await withEvaluateTimeout( capture.evaluate( snapshot => {
		const observer = ( window as typeof window & { __dlaEntrances?: { startupContexts?: Record<string, Array<{ width: number; height: number; started: boolean }>> } } ).__dlaEntrances;
		if ( ! observer ) return;
		const contexts = observer.startupContexts ??= {};
		for ( const state of snapshot.states ) {
			if ( Array.from( document.querySelectorAll( '[id]' ) ).filter( node => node.id === state.id ).length !== 1 ) continue;
			const poses = contexts[ state.id ] ??= [];
			const previous = poses.find( pose => pose.width === snapshot.width && pose.height === snapshot.height );
			if ( previous && previous.started !== state.started ) {
				document.getElementById( state.id )?.setAttribute( 'data-dla-viewport-entrance-loss', 'Source startup context has conflicting observations' );
				continue;
			}
			if ( ! previous ) poses.push( { width: snapshot.width, height: snapshot.height, started: state.started } );
		}
	}, snapshot ), evaluateTimeoutMs );
}

/** Replay the observed state switch; authored CSS owns time, easing and reduced motion. */
function replayViewportEntrances(): void {
	const named = globalThis as typeof globalThis & { __name?: ( fn: unknown ) => unknown };
	named.__name ??= fn => fn;
	const reduced = matchMedia( '(prefers-reduced-motion: reduce)' );
	for ( const element of document.querySelectorAll( '[data-dla-viewport-entrance]' ) ) {
		const state = JSON.parse( element.getAttribute( 'data-dla-viewport-entrance' )! ) as EntranceState;
		if ( element.closest( '[data-dla-device-document]' ) && ! element.getClientRects().length ) continue;
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
		if ( ! state.cssAnimations ) inline.setProperty( 'transition', 'none', 'important' );
		// Establish the pending pose before the observer can switch it; this creates
		// real CSS transitions even for entrances already in the initial viewport.
		getComputedStyle( element ).opacity;
		if ( ! state.cssAnimations ) {
			if ( transition ) inline.setProperty( 'transition', transition, priority );
			else inline.removeProperty( 'transition' );
		}
		let running = false, complete = false;
		const start = () => {
			if ( running || complete ) return;
			const effects = element.getAnimations().filter( ( animation ): animation is CSSAnimation => animation instanceof CSSAnimation &&
				animation.timeline === document.timeline && state.cssAnimations!.some( binding => binding.name === animation.animationName ) );
			const signatures = effects.map( effect => JSON.stringify( { name: effect.animationName, timing: effect.effect?.getTiming(), frames: ( effect.effect as KeyframeEffect ).getKeyframes() } ) ).sort();
			if ( JSON.stringify( signatures ) !== JSON.stringify( state.cssAnimations!.map( binding => JSON.stringify( binding ) ).sort() ) ||
				effects.some( effect => effect.playState !== 'paused' || effect.currentTime !== 0 ) ) {
				element.setAttribute( 'data-dla-viewport-entrance-loss', 'authored paused CSS animation binding changed' ); return;
			}
			running = true;
			effects.forEach( effect => effect.play() );
			void Promise.all( effects.map( effect => effect.finished ) ).then( () => {
				apply( 'after' ); complete = true; running = false;
				if ( ! state.repeat ) observer.unobserve( element );
			}, () => { running = false; element.setAttribute( 'data-dla-viewport-entrance-loss', 'CSS entrance completion was interrupted' ); } );
		};
		const observer = new IntersectionObserver( entries => {
			for ( const entry of entries ) {
				if ( entry.isIntersecting && ( ! state.cssAnimations || entry.intersectionRatio >= state.threshold[ 0 ] ) ) {
					if ( state.cssAnimations ) start();
					else { apply( 'after' ); if ( ! state.repeat ) observer.unobserve( element ); }
				} else if ( state.repeat && ! running ) { apply( 'before' ); complete = false; }
			}
		}, { rootMargin: state.rootMargin, threshold: state.threshold } );
		observer.observe( element );
		if ( state.cssAnimations && state.startupContexts ) {
			const startup = state.startupContexts.find( pose => pose.width === document.documentElement.clientWidth && pose.height === document.documentElement.clientHeight );
			if ( startup?.started ) start();
			else if ( ! startup ) element.setAttribute( 'data-dla-viewport-entrance-loss', 'CSS startup context was not observed' );
		}
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
				( state.cssAnimations !== undefined && ( state.threshold.length !== 1 || ! Array.isArray( state.cssAnimations ) || ! state.cssAnimations.length || state.cssAnimations.length > 32 ||
					state.cssAnimations.some( binding => ! binding || typeof binding.name !== 'string' || ! binding.name || ! binding.timing || ! Array.isArray( binding.frames ) ) ) ) ||
				( state.startupContexts !== undefined && ( ! Array.isArray( state.startupContexts ) || state.startupContexts.some( pose => ! pose || ! Number.isFinite( pose.width ) || ! Number.isFinite( pose.height ) || typeof pose.started !== 'boolean' ) ) ) ||
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
		} catch { node.removeAttr( VIEWPORT_ENTRANCE_ATTRIBUTE ); node.attr( 'data-dla-viewport-entrance-loss', 'Invalid viewport entrance evidence' ); }
	} );
	$( 'script[data-dla-viewport-entrances]' ).remove();
	if ( count ) $( 'body' ).append( `<script data-dla-viewport-entrances>(${ replayViewportEntrances.toString() })();</script>` );
	return $.html();
}
