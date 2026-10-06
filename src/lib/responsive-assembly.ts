import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import type { AnyNode, Element } from 'domhandler';
import { escapeHtmlAttr } from './html-escape.js';
import { appendScrollDrivenAnimations } from './scroll-driven-animations.js';
import { scopeCss } from './replicate/css-scope.js';
import { FLUID_RULES_STYLE_ATTRIBUTE } from './screenshot/fluid-capture.js';
import { isElementNode, isYuiRuntimeId } from './html-nodes.js';

/**
 * Responsive document assembly. The source pair is the raw captures. It chooses
 * which documents to assemble and owns a binding phone-only body-class gate.
 * Receipt evidence describes the tree that assembly emitted: the same raw
 * analysis when that pair is rendered, or one analysis of the portable pair
 * when that different pair is what ships.
 */

/**
 * Class tokens marking one side of a desktop/mobile document pair emitted
 * into a single exported page. Consumers that need to recognize these as a
 * document-scope boundary (e.g. to disambiguate a duplicate id captured on
 * both sides) cannot assume this naming — it is declared explicitly in the
 * capture receipt's `document_scope_classes` list rather than hardcoded
 * downstream.
 */
export const DESKTOP_DOCUMENT_CLASS = 'data-liberation-desktop-document';
export const MOBILE_DOCUMENT_CLASS = 'data-liberation-mobile-document';

const RESPONSIVE_DOCUMENT_CSS = `html,body{margin:0;padding:0}.${ MOBILE_DOCUMENT_CLASS }{display:none!important}`;

const RESPONSIVE_COUNTERPART_CLASS_PREFIX = 'data-liberation-responsive-counterpart-';
const RESPONSIVE_COUNTERPART_TAGS = 'p,h1,h2,h3,h4,h5,h6,a,button';
const RESPONSIVE_SOURCE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;

/**
 * Class tokens marking elements only one responsive capture rendered inside an
 * identity-subset collapse: a mobile-only element joins the desktop tree but
 * stays hidden above the switch width, a desktop-only element stays hidden at
 * or below it. Both are declared with the visibility stylesheet that collapse
 * emits, so no consumer needs to know the naming.
 */
const RESPONSIVE_MOBILE_ONLY_CLASS = 'data-liberation-mobile-only';
const RESPONSIVE_DESKTOP_ONLY_CLASS = 'data-liberation-desktop-only';
/** Hook class for an id-less element whose per-viewport inline style is projected into width-scoped rules. */
const RESPONSIVE_PROJECTION_CLASS_PREFIX = 'data-liberation-responsive-';

/** Switches which captured document is shown, at the detected width. */
function documentSwitchCss( switchWidth: number ): string {
	return `@media(max-width:${ switchWidth }px){.${ DESKTOP_DOCUMENT_CLASS }{display:none!important}.${ MOBILE_DOCUMENT_CLASS }{display:contents!important}}`;
}

/**
 * Fallback switch width, used only when the source gave us nothing to detect
 * from. A detected canvas floor is always preferred: the width a document stops
 * adapting at is the source's own switching point, and asserting a phone width
 * on a site whose canvas floor is 980px puts the switch in the wrong place.
 *
 * The mobile document is what the source serves phones, and it was captured
 * at phone width only. From 768px up are tablets, which per-device sources
 * serve their desktop document — the one the fluid sweep observed at 768px.
 */
export const DEFAULT_SWITCH_WIDTH = 767;

