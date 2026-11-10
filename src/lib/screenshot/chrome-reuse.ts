import { load } from 'cheerio';
import type { Element as DomElement } from 'domhandler';
import type { Page } from 'playwright';
import { normalizeCaptureState, normalizeGeneratedIds } from './capture-state.js';
import type { CapturedDialogInteraction } from './interaction-capture.js';

/**
 * Shared site chrome — the header, navigation and footer every route repeats —
 * is probed once per capture, on the entrypoint, and its interaction evidence
 * is reused on every route whose chrome is the same subtree.
 *
 * Chrome roots include nested landmarks, so a shared nav can match even when
 * its enclosing header holds page-specific content. Two roots match when
 * their signatures match: relative element paths, a few identity attributes
 * and the normalized text. Route-current state (classes, `aria-current`) is
 * not part of it. Ids, and classes built from an id, count by position, not by
 * value: builders give each page its own copy of the header under renamed ids.
 * Two roots must also render alike: each element's computed style (custom
 * properties aside, as they paint only through other properties; a font family
 * on an element with no text of its own; the root's grid slot) matches,
 * outside the current-route item (`aria-current`) on either page. A reused
 * state is translated to the route's ids and classes. A root may sit at a different place in each template, so a
 * reused state's selectors are rebased from the entrypoint root's prefix to the
 * route root's, and the state is kept only when every rebased selector names
 * the corresponding node on the route. Anything else is probed in place.
 *
 * Builder navbars are often plain elements with no landmark. A probed control
 * outside every landmark then names its own root: its outermost ancestor that
 * holds no page heading or main content (see `builderChromeRoots`). Templates
 * place that root at different depths, so routes find it by its tag and classes
 * and, like any root, reuse it only when its signature matches.
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

/**
 * Bounded rendering contract: box geometry, layout, typography and paint,
 * including generated content and fragment-based effects. No custom properties
 * (their resolved consumers are compared), animations/transitions (transient
 * capture state), or interaction-only properties such as cursor/touch-action.
 * Keep font-family, grid placement and pseudo styles: renamed-id matching must
 * still distinguish id/class-keyed CSS, with the exclusions below in styleOf.
 */
const CHROME_STYLE_PROPERTIES = [
	'display', 'visibility', 'opacity', 'content', 'box-sizing', 'position', 'z-index',
	'top', 'right', 'bottom', 'left', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
	'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
	'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
	'overflow-x', 'overflow-y', 'overflow-clip-margin', 'clip', 'clip-path',
	'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'order',
	'justify-content', 'align-content', 'align-items', 'align-self', 'justify-items', 'justify-self',
	'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows', 'grid-template-areas',
	'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows',
	'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end',
	'float', 'clear', 'vertical-align', 'table-layout', 'border-collapse', 'border-spacing',
	'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant',
	'font-feature-settings', 'font-variation-settings', 'line-height', 'letter-spacing', 'word-spacing',
	'white-space', 'word-break', 'overflow-wrap', 'text-align', 'text-indent', 'text-transform',
	'text-decoration-line', 'text-decoration-color', 'text-decoration-style', 'text-decoration-thickness',
	'text-underline-offset', 'text-overflow', 'text-shadow', 'direction', 'writing-mode',
	'color', 'background-color', 'background-image', 'background-position', 'background-size',
	'background-repeat', 'background-origin', 'background-clip', 'background-attachment',
	'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
	'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
	'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
	'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
	'border-image-source', 'border-image-slice', 'border-image-width', 'border-image-outset', 'border-image-repeat',
	'outline-width', 'outline-style', 'outline-color', 'outline-offset', 'box-shadow',
	'transform', 'transform-origin', 'translate', 'rotate', 'scale', 'perspective', 'perspective-origin',
	'filter', 'backdrop-filter', 'mix-blend-mode', 'isolation', 'object-fit', 'object-position',
	'list-style-type', 'list-style-position', 'list-style-image', 'appearance', 'accent-color',
	'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
	'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin',
	'mask-image', 'mask-size', 'mask-position', 'mask-repeat', 'mask-mode', 'mask-composite',
] as const;

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
	/** A builder chrome root's tag-and-class selector: a probed control named it, not a landmark element. */
	identity?: string;
	/** Index of the containing landmark, when this is a nested fallback. */
	parent?: number;
	/** The root's ids and id references, in order of first appearance: the signature names them by position. */
	ids: string[];
	/** Classes built from one of those ids, in order of first appearance. */
	classes: string[];
	/** A hash of each element's computed style, in document order; empty for a non-candidate route root. */
	styles: string[];
	/** Positions in `styles` inside the current-route item. */
	current: number[];
}

