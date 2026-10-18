import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type { CapturedDialogInteraction } from './interaction-capture.js';

/**
 * Shared site chrome — the header, navigation and footer every route repeats —
 * is probed once per capture, on the entrypoint, and its interaction evidence
 * is reused on every route whose chrome is the same subtree.
 *
 * A chrome root is an outermost landmark. Two roots are the same chrome when
 * their signatures match: relative element paths, a few identity attributes
 * and the normalized text. Route-current state (classes, `aria-current`) is
 * not part of it. A root may sit at a different place in each template, so a
 * reused state's selectors are rebased from the entrypoint root's prefix to the
 * route root's, and the state is kept only when every rebased selector names
 * the corresponding node on the route. Anything else is probed in place.
 */
export const CHROME_LANDMARK_SELECTOR = 'header,nav,footer,[role="banner"],[role="navigation"],[role="contentinfo"]';
/** Marks entrypoint chrome roots while the one-time chrome probe runs. */
export const CHROME_ROOT_ATTRIBUTE = 'data-lib-chrome-root';
/** Marks route controls whose entrypoint evidence was reused, for the route probe to skip. */
export const CHROME_REUSED_ATTRIBUTE = 'data-lib-chrome-reused';
/** The trigger selector for the one-time probe: everything outside chrome roots is skipped. */
export const OUTSIDE_CHROME = `:not([${ CHROME_ROOT_ATTRIBUTE }] *)`;

/** Attributes that identify a chrome node; presentation and current-route state are left out. */
const SIGNATURE_ATTRIBUTES = [ 'id', 'role', 'aria-haspopup', 'aria-controls', 'href', 'type' ];

export interface ChromeLandmark {
	/** Hash of the subtree signature. */
	signature: string;
	/**
	 * This root's selector in each form capture records a descendant's path
	 * with: compact (`nth-of-type` only among same-tag siblings), positional
	 * (always `nth-of-type`), and panel (positional from the nearest id).
	 * The positional form addresses the root.
	 */
	prefixes: [ compact: string, positional: string, panel: string ];
	/** `tag[role]` with its first class, for diagnostics. */
	label: string;
}

/** Where a recorded selector resolves, relative to the page's chrome roots. */
/**
 * Where a recorded selector resolves, relative to the page's chrome roots.
 * `invalid` is an unresolvable selector string: a state that records one can
 * never be replayed, so anchoring and reuse both reject it.
 */
export type ChromeAnchor =
	| { root: number; path: number[] }
	/** Outside chrome, identified by the node's unique `id` when it has one,
	 * otherwise by its structural path from `body` (only stable across pages of
	 * the same layout). */
	| { outside: { id: string } | { path: number[] } }
	| 'document' | 'absent' | 'invalid';

/** One probed state, anchored to the chrome root that holds its trigger. */
export interface ChromeState {
	root: number;
	state: CapturedDialogInteraction;
	/** One anchor per `selectorFields( state )` entry, in that order. */
	anchors: ChromeAnchor[];
}

export interface SharedChromeEvidence {
	url: string;
	landmarks: ChromeLandmark[];
	states: ChromeState[];
	/** Probed states that are not chrome evidence: trigger outside chrome or an unresolvable selector. */
	unanchored: number;
}

/** The one-time entrypoint probe for one capture profile. */
export interface SharedChromeProbe {
	/** `skipped`: this profile had no entrypoint probe (a reflow-only capture probes desktop only). */
	status: 'captured' | 'failed' | 'skipped';
	reason?: string;
	evidence?: SharedChromeEvidence;
	durationMs: number;
}

/** Recorded per route and profile on the manifest. */
export interface SharedChromeRouteDecision {
	chromeReused: boolean;
	reason: string;
	landmarks?: { route: number; entrypoint: number; matched: number };
	/** Entrypoint states replayed on this route; their triggers were not clicked here. */
	reusedStates?: number;
	/** Entrypoint states whose rebased selectors named other nodes here; probed in place. */
	rejectedStates?: number;
}

