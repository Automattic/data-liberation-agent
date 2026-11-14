import type { Page } from 'playwright';
import { documentCanScroll, settleDocument } from './page-helpers.js';
import { orElse } from '../failure-class.js';

/**
 * Captures scroll-position-driven DOM mutations: a header/logo/etc. that changes
 * CSS class (e.g. a "stuck"/"sticky-animate" style) and/or inline style (e.g. a
 * logo's `max-height`) once the page scrolls past some threshold, then reverts
 * on scroll-up. This is a distinct capture surface from `interaction-capture.ts`
 * (click-triggered dialogs): the trigger here is scroll position, not a click,
 * and the target is usually chrome (header) rather than a dialog/menu.
 *
 * Detection is purely behavioral (drive a real scroll, diff the DOM before and
 * after settling) so it works across builder platforms without any
 * platform-specific selectors or attribute names.
 */

export const SCROLL_STATES_SCHEMA = 'blocks-engine-capture/scroll-states/v1';

const MAX_CONTAINERS = 6;
const MAX_STYLE_TARGETS_PER_CONTAINER = 4;
const HEADER_BAND_PX = 400;
/** A generous first probe comfortably past virtually any realistic activation offset. */
const PROBE_OFFSET_PX = 200;
/** Refinement offsets tried, in order, only when the generous probe found a change. */
const REFINEMENT_OFFSETS_PX = [ 2, 20, 50, 100 ];
const SETTLE_SAMPLE_INTERVAL_MS = 120;
const SETTLE_MAX_WAIT_MS = 1_500;

export interface ScrollStyleTarget {
	selector: string;
	tag: string;
	id?: string;
	/** Per-CSS-property before ("rest", scrollY 0) and after ("scrolled") observed values. */
	properties: Record< string, { rest: string; scrolled: string } >;
}

export interface ScrollToggle {
	status: 'captured';
	target: { selector: string; tag: string; id?: string };
	/** Smallest probed scrollY (px) at which the mutation was observed. Approximate. */
	thresholdPx: number;
	classes: { add: string[]; remove: string[] };
	styleTargets: ScrollStyleTarget[];
}

export interface ScrollStatesReport {
	schema: typeof SCROLL_STATES_SCHEMA;
	sourceUrl: string;
	viewport: { width: number; height: number };
	capturedAt: string;
	toggles: ScrollToggle[];
}

interface ContainerSnapshot {
	key: string;
	selector: string;
	tag: string;
	id?: string;
	top: number;
	classList: string[];
	computed: Record< string, string >;
	styleTargets: { selector: string; tag: string; id?: string; styleText: string }[];
}

/** Capture scroll-driven class/style toggles after all baseline page artifacts are complete. */
export async function captureScrollStates(
	page: Page,
	sourceUrl: string
): Promise< ScrollStatesReport > {
	// Scroll anchoring moves the position when a toggle resizes in-flow chrome:
	// a sticky header shrinking past its threshold would be scrolled back under
	// it and flip forever. Each probe must hold the offset it asked for.
	const pinned = await page.addStyleTag( { content: 'html,body{overflow-anchor:none!important}' } ).catch( orElse( null ) );
	try {
		return await probeScrollStates( page, sourceUrl );
	} finally {
		await pinned?.evaluate( ( node ) => ( node as Element ).remove() ).catch( orElse( undefined ) );
	}
}