function learnedTransformSelectors( html: string ): string[] {
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

function hasLearnedTransform( selectors: string[], segment: string | undefined ): boolean {
	return !!segment && selectors.some( selector => selector.includes( `[data-dla-fluid-segment="${ segment }"]` ) );
}

function withoutTransform( style: string ): string {
	return inlineDeclarations( style )
		.filter( ( declaration ) => declaration.slice( 0, declaration.indexOf( ':' ) ).trim().toLowerCase() !== 'transform' )
		.join( '; ' );
}

/**
 * Attributes DLA's own capture infrastructure writes to mark that two
 * elements correspond across viewports: fluid-learning identities
 * (viewport-prefixed, e.g. `desktop-wrapper-0` vs `mobile-wrapper-0`) and
 * responsive counterpart slots. They cannot exist on the source site and
 * encode correspondence, never difference, so structural equivalence must
 * not read them as one.
 */
const CORRESPONDENCE_ATTRIBUTES = [ 'data-dla-geometry-id', 'data-dla-responsive-source' ];
const STRUCTURAL_SIGNATURE_ATTRIBUTES = new Set( [ 'id', 'href', 'name', 'type', 'for', 'action' ] );
const CAPTURE_GEOMETRY_ID = /^(?:desktop|mobile)-(?:target|wrapper)-\d+/i;
const UUID_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUnstableResponsiveId( id: string ): boolean {
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
function isStableIdentityId( id: string ): boolean {
	return RESPONSIVE_SOURCE_ID.test( id ) && ! isUnstableResponsiveId( id );
}

function childNodes( node: AnyNode ): AnyNode[] {
	return 'children' in node ? node.children : [];
}

/**
 * Whether the source served a genuinely different document under mobile
 * emulation, rather than the same one. The comparison is the element tree,
 * ordering, and structural attributes. Runtime ids, capture infrastructure
 * attributes, all text content, and embed hosts (iframes that hydrated on
 * one viewport and not the other) do not masquerade as a second design.
 * Text is ignored because desktop and mobile captures are taken seconds
 * apart, so any live value — a countdown, a cart count, relative time —
 * would otherwise ship two copies of the same responsive document.
 */
export function documentsDiffer( desktopHtml: string, mobileHtml: string ): boolean {
	const desktopBody = /<body\b([^>]*)>([\s\S]*?)<\/body\s*>/i.exec( desktopHtml )?.[ 2 ];
	const mobileBody = /<body\b([^>]*)>([\s\S]*?)<\/body\s*>/i.exec( mobileHtml )?.[ 2 ];
	if ( desktopBody === undefined || mobileBody === undefined ) return false;
	return responsiveBodySignature( desktopBody ) !== responsiveBodySignature( mobileBody );
}

/**
 * Per-route record of how many responsive documents were exported and why,
 * so downstream consumers and humans can audit the collapse decision from
 * the capture receipt alone. Present only when the source was captured under
 * mobile emulation too — without a second capture there was no decision.
 */
export interface ResponsiveVariantEvidence {
	/** Documents shipped in the exported route file. */
	variants: 1 | 2;
	outcome: 'collapsed-equivalent' | 'collapsed-identity-subset' | 'dual-structural';
	reason: string;
	/** How responsive CSS survives a collapse. Present only when collapsed. */
	css?: 'shared' | 'viewport-scoped';
	/** Elements only the desktop capture rendered, hidden at or below the switch width. Present only for an identity-subset collapse. */
	desktopOnlyElements?: number;
	/** Elements only the mobile capture rendered, inserted under their mapped parent and hidden above the switch width. Present only for an identity-subset collapse. */
	mobileOnlyElements?: number;
	/** Shared components the phone layout re-parents, shipped once per viewport inside the collapsed document. */
	divergedComponents?: number;
	/** Shared elements whose per-viewport inline styles were projected into width-scoped rules. Present only when an equivalent collapse found differing inline styles. */
	projectedInlineStyles?: number;
}

/** Which pair an analysis describes. Source chooses inputs; emitted is what the receipt records. */
type ResponsivePairRole = 'source' | 'emitted';

interface ResolvedResponsivePair {
	role: ResponsivePairRole;
	missingBody: boolean;
	gate?: string;
	/** Reused when this same pair is rendered. Not applied to a different pair. */
	merge?: IdentitySubsetMerge;
	projection?: EquivalentInlineProjection;
	evidence: ResponsiveVariantEvidence;
	dual: boolean;
}

function responsiveBodyContent( html: string ): string | undefined {
	return /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec( html )?.[ 1 ];
}

/**
 * A phone-only body flag can gate the source's desktop width rules. The
 * identity-subset path carries phone classes onto its single body, making a
 * `body:not(.flag)` rule false at desktop widths as well. The two-document
 * output is therefore required whenever a phone-only class actually gates
 * desktop CSS, and both the assembly and the receipt evidence must answer
 * this identically — the receipt describes the shipped file. Returns the
 * first gating class, or undefined when the documents may collapse.
 */
function mobileBodyClassGatesDesktopCss(
	desktopHtml: string,
	mobileHtml: string,
	desktopCss: string
): string | undefined {
	const bodyAttributes = ( html: string ): string => /<body\b([^>]*)>/i.exec( html )?.[ 1 ] ?? '';
	const bodyClasses = ( attributes: string ): string[] =>
		( cheerio.load( `<body${ attributes }></body>` )( 'body' ).attr( 'class' ) ?? '' )
			.split( /\s+/ )
			.filter( Boolean );
	const desktopClasses = new Set( bodyClasses( bodyAttributes( desktopHtml ) ) );
	return bodyClasses( bodyAttributes( mobileHtml ) ).find( ( className ) =>
		! desktopClasses.has( className ) &&
		new RegExp( `\\bbody\\s*:not\\(\\s*\\.${ className.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) }\\s*\\)` ).test( desktopCss )
	);
}

interface IdentitySubsetMerge {
	/** The reconciled single body: the desktop tree plus inserted mobile-only elements. */
	body: string;
	desktopOnlyElements: number;
	mobileOnlyElements: number;
	/** Shared elements whose per-viewport presentation was projected into width-scoped rules. */
	projectedElements: number;
	/** Width-scoped rules carrying each viewport's inline presentation for shared elements. */
	css: string;
	classAliases: Map<string, string>;
	/** Shared components the phone layout re-parents, shipped as one rendering per viewport. */
	divergedComponents: number;
}

/**
 * Split an inline style attribute into declarations, honouring parentheses and
 * quotes so `url(data:…;base64,…)` stays one declaration.
 */
function inlineDeclarations( style: string ): string[] {
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
function importantRule( selector: string, style: string ): string {
	const declarations = inlineDeclarations( style ).map( ( declaration ) =>
		/!\s*important\s*$/i.test( declaration ) ? declaration : `${ declaration }!important`
	);
	return declarations.length > 0 ? `${ selector }{${ declarations.join( ';' ) }}` : '';
}

/**
 * Reconciles two responsive captures into one body keyed on element identity.
 * When the two documents share stable ids and every id-bearing mobile element
 * either exists in the desktop body or is a mobile-only element whose nearest
 * id-bearing ancestor exists there, the mobile document is a re-rendering of
 * the same components — one tree plus width-scoped CSS reproduces both
 * renderings. Mobile-only elements are inserted under their mapped desktop
 * parent (hidden above the switch width); desktop-only elements are kept but
 * hidden at or below it. Any mobile content with no home in the desktop tree —
 * text outside a mapped parent, an id whose parent chain differs between
 * captures, or a mobile-only subtree whose outermost element hangs from no
 * shared ancestor — returns undefined so the caller keeps the two-document
 * output. Mobile-only elements nested inside a mobile-only subtree travel with
 * it. Platform
 * neutral: adapters whose ids are unstable simply fall back.
 */
function identitySubsetMerge(
	desktopHtml: string,
	mobileHtml: string,
	switchWidth: number = DEFAULT_SWITCH_WIDTH
): IdentitySubsetMerge | undefined {
	const desktopBody = responsiveBodyContent( desktopHtml );
	const learnedTransforms = learnedTransformSelectors( desktopHtml );
	const mobileBody = responsiveBodyContent( mobileHtml );
	if ( desktopBody === undefined || mobileBody === undefined ) return undefined;
	// An id a document repeats (a builder's per-instance icon id) names a
	// component template, not one element, so like a runtime id it carries no
	// identity: those elements pair by position under their identified parent.
	const repeated = new Set< string >();
	const load = ( body: string ) => {
		const $ = cheerio.load( `<body>${ body }</body>` );
		const ids = new Map< string, Element >();
		for ( const node of $( '[id]' ).toArray() ) {
			if ( ! isElementNode( node ) ) continue;
			const id = $( node ).attr( 'id' ) ?? '';
			if ( ! isStableIdentityId( id ) ) continue;
			if ( ids.has( id ) ) repeated.add( id );
			ids.set( id, node );
		}
		return { $, ids };
	};
	const isIdentityId = ( id: string ): boolean => isStableIdentityId( id ) && ! repeated.has( id );
	const nearestIdentityId = ( $: cheerio.CheerioAPI, node: AnyNode ): string | undefined => {
		for ( let current = node.parent; current; current = current.parent ) {
			if ( ! isElementNode( current ) ) continue;
			const id = $( current ).attr( 'id' );
			if ( id && isIdentityId( id ) ) return id;
		}
		return undefined;
	};
	const identityChain = ( $: cheerio.CheerioAPI, element: Element ): string[] => {
		const chain: string[] = [];
		for ( let current = element.parent; current; current = current.parent ) {
			if ( ! isElementNode( current ) ) continue;
			const id = $( current ).attr( 'id' );
			if ( id && isIdentityId( id ) ) chain.unshift( id );
		}
		return chain;
	};
	const desktop = load( desktopBody );
	const mobile = load( mobileBody );
	for ( const id of repeated ) {
		desktop.ids.delete( id );
		mobile.ids.delete( id );
	}
	const { $: $d, ids: desktopIds } = desktop;
	const { $: $m, ids: mobileIds } = mobile;
	const classAliases = new Map<string, string>();
	const desktopClassTokens = new Set<string>();
	$d( '[class]' ).each( ( _index, node ) =>
		( $d( node ).attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean ).forEach( ( token ) => desktopClassTokens.add( token ) )
	);
	let unsafeClassAlias = false;
	const bodyClasses = ( html: string ) => {
		const attributes = /<body\b([^>]*)>/i.exec( html )?.[ 1 ] ?? '';
		return ( cheerio.load( `<body${ attributes }></body>` )( 'body' ).attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean );
	};
	const desktopBodyClasses = new Set( bodyClasses( desktopHtml ) );
	for ( const token of bodyClasses( mobileHtml ) ) {
		if ( desktopBodyClasses.has( token ) ) continue;
		if ( desktopClassTokens.has( token ) ) unsafeClassAlias = true;
		classAliases.set( token, `${ RESPONSIVE_PROJECTION_CLASS_PREFIX }class-${ createHash( 'sha256' ).update( token ).digest( 'hex' ).slice( 0, 12 ) }` );
	}
	const mobileOnlyIds: string[] = [];
	const desktopOnlyIds: string[] = [];
	let sharedIdCount = 0;
	for ( const [ id ] of mobileIds ) {
		if ( desktopIds.has( id ) ) sharedIdCount++;
		else mobileOnlyIds.push( id );
	}
	for ( const [ id ] of desktopIds ) if ( ! mobileIds.has( id ) ) desktopOnlyIds.push( id );
	// Without a single shared id there is nothing to anchor one tree to.
	if ( sharedIdCount === 0 ) return undefined;
	// A mobile-only subtree maps when its outermost mobile-only element hangs
	// from a shared ancestor. Mobile-only elements nested inside it (a phone
	// menu's overlay inside the menu) travel with that subtree and need no home
	// of their own; an outermost element with no shared ancestor has none.
	const outermostMobileOnlyIds: string[] = [];
	for ( const id of mobileOnlyIds ) {
		const ancestor = nearestIdentityId( $m, mobileIds.get( id ) as Element );
		if ( ancestor && ! desktopIds.has( ancestor ) && mobileIds.has( ancestor ) ) continue;
		// Without an identified ancestor the element hangs from <body>, which
		// both documents share by construction.
		if ( ancestor && ! desktopIds.has( ancestor ) ) return undefined;
		outermostMobileOnlyIds.push( id );
	}
	// The same id must hang from the same shared ancestors in both captures, or
	// the documents nest their components differently and one tree cannot serve
	// both. A wrapper only one capture renders (a desktop transition layer) is
	// not a nesting difference: it stays in the tree, hidden on the other side.
	const shared = ( id: string ): boolean => desktopIds.has( id ) && mobileIds.has( id );
	for ( const [ id, desktopElement ] of desktopIds ) {
		if ( ! mobileIds.has( id ) ) continue;
		const desktopChain = identityChain( $d, desktopElement ).filter( shared );
		const mobileChain = identityChain( $m, mobileIds.get( id ) as Element ).filter( shared );
		if (
			desktopChain.length !== mobileChain.length ||
			desktopChain.some( ( value, index ) => value !== mobileChain[ index ] )
		)
			return undefined;
	}
	// Text the mobile capture rendered must live inside a mapped parent, or the
	// documents carry different content and collapsing would drop it. Script
	// and style bodies are not content.
	const unmappedText = ( node: AnyNode ): boolean => {
		for ( const child of childNodes( node ) ) {
			if ( child.type === 'text' ) {
				if ( ( child.data ?? '' ).trim() !== '' && nearestIdentityId( $m, child ) === undefined )
					return true;
			} else if (
				isElementNode( child ) &&
				child.tagName !== 'script' &&
				child.tagName !== 'style' &&
				child.tagName !== 'noscript' &&
				unmappedText( child )
			)
				return true;
		}
		return false;
	};
	if ( unmappedText( $m.root()[ 0 ] ) ) return undefined;

	// A desktop-only wrapper around shared components must keep rendering on
	// mobile, or hiding it would hide them too; only leaf-side desktop-only
	// elements are hidden at or below the switch width.
	let hiddenDesktopOnly = 0;
	for ( const id of desktopOnlyIds ) {
		const element = $d( desktopIds.get( id ) as Element );
		const wrapsShared = element
			.find( '[id]' )
			.toArray()
			.some( ( node ) => shared( $d( node ).attr( 'id' ) ?? '' ) );
		if ( wrapsShared ) continue;
		element.addClass( RESPONSIVE_DESKTOP_ONLY_CLASS );
		hiddenDesktopOnly++;
	}
	// A mobile-only element's real parent is often id-less (a mesh grid
	// container whose rules place children with `> [id=…]`), so it goes under
	// the desktop element at the same path below the shared ancestor. Each step
	// resolves by an identical class list or, failing that, the same tag at the
	// same position among id-less siblings; an unresolvable path keeps both
	// documents rather than misplacing the element.
	type Insertion = { parent: cheerio.Cheerio< Element >; index: number; html: string };
	const idlessChildren = ( $: cheerio.CheerioAPI, node: cheerio.Cheerio< Element > ) =>
		node
			.children()
			.toArray()
			.filter( ( child ) => ! $( child ).attr( 'id' ) );
	const insertions: Insertion[] = [];
	for ( const id of outermostMobileOnlyIds ) {
		const mobileElement = mobileIds.get( id ) as Element;
		const ancestorId = nearestIdentityId( $m, mobileElement );
		const path: Element[] = [];
		for ( let current = mobileElement.parent; current; current = current.parent ) {
			if ( ! isElementNode( current ) ) continue;
			if ( ancestorId ? $m( current ).attr( 'id' ) === ancestorId : current.tagName === 'body' ) break;
			path.unshift( current );
		}
		let parent = ancestorId ? $d( desktopIds.get( ancestorId ) as Element ) : $d( 'body' );
		let mobileParent = ancestorId ? $m( mobileIds.get( ancestorId ) as Element ) : $m( 'body' );
		for ( const step of path ) {
			const candidates = idlessChildren( $d, parent ).filter( ( child ) => child.tagName === step.tagName );
			const mobileSiblings = idlessChildren( $m, mobileParent ).filter(
				( child ) => child.tagName === step.tagName
			);
			const stepClass = $m( step ).attr( 'class' ) ?? '';
			const byClass = candidates.filter( ( child ) => ( $d( child ).attr( 'class' ) ?? '' ) === stepClass );
			const match =
				byClass.length === 1
					? byClass[ 0 ]
					: candidates.length === mobileSiblings.length
					? candidates[ mobileSiblings.indexOf( step ) ]
					: undefined;
			if ( ! match ) return undefined;
			parent = $d( match );
			mobileParent = $m( step );
		}
		const element = $m( mobileElement );
		element.addClass( RESPONSIVE_MOBILE_ONLY_CLASS );
		insertions.push( { parent, index: element.index(), html: $m.html( element ) ?? '' } );
	}
	// Descending sibling positions keep earlier insertions from shifting a
	// later one's reference child.
	insertions.sort( ( a, b ) => b.index - a.index );
	for ( const insertion of insertions ) {
		const parent = insertion.parent;
		const children = parent.children();
		if ( insertion.index < children.length ) children.eq( insertion.index ).before( insertion.html );
		else parent.append( insertion.html );
	}
	// One element now serves both viewports, but each capture rendered it with
	// its own presentation: a builder rescales text for phones through inline
	// styles on id-less descendants, too. Walk each shared component's subtree
	// in parallel while the two captures agree on structure and project every
	// difference instead of keeping only the desktop's. Class tokens union
	// (each capture's class rules are already scoped to its side of the
	// switch), and an image's `sizes` answers per viewport.
	const desktopRules: string[] = [];
	const mobileRules: string[] = [];
	let projectedElements = 0;
	// A shared component the two captures hold under different id-less
	// containers (a form field a phone layout moves into its own row) is
	// re-parented, not restyled; one tree cannot render both placements. The
	// walk records the shared component it started from, and only that
	// component ships once per viewport.
	const divergedRoots = new Set< string >();
	const sharedIdsIn = ( $: cheerio.CheerioAPI, node: Element ): string =>
		$( node )
			.find( '[id]' )
			.toArray()
			.map( ( child ) => $( child ).attr( 'id' ) ?? '' )
			.filter( ( id ) => shared( id ) )
			.sort()
			.join( ' ' );
	// Hook names derive from where an element sits below its nearest shared
	// component, never from document order, so chrome repeated on every route
	// serializes identically and stays recognizable as shared downstream.
	const projectPair = (
		d: cheerio.Cheerio< Element >,
		m: cheerio.Cheerio< Element >,
		path: string
	): void => {
		let projected = false;
		const desktopStyle = d.attr( 'style' ) ?? '';
		const mobileStyle = m.attr( 'style' ) ?? '';
		if ( desktopStyle.trim() !== mobileStyle.trim() ) {
			const desktopSegment = d.attr( 'data-dla-fluid-segment' );
			const projectedMobileStyle = hasLearnedTransform( learnedTransforms, desktopSegment )
				? withoutTransform( mobileStyle )
				: mobileStyle;
			const id = d.attr( 'id' );
			let selector: string;
			if ( id && isIdentityId( id ) ) selector = `#${ id }`;
			else {
				const hook = `${ RESPONSIVE_PROJECTION_CLASS_PREFIX }${ createHash( 'sha256' )
					.update( path )
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
			// Mobile-only class names must not meet desktop rules in the merged DOM.
			const aliases = missing.map( ( token ) => {
				if ( desktopClassTokens.has( token ) ) unsafeClassAlias = true;
				const alias = classAliases.get( token ) ?? `${ RESPONSIVE_PROJECTION_CLASS_PREFIX }class-${ createHash( 'sha256' ).update( token ).digest( 'hex' ).slice( 0, 12 ) }`;
				classAliases.set( token, alias );
				return alias;
			} );
			d.attr( 'class', [ ...( d.attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean ), ...aliases ].join( ' ' ) );
			projected = true;
		}
		const desktopSizes = d.attr( 'sizes' );
		const mobileSizes = m.attr( 'sizes' );
		if ( desktopSizes && mobileSizes && desktopSizes !== mobileSizes ) {
			d.attr( 'sizes', `(max-width:${ switchWidth }px) ${ mobileSizes }, ${ desktopSizes }` );
			projected = true;
		}
		if ( projected ) projectedElements++;
		// Descend through id-less children only while both captures agree on
		// their shape; id-bearing children are paired by identity on their own.
		// Components only one capture rendered are placed by identity, not by
		// position, so they sit outside the positional pairing.
		const paired = ( $: cheerio.CheerioAPI ) => ( child: Element ): boolean => {
			const childId = $( child ).attr( 'id' );
			return ! childId || ! isIdentityId( childId ) || shared( childId );
		};
		const desktopChildren = d.children().toArray().filter( paired( $d ) );
		const mobileChildren = m.children().toArray().filter( paired( $m ) );
		// A child that contains an identified component pairs with the child
		// holding the same component (a form grid whose phone layout drops
		// cells); otherwise align in document order: each mobile child pairs
		// with the next desktop child of the same tag and class list, so a
		// sibling only one capture rendered (a lightbox trigger, a hover layer)
		// does not stop the walk for the siblings both rendered.
		const anchorOf = ( $: cheerio.CheerioAPI, child: Element ): string | undefined =>
			$( child )
				.find( '[id]' )
				.toArray()
				.map( ( node ) => $( node ).attr( 'id' ) ?? '' )
				.find( ( id ) => shared( id ) );
		const desktopAnchors = desktopChildren.map( ( child ) => anchorOf( $d, child as Element ) );
		let cursor = 0;
		for ( const mobileChild of mobileChildren ) {
			const mobileAnchor = anchorOf( $m, mobileChild );
			const mobileClass = $m( mobileChild ).attr( 'class' ) ?? '';
			let match = mobileAnchor ? desktopAnchors.indexOf( mobileAnchor ) : -1;
			if ( match >= 0 && ( desktopChildren[ match ] as Element ).tagName !== mobileChild.tagName ) match = -1;
			for ( let index = cursor; match < 0 && index < desktopChildren.length; index++ ) {
				const candidate = desktopChildren[ index ] as Element;
				if ( desktopAnchors[ index ] && mobileAnchor !== desktopAnchors[ index ] ) continue;
				if ( candidate.tagName !== mobileChild.tagName ) continue;
				if ( ( $d( candidate ).attr( 'class' ) ?? '' ) !== mobileClass && desktopChildren.length !== mobileChildren.length )
					continue;
				match = index;
			}
			if ( match < 0 ) continue;
			cursor = match + 1;
			const desktopChild = desktopChildren[ match ] as Element;
			if ( sharedIdsIn( $d, desktopChild ) !== sharedIdsIn( $m, mobileChild ) ) {
				divergedRoots.add( path.split( '/' )[ 0 ] as string );
				continue;
			}
			const childId = $d( desktopChild ).attr( 'id' );
			if ( childId && isIdentityId( childId ) ) continue;
			projectPair( $d( desktopChild ), $m( mobileChild ), `${ path }/${ match }` );
		}
	};
	for ( const [ id, desktopElement ] of desktopIds ) {
		const mobileElement = mobileIds.get( id );
		if ( mobileElement ) projectPair( $d( desktopElement ), $m( mobileElement ), id );
	}
	if ( unsafeClassAlias ) return undefined;
	const divergedComponents = splitDivergedComponents( $d, $m, divergedRoots, desktopIds, mobileIds );
	if ( divergedComponents === undefined ) return undefined;
	$d( '[class]' ).each( ( _index, node ) => {
		const element = $d( node );
		element.attr( 'class', ( element.attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean ).map( ( token ) => classAliases.get( token ) ?? token ).join( ' ' ) );
	} );
	const css =
		( desktopRules.length > 0
			? `@media(min-width:${ switchWidth + 1 }px){${ desktopRules.join( '' ) }}`
			: '' ) +
		( mobileRules.length > 0 ? `@media(max-width:${ switchWidth }px){${ mobileRules.join( '' ) }}` : '' );
	return {
		body: $d( 'body' ).html() ?? desktopBody,
		desktopOnlyElements: hiddenDesktopOnly,
		mobileOnlyElements: insertions.length,
		projectedElements,
		css,
		classAliases,
		divergedComponents,
	};
}

interface EquivalentInlineProjection {
	/** The projected desktop body: hook classes added, moved inline styles removed. */
	body: string;
	/** Width-scoped rules carrying each viewport's inline presentation. */
	css: string;
	projectedElements: number;
}

/**
 * Nodes the body signature never sees cannot have moved the alignment between
 * two structurally equivalent captures: embed hosts and media a runtime may
 * render differently per viewport, inert script and style, runtime-id
 * elements, comments, and attribute-less empty mount divs/spans (which the
 * signature strips after dropping non-structural attributes).
 */
const SIGNATURE_TRANSPARENT_TAGS = new Set( [
	'script',
	'style',
	'noscript',
	'iframe',
	'svg',
	'map',
	'area',
	'picture',
	'source',
	'img',
	'canvas',
	'slot',
] );

/**
 * Projects per-element inline presentation differences between two
 * structurally equivalent responsive captures into width-scoped rules, the
 * same projection an identity-subset collapse applies to shared components.
 * The signature that decided the collapse compares structure, never style
 * attributes, so equivalent trees can still carry per-viewport inline
 * geometry — keeping only the desktop body would silently freeze mobile at
 * the desktop value. Both trees are walked in parallel positionally, ignoring
 * exactly the nodes the signature ignores; a `#id` selector stands when both
 * captures share one stable id unique in the document, otherwise a
 * deterministic hook class names the element. Any structural disagreement —
 * the alignment guarantee the signature provides, re-checked while walking —
 * returns undefined so the caller keeps the unprojected desktop body. Like
 * `projectPair`, identical inline styles project nothing, a desktop inline
 * style stays inline when mobile restates every property it sets, and a
 * desktop property mobile never states moves both sides into width-scoped
 * rules rather than leaking onto phones.
 */
function equivalentInlineProjection(
	desktopHtml: string,
	mobileHtml: string,
	switchWidth: number = DEFAULT_SWITCH_WIDTH
): EquivalentInlineProjection | undefined {
	const desktopBody = responsiveBodyContent( desktopHtml );
	const learnedTransforms = learnedTransformSelectors( desktopHtml );
	const mobileBody = responsiveBodyContent( mobileHtml );
	if ( desktopBody === undefined || mobileBody === undefined ) return undefined;
	const $d = cheerio.load( `<body>${ desktopBody }</body>` );
	const $m = cheerio.load( `<body>${ mobileBody }</body>` );
	const transparent = ( $: cheerio.CheerioAPI, node: AnyNode ): boolean => {
		if ( ! isElementNode( node ) ) return true;
		if ( SIGNATURE_TRANSPARENT_TAGS.has( node.tagName ) ) return true;
		const id = $( node ).attr( 'id' );
		if ( id && isYuiRuntimeId( id ) ) return true;
		if ( node.tagName !== 'div' && node.tagName !== 'span' ) return false;
		for ( const attribute of Object.keys( node.attribs ?? {} ) ) {
			if ( attribute === 'id' || attribute === 'name' ) {
				const value = $( node ).attr( attribute ) ?? '';
				// An unstable value is dropped from the signature, so it cannot
				// make the element structural; a stable one does.
				if ( value && ! isUnstableResponsiveId( value ) ) return false;
				continue;
			}
			if ( STRUCTURAL_SIGNATURE_ATTRIBUTES.has( attribute ) ) return false;
		}
		// An attribute-less mount disappears from the signature once everything
		// it wraps is transparent too — including their text, which leaves with
		// the removed subtrees — and the mount itself carries only whitespace.
		return childNodes( node ).every(
			( child ) =>
				transparent( $, child ) && ( child.type !== 'text' || ( child.data ?? '' ).trim() === '' )
		);
	};
	// An id the desktop body repeats would pair `#id` with the first match
	// instead of this element, so only a unique stable id may stand in a rule.
	const idCounts = new Map< string, number >();
	for ( const node of $d( '[id]' ).toArray() ) {
		if ( ! isElementNode( node ) ) continue;
		const id = $d( node ).attr( 'id' ) ?? '';
		if ( ! isStableIdentityId( id ) ) continue;
		idCounts.set( id, ( idCounts.get( id ) ?? 0 ) + 1 );
	}
	const desktopRules: string[] = [];
	const mobileRules: string[] = [];
	let projectedElements = 0;
	let aligned = true;
	const visibleChildren = ( $: cheerio.CheerioAPI, element: Element ): Element[] =>
		childNodes( element ).filter(
			( child ): child is Element => isElementNode( child ) && ! transparent( $, child )
		);
	const project = (
		d: cheerio.Cheerio< Element >,
		m: cheerio.Cheerio< Element >,
		path: string
	): void => {
		let projected = false;
		const desktopStyle = d.attr( 'style' ) ?? '';
		const mobileStyle = m.attr( 'style' ) ?? '';
		if ( desktopStyle.trim() !== mobileStyle.trim() ) {
			const desktopSegment = d.attr( 'data-dla-fluid-segment' );
			const projectedMobileStyle = hasLearnedTransform( learnedTransforms, desktopSegment )
				? withoutTransform( mobileStyle )
				: mobileStyle;
			const id = d.attr( 'id' );
			let selector: string;
			if ( id && isStableIdentityId( id ) && idCounts.get( id ) === 1 ) selector = `#${ id }`;
			else {
				const hook = `${ RESPONSIVE_PROJECTION_CLASS_PREFIX }${ createHash( 'sha256' )
					.update( path )
					.digest( 'hex' )
					.slice( 0, 12 ) }`;
				d.addClass( hook );
				selector = `.${ hook }`;
			}
			const property = ( declaration: string ) =>
				declaration.slice( 0, declaration.indexOf( ':' ) ).trim().toLowerCase();
			const desktopDeclarations = inlineDeclarations( desktopStyle );
			const mobileProperties = new Set( inlineDeclarations( projectedMobileStyle ).map( property ) );
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
		if ( projected ) projectedElements++;
		const desktopChildren = visibleChildren( $d, d.get( 0 ) as Element );
		const mobileChildren = visibleChildren( $m, m.get( 0 ) as Element );
		if ( desktopChildren.length !== mobileChildren.length ) {
			aligned = false;
			return;
		}
		for ( let index = 0; index < desktopChildren.length; index++ ) {
			const desktopChild = desktopChildren[ index ];
			const mobileChild = mobileChildren[ index ];
			if ( desktopChild.tagName !== mobileChild.tagName ) {
				aligned = false;
				return;
			}
			const childPath = `${ path }/${ index }`;
			project( $d( desktopChild ), $m( mobileChild ), childPath );
			if ( ! aligned ) return;
		}
	};
	const desktopTop = visibleChildren( $d, $d( 'body' ).get( 0 ) as Element );
	const mobileTop = visibleChildren( $m, $m( 'body' ).get( 0 ) as Element );
	if ( desktopTop.length !== mobileTop.length ) return undefined;
	for ( let index = 0; index < desktopTop.length; index++ ) {
		if ( desktopTop[ index ].tagName !== mobileTop[ index ].tagName ) return undefined;
		project( $d( desktopTop[ index ] ), $m( mobileTop[ index ] ), `body/${ index }` );
		if ( ! aligned ) return undefined;
	}
	if ( projectedElements === 0 ) return undefined;
	const css =
		( desktopRules.length > 0
			? `@media(min-width:${ switchWidth + 1 }px){${ desktopRules.join( '' ) }}`
			: '' ) +
		( mobileRules.length > 0 ? `@media(max-width:${ switchWidth }px){${ mobileRules.join( '' ) }}` : '' );
	return {
		body: $d( 'body' ).html() ?? desktopBody,
		css,
		projectedElements,
	};
}

function aliasResponsiveClasses( css: string, aliases: ReadonlyMap<string, string> ): string {
	if ( aliases.size === 0 ) return css;
	try {
		const root = postcss.parse( css );
		root.walkRules( ( rule ) => {
			rule.selector = selectorParser( ( selectors ) => {
				selectors.walkClasses( ( node ) => {
					const alias = aliases.get( node.value );
					if ( alias ) node.value = alias;
				} );
			} ).processSync( rule.selector );
		} );
		return root.toString();
	} catch {
		return css;
	}
}

/** Attributes that name other elements by id, so a renamed subtree keeps its own references. */
const ID_REFERENCE_ATTRIBUTES = [ 'for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'list', 'form', 'headers' ];

/**
 * Ship each re-parented shared component once per viewport: the desktop
 * rendering stays in place and is hidden at phone width, and the phone
 * rendering follows it, hidden above the switch. The phone copy's ids take the
 * `--dla-mobile` suffix, like a phone document's, and its references within
 * the copy follow them. Nested diverged components travel with their outermost
 * one. A component whose ids a link or anchor targets cannot be renamed
 * without moving that target, so the whole page stays dual instead.
 *
 * Returns the number of split components, or undefined to keep both documents.
 */
function splitDivergedComponents(
	$d: cheerio.CheerioAPI,
	$m: cheerio.CheerioAPI,
	roots: Set< string >,
	desktopIds: Map< string, Element >,
	mobileIds: Map< string, Element >
): number | undefined {
	if ( roots.size === 0 ) return 0;
	const outermost = [ ...roots ].filter( ( id ) => {
		const element = desktopIds.get( id );
		return element !== undefined && ! [ ...roots ].some( ( other ) => other !== id && $d( desktopIds.get( other ) as Element ).find( element ).length > 0 );
	} );
	const linkedFragments = new Set< string >();
	for ( const $ of [ $d, $m ] ) {
		$( 'a[href*="#"]' ).each( ( _index, link ) => {
			const href = $( link ).attr( 'href' ) ?? '';
			try {
				linkedFragments.add( decodeURIComponent( href.slice( href.indexOf( '#' ) + 1 ) ) );
			} catch {
				// An undecodable fragment targets nothing.
			}
		} );
	}
	for ( const id of outermost ) {
		const desktop = $d( desktopIds.get( id ) as Element );
		const mobileElement = mobileIds.get( id );
		if ( ! mobileElement ) return undefined;
		const mobile = $m( mobileElement ).clone();
		const idsIn = ( node: cheerio.Cheerio< Element >, $: cheerio.CheerioAPI ) => [ node, ...node.find( '[id]' ).toArray().map( ( child ) => $( child ) ) ].map( ( n ) => n.attr( 'id' ) ?? '' ).filter( Boolean );
		const targeted = ( node: cheerio.Cheerio< Element >, $: cheerio.CheerioAPI ) =>
			node.is( '[data-dla-anchor-target]' ) || node.find( '[data-dla-anchor-target]' ).length > 0 || idsIn( node, $ ).some( ( value ) => linkedFragments.has( value ) );
		if ( targeted( desktop, $d ) || targeted( $m( mobileElement ), $m ) ) return undefined;
		const renamed = new Map< string, string >();
		for ( const node of [ mobile, ...mobile.find( '[id]' ).toArray().map( ( child ) => $m( child ) ) ] ) {
			const value = node.attr( 'id' );
			if ( ! value ) continue;
			renamed.set( value, `${ value }--dla-mobile` );
			node.attr( 'id', `${ value }--dla-mobile` );
		}
		for ( const node of [ mobile, ...mobile.find( '*' ).toArray().map( ( child ) => $m( child ) ) ] ) {
			for ( const attribute of ID_REFERENCE_ATTRIBUTES ) {
				const value = node.attr( attribute );
				if ( value === undefined ) continue;
				node.attr( attribute, value.split( /\s+/ ).map( ( token ) => renamed.get( token ) ?? token ).join( ' ' ) );
			}
		}
		// Phone-only elements the merge placed inside the desktop rendering
		// already live in the phone copy.
		desktop.find( `.${ RESPONSIVE_MOBILE_ONLY_CLASS }` ).remove();
		desktop.addClass( RESPONSIVE_DESKTOP_ONLY_CLASS );
		mobile.removeClass( RESPONSIVE_DESKTOP_ONLY_CLASS ).addClass( RESPONSIVE_MOBILE_ONLY_CLASS );
		desktop.after( $m.html( mobile ) ?? '' );
	}
	return outermost.length;
}

/**
 * The mobile capture's body classes (a builder's device flag such as
 * `device-mobile-optimized`) are what its stylesheet keys on. Its rules are
 * already scoped to the mobile side of the switch, so the single body carries
 * both captures' classes.
 */
function withBodyClasses( openTag: string, mobileBodyAttributes: string, aliases: ReadonlyMap<string, string> = new Map() ): string {
	const mobileClasses = (
		cheerio.load( `<body${ mobileBodyAttributes }></body>` )( 'body' ).attr( 'class' ) ?? ''
	)
		.split( /\s+/ )
		.filter( Boolean )
		.map( ( token ) => aliases.get( token ) ?? token );
	if ( mobileClasses.length === 0 ) return openTag;
	const $ = cheerio.load( `${ openTag }</body>` );
	const body = $( 'body' );
	const classes = ( body.attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean );
	body.attr( 'class', [ ...new Set( [ ...classes, ...mobileClasses ] ) ].join( ' ' ) );
	return /<body\b[^>]*>/i.exec( $.html() )?.[ 0 ] ?? openTag;
}

/** Width-scoped visibility for elements only one side of the switch renders. */
function identitySubsetVisibilityCss( switchWidth: number ): string {
	return (
		`<style>@media(min-width:${ switchWidth + 1 }px){.${ RESPONSIVE_MOBILE_ONLY_CLASS }{display:none!important}}` +
		`@media(max-width:${ switchWidth }px){.${ RESPONSIVE_DESKTOP_ONLY_CLASS }{display:none!important}}</style>`
	);
}

/**
 * Entrance animations a builder starts from script cannot run in a captured
 * document, because capture strips the script. Re-bind them to the scroll
 * timeline so the authored motion survives.
 */
function withScrollDrivenAnimations( html: string ): string {
	const sourceCss = styleBlocks( html ).join( '\n' );
	if ( sourceCss === '' ) return html;
	const override = appendScrollDrivenAnimations( '', sourceCss );
	if ( override === '' ) return html;
	return /<\/head\s*>/i.test( html )
		? html.replace( /<\/head\s*>/i, `<style>${ override }</style></head>` )
		: `${ html }<style>${ override }</style>`;
}

function responsiveHtml(
	desktopHtml: string,
	mobileHtml: string,
	switchWidth: number,
	resolved: ResolvedResponsivePair,
	bindingGate?: string
): { html: string; evidence: ResponsiveVariantEvidence } {
	const assembled = assembleResponsiveHtml( desktopHtml, mobileHtml, switchWidth, resolved, bindingGate );
	return {
		html: withScrollDrivenAnimations( withMobileLinkedStyles( assembled.html, mobileHtml, switchWidth ) ),
		evidence: assembled.evidence,
	};
}

export type ResponsivePortableNormalization = 'absent' | 'applied' | 'pending';

export interface ResponsiveAssemblyInput {
	/** Captured desktop document, before portable rendering normalization. */
	rawDesktopHtml: string;
	/** Captured mobile document. Absent when mobile was not captured. */
	rawMobileHtml?: string;
	/** Desktop after rendering normalization and declarative form embeds. */
	portableDesktopHtml: string;
	/** Mobile after the same portable normalization. */
	portableMobileHtml?: string;
	switchWidth?: number;
}

export interface ResponsiveAssembly {
	/**
	 * Assembled HTML. When `portableNormalization` is `pending`, this is the raw
	 * assembly and still needs rendering normalization plus declarative form embeds.
	 */
	html: string;
	evidence?: ResponsiveVariantEvidence;
	hasMobileDocument: boolean;
	portableNormalization: ResponsivePortableNormalization;
}

/**
 * Resolve one responsive assembly.
 *
 * `source` is the raw capture pair. It chooses the documents to assemble and
 * owns a binding phone-only body-class gate. A raw collapse is rendered from
 * that same analysis. A raw structural dual assembles the portable pair, and
 * `emitted` is the analysis of that different pair — the receipt describes
 * what that render produced, not the source classification. A missing body
 * ships the desktop document alone.
 */
export function assembleResponsiveCapture( input: ResponsiveAssemblyInput ): ResponsiveAssembly {
	const switchWidth = input.switchWidth ?? DEFAULT_SWITCH_WIDTH;
	if ( input.rawMobileHtml === undefined ) {
		return {
			html: input.portableDesktopHtml,
			hasMobileDocument: false,
			portableNormalization: 'absent',
		};
	}
	const portableMobileHtml = input.portableMobileHtml ?? input.rawMobileHtml;
	const source = resolveResponsivePair( input.rawDesktopHtml, input.rawMobileHtml, switchWidth, 'source' );
	if ( source.gate ) {
		const assembled = responsiveHtml(
			input.portableDesktopHtml,
			portableMobileHtml,
			switchWidth,
			source,
			source.gate
		);
		return emittedAssembly( assembled, 'applied' );
	}
	if ( source.dual ) {
		const emitted = resolveResponsivePair(
			input.portableDesktopHtml,
			portableMobileHtml,
			switchWidth,
			'emitted'
		);
		return emittedAssembly(
			responsiveHtml( input.portableDesktopHtml, portableMobileHtml, switchWidth, emitted ),
			'applied'
		);
	}
	return emittedAssembly(
		responsiveHtml( input.rawDesktopHtml, input.rawMobileHtml, switchWidth, source ),
		'pending'
	);
}

function emittedAssembly(
	assembled: { html: string; evidence: ResponsiveVariantEvidence },
	portableNormalization: 'applied' | 'pending'
): ResponsiveAssembly {
	return {
		html: assembled.html,
		evidence: assembled.evidence,
		hasMobileDocument: assembled.evidence.outcome === 'dual-structural' && assembled.evidence.variants === 2,
		portableNormalization,
	};
}

function withMobileLinkedStyles( html: string, mobileHtml: string, switchWidth: number ): string {
	const mobileHead = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec( mobileHtml )?.[ 1 ];
	if ( ! mobileHead || ! /<link\b/i.test( mobileHead ) ) return html;
	return html.replace( /(<head\b[^>]*>)([\s\S]*?)(<\/head\s*>)/i, ( _match, open: string, head: string, close: string ) => {
		const $ = cheerio.load( head, undefined, false );
		const mobile = cheerio.load( mobileHead, undefined, false );
		const selector = 'style,link[rel~="stylesheet" i][href]:not([rel~="alternate" i]):not([disabled])';
		const key = ( node: cheerio.Cheerio< AnyNode > ): string =>
			node.is( 'style' )
				? `style:${ node.html()?.trim() }`
				: `link:${ node.attr( 'href' ) }:${ node.attr( 'media' ) ?? '' }`;
		const existing = new Map< string, cheerio.Cheerio< AnyNode > >(
			$( selector ).toArray().map( node => [ key( $( node ) ), $( node ) ] )
		);
		const mobileStyles = mobile( selector ).toArray();
		for ( let index = 0; index < mobileStyles.length; index++ ) {
			const link = mobile( mobileStyles[ index ] );
			if ( ! link.is( 'link' ) || ! link.attr( 'href' ) || existing.has( key( link ) ) ) continue;
			// Separate media gates preserve query lists and negated source media without
			// rewriting their logic. The import is localized by the normal resource pass.
			const href = JSON.stringify( link.attr( 'href' ) ).replace( /</g, '\\3c ' );
			const style = $( '<style>' )
				.attr( 'media', link.attr( 'media' ) ?? 'all' )
				.text( `@import url(${ href }) (max-width:${ switchWidth }px);` );
			const following = mobileStyles.slice( index + 1 )
				.map( node => existing.get( key( mobile( node ) ) ) ).find( Boolean );
			const preceding = mobileStyles.slice( 0, index ).reverse()
				.map( node => existing.get( key( mobile( node ) ) ) ).find( Boolean );
			if ( following ) following.before( style );
			else if ( preceding ) preceding.after( style );
			else $.root().append( style );
			existing.set( key( link ), style );
		}
		return `${ open }${ $.html() }${ close }`;
	} );
}

/**
 * Marks corresponding editable leaves from source identity, without comparing
 * their content or visual geometry. The nearest unique source id owns a leaf's
 * tag-relative slot even when the two responsive documents wrap it differently.
 */
function markResponsiveCounterparts(
	desktopBody: string,
	mobileBody: string
): { desktopBody: string; mobileBody: string } {
	if ( ! /\sid\s*=\s*["']/i.test( desktopBody ) || ! /\sid\s*=\s*["']/i.test( mobileBody ) )
		return { desktopBody, mobileBody };
	type Candidate = { node: Element; source: string };
	const collect = ( body: string ) => {
		const $ = cheerio.load( `<body>${ body }</body>` );
		const idCounts = new Map< string, number >();
		$( '[id]' ).each( ( _index, element ) => {
			const id = $( element ).attr( 'id' ) ?? '';
			if ( RESPONSIVE_SOURCE_ID.test( id ) ) idCounts.set( id, ( idCounts.get( id ) ?? 0 ) + 1 );
		} );
		const slots = new Map< string, number >();
		const candidates = new Map< string, Candidate >();
		$( RESPONSIVE_COUNTERPART_TAGS ).each( ( _index, element ) => {
			const node = $( element );
			const owner = node.closest( '[id]' );
			const sourceId = owner.attr( 'id' ) ?? '';
			if ( idCounts.get( sourceId ) !== 1 ) return;
			const tag = element.name.toLowerCase();
			const slotKey = `${ sourceId }\0${ tag }`;
			const slot = ( slots.get( slotKey ) ?? 0 ) + 1;
			slots.set( slotKey, slot );
			const source = `${ sourceId }:${ tag }:${ slot }`;
			candidates.set( source, { node: element, source } );
		} );
		return { $, candidates };
	};

	const desktop = collect( desktopBody );
	const mobile = collect( mobileBody );
	for ( const [ source, desktopCandidate ] of desktop.candidates ) {
		const mobileCandidate = mobile.candidates.get( source );
		if ( ! mobileCandidate ) continue;
		const token = `${ RESPONSIVE_COUNTERPART_CLASS_PREFIX }${ createHash( 'sha256' )
			.update( `mobile\0${ source }` )
			.digest( 'hex' )
			.slice( 0, 12 ) }`;
		for ( const [ $, candidate ] of [
			[ desktop.$, desktopCandidate ],
			[ mobile.$, mobileCandidate ],
		] as const ) {
			const node = $( candidate.node );
			node.addClass( token );
			node.attr( 'data-dla-responsive-source', candidate.source );
		}
	}
	return {
		desktopBody: desktop.$( 'body' ).html() ?? desktopBody,
		mobileBody: mobile.$( 'body' ).html() ?? mobileBody,
	};
}

/**
 * A captured dialog wired into the phone document (for example the opened phone
 * menu) is added after responsive assembly namespaced that document's anchors,
 * so its section links still name the desktop targets, which are hidden at
 * phone width. Point each same-page fragment link inside the phone document at
 * the phone copy of the section the desktop target resolved to.
 */
const RESPONSIVE_FRAGMENT_RUNTIME = `(function(){
function resolve(){var fragment;try{fragment=decodeURIComponent(location.hash.slice(1));}catch(_){return;}
var targets=Array.prototype.filter.call(document.querySelectorAll('[data-dla-responsive-fragment]'),function(el){return el.getAttribute('data-dla-responsive-fragment')===fragment&&el.getClientRects().length;});
if(targets.length===1)targets[0].scrollIntoView();}
function schedule(){requestAnimationFrame(resolve);}
window.addEventListener('hashchange',schedule);
document.addEventListener('click',function(event){var link=event.target.closest&&event.target.closest('a[href]');if(!link)return;var url;try{url=new URL(link.href);}catch(_){return;}if(url.origin===location.origin&&url.pathname===location.pathname&&url.hash)schedule();});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',schedule);else schedule();
})();`;

export function projectResponsiveIdentityCss( source: string, renamed: ReadonlyMap<string,string>, namedAliases: boolean ): string {
	// CSS accepts legacy HTML-comment wrappers; PostCSS rejects the closing CDC.
	// Strip only outer tokens, preserving quoted content inside the stylesheet.
	const css = postcss.parse( source.replace( /^\s*<!--/, '' ).replace( /-->\s*$/, '' ) );
	css.walkRules( rule => {
		const selectors = selectorParser().astSync( rule.selector );
		const replacements: Array<{ node: selectorParser.Identifier | selectorParser.Attribute; alias: selectorParser.Identifier | selectorParser.Attribute }> = [];
		selectors.walkIds( id => { const value = renamed.get( id.value ); if ( value ) { const alias = id.clone(); alias.value = value; replacements.push( { node: id, alias } ); } } );
		if ( namedAliases ) selectors.walkAttributes( attribute => { if ( attribute.attribute === 'name' ) { const alias = attribute.clone(); alias.attribute = 'data-dla-anchor-alias'; replacements.push( { node: attribute, alias } ); } } );
		for ( const { node, alias } of replacements ) node.replaceWith( selectorParser.pseudo( { value: ':is', nodes: [
			selectorParser.selector( { value: '', nodes: [ node.clone() ] } ), selectorParser.selector( { value: '', nodes: [ alias ] } ),
		] } ) );
		rule.selector = selectors.toString();
	} );
	return css.toString();
}

export function routePhoneDocumentFragments( html: string, documentPath: string, identities?: { ids: Map<string,string>; namedAliases: boolean } ): string {
	// Named aliases need reconciliation even when the responsive source
	// collapsed to a single document. Preserve the cheap path for other pages.
	if ( ! html.includes( MOBILE_DOCUMENT_CLASS ) && ! /<a\b[^>]*\bname\s*=/i.test( html ) ) return html;
	const $ = cheerio.load( html );
	const mobile = $( `.${ MOBILE_DOCUMENT_CLASS }` ).first();
	const sourceIds = new Map< string, string >();
	$( `.${ DESKTOP_DOCUMENT_CLASS } [data-dla-anchor-target][data-dla-anchor-source-id]` ).each( ( _index, element ) => {
		const fragment = $( element ).attr( 'data-dla-anchor-target' );
		const sourceId = $( element ).attr( 'data-dla-anchor-source-id' );
		if ( fragment && sourceId ) sourceIds.set( fragment, sourceId );
	} );
	let changed = false;
	const renamed = new Map< string, string >();
	const aliases = new Set< string >();
	// A legacy named anchor inside its identically named id target is an alias,
	// not another destination. Keep its styling token without duplicating the
	// native fragment identity; browsers already prefer the ancestor's id.
	$( 'a[name]' ).each( ( _index, element ) => {
		const node = $( element );
		const name = node.attr( 'name' )!;
		if ( ! name || node.parents( '[id]' ).filter( ( _i, parent ) => $( parent ).attr( 'id' ) === name ).length === 0 ) return;
		node.attr( 'data-dla-anchor-alias', name ).removeAttr( 'name' );
		aliases.add( name );
		changed = true;
	} );
	const phoneTarget = ( fragment: string ): boolean => {
		const phoneId = `${ fragment }--dla-mobile`;
		if ( mobile.find( '[id]' ).filter( ( _i, candidate ) => $( candidate ).attr( 'id' ) === phoneId ).length === 0 ) {
			// Ordinary authored fragments have no adapter marker. Their mobile
			// target still carries the original id and collides with the desktop
			// copy; preserve its associations when assigning the phone identity.
			const authored = mobile.find( '[id]' ).filter( ( _i, candidate ) => $( candidate ).attr( 'id' ) === fragment );
			if ( authored.length === 1 ) {
				authored.attr( 'id', phoneId );
				renamed.set( fragment, phoneId );
				changed = true;
			}
			const sourceId = sourceIds.get( fragment );
			const counterpart = authored.length === 1 ? authored : sourceId
				? mobile.find( '[id]' ).filter( ( _i, candidate ) => $( candidate ).attr( 'id' ) === sourceId )
				: $();
			if ( counterpart.length !== 1 ) return false;
			if ( authored.length !== 1 ) counterpart.before(
				`<span id="${ escapeHtmlAttr( phoneId ) }" data-dla-anchor-target="${ escapeHtmlAttr( fragment ) }" aria-hidden="true"></span>`
			);
		}
		return true;
	};
	let responsiveAliases = false;
	for ( const fragment of aliases ) {
		const desktopTarget = $( `.${ DESKTOP_DOCUMENT_CLASS } [id]` ).filter( ( _i, element ) => $( element ).attr( 'id' ) === fragment );
		const mobileTarget = mobile.find( '[id]' ).filter( ( _i, element ) => $( element ).attr( 'id' ) === fragment );
		if ( desktopTarget.length !== 1 || mobileTarget.length !== 1 || ! phoneTarget( fragment ) ) continue;
		desktopTarget.attr( 'data-dla-responsive-fragment', fragment );
		mobileTarget.attr( 'data-dla-responsive-fragment', fragment );
		responsiveAliases = true;
	}
	mobile.find( 'a[href]' ).each( ( _index, element ) => {
		const link = $( element );
		const href = link.attr( 'href' ) ?? '';
		const hash = href.indexOf( '#' );
		if ( hash < 0 ) return;
		const path = href.slice( 0, hash );
		if ( path !== '' && path.split( '?' )[ 0 ] !== documentPath ) return;
		let fragment: string;
		try { fragment = decodeURIComponent( href.slice( hash + 1 ) ); } catch { return; }
		if ( ! fragment || fragment.endsWith( '--dla-mobile' ) || ! phoneTarget( fragment ) ) return;
		link.attr( 'href', `${ path }#${ encodeURIComponent( fragment ) }--dla-mobile` );
		changed = true;
	} );
	if ( renamed.size > 0 || aliases.size > 0 ) {
		mobile.find( '*' ).each( ( _index, element ) => {
			const node = $( element );
			for ( const attribute of ID_REFERENCE_ATTRIBUTES ) {
				const value = node.attr( attribute );
				if ( value !== undefined ) node.attr( attribute, value.split( /\s+/ ).map( token => renamed.get( token ) ?? token ).join( ' ' ) );
			}
		} );
		$( 'style' ).each( ( _index, element ) => {
			const node = $( element );
			node.html( projectResponsiveIdentityCss( node.html() ?? '', renamed, aliases.size > 0 ) );
		} );
		if ( identities ) { for ( const [ key, value ] of renamed ) identities.ids.set( key, value ); identities.namedAliases ||= aliases.size > 0; }
	}
	if ( responsiveAliases ) $( 'body' ).append( `<script data-dla-responsive-fragments>${ RESPONSIVE_FRAGMENT_RUNTIME }</script>` );
	return changed ? $.html() : html;
}

function assembleResponsiveHtml(
	desktopHtml: string,
	mobileHtml: string,
	switchWidth: number = DEFAULT_SWITCH_WIDTH,
	resolved: ResolvedResponsivePair,
	bindingGate?: string
): { html: string; evidence: ResponsiveVariantEvidence } {
	const desktopBodyMatch = /<body\b([^>]*)>([\s\S]*?)<\/body\s*>/i.exec( desktopHtml );
	let desktopBody = desktopBodyMatch?.[ 2 ];
	const mobileBodyMatch = /<body\b([^>]*)>([\s\S]*?)<\/body\s*>/i.exec( mobileHtml );
	let mobileBody = mobileBodyMatch?.[ 2 ];
	if ( desktopBody === undefined || mobileBody === undefined ) {
		// The desktop document is what ships. A source gate cannot claim two
		// documents when this pair has no body to wrap.
		return { html: desktopHtml, evidence: missingBodyEvidence() };
	}
	const mobileViewport = /<meta\b[^>]*\bname\s*=\s*(["'])viewport\1[^>]*>/i.exec(
		mobileHtml
	)?.[ 0 ];
	const gatedByMobileClass = bindingGate ?? resolved.gate;
	const withMobileViewport = ( html: string ): string => {
		if ( ! mobileViewport ) return html;
		return /<meta\b[^>]*\bname\s*=\s*(["'])viewport\1[^>]*>/i.test( html )
			? html.replace( /<meta\b[^>]*\bname\s*=\s*(["'])viewport\1[^>]*>/i, mobileViewport )
			: html.replace( /<\/head\s*>/i, `${ mobileViewport }</head>` );
	};
	if ( gatedByMobileClass === undefined && ! resolved.dual && ! resolved.merge ) {
		// Equivalent trees can still carry different inline presentation: the
		// signature compares structure, never style attributes. Project those
		// differences the way an identity-subset collapse does, so one editable
		// body renders both captured viewports instead of freezing mobile at the
		// desktop's inline geometry.
		const projection = resolved.projection;
		const evidence = resolved.evidence;
		const projectionStyle = projection ? `<style>${ projection.css }</style>` : '';
		const withProjectedBody = ( html: string ): string =>
			projection
				? html.replace(
						/(<body\b[^>]*>)[\s\S]*?(<\/body\s*>)/i,
						( _match, open: string, close: string ) => `${ open }${ projection.body }${ close }`
				  )
				: html;
		// Projection rules are inserted before </head>; a document without one
		// would silently lose them.
		const withProjectionStyle = ( html: string ): string => {
			if ( ! projectionStyle ) return html;
			const withHead = /<\/head\s*>/i.test( html ) ? html : html.replace( /<body\b/i, '<head></head><body' );
			return withHead.replace( /<\/head\s*>/i, `${ projectionStyle }</head>` );
		};
		if ( styleBlocks( desktopHtml ).join( '\n' ) === styleBlocks( mobileHtml ).join( '\n' ) )
			return { html: withMobileViewport( withProjectionStyle( withProjectedBody( desktopHtml ) ) ), evidence };
		// A stylesheet present in both captures must apply at every width, so it is
		// left out of both scoping passes below and kept exactly once, unscoped, from
		// the desktop copy that already carries it.
		const shared = sharedStyleContents( desktopHtml, mobileHtml );
		return {
			html: withProjectionStyle(
				withMobileViewport(
					withProjectedBody( scopedStyles( desktopHtml, `(min-width:${ switchWidth + 1 }px)`, shared ) )
				).replace(
					/<\/head\s*>/i,
					`${ responsiveMobileStyles( mobileHtml, undefined, switchWidth, shared ) }</head>`
				)
			),
			evidence,
		};
	}
	const identitySubset = gatedByMobileClass ? undefined : resolved.merge;
	if ( identitySubset ) {
		// One body carries both renderings: mobile-only elements join the desktop
		// tree under their mapped parents and width-scoped visibility hides each
		// side's unique elements on the other regime. Anchor, media, and
		// counterpart evidence stay single-document; no mobile namespacing.
		const shared = sharedStyleContents( desktopHtml, mobileHtml );
		// Projection and visibility rules are inserted before </head>; a document
		// without one would silently lose them.
		const withHead = ( html: string ): string =>
			/<\/head\s*>/i.test( html ) ? html : html.replace( /<body\b/i, '<head></head><body' );
		return {
			html: withMobileViewport(
				withHead( scopedStyles( desktopHtml, `(min-width:${ switchWidth + 1 }px)`, shared ) )
			)
				.replace(
					/(<body\b[^>]*>)[\s\S]*?(<\/body\s*>)/i,
					( _match, open: string, close: string ) =>
						`${ withBodyClasses( open, mobileBodyMatch?.[ 1 ] ?? '', identitySubset.classAliases ) }${ identitySubset.body }${ close }`
				)
				.replace(
					/<\/head\s*>/i,
					`${ responsiveMobileStyles( mobileHtml, undefined, switchWidth, shared, identitySubset.classAliases ) }${ identitySubsetVisibilityCss( switchWidth ) }${
						identitySubset.css ? `<style>${ identitySubset.css }</style>` : ''
					}</head>`
				),
			evidence: resolved.evidence,
		};
	}
	( { desktopBody, mobileBody } = markResponsiveCounterparts( desktopBody, mobileBody ) );

	// Both documents ship in one file from here on, so their anchor targets would
	// collide on a shared id. Namespace the mobile copy and repoint its own links.
	const desktop = cheerio.load( `<body>${ desktopBody }</body>` );
	const desktopTargets = new Map< string, string >();
	desktop( '[data-dla-anchor-target][data-dla-anchor-source-id]' ).each( ( _index, element ) => {
		const target = desktop( element );
		const fragment = target.attr( 'data-dla-anchor-target' );
		const sourceId = target.attr( 'data-dla-anchor-source-id' );
		if ( fragment && sourceId ) desktopTargets.set( fragment, sourceId );
	} );
	const mobile = cheerio.load( `<body>${ mobileBody }</body>` );
	mobile( 'a[data-dla-anchor-fragment]' ).each( ( _index, element ) => {
		const fragment = mobile( element ).attr( 'data-dla-anchor-fragment' );
		const sourceId = fragment ? desktopTargets.get( fragment ) : undefined;
		if ( ! fragment || mobile( `[data-dla-anchor-target="${ fragment }"]` ).length > 0 ) return;
		if ( sourceId ) {
			const counterpart = mobile( '[id]' )
				.filter( ( _i, candidate ) => mobile( candidate ).attr( 'id' ) === sourceId )
				.first();
			if ( counterpart.length === 1 ) {
				counterpart.attr( 'data-dla-anchor-target', fragment );
				return;
			}
		}
		const localTarget = mobile( '[id]' )
			.filter( ( _i, candidate ) => mobile( candidate ).attr( 'id' ) === fragment )
			.first();
		if ( localTarget.length === 1 ) localTarget.attr( 'data-dla-anchor-target', fragment );
	} );
	mobile( '[data-dla-anchor-target]' ).each( ( _index, element ) => {
		const node = mobile( element );
		const fragment = node.attr( 'data-dla-anchor-target' );
		if ( fragment ) node.attr( 'id', `${ fragment }--dla-mobile` );
	} );
	mobile( 'a[data-dla-anchor-fragment][href]' ).each( ( _index, element ) => {
		const node = mobile( element );
		const fragment = node.attr( 'data-dla-anchor-fragment' );
		const href = node.attr( 'href' );
		if ( fragment && href )
			node.attr(
				'href',
				`${ href.replace( /#.*$/, '' ) }#${ encodeURIComponent( fragment ) }--dla-mobile`
			);
	} );
	mobileBody = mobile( 'body' ).html() ?? mobileBody;

	const wrapperAttributes = ( baseClass: string, bodyAttributes: string ): string => {
		const body = cheerio.load( `<body${ bodyAttributes }></body>` )( 'body' );
		const className = [ baseClass, body.attr( 'class' ) ].filter( Boolean ).join( ' ' );
		const style = body.attr( 'style' );
		return `class="${ escapeHtmlAttr( className ) }"${
			style ? ` style="${ escapeHtmlAttr( style ) }"` : ''
		}`;
	};
	const bodyClasses = ( bodyAttributes: string ): string[] =>
		( cheerio.load( `<body${ bodyAttributes }></body>` )( 'body' ).attr( 'class' ) ?? '' )
			.split( /\s+/ )
			.filter( Boolean );
	const mobileBodyClasses = new Set( bodyClasses( mobileBodyMatch?.[ 1 ] ?? '' ) );
	const sharedBodyClasses = [ ...new Set( bodyClasses( desktopBodyMatch?.[ 1 ] ?? '' ) ) ].filter(
		( className ) => mobileBodyClasses.has( className )
	);
	const outerBody = `<body${
		sharedBodyClasses.length > 0
			? ` class="${ escapeHtmlAttr( sharedBodyClasses.join( ' ' ) ) }"`
			: ''
	}>`;
	const responsiveBody = `<div ${ wrapperAttributes(
		DESKTOP_DOCUMENT_CLASS,
		desktopBodyMatch?.[ 1 ] ?? ''
	) } data-dla-document-scope>${ desktopBody }</div><div ${ wrapperAttributes(
		MOBILE_DOCUMENT_CLASS,
		mobileBodyMatch?.[ 1 ] ?? ''
	) } data-dla-document-scope>${ mobileBody }</div>`;
	const sharedStyles = styleBlocks( desktopHtml );
	const evidence = dualStructuralEvidence( gatedByMobileClass );
	if (
		! gatedByMobileClass &&
		sharedStyles.length > 0 &&
		sharedStyles.join( '\n' ) === styleBlocks( mobileHtml ).join( '\n' )
	) {
		return {
			html: withMobileViewport( desktopHtml )
				.replace(
					/<\/head\s*>/i,
					`<style>${ RESPONSIVE_DOCUMENT_CSS }${ documentSwitchCss( switchWidth ) }</style></head>`
				)
				.replace(
					/<body\b[^>]*>[\s\S]*?(<\/body\s*>)/i,
					( _match, closingBody: string ) => `${ outerBody }${ responsiveBody }${ closingBody }`
				),
			evidence,
		};
	}
	// A stylesheet present in both captures must apply at every width, so it is
	// left out of both scoping passes below and kept exactly once, unscoped, from
	// the desktop copy that already carries it.
	const shared = gatedByMobileClass ? new Set< string >() : sharedStyleContents( desktopHtml, mobileHtml );
	const mobileStyles = responsiveMobileStyles(
		mobileHtml,
		`.${ MOBILE_DOCUMENT_CLASS }`,
		switchWidth,
		shared
	);
	return {
		html: withMobileViewport(
			scopedStyles( desktopHtml, `(min-width:${ switchWidth + 1 }px)`, shared )
		)
			.replace(
				/<\/head\s*>/i,
				`${ mobileStyles }<style>${ RESPONSIVE_DOCUMENT_CSS }${ documentSwitchCss( switchWidth ) }</style></head>`
			)
			.replace(
				/<body\b[^>]*>[\s\S]*?(<\/body\s*>)/i,
				( _match, closingBody: string ) => `${ outerBody }${ responsiveBody }${ closingBody }`
			),
		evidence,
	};
}

function equivalentEvidence(
	desktopHtml: string,
	mobileHtml: string,
	projection: EquivalentInlineProjection | undefined
): ResponsiveVariantEvidence {
	const sharedStyles = styleBlocks( desktopHtml ).join( '\n' ) === styleBlocks( mobileHtml ).join( '\n' );
	return {
		variants: 1,
		outcome: 'collapsed-equivalent',
		reason:
			'mobile document is structurally equivalent to desktop once capture-infrastructure attributes are normalized; shipped one document',
		css: sharedStyles ? 'shared' : 'viewport-scoped',
		...( projection && projection.projectedElements > 0
			? { projectedInlineStyles: projection.projectedElements }
			: {} ),
	};
}

function identitySubsetEvidence(
	desktopHtml: string,
	mobileHtml: string,
	merge: IdentitySubsetMerge
): ResponsiveVariantEvidence {
	const sharedStyles = styleBlocks( desktopHtml ).join( '\n' ) === styleBlocks( mobileHtml ).join( '\n' );
	return {
		variants: 1,
		outcome: 'collapsed-identity-subset',
		reason: `mobile document reconciles with desktop by element identity (${ merge.mobileOnlyElements } mobile-only, ${ merge.desktopOnlyElements } desktop-only elements${
			merge.divergedComponents > 0 ? `, ${ merge.divergedComponents } re-parented component${ merge.divergedComponents === 1 ? '' : 's' } shipped per viewport` : ''
		}); shipped one document`,
		css: sharedStyles ? 'shared' : 'viewport-scoped',
		desktopOnlyElements: merge.desktopOnlyElements,
		mobileOnlyElements: merge.mobileOnlyElements,
		...( merge.divergedComponents > 0 ? { divergedComponents: merge.divergedComponents } : {} ),
	};
}

function dualStructuralEvidence( gatedClass: string | undefined ): ResponsiveVariantEvidence {
	return gatedClass
		? {
				variants: 2,
				outcome: 'dual-structural',
				reason: `a phone-only body class gates desktop CSS (body:not(.${ gatedClass })); both variants shipped`,
			}
		: {
				variants: 2,
				outcome: 'dual-structural',
				reason: 'mobile document differs structurally from desktop; both variants shipped',
			};
}

function missingBodyEvidence(): ResponsiveVariantEvidence {
	return {
		variants: 1,
		outcome: 'collapsed-equivalent',
		reason: 'a captured document is missing its body, so assembly shipped the desktop document alone',
	};
}

/**
 * One analysis of a pair. A phone-only body class is decided before structure.
 * A missing body is not a second document. The merge or projection is kept so
 * rendering the same pair does not analyze it again.
 */
function resolveResponsivePair(
	desktopHtml: string,
	mobileHtml: string,
	switchWidth: number,
	role: ResponsivePairRole
): ResolvedResponsivePair {
	const gate = mobileBodyClassGatesDesktopCss(
		desktopHtml,
		mobileHtml,
		styleBlocks( desktopHtml ).join( '\n' )
	);
	if ( gate !== undefined ) {
		return {
			role,
			missingBody: false,
			gate,
			dual: true,
			evidence: dualStructuralEvidence( gate ),
		};
	}
	const desktopBody = /<body\b([^>]*)>([\s\S]*?)<\/body\s*>/i.exec( desktopHtml )?.[ 2 ];
	const mobileBody = /<body\b([^>]*)>([\s\S]*?)<\/body\s*>/i.exec( mobileHtml )?.[ 2 ];
	if ( desktopBody === undefined || mobileBody === undefined ) {
		return { role, missingBody: true, dual: false, evidence: missingBodyEvidence() };
	}
	// Native effects bind target and subject within one source document. A tree
	// collapse must not discard one profile's effects or redirect its subjects.
	if ( /data-dla-native-effects=/.test( desktopHtml + mobileHtml ) ) {
		return { role, missingBody: false, dual: true, evidence: { ...dualStructuralEvidence( undefined ), reason: 'Native view timelines retain profile-scoped target and subject identities.' } };
	}
	if ( responsiveBodySignature( desktopBody ) === responsiveBodySignature( mobileBody ) ) {
		const projection = equivalentInlineProjection( desktopHtml, mobileHtml, switchWidth );
		return {
			role,
			missingBody: false,
			dual: false,
			projection,
			evidence: equivalentEvidence( desktopHtml, mobileHtml, projection ),
		};
	}
	const merge = identitySubsetMerge( desktopHtml, mobileHtml, switchWidth );
	if ( merge ) {
		return {
			role,
			missingBody: false,
			dual: false,
			merge,
			evidence: identitySubsetEvidence( desktopHtml, mobileHtml, merge ),
		};
	}
	return {
		role,
		missingBody: false,
		dual: true,
		evidence: dualStructuralEvidence( undefined ),
	};
}

/**
 * Stylesheet content visible to the responsive assembly. Style blocks the
 * capture generated itself (fluid learning rules) are not source styles: the
 * collapse compares what the source served to each viewport, and viewport
 * scoping must never narrow a rule that carries its own media conditions.
 */
function styleBlocks( html: string ): string[] {
	return [ ...html.matchAll( /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi ) ]
		.filter( ( match ) => ! FLUID_RULES_STYLE_ATTRIBUTE.test( match[ 1 ] ) )
		.map( ( match ) => match[ 2 ].trim() );
}

/**
 * Stylesheet content present in both captures. A stylesheet keyed here must
 * survive assembly unscoped rather than being narrowed to whichever viewport's
 * copy happens to be kept, because the source served it to both.
 */
function sharedStyleContents( desktopHtml: string, mobileHtml: string ): Set< string > {
	const desktopBlocks = new Set( styleBlocks( desktopHtml ) );
	return new Set( styleBlocks( mobileHtml ).filter( ( block ) => desktopBlocks.has( block ) ) );
}

function responsiveMobileStyles(
	mobileHtml: string,
	scope?: string,
	switchWidth: number = DEFAULT_SWITCH_WIDTH,
	skip: ReadonlySet< string > = new Set(),
	classAliases: ReadonlyMap<string, string> = new Map()
): string {
	const bodyAttributes = /<body\b([^>]*)>/i.exec( mobileHtml )?.[ 1 ] ?? '';
	const rootClasses = (
		cheerio.load( `<body${ bodyAttributes }></body>` )( 'body' ).attr( 'class' ) ?? ''
	)
		.split( /\s+/ )
		.filter( Boolean );
	return styleBlocks( mobileHtml )
		.filter( ( style ) => style !== '' && ( ! skip.has( style ) || classAliases.size > 0 ) )
		.map(
			( original ) => {
				const style = aliasResponsiveClasses( original, classAliases );
				return `<style media="(max-width:${ switchWidth }px)">${ scope ? scopeCss( style, { scope, rootClasses } ) : style }</style>`;
			}
		)
		.join( '' );
}

function scopedStyles(
	html: string,
	media: string,
	skip: ReadonlySet< string > = new Set()
): string {
	return html.replace(
		/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi,
		( match, attributes: string, css: string ) => {
			// Capture-generated rules carry their own media conditions and are
			// width-independent by construction; narrowing them to one side of
			// the switch would strand the other regime's rule.
			if ( FLUID_RULES_STYLE_ATTRIBUTE.test( attributes ) ) return match;
			if ( skip.has( css.trim() ) ) return `<style${ attributes }>${ css }</style>`;
			const existingMedia = /\bmedia\s*=\s*(["'])(.*?)\1/i.exec( attributes );
			if ( ! existingMedia ) return `<style${ attributes } media="${ media }">${ css }</style>`;
			const combined = `${ media } and (${ existingMedia[ 2 ] })`;
			const scopedAttributes = attributes.replace(
				existingMedia[ 0 ],
				`media=${ existingMedia[ 1 ] }${ combined }${ existingMedia[ 1 ] }`
			);
			return `<style${ scopedAttributes }>${ css }</style>`;
		}
	);
}

function responsiveBodySignature( body: string ): string {
	const $ = cheerio.load( `<body>${ body }</body>` );
	$( 'script,style,noscript,iframe' ).remove();
	$( '[id]' ).each( ( _index, element ) => {
		if ( isYuiRuntimeId( $( element ).attr( 'id' ) ?? '' ) ) $( element ).remove();
	} );
	$( 'svg,map,area,picture,source,img,canvas,slot' ).remove();
	$( '*' )
		.contents()
		.each( ( _index, child ) => {
			if ( child.type === 'comment' ) $( child ).remove();
		} );
	$( '*' ).each( ( _index, element ) => {
		const node = $( element );
		for ( const attribute of Object.keys( 'attribs' in element ? element.attribs : {} ) ) {
			if ( ! STRUCTURAL_SIGNATURE_ATTRIBUTES.has( attribute ) ) node.removeAttr( attribute );
		}
		for ( const attribute of [ 'id', 'name' ] ) {
			const value = node.attr( attribute );
			if ( value && isUnstableResponsiveId( value ) ) node.removeAttr( attribute );
		}
		if ( node.is( 'form,iframe' ) ) {
			for ( const attribute of [ 'id', 'name', 'target' ] ) {
				const value = node.attr( attribute );
				if ( value && /(?:target|frame)[-_]?\d{6,}$/i.test( value ) )
					node.attr( attribute, 'capture-target' );
			}
		}
	} );
	let removedEmptyMount = true;
	while ( removedEmptyMount ) {
		removedEmptyMount = false;
		$( 'div,span' ).each( ( _index, element ) => {
			const node = $( element );
			if (
				Object.keys( 'attribs' in element ? element.attribs : {} ).length === 0 &&
				node.children().length === 0 &&
				node.text().trim() === ''
			) {
				node.remove();
				removedEmptyMount = true;
			}
		} );
	}
	$( '*' )
		.contents()
		.each( ( _index, child ) => {
			if ( child.type === 'text' ) child.data = '';
		} );
	return ( $( 'body' ).html() ?? '' ).replace( />\s+</g, '><' ).replace( /\s+/g, ' ' ).trim();
}