export interface SharedChromeSummary {
	entrypoint: string;
	profiles: Record< string, { status: SharedChromeProbe['status']; reason?: string; landmarks: number; states: number; captured: number; unanchored: number; durationMs: number } >;
	routes: { checked: number; reused: number; probedInPlace: Array< { url: string; profile: string; reason: string } > };
}

/** Every string field of a state named `…selector`, in a stable order. */
export function selectorFields( value: unknown, path = '' ): Array< { path: string; selector: string } > {
	if ( Array.isArray( value ) ) return value.flatMap( ( item, index ) => selectorFields( item, `${ path }[${ index }]` ) );
	if ( ! value || typeof value !== 'object' ) return [];
	return Object.entries( value as Record< string, unknown > ).flatMap( ( [ key, child ] ) =>
		typeof child === 'string'
			? /selector$/i.test( key ) ? [ { path: path ? `${ path }.${ key }` : key, selector: child } ] : []
			: selectorFields( child, path ? `${ path }.${ key }` : key ) );
}

/**
 * Rewrite every selector field that names a node under the `from` root so it
 * names the same node under the `to` root. Prefixes pair by form; a selector
 * matches a prefix only at a combinator boundary.
 */
export function rebaseChromeState< T >( state: T, from: readonly string[], to: readonly string[] ): T {
	const pairs = from.map( ( prefix, index ) => [ prefix, to[ index ]! ] as const )
		.sort( ( a, b ) => b[ 0 ].length - a[ 0 ].length );
	const rebase = ( selector: string ): string => {
		for ( const [ prefix, replacement ] of pairs ) {
			if ( selector === prefix || selector.startsWith( `${ prefix } ` ) ) return replacement + selector.slice( prefix.length );
		}
		return selector;
	};
	const walk = ( value: unknown, key: string ): unknown => {
		if ( typeof value === 'string' ) return /selector$/i.test( key ) ? rebase( value ) : value;
		if ( Array.isArray( value ) ) return value.map( item => walk( item, key ) );
		if ( value && typeof value === 'object' ) return Object.fromEntries( Object.entries( value as Record< string, unknown > ).map( ( [ name, child ] ) => [ name, walk( child, name ) ] ) );
		return value;
	};
	return walk( state, '' ) as T;
}

/**
 * The page's outermost chrome landmarks, in document order. With `mark`, each
 * root also gets `CHROME_ROOT_ATTRIBUTE` (cleared by `clearChromeMarks`).
 */
