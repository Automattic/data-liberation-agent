import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import postcss from 'postcss';
import type { AnyNode, Element } from 'domhandler';
import { isElementNode, isYuiRuntimeId } from './html-nodes.js';
import { FLUID_RULES_STYLE_ATTRIBUTE } from './screenshot/fluid-capture.js';
import { documentElementTags } from './screenshot/document-integrity.js';

/**
 * Cross-viewport node correspondence (#1034 point 5).
 *
 * A structural signature and shared stable ids answer "are these two captures
 * the same document?" for many sources, but a builder whose phone rendering
 * adds a menu toggle, re-orders a list or wraps a section differently keeps
 * two full page copies today. This module reconciles the remaining pairs by
 * node correspondence: elements pair through their text and media identity —
 * what they say and which images and references they carry — never through
 * structural equality, and never through position alone. Matched nodes carry
 * their per-viewport presentation as width-scoped style; nodes one capture
 * rendered alone become width-scoped visibility on the one tree. The caller
 * keeps both documents when correspondence declines, so a bad match can never
 * replace an honest `dual-structural`.
 */

/** Class tokens marking elements only one responsive capture rendered. */
export const RESPONSIVE_MOBILE_ONLY_CLASS = 'data-blocks-engine-capture-mobile-only';
export const RESPONSIVE_DESKTOP_ONLY_CLASS = 'data-blocks-engine-capture-desktop-only';
/** Hook class for an id-less element whose per-viewport inline style is projected into width-scoped rules. */
export const RESPONSIVE_PROJECTION_CLASS_PREFIX = 'data-blocks-engine-capture-responsive-';

/** Id grammar a stable source identity must satisfy. */
export const RESPONSIVE_SOURCE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const CAPTURE_GEOMETRY_ID = /^(?:desktop|mobile)-(?:target|wrapper)-\d+/i;
const UUID_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUnstableResponsiveId( id: string ): boolean {
	return id
		.split( /\s+/ )
		.some(
			( token ) =>
				isYuiRuntimeId( token ) || CAPTURE_GEOMETRY_ID.test( token ) || UUID_ID.test( token )
		);
}

/**
 * Whether an id can stand for element identity across responsive captures.
 * Runtime-generated ids name a hydration or a capture artifact, not a
 * component, so they are transparent to identity reconciliation.
 */
export function isStableIdentityId( id: string ): boolean {
	return RESPONSIVE_SOURCE_ID.test( id ) && ! isUnstableResponsiveId( id );
}

export function learnedTransformSelectors( html: string ): string[] {
	const selectors: string[] = [];
	for ( const match of html.matchAll( /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi ) ) {
		if ( ! FLUID_RULES_STYLE_ATTRIBUTE.test( match[ 1 ] ?? '' ) ) continue;
		try {
			postcss.parse( match[ 2 ] ?? '' ).walkRules( ( rule ) => {
				if ( rule.nodes?.some( ( node ) => node.type === 'decl' && node.prop.toLowerCase() === 'transform' ) ) selectors.push( rule.selector );
			} );
		} catch {
			// Malformed capture-owned CSS is not evidence of a usable model.
		}
	}
	return selectors;
}

export function hasLearnedTransform( selectors: string[], segment: string | undefined ): boolean {
	return !!segment && selectors.some( selector => selector.includes( `[data-blocks-engine-capture-fluid-segment="${ segment }"]` ) );
}

export function withoutTransform( style: string ): string {
	return inlineDeclarations( style )
		.filter( ( declaration ) => declaration.slice( 0, declaration.indexOf( ':' ) ).trim().toLowerCase() !== 'transform' )
		.join( '; ' );
}

/**
 * Split an inline style attribute into declarations, honouring parentheses and
 * quotes so `url(data:…;base64,…)` stays one declaration.
 */