async function probeScrollStates(
	page: Page,
	sourceUrl: string
): Promise< ScrollStatesReport > {
	const viewport = page.viewportSize() ?? { width: 0, height: 0 };
	const empty: ScrollStatesReport = {
		schema: SCROLL_STATES_SCHEMA,
		sourceUrl,
		viewport,
		capturedAt: new Date().toISOString(),
		toggles: [],
	};
	if ( ! await documentCanScroll( page ) ) return empty;

	const scrollTo = ( y: number ): Promise< void > => scrollPage( page, y );

	let baseline: ContainerSnapshot[];
	try {
		await scrollTo( 0 );
		baseline = await settledSnapshot( page );
	} catch {
		return empty;
	}
	if ( baseline.length === 0 ) return empty;

	let probed: ContainerSnapshot[];
	try {
		await scrollTo( PROBE_OFFSET_PX );
		probed = await settledSnapshot( page );
	} catch {
		await scrollTo( 0 ).catch( orElse( undefined ) );
		return empty;
	}

	const changedKeys = changedContainerKeys( baseline, probed );
	if ( changedKeys.size === 0 ) {
		await scrollTo( 0 ).catch( orElse( undefined ) );
		return empty;
	}

	// Refine the threshold: try smaller offsets in ascending order and keep the
	// smallest one that still reproduces the same set of changed containers.
	let thresholdPx = PROBE_OFFSET_PX;
	let atThreshold = probed;
	for ( const offset of REFINEMENT_OFFSETS_PX ) {
		let sample: ContainerSnapshot[];
		try {
			await scrollTo( offset );
			sample = await settledSnapshot( page );
		} catch {
			break;
		}
		const sampleChanged = changedContainerKeys( baseline, sample );
		const stillReproduces = [ ...changedKeys ].every( ( key ) => sampleChanged.has( key ) );
		if ( stillReproduces ) {
			thresholdPx = offset;
			atThreshold = sample;
			break;
		}
	}

	// Confirm reversibility: back at the top, the mutation should undo itself.
	// A one-way (irreversible) mutation is not this behavior, so skip.
	let reverted: ContainerSnapshot[];
	try {
		await scrollTo( 0 );
		reverted = await settledSnapshot( page );
	} catch {
		return empty;
	}
	const stillChangedAtTop = changedContainerKeys( baseline, reverted );

	const toggles: ScrollToggle[] = [];
	const byKeyBaseline = new Map( baseline.map( ( entry ) => [ entry.key, entry ] ) );
	const byKeyAtThreshold = new Map( atThreshold.map( ( entry ) => [ entry.key, entry ] ) );
	for ( const key of changedKeys ) {
		if ( stillChangedAtTop.has( key ) ) continue; // irreversible; not scroll-linked
		const before = byKeyBaseline.get( key );
		const after = byKeyAtThreshold.get( key );
		if ( ! before || ! after ) continue;

		const beforeSet = new Set( before.classList );
		const afterSet = new Set( after.classList );
		const add = after.classList.filter( ( cls ) => ! beforeSet.has( cls ) );
		const remove = before.classList.filter( ( cls ) => ! afterSet.has( cls ) );

		const styleTargets: ScrollStyleTarget[] = [];
		const computedProperties: Record< string, { rest: string; scrolled: string } > = {};
		const computedKeys = new Set( [
			...Object.keys( before.computed ),
			...Object.keys( after.computed ),
		] );
		for ( const property of computedKeys ) {
			const rest = before.computed[ property ] ?? '';
			const scrolled = after.computed[ property ] ?? '';
			if ( rest !== scrolled ) computedProperties[ property ] = { rest, scrolled };
		}
		if ( Object.keys( computedProperties ).length > 0 ) {
			styleTargets.push( {
				selector: ':scope',
				tag: before.tag,
				...( before.id ? { id: before.id } : {} ),
				properties: computedProperties,
			} );
		}
		const afterStyleByKey = new Map(
			after.styleTargets.map( ( target ) => [ target.selector, target ] )
		);
		for ( const beforeTarget of before.styleTargets ) {
			const afterTarget = afterStyleByKey.get( beforeTarget.selector );
			if ( ! afterTarget || afterTarget.styleText === beforeTarget.styleText ) continue;
			const properties = diffInlineStyle( beforeTarget.styleText, afterTarget.styleText );
			if ( Object.keys( properties ).length === 0 ) continue;
			styleTargets.push( {
				selector: beforeTarget.selector,
				tag: beforeTarget.tag,
				...( beforeTarget.id ? { id: beforeTarget.id } : {} ),
				properties,
			} );
		}

		if ( add.length === 0 && remove.length === 0 && styleTargets.length === 0 ) continue;

		toggles.push( {
			status: 'captured',
			target: {
				selector: before.selector,
				tag: before.tag,
				...( before.id ? { id: before.id } : {} ),
			},
			thresholdPx,
			classes: { add, remove },
			styleTargets,
		} );
	}

	await dropClassDerivedProperties( page, toggles );

	return {
		schema: SCROLL_STATES_SCHEMA,
		sourceUrl,
		viewport,
		capturedAt: new Date().toISOString(),
		toggles: toggles.filter( ( toggle ) =>
			toggle.classes.add.length > 0 || toggle.classes.remove.length > 0 || toggle.styleTargets.length > 0
		),
	};
}

/** A source's `scroll-behavior: smooth` would animate the jump and a snapshot would land mid-scroll. */
async function scrollPage( page: Page, y: number ): Promise< void > {
	await page.evaluate( ( value ) => window.scrollTo( { top: value, behavior: 'instant' } ), y );
}

/**
 * A computed change the toggled classes explain on their own is a consequence of
 * those classes (a header whose height follows a logo the class shrinks), not a
 * value to pin: the materialized class toggle already carries it, at every
 * viewport. Scrolled with transitions frozen, revert only the class change and
 * keep just the properties that do not return to rest.
 */