/** Same chrome: equal signatures, rendered alike outside either page's current-route item. */
export function sameChrome( a: ChromeLandmark, b: ChromeLandmark ): boolean {
	if ( a.signature !== b.signature || a.styles.length !== b.styles.length ) return false;
	const current = new Set( [ ...a.current, ...b.current ] );
	return a.styles.every( ( style, index ) => current.has( index ) || style === b.styles[ index ] );
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
	/** All entrypoint outcomes reused, including negative probe results. */
	reusedOutcomes?: number;
	/** Nested landmarks reused when their enclosing landmark did not match. */
	nestedMatches?: number;
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

/** A name usable verbatim in CSS: translation never meets an escaped form. */
const PLAIN_NAME = /^-?[A-Za-z_][\w-]*$/;

/**
 * Rename ids and classes in every string of a state, as whole tokens: ids after
 * `#` (selectors, CSS, fragment links) and in `id`, `for` and `aria-*` values of
 * captured markup; classes after `.` and in `class` values. A name the maps do
 * not hold but that is built from a renamed id (the id bounded by `-` or `_`,
 * as a builder names a panel it portals out of the header) is renamed with it.
 * One pass each, so a pair of swapped names cannot translate twice.
 */
export function translateChromeNames< T >( state: T, names: { ids: ReadonlyMap< string, string >; classes: ReadonlyMap< string, string > } ): T {
	const plain = ( map: ReadonlyMap< string, string > ) => new Map( [ ...map ].filter( ( [ from, to ] ) => from !== to && PLAIN_NAME.test( from ) && PLAIN_NAME.test( to ) ) );
	const ids = plain( names.ids );
	const alternation = [ ...ids.keys() ].sort( ( a, b ) => b.length - a.length ).map( name => name.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) ).join( '|' );
	const built = ids.size ? new RegExp( `(?<=^|[-_])(${ alternation })(?=[-_]|$)`, 'g' ) : null;
	const rule = ( map: ReadonlyMap< string, string >, prefix: string, attributes: string ) => {
		const renamed = plain( map );
		if ( ! renamed.size && ! built ) return ( text: string ) => text;
		const rename = ( name: string ) => renamed.get( name ) ?? ( built && PLAIN_NAME.test( name ) ? name.replace( built, found => ids.get( found )! ) : name );
		const selector = new RegExp( `\\${ prefix }(-?[A-Za-z_][\\w-]*)`, 'g' );
		const token = /(?<![\w-])([\w-]+)(?![\w-])/g;
		const attribute = new RegExp( `(\\s(?:${ attributes })=)(["'])(.*?)\\2`, 'g' );
		return ( text: string ) => text
			.replace( attribute, ( _, name: string, quote: string, value: string ) => `${ name }${ quote }${ value.replace( token, rename ) }${ quote }` )
			.replace( selector, ( _, found: string ) => `${ prefix }${ rename( found ) }` );
	};
	const id = rule( names.ids, '#', 'id|for|aria-[\\w-]+' );
	const classes = rule( names.classes, '.', 'class' );
	const walk = ( value: unknown ): unknown => {
		if ( typeof value === 'string' ) return classes( id( value ) );
		if ( Array.isArray( value ) ) return value.map( walk );
		if ( value && typeof value === 'object' ) return Object.fromEntries( Object.entries( value as Record< string, unknown > ).map( ( [ key, child ] ) => [ key, walk( child ) ] ) );
		return value;
	};
	return walk( state ) as T;
}

/**
 * The page's chrome landmarks, including nested fallbacks, in document order. With `mark`, each
 * root also gets `CHROME_ROOT_ATTRIBUTE` (cleared by `clearChromeMarks`).
 */