export function inlineDeclarations( style: string ): string[] {
	const declarations: string[] = [];
	let current = '';
	let depth = 0;
	let quote = '';
	for ( const character of style ) {
		if ( quote ) {
			if ( character === quote ) quote = '';
		} else if ( character === '"' || character === "'" ) quote = character;
		else if ( character === '(' ) depth++;
		else if ( character === ')' && depth > 0 ) depth--;
		else if ( character === ';' && depth === 0 ) {
			if ( current.trim() ) declarations.push( current.trim() );
			current = '';
			continue;
		}
		current += character;
	}
	if ( current.trim() ) declarations.push( current.trim() );
	return declarations;
}

/**
 * An inline style moved into a stylesheet keeps its cascade position by
 * becoming important: inline declarations outrank every normal author rule,
 * and so does an important id rule.
 */
export function importantRule( selector: string, style: string ): string {
	const declarations = inlineDeclarations( style ).map( ( declaration ) =>
		/!\s*important\s*$/i.test( declaration ) ? declaration : `${ declaration }!important`
	);
	return declarations.length > 0 ? `${ selector }{${ declarations.join( ';' ) }}` : '';
}

/** The real `<body>` content of a serialized document, as raw markup. */
function bodyContent( html: string ): string | undefined {
	const { open, close } = documentElementTags( html, 'body' );
	if ( ! open || ! close || close.start < open.end ) return undefined;
	return html.slice( open.end, close.start );
}

/** Raw class tokens of the real `<body>` start tag. */
function bodyClassTokens( html: string ): string[] {
	const attributes = documentElementTags( html, 'body' ).open?.attributes ?? '';
	return ( cheerio.load( `<body${ attributes }></body>` )( 'body' ).attr( 'class' ) ?? '' )
		.split( /\s+/ )
		.filter( Boolean );
}

/**
 * One reconciled viewport pair: a single body that renders both captures at
 * their own widths, plus the correspondence record the receipt reports.
 */
export interface ViewportTreeReconciliation {
	/** The reconciled single body: the desktop tree plus inserted mobile-only subtrees. */
	body: string;
	/** Matched node pairs across the two captures, including the body pair. */
	matchedNodes: number;
	/** Elements only the desktop capture rendered, hidden at or below the switch width. */
	desktopOnlyElements: number;
	/** Elements only the mobile capture rendered, inserted under their matched parent and hidden above it. */
	mobileOnlyElements: number;
	/** Matched elements whose per-viewport presentation was projected into width-scoped rules. */
	projectedElements: number;
	/** Width-scoped rules carrying each viewport's inline presentation. */
	css: string;
	classAliases: Map<string, string>;
	/** Shared components the phone layout re-parents; node correspondence declines instead of splitting, so it always returns 0. */
	divergedComponents: number;
	/** Which identity signal anchored the match, for the receipt reason. */
	identityBasis: 'ids' | 'content';
}

/** Inert containers whose per-viewport copies carry no content identity. */
const RECONCILE_SKIP = new Set( [ 'script', 'style', 'noscript', 'template' ] );

const SOURCE_REFERENCE_ATTRIBUTES: Record< string, readonly string[] > = {
	a: [ 'href' ],
	area: [ 'href' ],
	img: [ 'src', 'srcset' ],
	video: [ 'src', 'poster' ],
	audio: [ 'src' ],
	iframe: [ 'src' ],
	embed: [ 'src' ],
	object: [ 'data' ],
};

function childNodes( node: AnyNode ): AnyNode[] {
	return 'children' in node ? node.children : [];
}

function childElements( element: Element ): Element[] {
	return childNodes( element ).filter(
		( child ): child is Element => isElementNode( child ) && ! RECONCILE_SKIP.has( child.tagName )
	);
}

function parentOf( element: Element ): Element | undefined {
	const parent = element.parent;
	return parent && isElementNode( parent ) ? parent : undefined;
}

/** The element's own text: its direct text nodes, whitespace-collapsed. */
function ownText( element: Element ): string {
	return childNodes( element )
		.filter( ( child ) => child.type === 'text' )
		.map( ( child ) => child.data ?? '' )
		.join( '' )
		.replace( /\s+/g, ' ' )
		.trim();
}