async function dropClassDerivedProperties( page: Page, toggles: ScrollToggle[] ): Promise< void > {
	const probes = toggles.flatMap( ( toggle, index ) => {
		const self = toggle.styleTargets.find( ( target ) => target.selector === ':scope' );
		if ( ! self || ( toggle.classes.add.length === 0 && toggle.classes.remove.length === 0 ) ) return [];
		return [ { index, selector: toggle.target.selector, add: toggle.classes.add, remove: toggle.classes.remove, properties: self.properties } ];
	} );
	if ( probes.length === 0 ) return;
	const frames = () => page.evaluate( () => new Promise< void >( ( resolve ) => requestAnimationFrame( () => requestAnimationFrame( () => resolve() ) ) ) );
	const freeze = await page.addStyleTag( { content: '*,*::before,*::after{transition:none!important;animation:none!important}' } ).catch( orElse( null ) );
	if ( ! freeze ) return;
	let derived: string[][] = probes.map( () => [] );
	try {
		await scrollPage( page, PROBE_OFFSET_PX );
		await frames();
		derived = await page.evaluate( ( entries ) => entries.map( ( entry ) => {
			const element = document.querySelector( entry.selector );
			if ( ! element || ! entry.add.every( ( name ) => element.classList.contains( name ) ) || entry.remove.some( ( name ) => element.classList.contains( name ) ) ) return [];
			const scrolled = element.getAttribute( 'class' )!;
			element.classList.remove( ...entry.add );
			element.classList.add( ...entry.remove );
			const style = getComputedStyle( element );
			const explained = Object.entries( entry.properties )
				.filter( ( [ property, { rest } ] ) => style.getPropertyValue( property ) === rest )
				.map( ( [ property ] ) => property );
			element.setAttribute( 'class', scrolled );
			return explained;
		} ), probes );
	} catch {
		// Keep every observed property when the probe cannot run.
	} finally {
		await scrollPage( page, 0 ).catch( orElse( undefined ) );
		await frames().catch( orElse( undefined ) );
		await freeze.evaluate( ( node ) => ( node as Element ).remove() ).catch( orElse( undefined ) );
	}
	probes.forEach( ( probe, position ) => {
		const toggle = toggles[ probe.index ]!;
		const self = toggle.styleTargets.find( ( target ) => target.selector === ':scope' )!;
		for ( const property of derived[ position ] ?? [] ) delete self.properties[ property ];
		if ( Object.keys( self.properties ).length === 0 ) toggle.styleTargets = toggle.styleTargets.filter( ( target ) => target !== self );
	} );
}

function changedContainerKeys(
	before: ContainerSnapshot[],
	after: ContainerSnapshot[]
): Set< string > {
	const afterByKey = new Map( after.map( ( entry ) => [ entry.key, entry ] ) );
	const changed = new Set< string >();
	for ( const entry of before ) {
		const match = afterByKey.get( entry.key );
		if ( ! match ) continue;
		const beforeClasses = new Set( entry.classList );
		const afterClasses = new Set( match.classList );
		const classesDiffer =
			beforeClasses.size !== afterClasses.size ||
			[ ...beforeClasses ].some( ( cls ) => ! afterClasses.has( cls ) );
		const styleByKey = new Map( match.styleTargets.map( ( target ) => [ target.selector, target ] ) );
		const styleDiffers = entry.styleTargets.some(
			( target ) => styleByKey.get( target.selector )?.styleText !== target.styleText
		);
		const computedDiffers =
			JSON.stringify( entry.computed ) !== JSON.stringify( match.computed );
		if ( classesDiffer || styleDiffers || computedDiffers ) changed.add( entry.key );
	}
	return changed;
}

/** Parse two `style="..."` attribute strings and return only the properties that differ. */
function diffInlineStyle(
	before: string,
	after: string
): Record< string, { rest: string; scrolled: string } > {
	const beforeMap = parseInlineStyle( before );
	const afterMap = parseInlineStyle( after );
	const result: Record< string, { rest: string; scrolled: string } > = {};
	const keys = new Set( [ ...beforeMap.keys(), ...afterMap.keys() ] );
	for ( const key of keys ) {
		const restValue = beforeMap.get( key ) ?? '';
		const scrolledValue = afterMap.get( key ) ?? '';
		if ( restValue !== scrolledValue ) result[ key ] = { rest: restValue, scrolled: scrolledValue };
	}
	return result;
}

function parseInlineStyle( styleText: string ): Map< string, string > {
	const map = new Map< string, string >();
	for ( const declaration of styleText.split( ';' ) ) {
		const separator = declaration.indexOf( ':' );
		if ( separator === -1 ) continue;
		const property = declaration.slice( 0, separator ).trim();
		const value = declaration.slice( separator + 1 ).trim();
		if ( property ) map.set( property, value );
	}
	return map;
}