/** The page a link names, for comparing it with a route: no fragment, no trailing slash. */
function linkedPage( href: string, base: string ): string | undefined {
	try {
		const target = new URL( href, base );
		if ( ! /^https?:$/.test( target.protocol ) ) return undefined;
		return `${ target.origin }${ target.pathname.replace( /\/+$/, '' ) }${ target.search }`;
	} catch {
		return undefined;
	}
}

/**
 * Move a reused state's current-route marking from the entrypoint to the route.
 *
 * Probed markup marks the link to the page it was probed on (`aria-current`)
 * and often styles that link's item apart (a builder's `data-selected`, a
 * class). The marking is learned from the markup itself: the attributes in
 * which the current item's elements differ from their sibling items while the
 * siblings agree with each other (so per-item values such as `href` or an id
 * never count). The entrypoint's item takes the siblings' values and the item
 * linking to the route takes the marking. Markup that marks no page is returned
 * as is. When the marking cannot be learned (fewer than two like siblings, or
 * the route's link sits in another structure), the result is `null` and the
 * state must be probed on the route.
 */
export function retargetCurrentRoute( html: string, from: string, to: string ): string | null {
	if ( ! html.includes( '<a' ) ) return html;
	const $ = load( html, null, false );
	const links = $( 'a[href]' ).toArray();
	const page = ( link: DomElement ) => linkedPage( $( link ).attr( 'href' )!, from );
	const isCurrent = ( link: DomElement ) => { const value = $( link ).attr( 'aria-current' ); return value !== undefined && value !== 'false'; };
	const route = linkedPage( to, to );
	const current = links.filter( isCurrent );
	const targets = route ? links.filter( link => ! isCurrent( link ) && page( link ) === route ) : [];
	if ( ! current.length || ( ! targets.length && current.every( link => page( link ) === route ) ) ) return html;
	// A link's item: its outermost ancestor holding no other link.
	const item = ( link: DomElement ): DomElement => {
		let node = link;
		while ( node.parent && node.parent.type === 'tag' && $( node.parent ).find( 'a[href]' ).length === 1 ) node = node.parent as DomElement;
		return node;
	};
	const elements = ( root: DomElement ): DomElement[] => [ root, ...$( root ).find( '*' ).toArray() ];
	const shape = ( root: DomElement ) => elements( root ).map( node => node.name ).join( ' ' );
	for ( const link of current ) {
		const own = item( link );
		const siblings = links.filter( other => ! isCurrent( other ) ).map( item ).filter( root => root !== own && shape( root ) === shape( own ) );
		if ( siblings.length < 2 ) return null;
		const [ ownNodes, ...siblingNodes ] = [ own, ...siblings ].map( elements );
		// Per element position: attribute → [marked value, unmarked value].
		const marking = ownNodes!.map( ( node, index ) => {
			const names = new Set( [ node, ...siblingNodes.map( nodes => nodes[ index ]! ) ].flatMap( each => Object.keys( each.attribs ) ) );
			return [ ...names ].flatMap( name => {
				const values = siblingNodes.map( nodes => nodes[ index ]!.attribs[ name ] );
				const rest = values[ 0 ];
				return values.every( value => value === rest ) && node.attribs[ name ] !== rest ? [ [ name, node.attribs[ name ], rest ] as const ] : [];
			} );
		} );
		const apply = ( nodes: DomElement[], pick: 1 | 2 ) => nodes.forEach( ( node, index ) => {
			for ( const change of marking[ index ]! ) {
				const value = change[ pick ];
				if ( value === undefined ) delete node.attribs[ change[ 0 ] ];
				else node.attribs[ change[ 0 ] ] = value;
			}
		} );
		const marked = targets.map( item );
		if ( marked.some( root => shape( root ) !== shape( own ) ) ) return null;
		apply( ownNodes!, 2 );
		for ( const root of marked ) apply( elements( root ), 1 );
	}
	return $.html();
}