/** Absolute spellings compare canonically; relative references stay literal. */
function canonicalReference( value: string ): string {
	if ( ! /^https?:\/\//i.test( value ) ) return value;
	try {
		return new URL( value ).href;
	} catch {
		return value;
	}
}

/** Resolved navigation or media identity, or '' when the element carries none. */
export function referenceOf( element: Element ): string {
	const attributes = SOURCE_REFERENCE_ATTRIBUTES[ element.tagName ];
	if ( ! attributes ) return '';
	const values = attributes
		.map( ( attribute ) => ( element.attribs?.[ attribute ] ?? '' ).trim() )
		.filter( Boolean );
	return values.length === 0 ? '' : values.map( canonicalReference ).join( '|' );
}

/**
 * The content-identity key of an element: what it says (its own text), which
 * media it carries, or — for a link — where it goes and what it says. An
 * element without any of these (a bare container) has no content identity and
 * pairs through its matched children instead.
 */
function keyOf( element: Element ): string | undefined {
	const tag = element.tagName;
	if ( RECONCILE_SKIP.has( tag ) ) return undefined;
	if ( tag === 'a' || tag === 'area' ) {
		const href = ( element.attribs?.href ?? '' ).trim();
		if ( href ) return `a|${ canonicalReference( href ) }|${ ownText( element ) }`;
	}
	const media = referenceOf( element );
	if ( media ) return `m|${ tag }|${ media }`;
	const text = ownText( element );
	return text ? `t|${ tag }|${ text }` : undefined;
}

interface ContentKeys {
	keys: Map< string, Element >;
}

/**
 * Content keys of one body. A key two or more elements carry names a repeated
 * component, not one node, so like a runtime id it pairs nothing; those
 * elements pair positionally under a matched parent instead.
 */
function collectKeys( body: Element ): ContentKeys {
	const all = new Map< string, Element >();
	const repeated = new Set< string >();
	const visit = ( element: Element ): void => {
		const key = keyOf( element );
		if ( key ) {
			if ( all.has( key ) ) repeated.add( key );
			else all.set( key, element );
		}
		for ( const child of childElements( element ) ) visit( child );
	};
	visit( body );
	for ( const key of repeated ) all.delete( key );
	return { keys: all };
}

/**
 * Reconciles two responsive captures into one body by node correspondence.
 *
 * Elements pair when their text and media identity matches and is unique in
 * each document; the parents of matched nodes pair along with them while both
 * sides agree, which is what gives a phone-only menu toggle its home inside
 * the merged header. Under each matched pair, remaining children pair in
 * document order when their identity agrees, and otherwise ship for one width
 * only: desktop-only elements stay with width-scoped visibility, mobile-only
 * elements are inserted under their matched parent with it. Matched nodes
 * carry their per-viewport presentation as width-scoped rules — inline styles,
 * mobile-only class tokens (aliased so they cannot meet desktop rules) and
 * image `sizes`. Any disagreement correspondence cannot settle — nesting that
 * differs, a phone-only wrapper around matched content, an inserted id the
 * merged tree already uses — returns undefined so the caller keeps both
 * documents. Requires at least one content-identity anchor: without one the
 * captures carry different content, and `dual-structural` is the honest
 * outcome.
 */
export function correspondenceMerge(
	desktopHtml: string,
	mobileHtml: string,
	switchWidth: number
): ViewportTreeReconciliation | undefined {
	const desktopBody = bodyContent( desktopHtml );
	const mobileBody = bodyContent( mobileHtml );
	if ( desktopBody === undefined || mobileBody === undefined ) return undefined;
	const learnedTransforms = learnedTransformSelectors( desktopHtml );
	const $d = cheerio.load( `<body>${ desktopBody }</body>` );
	const $m = cheerio.load( `<body>${ mobileBody }</body>` );
	const bodyD = $d( 'body' ).get( 0 );
	const bodyM = $m( 'body' ).get( 0 );
	if ( ! bodyD || ! bodyM ) return undefined;

	const desktopToMobile = new Map< Element, Element >();
	const mobileToDesktop = new Map< Element, Element >();
	const pair = ( desktopElement: Element, mobileElement: Element ): boolean => {
		if ( desktopToMobile.has( desktopElement ) || mobileToDesktop.has( mobileElement ) ) return false;
		// Children can establish a container correspondence, but must not erase
		// that container's own destination (including viewport-specific bases).
		if ( referenceOf( desktopElement ) !== referenceOf( mobileElement ) ) return false;
		desktopToMobile.set( desktopElement, mobileElement );
		mobileToDesktop.set( mobileElement, desktopElement );
		return true;
	};

	// Seed: unique content identity in both documents. Without one anchor the
	// two captures carry different content, and one tree would be a guess.
	let anchors = 0;
	const desktopKeys = collectKeys( bodyD );
	const mobileKeys = collectKeys( bodyM );
	for ( const [ key, desktopElement ] of desktopKeys.keys ) {
		const mobileElement = mobileKeys.keys.get( key );
		if ( mobileElement && pair( desktopElement, mobileElement ) ) anchors++;
	}
	if ( anchors === 0 ) return undefined;
	pair( bodyD, bodyM );

	// Grow: the parents of matched nodes pair while both sides agree on the
	// match. This is what pairs the containers — a header, a nav, a main —
	// whose own content is only the matched children they hold.
	for ( let grown = true; grown; ) {
		grown = false;
		const proposalsD = new Map< Element, Set< Element > >();
		const proposalsM = new Map< Element, Set< Element > >();
		for ( const [ desktopElement, mobileElement ] of desktopToMobile ) {
			const pd = parentOf( desktopElement );
			const pm = parentOf( mobileElement );
			if ( ! pd || ! pm ) continue;
			( proposalsD.get( pd ) ?? proposalsD.set( pd, new Set() ).get( pd )! ).add( pm );
			( proposalsM.get( pm ) ?? proposalsM.set( pm, new Set() ).get( pm )! ).add( pd );
		}
		for ( const [ pd, candidates ] of proposalsD ) {
			if ( candidates.size !== 1 ) continue;
			const [ pm ] = [ ...candidates ];
			if ( ( proposalsM.get( pm! )?.size ?? 0 ) !== 1 ) continue;
			if ( pd!.tagName !== pm!.tagName ) continue;
			if ( pair( pd!, pm! ) ) grown = true;
		}
	}

	// Fill: under every matched pair, pair the remaining children in document
	// order when their identity agrees. One-sided children become width-scoped
	// visibility on the tree; a mismatch correspondence cannot settle declines
	// the merge.
	const mobileOnlyInsertions: Array< { parent: Element; element: Element } > = [];
	let declined = false;
	// Elements still holding a matched descendant, one set per side. Computed
	// once: a node hanging under an unmatched element never gains a matched
	// descendant during the fill, so what wraps here is what wraps everywhere.
	const wrapsMatched = ( body: Element, matched: Map< Element, unknown > ): Set< Element > => {
		const wraps = new Set< Element >();
		const visit = ( element: Element ): boolean => {
			let holds = matched.has( element );
			for ( const child of childElements( element ) ) if ( visit( child ) ) holds = true;
			if ( holds && element !== body ) wraps.add( element );
			return holds;
		};
		visit( body );
		return wraps;
	};
	const desktopWraps = wrapsMatched( bodyD, desktopToMobile );
	const mobileWraps = wrapsMatched( bodyM, mobileToDesktop );
	/** Text and media identity, ignoring classes and presentation attributes. */
	const sameIdentity = ( d: Element, m: Element ): boolean =>
		d.tagName === m.tagName && ownText( d ) === ownText( m ) && referenceOf( d ) === referenceOf( m );

	const reconcileChildren = ( pd: Element, pm: Element ): void => {
		const dKids = childElements( pd );
		const mKids = childElements( pm );
		// Every matched child must hang from this same pair, in the same order,
		// or the captures nest their components differently.
		let cursor = -1;
		for ( const dKid of dKids ) {
			const mKid = desktopToMobile.get( dKid );
			if ( mKid === undefined ) continue;
			const index = mKids.indexOf( mKid );
			if ( index < 0 || index <= cursor ) {
				declined = true;
				return;
			}
			cursor = index;
		}
		let i = 0;
		let j = 0;
		while ( i < dKids.length || j < mKids.length ) {
			while ( i < dKids.length && desktopToMobile.has( dKids[ i ] ) ) i++;
			while ( j < mKids.length && mobileToDesktop.has( mKids[ j ] ) ) j++;
			if ( i >= dKids.length ) {
				for ( ; j < mKids.length; j++ ) mobileOnlyInsertions.push( { parent: pd, element: mKids[ j ] } );
				return;
			}
			if ( j >= mKids.length ) return; // remaining desktop children are one-sided; the classification pass marks them
			const dKid = dKids[ i ];
			const mKid = mKids[ j ];
			if ( sameIdentity( dKid, mKid ) ) {
				pair( dKid, mKid );
				i++;
				j++;
				continue;
			}
			// A phone-only wrapper still holding matched content cannot be
			// reproduced on the tree without duplicating that content.
			if ( mobileWraps.has( mKid ) ) {
				declined = true;
				return;
			}
			// A desktop-only wrapper holding matched content keeps rendering at
			// every width; hiding it would hide the content it wraps.
			if ( desktopWraps.has( dKid ) ) {
				i++;
				continue;
			}
			if ( dKids.length - i > mKids.length - j ) {
				i++;
				continue;
			}
			if ( dKids.length - i < mKids.length - j ) {
				mobileOnlyInsertions.push( { parent: pd, element: mKid } );
				j++;
				continue;
			}
			// Equal remaining runs and no shared identity: neither side names the
			// other, so both ship, each for its own width.
			mobileOnlyInsertions.push( { parent: pd, element: mKid } );
			i++;
			j++;
		}
	};

	const processed = new Set< Element >();
	for ( let progress = true; progress && ! declined; ) {
		progress = false;
		for ( const [ desktopElement, mobileElement ] of [ ...desktopToMobile ] ) {
			if ( declined ) break;
			if ( processed.has( desktopElement ) ) continue;
			processed.add( desktopElement );
			reconcileChildren( desktopElement, mobileElement );
			progress = true;
		}
	}
	if ( declined ) return undefined;

	// Class aliases: a class token only the mobile capture rendered must not
	// meet desktop rules in the merged DOM, so it travels under an alias the
	// mobile stylesheet is rewritten to.
	const classAliases = new Map< string, string >();
	let unsafeClassAlias = false;
	const desktopClassTokens = new Set< string >();
	$d( '[class]' ).each( ( _index, node ) => {
		if ( ! isElementNode( node ) ) return;
		( node.attribs?.class ?? '' ).split( /\s+/ ).filter( Boolean ).forEach( ( token ) => desktopClassTokens.add( token ) );
	} );
	const aliasClass = ( token: string ): string => {
		if ( desktopClassTokens.has( token ) ) unsafeClassAlias = true;
		const alias = classAliases.get( token ) ?? `${ RESPONSIVE_PROJECTION_CLASS_PREFIX }class-${ createHash( 'sha256' ).update( token ).digest( 'hex' ).slice( 0, 12 ) }`;
		classAliases.set( token, alias );
		return alias;
	};
	const desktopBodyClasses = new Set( bodyClassTokens( desktopHtml ) );
	for ( const token of bodyClassTokens( mobileHtml ) ) {
		if ( desktopBodyClasses.has( token ) ) continue;
		aliasClass( token );
	}

	// Desktop-only: every unmatched element that holds no matched descendant,
	// hidden at or below the switch width. A wrapper still holding matched
	// descendants keeps rendering at every width.
	let desktopOnlyElements = 0;
	for ( const node of $d( 'body *' ).toArray() ) {
		if ( ! isElementNode( node ) ) continue;
		if ( RECONCILE_SKIP.has( node.tagName ) ) continue;
		if ( desktopToMobile.has( node ) || desktopWraps.has( node ) ) continue;
		$d( node ).addClass( RESPONSIVE_DESKTOP_ONLY_CLASS );
		desktopOnlyElements++;
	}

	// A mobile-only subtree must not carry an id the merged tree already uses:
	// the desktop copy keeps every matched id, and a duplicate id would move an
	// anchor target. Keep both documents rather than rename source ids.
	const desktopIdValues = new Set< string >();
	for ( const node of $d( '[id]' ).toArray() ) {
		if ( ! isElementNode( node ) ) continue;
		const id = node.attribs?.id ?? '';
		if ( id ) desktopIdValues.add( id );
	}
	const carriesUsedId = ( element: Element ): boolean => {
		const id = element.attribs?.id ?? '';
		if ( id && desktopIdValues.has( id ) ) return true;
		return childElements( element ).some( carriesUsedId );
	};
	const insertions: Array< { parent: Element; before?: Element; html: string } > = [];
	for ( const insertion of mobileOnlyInsertions ) {
		if ( carriesUsedId( insertion.element ) ) return undefined;
		$m( insertion.element ).addClass( RESPONSIVE_MOBILE_ONLY_CLASS );
		// Raw sibling indexes include viewport-only and inert nodes. Anchor to
		// the next corresponding sibling instead, preserving the phone order.
		const siblings = childElements( parentOf( insertion.element )! );
		const following = siblings.slice( siblings.indexOf( insertion.element ) + 1 );
		const before = following.map( node => mobileToDesktop.get( node ) )
			.find( node => node !== undefined && parentOf( node ) === insertion.parent );
		insertions.push( {
			parent: insertion.parent,
			before,
			html: $m.html( insertion.element ) ?? '',
		} );
	}
	for ( const insertion of insertions ) {
		if ( insertion.before ) $d( insertion.before ).before( insertion.html );
		else $d( insertion.parent ).append( insertion.html );
	}

	// One element now serves both viewports, but each capture rendered it with
	// its own presentation. Project every difference into width-scoped rules
	// instead of keeping only the desktop's. Class tokens union (each capture's
	// class rules are already scoped to its side of the switch), and an image's
	// `sizes` answers per viewport.
	const desktopRules: string[] = [];
	const mobileRules: string[] = [];
	let projectedElements = 0;
	const idCounts = new Map< string, number >();
	for ( const node of $d( '[id]' ).toArray() ) {
		if ( ! isElementNode( node ) ) continue;
		const id = node.attribs?.id ?? '';
		if ( ! isStableIdentityId( id ) ) continue;
		idCounts.set( id, ( idCounts.get( id ) ?? 0 ) + 1 );
	}
	// Hook names derive from an element's nearest stable-id ancestor and its
	// own content, never from document order alone, so chrome repeated on
	// every route serializes identically and stays recognizable downstream.
	const identityPath = ( element: Element ): string => {
		const parts: string[] = [];
		for ( let current: Element | undefined = element; current && current !== bodyD; current = parentOf( current ) ) {
			const id = current.attribs?.id ?? '';
			if ( id && isStableIdentityId( id ) ) return `#${ id }/${ parts.join( '/' ) }`;
			const parent = parentOf( current );
			const siblings = parent ? childElements( parent ) : [];
			parts.unshift( `${ current.tagName }[${ Math.max( 0, siblings.indexOf( current ) ) }]:${ ownText( current ).slice( 0, 64 ) }` );
		}
		return `body/${ parts.join( '/' ) }`;
	};
	const project = ( d: cheerio.Cheerio< Element >, m: cheerio.Cheerio< Element > ): void => {
		let projected = false;
		const desktopStyle = d.attr( 'style' ) ?? '';
		const mobileStyle = m.attr( 'style' ) ?? '';
		if ( desktopStyle.trim() !== mobileStyle.trim() ) {
			const desktopSegment = d.attr( 'data-blocks-engine-capture-fluid-segment' );
			const projectedMobileStyle = hasLearnedTransform( learnedTransforms, desktopSegment )
				? withoutTransform( mobileStyle )
				: mobileStyle;
			const id = d.attr( 'id' );
			let selector: string;
			if ( id && isStableIdentityId( id ) && idCounts.get( id ) === 1 ) selector = `#${ id }`;
			else {
				const hook = `${ RESPONSIVE_PROJECTION_CLASS_PREFIX }${ createHash( 'sha256' )
					.update( identityPath( d.get( 0 ) as Element ) )
					.digest( 'hex' )
					.slice( 0, 12 ) }`;
				d.addClass( hook );
				selector = `.${ hook }`;
			}
			const property = ( declaration: string ) =>
				declaration.slice( 0, declaration.indexOf( ':' ) ).trim().toLowerCase();
			const desktopDeclarations = inlineDeclarations( desktopStyle );
			const mobileProperties = new Set( inlineDeclarations( projectedMobileStyle ).map( property ) );
			// The desktop inline style stays where the reference viewport reads it
			// when mobile restates every property it sets; otherwise it would leak
			// onto phones, so both sides move into width-scoped rules.
			const keepsInline =
				! /!\s*important/i.test( desktopStyle ) &&
				desktopDeclarations.every( ( declaration ) => mobileProperties.has( property( declaration ) ) );
			if ( ! keepsInline ) {
				const desktopRule = importantRule( selector, desktopStyle );
				if ( desktopRule ) desktopRules.push( desktopRule );
				d.removeAttr( 'style' );
			}
			const mobileRule = importantRule( selector, projectedMobileStyle );
			if ( mobileRule ) mobileRules.push( mobileRule );
			projected = true;
		}
		const desktopClasses = ( d.attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean );
		const mobileClasses = ( m.attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean );
		const missing = mobileClasses.filter( ( token ) => ! desktopClasses.includes( token ) );
		if ( missing.length > 0 ) {
			d.attr( 'class', [ ...desktopClasses, ...missing.map( aliasClass ) ].join( ' ' ) );
			projected = true;
		}
		const desktopSizes = d.attr( 'sizes' );
		const mobileSizes = m.attr( 'sizes' );
		if ( desktopSizes && mobileSizes && desktopSizes !== mobileSizes ) {
			d.attr( 'sizes', `(max-width:${ switchWidth }px) ${ mobileSizes }, ${ desktopSizes }` );
			projected = true;
		}
		if ( projected ) projectedElements++;
	};
	for ( const [ desktopElement, mobileElement ] of desktopToMobile ) {
		project( $d( desktopElement ), $m( mobileElement ) );
	}
	if ( unsafeClassAlias ) return undefined;
	$d( '[class]' ).each( ( _index, node ) => {
		const element = $d( node );
		element.attr(
			'class',
			( element.attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean ).map( ( token ) => classAliases.get( token ) ?? token ).join( ' ' )
		);
	} );
	const css =
		( desktopRules.length > 0
			? `@media(min-width:${ switchWidth + 1 }px){${ desktopRules.join( '' ) }}`
			: '' ) +
		( mobileRules.length > 0 ? `@media(max-width:${ switchWidth }px){${ mobileRules.join( '' ) }}` : '' );
	return {
		body: $d( 'body' ).html() ?? desktopBody,
		matchedNodes: desktopToMobile.size,
		desktopOnlyElements,
		mobileOnlyElements: insertions.length,
		projectedElements,
		css,
		classAliases,
		divergedComponents: 0,
		identityBasis: 'content',
	};
}