/** Snapshot candidate containers once class/style writes and the transitions they start have settled. */
async function settledSnapshot( page: Page ): Promise< ContainerSnapshot[] > {
	await settleDocument( page, 'scroll-state', { quietMs: SETTLE_SAMPLE_INTERVAL_MS, timeoutMs: SETTLE_MAX_WAIT_MS, animations: true } );
	return snapshotContainers( page );
}

async function snapshotContainers( page: Page ): Promise< ContainerSnapshot[] > {
	return page.evaluate(
		( { maxContainers, maxStyleTargets, band } ) => {
			const cssEscape = ( value: string ) =>
				globalThis.CSS?.escape
					? globalThis.CSS.escape( value )
					: value.replace( /[^a-zA-Z0-9_-]/g, '\\$&' );
			const bodyRootedSelector = ( element: Element ): string => {
				if ( element.id ) return `#${ cssEscape( element.id ) }`;
				const parts: string[] = [];
				for (
					let node: Element | null = element;
					node && node !== document.body;
					node = node.parentElement
				) {
					const tag = node.tagName.toLowerCase();
					const siblings = node.parentElement
						? Array.from( node.parentElement.children ).filter(
								( sibling ) => sibling.tagName === node!.tagName
						  )
						: [];
					parts.unshift(
						siblings.length > 1
							? `${ tag }:nth-of-type(${ siblings.indexOf( node ) + 1 })`
							: tag
					);
				}
				return `body > ${ parts.join( ' > ' ) }`;
			};
			const relativeSelector = ( root: Element, element: Element ): string => {
				if ( element.id ) return `#${ cssEscape( element.id ) }`;
				const parts: string[] = [];
				for (
					let node: Element | null = element;
					node && node !== root;
					node = node.parentElement
				) {
					const tag = node.tagName.toLowerCase();
					const siblings = node.parentElement
						? Array.from( node.parentElement.children ).filter(
								( sibling ) => sibling.tagName === node!.tagName
						  )
						: [];
					parts.unshift(
						siblings.length > 1
							? `${ tag }:nth-of-type(${ siblings.indexOf( node ) + 1 })`
							: tag
					);
				}
				return parts.join( ' > ' );
			};

			const inBand = ( element: Element ): boolean => {
				const rect = element.getBoundingClientRect();
				if ( rect.width === 0 || rect.height === 0 ) return false;
				const style = getComputedStyle( element );
				if ( style.display === 'none' || style.visibility === 'hidden' ) return false;
				return rect.top < band;
			};

			const headers = Array.from(
				document.querySelectorAll(
					'header, [class*="header" i], [id*="header" i], nav, [role="banner"]'
				)
			).filter( inBand );

			// Prefer the outer header, but keep nested positioned chrome: many
			// builders restyle an inner absolute bar via a body/html scroll class
			// (the outer wrap's classList never changes).
			const outer = headers.filter(
				( element, index ) =>
					! headers.some(
						( other, otherIndex ) => otherIndex !== index && other.contains( element )
					)
			);
			const nestedChrome: Element[] = [];
			for ( const root of outer ) {
				for ( const child of Array.from( root.querySelectorAll( '*' ) ) ) {
					if ( ! inBand( child ) ) continue;
					const position = getComputedStyle( child ).position;
					if ( position === 'absolute' || position === 'fixed' || position === 'sticky' ) {
						nestedChrome.push( child );
					}
				}
			}
			const filtered = [ ...outer, ...nestedChrome ].slice( 0, maxContainers );

			const chromeComputed = ( element: Element ): Record< string, string > => {
				const style = getComputedStyle( element );
				return {
					position: style.position,
					top: style.top,
					'background-color': style.backgroundColor,
					height: style.height,
					'max-height': style.maxHeight,
					'box-shadow': style.boxShadow,
				};
			};

			return filtered.map( ( element ) => {
				const selector = bodyRootedSelector( element );
				const styleTargets = Array.from( element.querySelectorAll( '[style]' ) )
					.slice( 0, maxStyleTargets )
					.map( ( styled ) => ( {
						selector: relativeSelector( element, styled ),
						tag: styled.tagName.toLowerCase(),
						...( styled.id ? { id: styled.id } : {} ),
						styleText: styled.getAttribute( 'style' ) ?? '',
					} ) );
				return {
					key: selector,
					selector,
					tag: element.tagName.toLowerCase(),
					...( element.id ? { id: element.id } : {} ),
					top: element.getBoundingClientRect().top,
					classList: Array.from( element.classList ),
					computed: chromeComputed( element ),
					styleTargets,
				};
			} );
		},
		{ maxContainers: MAX_CONTAINERS, maxStyleTargets: MAX_STYLE_TARGETS_PER_CONTAINER, band: HEADER_BAND_PX }
	);
}