export async function readChromeLandmarks( page: Page, mark = false ): Promise< ChromeLandmark[] > {
	const raw = await page.evaluate( ( { selector, attributes, rootAttribute, mark } ) => {
		const skipped = new Set( [ 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE' ] );
		const kept = ( element: Element ) => ! skipped.has( element.tagName );
		const sameTag = ( element: Element ) => Array.from( element.parentElement?.children ?? [] ).filter( sibling => sibling.tagName === element.tagName );
		const positional = ( element: Element ) => `${ element.tagName.toLowerCase() }:nth-of-type(${ sameTag( element ).indexOf( element ) + 1 })`;
		const compact = ( element: Element ) => sameTag( element ).length > 1 ? positional( element ) : element.tagName.toLowerCase();
		const chain = ( element: Element, part: ( element: Element ) => string, stopAtId: boolean ) => {
			const parts: string[] = [];
			for ( let node: Element | null = element; node && node !== document.body; node = node.parentElement ) {
				if ( stopAtId && node.id ) return [ `#${ CSS.escape( node.id ) }`, ...parts ].join( ' > ' );
				parts.unshift( part( node ) );
			}
			return `body > ${ parts.join( ' > ' ) }`;
		};
		const roots = Array.from( document.querySelectorAll( selector ) )
			.filter( element => ! element.parentElement?.closest( selector ) && ! element.closest( 'script,style,noscript,template' ) && kept( element ) );
		return roots.map( root => {
			const lines: string[] = [];
			const describe = ( element: Element ) => attributes.map( name => element.getAttribute( name ) ).map( value => value ?? '' ).join( '|' );
			const text: string[] = [];
			const walk = ( element: Element, prefix: string ) => {
				let position = 0;
				for ( const child of Array.from( element.childNodes ) ) {
					if ( child.nodeType === Node.TEXT_NODE ) {
						const value = ( child.textContent ?? '' ).replace( /\s+/g, ' ' ).trim();
						if ( value ) text.push( value );
						continue;
					}
					if ( ! ( child instanceof Element ) || ! kept( child ) ) continue;
					const path = `${ prefix }/${ position++ }`;
					lines.push( `${ path } ${ child.tagName.toLowerCase() } ${ describe( child ) }` );
					walk( child, path );
				}
			};
			lines.push( `${ root.tagName.toLowerCase() } ${ describe( root ) }` );
			walk( root, '' );
			if ( mark ) root.setAttribute( rootAttribute, '' );
			return {
				raw: `${ lines.join( '\n' ) }\n${ text.join( ' ' ) }`,
				prefixes: [ chain( root, compact, false ), chain( root, positional, false ), chain( root, positional, true ) ],
				label: `${ root.tagName.toLowerCase() }${ root.getAttribute( 'role' ) ? `[role=${ root.getAttribute( 'role' ) }]` : '' }${ root.classList[ 0 ] ? `.${ root.classList[ 0 ] }` : '' }`,
			};
		} );
	}, { selector: CHROME_LANDMARK_SELECTOR, attributes: SIGNATURE_ATTRIBUTES, rootAttribute: CHROME_ROOT_ATTRIBUTE, mark } );
	return raw.map( ( { raw: signature, prefixes, label } ) => ( {
		signature: createHash( 'sha256' ).update( signature ).digest( 'hex' ).slice( 0, 32 ),
		prefixes: prefixes as ChromeLandmark['prefixes'],
		label,
	} ) );
}

/** Resolve selectors on the page and anchor each to the given chrome roots. */
async function anchorSelectors( page: Page, roots: readonly ChromeLandmark[], selectors: readonly string[][] ): Promise< ChromeAnchor[][] > {
	return page.evaluate( ( { roots, selectors } ) => {
		const skipped = new Set( [ 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE' ] );
		type OutsideAnchorInPage = { id: string } | { path: number[] };
		type ChromeAnchorInPage = { root: number; path: number[] } | { outside: OutsideAnchorInPage } | 'document' | 'absent' | 'invalid';
		const kept = ( element: Element ) => ! skipped.has( element.tagName );
		const elements = roots.map( root => document.querySelector( root ) );
		const outside = ( element: Element ): { outside: OutsideAnchorInPage } => (
			{ outside: element.id ? { id: element.id } : { path: bodyPath( element ) } }
		);
		const bodyPath = ( element: Element ): number[] => {
			const path: number[] = [];
			for ( let node: Element | null = element; node && node !== document.body; node = node.parentElement ) {
				path.unshift( Array.from( node.parentElement!.children ).filter( kept ).indexOf( node ) );
			}
			return path;
		};
		const anchor = ( selector: string ): ChromeAnchorInPage => {
			let element: Element | null;
			try {
				element = document.querySelector( selector );
			} catch {
				return 'invalid';
			}
			if ( ! element ) return 'absent';
			if ( element === document.body || element === document.documentElement ) return 'document';
			const root = elements.findIndex( candidate => candidate?.contains( element ) );
			if ( root < 0 ) return outside( element );
			const path: number[] = [];
			for ( let node: Element = element; node !== elements[ root ]; node = node.parentElement! ) {
				if ( ! kept( node ) ) return outside( element );
				path.unshift( Array.from( node.parentElement!.children ).filter( kept ).indexOf( node ) );
			}
			return { root, path };
		};
		return selectors.map( list => list.map( anchor ) );
	}, { roots: roots.map( root => root.prefixes[ 1 ] ), selectors: selectors.map( list => [ ...list ] ) } );
}

/**
 * Anchor the states probed on the entrypoint. A state is chrome evidence when
 * its trigger is inside a chrome root and every other selector it records
 * resolves — in any chrome root, the document itself, nowhere, or a node
 * outside chrome: builders often render a chrome control's panel at body
 * level. Where each selector resolved — and its path inside a root — is
 * recorded, and `reuseSharedChrome` verifies all of it again on every route
 * before the state is reused there.
 */
export async function anchorChromeStates( page: Page, landmarks: readonly ChromeLandmark[], states: readonly CapturedDialogInteraction[] ): Promise< { states: ChromeState[]; unanchored: number } > {
	const fields = states.map( state => selectorFields( state ) );
	const anchors = await anchorSelectors( page, landmarks, fields.map( list => list.map( field => field.selector ) ) );
	const anchored: ChromeState[] = [];
	states.forEach( ( state, index ) => {
		const trigger = anchors[ index ]![ fields[ index ]!.findIndex( field => field.path === 'trigger.selector' ) ];
		if ( ! trigger || typeof trigger !== 'object' ) return;
		// Every resolvable position is reusable evidence: reuse verifies every
		// selector again on the route, so only a state this page could not even
		// name (an invalid selector, or a trigger outside chrome) is dropped.
		if ( anchors[ index ]!.every( item => item !== 'invalid' ) && 'root' in trigger ) {
			anchored.push( { root: trigger.root, state, anchors: anchors[ index ]! } );
		}
	} );
	return { states: anchored, unanchored: states.length - anchored.length };
}

export async function clearChromeMarks( page: Page ): Promise< void > {
	await page.evaluate( ( names ) => {
		for ( const name of names ) for ( const element of Array.from( document.querySelectorAll( `[${ name }]` ) ) ) element.removeAttribute( name );
	}, [ CHROME_ROOT_ATTRIBUTE, CHROME_REUSED_ATTRIBUTE ] ).catch( () => undefined );
}

export interface ChromeReuse {
	decision: SharedChromeRouteDecision;
	/** Rebased entrypoint states, tagged `reusedFrom`. */
	states: CapturedDialogInteraction[];
	/** Selector of route controls whose evidence was reused; the route probe skips them. */
	skip?: string;
	/**
	 * Positional selectors of route chrome roots that match no entrypoint
	 * landmark. Their controls have no reusable evidence; a reflow-only route
	 * probes their phone-only controls in place (see `probePhoneOnlyChrome`).
	 */
	unmatchedRoots?: string[];
}

/**
 * Match this route's chrome to the entrypoint's, rebase and validate the
 * entrypoint's states, and mark the reused triggers on the page.
 */
export async function reuseSharedChrome( page: Page, probe: SharedChromeProbe ): Promise< ChromeReuse > {
	const evidence = probe.evidence;
	if ( probe.status !== 'captured' || ! evidence ) {
		return { decision: { chromeReused: false, reason: probe.status === 'skipped' ? probe.reason ?? 'the entrypoint chrome was not probed' : `the entrypoint chrome probe failed: ${ probe.reason ?? 'no evidence' }` }, states: [] };
	}
	if ( ! evidence.landmarks.length ) return { decision: { chromeReused: false, reason: 'the entrypoint has no chrome landmarks' }, states: [] };
	const landmarks = await readChromeLandmarks( page );
	const counts = { route: landmarks.length, entrypoint: evidence.landmarks.length };
	if ( ! landmarks.length ) return { decision: { chromeReused: false, reason: 'this route has no chrome landmarks', landmarks: { ...counts, matched: 0 } }, states: [] };
	// The n-th occurrence of a signature pairs with its n-th occurrence here.
	const matched = new Map< number, number >();
	const used = new Set< number >();
	evidence.landmarks.forEach( ( landmark, index ) => {
		const found = landmarks.findIndex( ( candidate, position ) => ! used.has( position ) && candidate.signature === landmark.signature );
		if ( found < 0 ) return;
		used.add( found );
		matched.set( index, found );
	} );
	const unmatchedRoots = landmarks.filter( ( _, position ) => ! used.has( position ) ).map( root => root.prefixes[ 1 ] );
	if ( ! matched.size ) {
		return { unmatchedRoots, decision: { chromeReused: false, reason: `no chrome landmark matches the entrypoint's (${ landmarks.map( item => item.label ).join( ', ' ) } here; ${ evidence.landmarks.map( item => item.label ).join( ', ' ) } there)`, landmarks: { ...counts, matched: 0 } }, states: [] };
	}
	const candidates = evidence.states.filter( item =>
		matched.has( item.root ) && item.anchors.every( anchor => typeof anchor !== 'object' || 'outside' in anchor || matched.has( anchor.root ) )
	).map( item => {
		const root = matched.get( item.root )!;
		const state = rebaseChromeState( item.state, evidence.landmarks[ item.root ]!.prefixes, landmarks[ root ]!.prefixes );
		const expected: ChromeAnchor[] = item.anchors.map( anchor => {
			if ( typeof anchor !== 'object' ) return anchor;
			if ( 'outside' in anchor ) return anchor;
			return { root: matched.get( anchor.root )!, path: anchor.path };
		} );
		return { state, expected };
	} );
	const resolved = await anchorSelectors( page, landmarks, candidates.map( candidate => selectorFields( candidate.state ).map( field => field.selector ) ) );
	const reused = candidates.filter( ( candidate, index ) => JSON.stringify( resolved[ index ] ) === JSON.stringify( candidate.expected ) );
	await page.evaluate( ( { selectors, attribute } ) => {
		for ( const selector of selectors ) document.querySelector( selector )?.setAttribute( attribute, '' );
	}, { selectors: reused.map( candidate => candidate.state.trigger.selector ), attribute: CHROME_REUSED_ATTRIBUTE } );
	const rejected = candidates.length - reused.length;
	return {
		decision: {
			chromeReused: true,
			reason: `${ matched.size } of ${ landmarks.length } chrome landmarks match the entrypoint; ${ reused.length } entrypoint states reused${ rejected ? `, ${ rejected } probed in place because their selectors name other nodes here` : '' }`,
			landmarks: { ...counts, matched: matched.size },
			reusedStates: reused.length,
			...( rejected ? { rejectedStates: rejected } : {} ),
		},
		states: reused.map( candidate => ( { ...candidate.state, reusedFrom: evidence.url } ) ),
		...( reused.length ? { skip: `[${ CHROME_REUSED_ATTRIBUTE }]` } : {} ),
		...( unmatchedRoots.length ? { unmatchedRoots } : {} ),
	};
}

export function summarizeSharedChrome(
	entrypoint: string,
	probes: ReadonlyMap< string, SharedChromeProbe >,
	decisions: ReadonlyArray< { url: string; profile: string } & SharedChromeRouteDecision >
): SharedChromeSummary {
	return {
		entrypoint,
		profiles: Object.fromEntries( [ ...probes ].map( ( [ profile, probe ] ) => [ profile, {
			status: probe.status,
			...( probe.reason ? { reason: probe.reason } : {} ),
			landmarks: probe.evidence?.landmarks.length ?? 0,
			states: probe.evidence?.states.length ?? 0,
			captured: probe.evidence?.states.filter( item => item.state.status === 'captured' ).length ?? 0,
			unanchored: probe.evidence?.unanchored ?? 0,
			durationMs: probe.durationMs,
		} ] ) ),
		routes: {
			checked: decisions.length,
			reused: decisions.filter( decision => decision.chromeReused ).length,
			probedInPlace: decisions.filter( decision => ! decision.chromeReused ).map( ( { url, profile, reason } ) => ( { url, profile, reason } ) ),
		},
	};
}