/** Every `html` string of a state, retargeted to the route; `null` when one cannot be. */
function retargetState< T >( state: T, from: string, to: string ): T | null {
	let failed = false;
	const walk = ( value: unknown, key: string ): unknown => {
		if ( typeof value === 'string' ) {
			if ( key !== 'html' ) return value;
			const html = retargetCurrentRoute( value, from, to );
			if ( html === null ) failed = true;
			return html ?? value;
		}
		if ( Array.isArray( value ) ) return value.map( item => walk( item, key ) );
		if ( value && typeof value === 'object' ) return Object.fromEntries( Object.entries( value as Record< string, unknown > ).map( ( [ name, child ] ) => [ name, walk( child, name ) ] ) );
		return value;
	};
	const result = walk( state, '' ) as T;
	return failed ? null : result;
}

/**
 * With candidates, read styles only for structurally matching roots. Structure
 * and styles share one evaluate, so nested roots need no additional round trips.
 * Without candidates, establish the complete entrypoint rendering evidence.
 */
export async function readChromeLandmarks( page: Page, mark = false, builderRoots: readonly string[] = [], candidates?: readonly ChromeLandmark[] ): Promise< ChromeLandmark[] > {
	await normalizeCaptureState( page );
	await normalizeGeneratedIds( page );
	const raw = await page.evaluate( ( { selector, attributes, rootAttribute, mark, builderRoots, signatures, properties } ) => {
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
		const landmarks = Array.from( document.querySelectorAll( selector ) )
			.filter( element => ! element.closest( 'script,style,noscript,template' ) && kept( element ) );
		const identities = new Map< Element, string >();
		for ( const identity of builderRoots ) {
			const found = Array.from( document.querySelectorAll( identity ) ).filter( element => ! element.closest( selector ) && ! element.querySelector( selector ) );
			for ( const element of found ) if ( ! found.some( other => other !== element && other.contains( element ) ) && ! identities.has( element ) ) identities.set( element, identity );
		}
		const roots = [ ...landmarks, ...identities.keys() ];
		const escape = ( name: string ) => name.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
		const hash = ( text: string ) => {
			let a = 0xdeadbeef, b = 0x41c6ce57;
			for ( let index = 0; index < text.length; index++ ) {
				const code = text.charCodeAt( index );
				a = Math.imul( a ^ code, 2654435761 );
				b = Math.imul( b ^ code, 1597334677 );
			}
			a = Math.imul( a ^ ( a >>> 16 ), 2246822507 ) ^ Math.imul( b ^ ( b >>> 13 ), 3266489909 );
			b = Math.imul( b ^ ( b >>> 16 ), 2246822507 ) ^ Math.imul( a ^ ( a >>> 13 ), 3266489909 );
			return ( b >>> 0 ).toString( 16 ) + ( a >>> 0 ).toString( 16 );
		};
		const page = location.href.split( '#' )[ 0 ]!;
		return roots.map( root => {
			const elements: Element[] = [];
			const text: string[] = [];
			const collect = ( element: Element ) => {
				elements.push( element );
				for ( const child of Array.from( element.childNodes ) ) {
					if ( child.nodeType === Node.TEXT_NODE ) {
						const value = ( child.textContent ?? '' ).replace( /\s+/g, ' ' ).trim();
						if ( value ) text.push( value );
					} else if ( child instanceof Element && kept( child ) ) collect( child );
				}
			};
			collect( root );
			// An id is named by its first appearance, so a copy of the same chrome
			// under renamed (or runtime-generated) ids has the same signature.
			const ids: string[] = [];
			const fragment = ( value: string ) => {
				try { return decodeURIComponent( value ); } catch { return value; }
			};
			const label = ( id: string ) => {
				if ( ! ids.includes( id ) ) ids.push( id );
				return `#${ ids.indexOf( id ) }`;
			};
			for ( const element of elements ) {
				if ( element.id ) label( element.id );
				for ( const token of ( element.getAttribute( 'aria-controls' ) ?? '' ).split( /\s+/ ) ) if ( token ) label( token );
				const href = element.getAttribute( 'href' ) ?? '';
				if ( href.length > 1 && href.startsWith( '#' ) ) label( fragment( href.slice( 1 ) ) );
			}
			const alternation = [ ...ids ].sort( ( a, b ) => b.length - a.length ).map( escape ).join( '|' );
			const inClass = ids.length ? new RegExp( `(?<=^|[-_])(${ alternation })(?=[-_]|$)`, 'g' ) : null;
			const inStyle = ids.length ? new RegExp( `#(${ alternation })(?![\\w-])`, 'g' ) : null;
			const classes: string[] = [];
			const describe = ( element: Element ) => {
				const values = attributes.map( name => {
					const value = element.getAttribute( name ) ?? '';
					if ( ! value ) return '';
					if ( name === 'id' ) return label( value );
					if ( name === 'aria-controls' ) return value.split( /\s+/ ).map( label ).join( ' ' );
					if ( name === 'href' && value.length > 1 && value.startsWith( '#' ) ) return `href:${ label( fragment( value.slice( 1 ) ) ) }`;
					return value;
				} );
				// Other classes are presentation; one built from an id is that id's copy.
				for ( const name of inClass ? Array.from( element.classList ) : [] ) {
					const relabelled = name.replace( inClass!, label );
					if ( relabelled === name ) continue;
					if ( ! classes.includes( name ) ) classes.push( name );
					values.push( `.${ relabelled }` );
				}
				return values.join( '|' );
			};
			const lines: string[] = [];
			const walk = ( element: Element, prefix: string ) => {
				let position = 0;
				for ( const child of Array.from( element.children ) ) {
					if ( ! kept( child ) ) continue;
					const path = `${ prefix }/${ position++ }`;
					lines.push( `${ path } ${ child.tagName.toLowerCase() } ${ describe( child ) }` );
					walk( child, path );
				}
			};
			lines.push( `${ root.tagName.toLowerCase() } ${ describe( root ) }` );
			walk( root, '' );
			const signature = hash( `${ lines.join( '\n' ) }\n${ text.join( ' ' ) }` );
			// Only structural candidates can change the reuse decision. Entrypoint
			// reads (no signatures supplied) establish styles for every root once.
			const needsStyles = signatures === null || signatures.includes( signature );
			// Computed style, relabelled like the markup. A fragment URL resolves
			// against this route, so it is compared as the bare fragment. A font
			// family paints only text: an element without text of its own passes
			// it on to descendants, which are compared themselves. The root's slot
			// in the page grid is the template's, not the chrome's.
			const rendersText = ( element: Element ) => /^(INPUT|TEXTAREA|SELECT|LI)$/.test( element.tagName )
				|| Array.from( element.childNodes ).some( child => child.nodeType === Node.TEXT_NODE && ( child.textContent ?? '' ).trim() );
			const styleOf = ( element: Element ) => {
				const parts: string[] = [];
				const ignored = new Set( [
					...( element === root ? [ 'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end' ] : [] ),
					...( rendersText( element ) ? [] : [ 'font-family' ] ),
				] );
				for ( const pseudo of [ null, '::before', '::after' ] ) {
					const style = getComputedStyle( element, pseudo );
					if ( pseudo && [ 'none', 'normal' ].includes( style.content ) ) continue;
					parts.push( pseudo ?? '' );
					for ( const name of properties ) {
						if ( pseudo || ! ignored.has( name ) ) parts.push( `${ name }:${ style.getPropertyValue( name ) }` );
					}
				}
				const value = parts.join( ';' ).split( `url("${ page }#` ).join( 'url("#' );
				return hash( inStyle ? value.replace( inStyle, ( _, id: string ) => label( id ) ) : value );
			};
			const currentItems = Array.from( root.querySelectorAll( '[aria-current]:not([aria-current="false"])' ) );
			if ( root.matches( '[aria-current]:not([aria-current="false"])' ) ) currentItems.push( root );
			const current = elements.flatMap( ( element, index ) => currentItems.some( item => item.contains( element ) ) ? [ index ] : [] );
			if ( mark ) root.setAttribute( rootAttribute, '' );
			return {
				ids,
				classes,
				styles: needsStyles ? elements.map( styleOf ) : [],
				current,
				raw: signature,
				prefixes: [ chain( root, compact, false ), chain( root, positional, false ), chain( root, positional, true ) ],
				label: `${ root.tagName.toLowerCase() }${ root.getAttribute( 'role' ) ? `[role=${ root.getAttribute( 'role' ) }]` : '' }${ root.classList[ 0 ] ? `.${ root.classList[ 0 ] }` : '' }`,
				identity: identities.get( root ),
				parent: roots.indexOf( root.parentElement?.closest( selector )! ),
			};
		} );
	}, { selector: CHROME_LANDMARK_SELECTOR, attributes: SIGNATURE_ATTRIBUTES, rootAttribute: CHROME_ROOT_ATTRIBUTE, mark, builderRoots: [ ...builderRoots ], signatures: candidates ? candidates.map( root => root.signature ) : null, properties: CHROME_STYLE_PROPERTIES } );
	return raw.map( ( { raw: signature, prefixes, label, identity, ids, classes, styles, current, parent } ) => ( {
		signature,
		prefixes: prefixes as ChromeLandmark['prefixes'],
		label,
		ids,
		classes,
		styles,
		current,
		...( identity ? { identity } : {} ),
		...( parent >= 0 ? { parent } : {} ),
	} ) );
}

/**
 * Tag-and-class selectors of the builder chrome roots that hold these states'
 * triggers: for a trigger outside every landmark, its outermost ancestor below
 * `body` that holds no page heading or main content. A root is named only when
 * its classes identify it uniquely on this page.
 */
export async function builderChromeRoots( page: Page, states: readonly CapturedDialogInteraction[] ): Promise< string[] > {
	return page.evaluate( ( { selector, triggers } ) => {
		const content = 'h1,main,[role="main"]';
		const roots = new Set< string >();
		for ( const trigger of triggers ) {
			let element: Element | null = null;
			try { element = document.querySelector( trigger ); } catch { continue; }
			if ( ! element || element.closest( selector ) || element.closest( content ) ) continue;
			let root = element;
			while ( root.parentElement && root.parentElement !== document.body && ! root.parentElement.querySelector( content ) ) root = root.parentElement;
			if ( root.querySelector( selector ) || ! root.classList.length ) continue;
			const identity = root.tagName.toLowerCase() + Array.from( root.classList ).map( name => `.${ CSS.escape( name ) }` ).join( '' );
			if ( document.querySelectorAll( identity ).length === 1 ) roots.add( identity );
		}
		return [ ...roots ];
	}, { selector: CHROME_LANDMARK_SELECTOR, triggers: states.map( state => state.trigger.selector ) } );
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
				if ( ! node.parentElement ) return path;
				path.unshift( Array.from( node.parentElement.children ).filter( kept ).indexOf( node ) );
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
			// Prefer the innermost landmark so nested fallback evidence has its own prefix.
			const root = elements.reduce( ( found, candidate, index ) => candidate?.contains( element ) ? index : found, -1 );
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
	const landmarks = await readChromeLandmarks( page, false, evidence.landmarks.flatMap( landmark => landmark.identity ? [ landmark.identity ] : [] ), evidence.landmarks );
	const counts = { route: landmarks.length, entrypoint: evidence.landmarks.length };
	if ( ! landmarks.length ) return { decision: { chromeReused: false, reason: 'this route has no chrome landmarks', landmarks: { ...counts, matched: 0 } }, states: [] };
	// The n-th occurrence of a signature pairs with its n-th occurrence here.
	const matched = new Map< number, number >();
	const used = new Set< number >();
	evidence.landmarks.forEach( ( landmark, index ) => {
		const found = landmarks.findIndex( ( candidate, position ) => ! used.has( position ) && sameChrome( candidate, landmark ) );
		if ( found < 0 ) return;
		used.add( found );
		matched.set( index, found );
	} );
	const unmatchedRoots = landmarks.filter( ( root, position ) => ! used.has( position ) && root.parent === undefined ).map( root => root.prefixes[ 1 ] );
	const nestedMatches = [ ...used ].filter( position => {
		const parent = landmarks[ position ]!.parent;
		return parent !== undefined && ! used.has( parent );
	} ).length;
	if ( ! matched.size ) {
		return { unmatchedRoots, decision: { chromeReused: false, reason: `no chrome landmark matches the entrypoint's (${ landmarks.map( item => item.label ).join( ', ' ) } here; ${ evidence.landmarks.map( item => item.label ).join( ', ' ) } there)`, landmarks: { ...counts, matched: 0 } }, states: [] };
	}
	const eligible = evidence.states.filter( item =>
		matched.has( item.root ) && item.anchors.every( anchor => typeof anchor !== 'object' || 'outside' in anchor || matched.has( anchor.root ) )
	).map( item => {
		const root = matched.get( item.root )!;
		// Equal signatures name the same ids and id classes in the same positions.
		const from = evidence.landmarks[ item.root ]!, to = landmarks[ root ]!;
		const names = {
			ids: new Map( from.ids.map( ( id, index ) => [ id, to.ids[ index ]! ] ) ),
			classes: new Map( from.classes.map( ( name, index ) => [ name, to.classes[ index ]! ] ) ),
		};
		const translated = translateChromeNames( { state: item.state, prefixes: from.prefixes }, names );
		const rebased = rebaseChromeState( translated.state, translated.prefixes, landmarks[ root ]!.prefixes );
		// Markup that marks the entrypoint as the current page is moved to this
		// route; markup whose marking cannot be moved is probed in place.
		const state = retargetState( rebased, evidence.url, page.url() );
		const expected: ChromeAnchor[] = item.anchors.map( anchor => {
			if ( typeof anchor !== 'object' ) return anchor;
			if ( 'outside' in anchor ) return 'id' in anchor.outside ? { outside: { id: translateChromeNames( `#${ anchor.outside.id }`, names ).slice( 1 ) } } : anchor;
			return { root: matched.get( anchor.root )!, path: anchor.path };
		} );
		return state ? { state, expected } : undefined;
	} );
	const candidates = eligible.filter( ( candidate ): candidate is NonNullable< typeof candidate > => candidate !== undefined );
	const resolved = await anchorSelectors( page, landmarks, candidates.map( candidate => selectorFields( candidate.state ).map( field => field.selector ) ) );
	const reused = candidates.filter( ( candidate, index ) => JSON.stringify( resolved[ index ] ) === JSON.stringify( candidate.expected ) );
	await page.evaluate( ( { roots, rejected, attribute } ) => {
		for ( const selector of roots ) {
			const root = document.querySelector( selector );
			if ( ! root ) continue;
			for ( const element of [ root, ...Array.from( root.querySelectorAll( '*' ) ) ] ) element.setAttribute( attribute, '' );
		}
		// Invalid replay evidence still gets a fresh probe, as before.
		for ( const selector of rejected ) document.querySelector( selector )?.removeAttribute( attribute );
	}, {
		// Incomplete entrypoint evidence cannot authorize skipping unrecorded controls.
		roots: evidence.unanchored || eligible.length !== reused.length ? reused.map( candidate => candidate.state.trigger.selector ) : [ ...used ].map( index => landmarks[ index ]!.prefixes[ 1 ] ),
		rejected: candidates.filter( candidate => ! reused.includes( candidate ) ).map( candidate => candidate.state.trigger.selector ),
		attribute: CHROME_REUSED_ATTRIBUTE,
	} );
	const rejected = eligible.length - reused.length;
	const states = reused.filter( candidate => candidate.state.status === 'captured' || candidate.state.status === 'observed-incomplete' )
		.map( candidate => ( { ...candidate.state, reusedFrom: evidence.url } ) );
	return {
		decision: {
			chromeReused: true,
			reason: `${ matched.size } of ${ landmarks.length } chrome landmarks match the entrypoint; ${ states.length } entrypoint states reused; ${ nestedMatches } nested landmarks matched; ${ reused.length } outcomes reused${ rejected ? `, ${ rejected } probed in place because their selectors name other nodes here or their current-route marking cannot be moved` : '' }`,
			landmarks: { ...counts, matched: matched.size },
			reusedStates: states.length,
			reusedOutcomes: reused.length,
			nestedMatches,
			...( rejected ? { rejectedStates: rejected } : {} ),
		},
		states,
		...( matched.size ? { skip: `[${ CHROME_REUSED_ATTRIBUTE }]` } : {} ),
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
