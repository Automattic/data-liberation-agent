import { createHash } from 'node:crypto';
import { mergeViewportEntranceStates, VIEWPORT_ENTRANCE_ATTRIBUTE } from './viewport-entrances.js';
import * as cheerio from 'cheerio';
import { readDocument } from './parsed-documents.js';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import type { AnyNode, Element } from 'domhandler';
import { escapeHtmlAttr } from './html-escape.js';
import { appendScrollDrivenAnimations } from './scroll-driven-animations.js';
import { cssIdentifier, parseCss, parseSelectorList, projectStylesheet, scopeCss, type UnparseableStylesheetSink } from './replicate/css-scope.js';
import { FLUID_RULES_STYLE_ATTRIBUTE } from './screenshot/fluid-capture.js';
import { documentElementTags } from './screenshot/document-integrity.js';
import { isElementNode, isYuiRuntimeId } from './html-nodes.js';
import { CONSENT_OVERLAY_DIALOG_SELECTOR, CONSENT_VENDOR_RE, isConsentOverlayRoot } from './consent-overlay.js';
import {
	correspondenceMerge,
	hasLearnedTransform,
	importantRule,
	inlineDeclarations,
	isStableIdentityId,
	isUnstableResponsiveId,
	learnedTransformSelectors,
	RESPONSIVE_DESKTOP_ONLY_CLASS,
	RESPONSIVE_MOBILE_ONLY_CLASS,
	RESPONSIVE_PROJECTION_CLASS_PREFIX,
	RESPONSIVE_SOURCE_ID,
	referenceOf,
	type ViewportTreeReconciliation,
	withoutTransform,
} from './viewport-correspondence.js';

/**
 * Responsive document assembly. The source pair is the raw captures. It chooses
 * which documents to assemble and owns a binding phone-only body-class gate.
 * Receipt evidence describes the tree that assembly emitted: the same raw
 * analysis when that pair is rendered, or one analysis of the portable pair
 * when that different pair is what ships. A pair neither the structural
 * signature nor stable ids reconcile is reconciled by node correspondence on
 * the portable pair that ships (#1034 point 5).
 */

/**
 * Class tokens marking one side of a desktop/mobile document pair emitted
 * into a single exported page. Consumers that need to recognize these as a
 * document-scope boundary (e.g. to disambiguate a duplicate id captured on
 * both sides) cannot assume this naming — it is declared explicitly in the
 * capture receipt's `document_scope_classes` list rather than hardcoded
 * downstream.
 */
export const DESKTOP_DOCUMENT_CLASS = 'data-blocks-engine-capture-desktop-document';
export const MOBILE_DOCUMENT_CLASS = 'data-blocks-engine-capture-mobile-document';
/**
 * Class token of a middle width range's document (#1379): a source whose width
 * breakpoints select a third layout between the phone and desktop documents
 * ships it as a further wrapper. The outermost ranges keep the desktop and
 * mobile classes; further middle ranges are `<key>-document` with key
 * `middle-<n>`, ordered by width. Each middle copy of an anchor target takes
 * the `--data-blocks-engine-capture-<key>` id suffix.
 */
export const MIDDLE_DOCUMENT_CLASS = 'data-blocks-engine-capture-middle-document';

/** A middle width range's document, between the phone and desktop documents (inclusive bounds). */
export interface ResponsiveWidthDocument {
	html: string;
	minWidth: number;
	maxWidth: number;
}

/** The key, class and id suffix of the middle range at `index` (ordered by width). */
function middleVariant( index: number ): { key: string; className: string } {
	const key = index === 0 ? 'middle' : `middle-${ index + 1 }`;
	return { key, className: `data-blocks-engine-capture-${ key }-document` };
}

/**
 * Intersect query lists, keeping media types before conditions. `undefined`
 * requests separate gates: appending to `not print` would negate the width too,
 * and distinct media types cannot share one query. Callers must retain both
 * queries (a style media attribute plus an inner @media), never drop either.
 */
export function combineMediaQueries( left: string, right: string ): string | undefined {
	const queries: string[] = [];
	for ( const a of postcss.list.comma( left.trim() || 'all' ) ) {
		for ( const b of postcss.list.comma( right.trim() || 'all' ) ) {
			if ( /^all$/i.test( a ) ) { queries.push( b ); continue; }
			if ( /^all$/i.test( b ) ) { queries.push( a ); continue; }
			if ( /^not\b/i.test( a ) || /^not\b/i.test( b ) ) return undefined;
			const parse = ( query: string ) => {
				const type = /^(?:(only)\s+)?([a-z][\w-]*)(?:\s+and\s+|$)/i.exec( query );
				const condition = type ? query.slice( type[ 0 ].length ).trim() : query;
				return { type: type?.[ 2 ]?.toLowerCase(), only: Boolean( type?.[ 1 ] ), condition };
			};
			const x = parse( a );
			const y = parse( b );
			const types = [ x.type, y.type ].filter( type => type && type !== 'all' );
			if ( new Set( types ).size > 1 ) return undefined;
			const type = types[ 0 ] ?? ( x.only || y.only ? 'all' : undefined );
			const conditions = [ x.condition, y.condition ].filter( Boolean ).map( condition =>
				condition.startsWith( '(' ) && ! /\bor\b/i.test( condition ) ? condition : `(${ condition })`
			);
			queries.push( [ ...( type ? [ `${ x.only || y.only ? 'only ' : '' }${ type }` ] : [] ), ...conditions ].join( ' and ' ) );
		}
	}
	return queries.join( ', ' );
}

function middleMedia( range: { minWidth: number; maxWidth: number } ): string {
	return combineMediaQueries( `(min-width:${ range.minWidth }px)`, `(max-width:${ range.maxWidth }px)` )!;
}

const RESPONSIVE_DOCUMENT_CSS = `.${ MOBILE_DOCUMENT_CLASS }{display:none!important}`;

/**
 * Device scoping moves each document's own `body` rules off the real body
 * (desktop rules behind a min-width query, mobile rules onto its wrapper), so a
 * zero box replaces the user-agent body margin. It leads the head so any author
 * rule that still targets html/body keeps winning the cascade (#1554).
 */
const RESPONSIVE_DOCUMENT_RESET_CSS = '<style>html,body{margin:0;padding:0}</style>';

const RESPONSIVE_COUNTERPART_CLASS_PREFIX = 'data-blocks-engine-capture-responsive-counterpart-';
const RESPONSIVE_COUNTERPART_TAGS = 'p,h1,h2,h3,h4,h5,h6,a,button';

/** Switches which captured document is shown, at the detected width. */
function documentSwitchCss( switchWidth: number ): string {
	return `@media(max-width:${ switchWidth }px){.${ DESKTOP_DOCUMENT_CLASS }{display:none!important}.${ MOBILE_DOCUMENT_CLASS }{display:contents!important}}`;
}

// Document boundaries come from the real tags only. Captured pages keep their
// scripts as text, and a script can carry `<head>`, `<body …>` or `</body>`
// strings (a popup written with document.write); a regex would stop there.

/** A real head or body element of a serialized document, as raw markup slices. */
interface DocumentElement {
	attributes: string;
	open: string;
	content: string;
	close: string;
	start: number;
	end: number;
}

function documentElement( html: string, name: 'head' | 'body' ): DocumentElement | undefined {
	const { open, close } = documentElementTags( html, name );
	if ( ! open || ! close || close.start < open.end ) return undefined;
	return {
		attributes: open.attributes,
		open: html.slice( open.start, open.end ),
		content: html.slice( open.end, close.start ),
		close: html.slice( close.start, close.end ),
		start: open.start,
		end: close.end,
	};
}

/** Raw attributes of the real `<body>` start tag; empty when there is none. */
function bodyAttributes( html: string ): string {
	return documentElementTags( html, 'body' ).open?.attributes ?? '';
}

/** Replace the real head or body element, start tag through end tag. Unchanged without one. */
function replaceDocumentElement( html: string, name: 'head' | 'body', render: ( element: DocumentElement ) => string ): string {
	const element = documentElement( html, name );
	return element ? html.slice( 0, element.start ) + render( element ) + html.slice( element.end ) : html;
}

function hasHeadClose( html: string ): boolean {
	return documentElementTags( html, 'head' ).close !== undefined;
}

/** Insert markup before the real `</head>`. Unchanged without one. */
function insertBeforeHeadClose( html: string, markup: string ): string {
	const close = documentElementTags( html, 'head' ).close;
	return close ? html.slice( 0, close.start ) + markup + html.slice( close.start ) : html;
}

/** Insert markup right after the real `<head>` open tag. Unchanged without one. */
function insertAfterHeadOpen( html: string, markup: string ): string {
	const open = documentElementTags( html, 'head' ).open;
	return open ? html.slice( 0, open.end ) + markup + html.slice( open.end ) : html;
}

/** Give a document without `</head>` an empty head before its real body. */
function withHeadElement( html: string ): string {
	if ( hasHeadClose( html ) ) return html;
	const open = documentElementTags( html, 'body' ).open;
	return open ? `${ html.slice( 0, open.start ) }<head></head>${ html.slice( open.start ) }` : html;
}

/**
 * Legacy width-only assembly fallback. Source-owned device selection bypasses
 * this path: a canvas floor or CSS boundary does not prove a device transition.
 * Explicit observed width contracts supply their own boundary instead.
 */
export const DEFAULT_SWITCH_WIDTH = 767;

/**
 * Attributes DLA's own capture infrastructure writes to mark that two
 * elements correspond across viewports: fluid-learning identities
 * (viewport-prefixed, e.g. `desktop-wrapper-0` vs `mobile-wrapper-0`) and
 * responsive counterpart slots. They cannot exist on the source site and
 * encode correspondence, never difference, so structural equivalence must
 * not read them as one.
 */
const CORRESPONDENCE_ATTRIBUTES = [ 'data-blocks-engine-capture-geometry-id', 'data-blocks-engine-capture-responsive-source' ];
const STRUCTURAL_SIGNATURE_ATTRIBUTES = new Set( [ 'id', 'href', 'name', 'type', 'for', 'action' ] );

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
 * Consent overlay subtrees (`isConsentOverlayRoot`) are left out: consent
 * managers lay out their own chrome per viewport.
 */
export function documentsDiffer( desktopHtml: string, mobileHtml: string ): boolean {
	const desktopBody = documentElement( desktopHtml, 'body' )?.content;
	const mobileBody = documentElement( mobileHtml, 'body' )?.content;
	if ( desktopBody === undefined || mobileBody === undefined ) return false;
	return responsiveBodySignature( desktopBody, desktopHtml + mobileHtml ) !== responsiveBodySignature( mobileBody, desktopHtml + mobileHtml );
}

/**
 * Per-route record of how many responsive documents were exported and why,
 * so downstream consumers and humans can audit the collapse decision from
 * the capture receipt alone. Present only when the source was captured under
 * mobile emulation too — without a second capture there was no decision.
 */
export interface ResponsiveVariantEvidence {
	/** Documents shipped in the exported route file. */
	variants: number;
	outcome: 'collapsed-equivalent' | 'collapsed-identity-subset' | 'dual-structural';
	reason: string;
	/** How responsive CSS survives a collapse. Present only when collapsed. */
	css?: 'shared' | 'viewport-scoped';
	/** Elements only the desktop capture rendered, hidden at or below the switch width. Present only for an identity-subset collapse. */
	desktopOnlyElements?: number;
	/** Elements only the mobile capture rendered, inserted under their mapped parent and hidden above the switch width. Present only for an identity-subset collapse. */
	mobileOnlyElements?: number;
	/** Matched node pairs the reconciliation established across the two captures. Present when a collapse records the correspondence. */
	matchedNodes?: number;
	/** Shared components the phone layout re-parents, shipped once per viewport inside the collapsed document. */
	divergedComponents?: number;
	/** Shared elements whose per-viewport inline styles were projected into width-scoped rules. Present only when an equivalent collapse found differing inline styles. */
	projectedInlineStyles?: number;
	/**
	 * The width range each shipped document is selected in (inclusive bounds),
	 * phone first. Present only when the source selects more than two layouts by
	 * width and a middle document shipped (#1379).
	 */
	widthRanges?: Array< { document: string; minWidth?: number; maxWidth?: number } >;
}

/** Which pair an analysis describes. Source chooses inputs; emitted is what the receipt records. */
type ResponsivePairRole = 'source' | 'emitted';

interface ResolvedResponsivePair {
	role: ResponsivePairRole;
	missingBody: boolean;
	gate?: string;
	/** Reused when this same pair is rendered. Not applied to a different pair. */
	merge?: ViewportTreeReconciliation;
	projection?: EquivalentInlineProjection;
	evidence: ResponsiveVariantEvidence;
	dual: boolean;
}

function responsiveBodyContent( html: string ): string | undefined {
	return documentElement( html, 'body' )?.content;
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

/** Inline normal declarations cannot be promoted above matching author-important
 * rules without changing the source cascade. Keep both native documents when
 * responsive reconciliation would need to relocate those declarations.
 */
function requiresNativeInlineCascade( desktopHtml: string, mobileHtml: string ): boolean {
	const desktop = readDocument( desktopHtml );
	const mobile = readDocument( mobileHtml );
	const inlineStyles = ( $: cheerio.CheerioAPI ) => $( 'body [style],body[style]' )
		.map( ( _, element ) => $( element ).attr( 'style' ) ?? '' ).get();
	if ( JSON.stringify( inlineStyles( desktop ) ) === JSON.stringify( inlineStyles( mobile ) ) ) return false;
	for ( const [ html, $ ] of [ [ desktopHtml, desktop ], [ mobileHtml, mobile ] ] as const ) {
		const rules: Array<{ selector: string; properties: Set<string> }> = [];
		for ( const block of styleBlocks( html ) ) {
			try {
				parseCss( block ).walkRules( rule => {
					const properties = new Set<string>();
					rule.walkDecls( declaration => { if ( declaration.important ) properties.add( declaration.prop.toLowerCase() ); } );
					if ( properties.size ) rules.push( { selector: rule.selector, properties } );
				} );
			} catch { /* Invalid CSS cannot establish a matching cascade rule. */ }
		}
		for ( const element of $( 'body [style],body[style]' ).toArray() ) {
			const node = $( element );
			const normalProperties = inlineDeclarations( node.attr( 'style' ) ?? '' )
				.filter( declaration => ! /!\s*important\s*$/i.test( declaration ) )
				.map( declaration => declaration.slice( 0, declaration.indexOf( ':' ) ).trim().toLowerCase() );
			for ( const rule of rules ) {
				if ( ! normalProperties.some( property => [ ...rule.properties ].some( important => cascadePropertiesOverlap( property, important ) ) ) ) continue;
				try { if ( node.is( rule.selector ) ) return true; } catch { /* Pseudo-elements do not style the element's inline box. */ }
			}
		}
	}
	return false;
}

/** Retain native priority when shorthand overlap cannot safely be promoted. */
function cascadePropertiesOverlap( normal: string, important: string ): boolean {
	if ( normal === important ) return true;
	if ( normal.startsWith( '--' ) || important.startsWith( '--' ) ) return false;
	if ( important === 'all' ) return true;
	const families = [ 'margin', 'padding', 'border', 'background', 'font', 'outline', 'animation', 'transition', 'flex', 'grid', 'columns', 'list-style', 'overflow', 'text-decoration' ];
	return families.some( family =>
		( normal === family || normal.startsWith( `${ family }-` ) ) &&
		( important === family || important.startsWith( `${ family }-` ) )
	) || ( important === 'inset' && [ 'top', 'right', 'bottom', 'left' ].includes( normal ) ) ||
		( important === 'gap' && [ 'row-gap', 'column-gap' ].includes( normal ) );
}

// An identity attribute must anchor nearly all rendered text in both captures
// (that is what the merge needs), name nearly one element per value (a value
// repeated within a document is excluded like a repeated id), and mostly
// recur across the captures, which per-render values never do.
const IDENTITY_ATTRIBUTE_MIN_TEXT_COVERAGE = 0.9;
const IDENTITY_ATTRIBUTE_MIN_UNIQUENESS = 0.98;
const IDENTITY_ATTRIBUTE_MIN_OVERLAP = 0.9;

function discoverIdentityAttributes( desktop: cheerio.CheerioAPI, mobile: cheerio.CheerioAPI ): { names: string[]; repeated: Set< string > } {
	const inventory = ( $: cheerio.CheerioAPI ) => {
		const attributes = new Map< string, { values: Map< string, number >; count: number } >();
		for ( const element of $( 'body *' ).toArray().filter( isElementNode ) ) {
			for ( const [ name, value ] of Object.entries( element.attribs ) ) {
				if ( name === 'id' || name === 'class' || name === 'style' || ! value.trim() ) continue;
				const entry = attributes.get( name ) ?? { values: new Map< string, number >(), count: 0 };
				entry.values.set( value, ( entry.values.get( value ) ?? 0 ) + 1 );
				entry.count++;
				attributes.set( name, entry );
			}
		}
		const texts = $( 'body *' ).contents().toArray().filter( node => node.type === 'text' && ( node.data ?? '' ).trim() !== '' && isElementNode( node.parent as AnyNode ) && ! [ 'script', 'style', 'noscript' ].includes( ( node.parent as Element ).tagName ) );
		const textCoverage = ( name: string ): number => texts.filter( text => {
			for ( let current = text.parent; current && isElementNode( current ); current = current.parent ) if ( current.attribs[ name ]?.trim() ) return true;
			return false;
		} ).length / Math.max( 1, texts.length );
		return { attributes, textCoverage };
	};
	const d = inventory( desktop );
	const m = inventory( mobile );
	const repeated = new Set< string >();
	const names = [ ...d.attributes.keys() ].filter( name => {
		const left = d.attributes.get( name )!;
		const right = m.attributes.get( name );
		if ( ! right || left.values.size < left.count * IDENTITY_ATTRIBUTE_MIN_UNIQUENESS || right.values.size < right.count * IDENTITY_ATTRIBUTE_MIN_UNIQUENESS ) return false;
		const shared = [ ...left.values.keys() ].filter( value => right.values.has( value ) ).length;
		if ( shared / Math.max( left.values.size, right.values.size ) < IDENTITY_ATTRIBUTE_MIN_OVERLAP ) return false;
		if ( d.textCoverage( name ) < IDENTITY_ATTRIBUTE_MIN_TEXT_COVERAGE || m.textCoverage( name ) < IDENTITY_ATTRIBUTE_MIN_TEXT_COVERAGE ) return false;
		for ( const side of [ left, right ] ) for ( const [ value, count ] of side.values ) if ( count > 1 ) repeated.add( JSON.stringify( [ name, value ] ) );
		return true;
	} ).sort();
	return { names, repeated };
}

/**
 * Reconciles two responsive captures into one body keyed on element identity.
 * Stable ids take precedence over discovered unique, broadly shared attributes.
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
/** Inline styles are equal when their declarations are, regardless of serialization whitespace. */
function sameInlineStyle( a: string | undefined, b: string | undefined ): boolean {
	if ( a === b ) return true;
	if ( a === undefined || b === undefined ) return false;
	const normalized = ( style: string ) => inlineDeclarations( style ).map( ( declaration ) => {
		const colon = declaration.indexOf( ':' );
		return colon < 0 ? declaration : `${ declaration.slice( 0, colon ).trim().toLowerCase() }:${ declaration.slice( colon + 1 ).trim() }`;
	} ).join( ';' );
	return normalized( a ) === normalized( b );
}

export function identitySubsetMerge(
	desktopHtml: string,
	mobileHtml: string,
	switchWidth: number = DEFAULT_SWITCH_WIDTH,
	deviceKey?: string,
	onUnreconciled?: ( reason: string ) => void,
	defaultKey?: string
): ViewportTreeReconciliation | undefined {
	const cannotMerge = ( reason: string ): undefined => { onUnreconciled?.( reason ); return undefined; };
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
			if ( ! isElementNode( node ) || isUnrenderedElement( node ) ) continue;
			const id = $( node ).attr( 'id' ) ?? '';
			if ( ! isStableIdentityId( id ) ) continue;
			if ( ids.has( id ) ) repeated.add( id );
			ids.set( id, node );
		}
		return { $, ids };
	};
	const isIdentityId = ( id: string ): boolean => isStableIdentityId( id ) && ! repeated.has( id );
	const desktop = load( desktopBody );
	const mobile = load( mobileBody );
	const { names: attributes, repeated: repeatedAttributes } = discoverIdentityAttributes( desktop.$, mobile.$ );
	const identities = new WeakMap<Element, string>();
	// An id only one capture renders (a runtime marking its active component)
	// proves nothing about the counterpart; a discovered attribute both
	// captures carry still does.
	const sourceIds = [ new Set( desktop.ids.keys() ), new Set( mobile.ids.keys() ) ];
	for ( const [ index, document ] of [ desktop, mobile ].entries() ) {
		const otherIds = sourceIds[ 1 - index ] as Set<string>;
		document.ids.clear();
		for ( const node of document.$( 'body *' ).toArray().filter( isElementNode ) ) {
			// Non-rendering subtrees retain the default document's copy, not a
			// component identity that could require per-device splitting.
			if ( isUnrenderedElement( node ) ) continue;
			const id = node.attribs.id;
			const attribute = attributes.find( name => Boolean( node.attribs[ name ]?.trim() ) && ! repeatedAttributes.has( JSON.stringify( [ name, node.attribs[ name ] ] ) ) );
			const ownId = id && isIdentityId( id ) ? id : undefined;
			const identity = ownId && ( otherIds.has( ownId ) || ! attribute ) ? ownId : attribute
				? `attribute-${ createHash( 'sha256' ).update( JSON.stringify( [ attribute, node.attribs[ attribute ] ] ) ).digest( 'hex' ) }` : undefined;
			if ( ! identity ) continue;
			identities.set( node, identity );
			document.ids.set( identity, node );
		}
	}
	const identityOf = ( node: Element ): string | undefined => identities.get( node );
	const nearestIdentityId = ( $: cheerio.CheerioAPI, node: AnyNode ): string | undefined => {
		for ( let current = node.parent; current; current = current.parent ) {
			if ( ! isElementNode( current ) ) continue;
			const id = identityOf( current );
			if ( id ) return id;
		}
		return undefined;
	};
	const identityChain = ( $: cheerio.CheerioAPI, element: Element ): string[] => {
		const chain: string[] = [];
		for ( let current = element.parent; current; current = current.parent ) {
			if ( ! isElementNode( current ) ) continue;
			const id = identityOf( current );
			if ( id ) chain.unshift( id );
		}
		return chain;
	};
	const { $: $d, ids: desktopIds } = desktop;
	const { $: $m, ids: mobileIds } = mobile;
	const classAliases = new Map<string, string>();
	const desktopClassTokens = new Set<string>();
	$d( '[class]' ).each( ( _index, node ) =>
		( $d( node ).attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean ).forEach( ( token ) => desktopClassTokens.add( token ) )
	);
	const retainedClassTokens = new Set<string>();
	const desktopClassAliases = new Map<string, string>();
	const desktopStyledClasses = new Set( [ ...styleBlocks( desktopHtml ).join( '' ).matchAll( /\.(-?[_a-zA-Z][\w-]*)/g ) ].map( match => match[ 1 ] as string ) );
	const bodyClasses = ( html: string ) => {
		const attributes = bodyAttributes( html );
		return ( cheerio.load( `<body${ attributes }></body>` )( 'body' ).attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean );
	};
	const desktopBodyClasses = new Set( bodyClasses( desktopHtml ) );
	for ( const token of deviceKey ? [] : bodyClasses( mobileHtml ) ) {
		if ( desktopBodyClasses.has( token ) ) continue;
		if ( desktopClassTokens.has( token ) ) retainedClassTokens.add( token );
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
	if ( sharedIdCount === 0 ) return cannotMerge( 'No shared stable element identities' );
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
		if ( ancestor && ! desktopIds.has( ancestor ) ) return cannotMerge( 'Device-only component has no shared ancestor' );
		outermostMobileOnlyIds.push( id );
	}
	// The same id must hang from the same shared ancestors in both captures, or
	// the documents nest their components differently and one tree cannot serve
	// both. A wrapper only one capture renders (a desktop transition layer) is
	// not a nesting difference: it stays in the tree, hidden on the other side.
	const shared = ( id: string ): boolean => desktopIds.has( id ) && mobileIds.has( id );
	// Identity alone does not account for anonymous layout containers. Compare
	// wrapper counts in each interval between shared ancestors, not just total
	// depth: dropping a phone row/cell (or retaining a desktop absolute box)
	// cannot be repaired by projecting styles onto the shared component. Treat
	// every wrapper as potentially layout-bearing; CSS selectors and inherited
	// sizing make an authored-property whitelist insufficient. Equal-depth trees
	// remain eligible for the existing paired inline/class projection, including
	// builders that only restyle their wrappers. Device-key reconciliation keeps
	// divergent placements separately rather than collapsing them.
	const wrapperIntervals = ( element: Element ): number[] => {
		const intervals = [ 0 ];
		for ( let parent = element.parent; parent && isElementNode( parent ) && parent.tagName !== 'body'; parent = parent.parent ) {
			if ( shared( identityOf( parent ) ?? '' ) ) intervals.push( 0 );
			else intervals[ intervals.length - 1 ]!++;
		}
		return intervals;
	};
	for ( const [ id, desktopElement ] of desktopIds ) {
		if ( ! mobileIds.has( id ) ) continue;
		const desktopChain = identityChain( $d, desktopElement ).filter( shared );
		const mobileChain = identityChain( $m, mobileIds.get( id ) as Element ).filter( shared );
		if (
			desktopChain.length !== mobileChain.length ||
			desktopChain.some( ( value, index ) => value !== mobileChain[ index ] )
		)
			return cannotMerge( 'Shared component ancestry differs' );
		if ( ! deviceKey ) {
			const desktopWrappers = wrapperIntervals( desktopElement );
			const mobileWrappers = wrapperIntervals( mobileIds.get( id ) as Element );
			if ( desktopWrappers.some( ( count, index ) => count !== mobileWrappers[ index ] ) )
				return cannotMerge( 'Shared component wrapper ancestry differs' );
		}
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
				! UNRENDERED_TAGS.has( child.tagName ) &&
				unmappedText( child )
			)
				return true;
		}
		return false;
	};
	if ( unmappedText( $m.root()[ 0 ] ) ) return cannotMerge( 'Device text has no stable identified parent' );

	// A desktop-only wrapper around shared components must keep rendering on
	// mobile, or hiding it would hide them too; only leaf-side desktop-only
	// elements are hidden at or below the switch width.
	let hiddenDesktopOnly = 0;
	for ( const id of desktopOnlyIds ) {
		const element = $d( desktopIds.get( id ) as Element );
		const wrapsShared = element
			.find( '*' )
			.toArray()
			.some( ( node ) => shared( identityOf( node ) ?? '' ) );
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
			.filter( ( child ) => ! $( child ).attr( 'id' ) && ! identityOf( child ) );
	const insertions: Insertion[] = [];
	const insertedWrappers = new Set< Element >();
	for ( const id of outermostMobileOnlyIds ) {
		const mobileElement = mobileIds.get( id ) as Element;
		const ancestorId = nearestIdentityId( $m, mobileElement );
		const path: Element[] = [];
		for ( let current = mobileElement.parent; current; current = current.parent ) {
			if ( ! isElementNode( current ) ) continue;
			if ( ancestorId ? identityOf( current ) === ancestorId : current.tagName === 'body' ) break;
			path.unshift( current );
		}
		let parent = ancestorId ? $d( desktopIds.get( ancestorId ) as Element ) : $d( 'body' );
		let mobileParent = ancestorId ? $m( mobileIds.get( ancestorId ) as Element ) : $m( 'body' );
		// An id-less wrapper only the phone renders (a hover overlay a phone
		// layout shows at rest) has no desktop step to resolve. When it holds
		// no shared component, it is itself the mobile-only island.
		let island: Element = mobileElement;
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
			if ( ! match ) {
				const mobileOnlyWrapper =
					byClass.length === 0 &&
					( candidates.length === 0 || candidates.length < mobileSiblings.length ) &&
					! $m( step )
						.find( '*' )
						.toArray()
						.some( ( node ) => shared( identityOf( node ) ?? '' ) );
				if ( ! mobileOnlyWrapper ) return cannotMerge( 'Device-only component placement could not be resolved' );
				island = step;
				break;
			}
			parent = $d( match );
			mobileParent = $m( step );
		}
		if ( island !== mobileElement ) {
			if ( insertedWrappers.has( island ) ) continue;
			insertedWrappers.add( island );
		}
		const element = $m( island );
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
	let anonymousMobileOnly = 0;
	const deviceInlineRestores: Array<() => void> = [];
	let incompatibleEntrance = false;
	if ( deviceKey ) {
		// A wrapper with an identity only one device renders (a desktop page
		// transition layer) stays in the tree and keeps rendering around the
		// shared components it wraps, so it is not a placement difference.
		const placement = ( $: cheerio.CheerioAPI, node: Element ) => {
			const steps: string[] = [];
			for ( let parent = node.parent; parent && isElementNode( parent ) && parent.tagName !== 'body'; parent = parent.parent ) {
				const parentId = identityOf( parent );
				if ( parentId && ! shared( parentId ) ) continue;
				steps.unshift( parentId ?? `${ parent.tagName }.${ $( parent ).attr( 'class' ) ?? '' }` );
			}
			return steps.join( '/' );
		};
		for ( const [ id, node ] of desktopIds ) {
			const other = mobileIds.get( id );
			if ( other && placement( $d, node ) !== placement( $m, other ) ) divergedRoots.add( id );
		}
	}
	const sharedIdsIn = ( $: cheerio.CheerioAPI, node: Element ): string =>
		$( node )
			.find( '*' )
			.toArray()
			.map( ( child ) => identityOf( child ) ?? '' )
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
		// Stable ids cannot override each document's resolved URL identity: a
		// component whose viewports link or embed different destinations (a
		// rotating partner strip) ships once per viewport, like a re-parented one.
		if ( deviceKey ) {
			if ( d.get( 0 )!.tagName !== m.get( 0 )!.tagName ||
				d.contents().filter( ( _i, node ) => node.type === 'text' ).text() !== m.contents().filter( ( _i, node ) => node.type === 'text' ).text() ||
				d.attr( 'sizes' ) !== m.attr( 'sizes' ) ) {
				divergedRoots.add( path.split( '/' )[ 0 ] as string );
				return;
			}
			// A class token is a per-device attribute like an inline style, not
			// a structural difference: the selected device's runtime swaps the
			// recorded tokens, leaving any token added after reconciliation.
			const ownClasses = ( d.attr( 'class' ) ?? '' ).split( /\s+/ ).filter( token => token && token !== RESPONSIVE_DESKTOP_ONLY_CLASS && token !== RESPONSIVE_MOBILE_ONLY_CLASS ).join( ' ' );
			if ( ownClasses !== ( m.attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean ).join( ' ' ) ) {
				d.attr( 'data-blocks-engine-capture-device-class', JSON.stringify( { ...( defaultKey ? { [ defaultKey ]: ownClasses } : {} ), [ deviceKey ]: m.attr( 'class' ) ?? '' } ) );
				const original = m.attr( 'class' );
				deviceInlineRestores.push( () => { if ( original === undefined ) m.removeAttr( 'class' ); else m.attr( 'class', original ); } );
				m.attr( 'class', d.attr( 'class' ) ?? '' );
			}
			// Keep native inline priority instead of promoting declarations to !important.
			if ( ! sameInlineStyle( d.attr( 'style' ), m.attr( 'style' ) ) ) {
				d.attr( 'data-blocks-engine-capture-device-inline', JSON.stringify( { [ deviceKey ]: m.attr( 'style' ) ?? '' } ) );
				const original = m.attr( 'style' );
				deviceInlineRestores.push( () => { if ( original === undefined ) m.removeAttr( 'style' ); else m.attr( 'style', original ); } );
				m.attr( 'style', d.attr( 'style' ) ?? '' );
			}
		}
		if ( referenceOf( d.get( 0 )! ) !== referenceOf( m.get( 0 )! ) ) {
			divergedRoots.add( path.split( '/' )[ 0 ] as string );
			return;
		}
		if ( deviceKey && ( d.attr( VIEWPORT_ENTRANCE_ATTRIBUTE ) !== undefined || m.attr( VIEWPORT_ENTRANCE_ATTRIBUTE ) !== undefined ) ) {
			const scope = defaultKey ? { left: [ defaultKey ], right: [ deviceKey ], all: [ defaultKey, deviceKey ] } : undefined;
			const state = mergeViewportEntranceStates( d.attr( VIEWPORT_ENTRANCE_ATTRIBUTE ), m.attr( VIEWPORT_ENTRANCE_ATTRIBUTE ), scope );
			if ( state === undefined ) incompatibleEntrance = true;
			else d.attr( VIEWPORT_ENTRANCE_ATTRIBUTE, state );
		}
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
			if ( id && isIdentityId( id ) ) selector = `#${ id }`;
			else {
				// Equal hooks must project equal rules, independent of document order.
				const hook = `${ RESPONSIVE_PROJECTION_CLASS_PREFIX }${ createHash( 'sha256' )
					.update( JSON.stringify( [ switchWidth, desktopStyle, projectedMobileStyle ] ) )
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
			// A token the desktop tree also uses elsewhere (a content-hashed
			// style class two components share) keeps its desktop occurrences.
			const aliases = missing.map( ( token ) => {
				if ( desktopClassTokens.has( token ) ) retainedClassTokens.add( token );
				const alias = classAliases.get( token ) ?? `${ RESPONSIVE_PROJECTION_CLASS_PREFIX }class-${ createHash( 'sha256' ).update( token ).digest( 'hex' ).slice( 0, 12 ) }`;
				classAliases.set( token, alias );
				return alias;
			} );
			d.attr( 'class', [ ...( d.attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean ), ...aliases ].join( ' ' ) );
			projected = true;
		}
		// A styled token only the desktop rendering carries must not meet the
		// phone side: a content-hashed rule the two captures share would size
		// the phone rendering like the desktop one.
		const desktopOnly = deviceKey ? [] : desktopClasses.filter( token =>
			! mobileClasses.includes( token ) && desktopStyledClasses.has( token ) && ! token.startsWith( RESPONSIVE_PROJECTION_CLASS_PREFIX ) );
		if ( desktopOnly.length > 0 ) {
			const renamed = new Map( desktopOnly.map( token => {
				const alias = desktopClassAliases.get( token ) ?? `${ RESPONSIVE_PROJECTION_CLASS_PREFIX }desktop-class-${ createHash( 'sha256' ).update( token ).digest( 'hex' ).slice( 0, 12 ) }`;
				desktopClassAliases.set( token, alias );
				return [ token, alias ];
			} ) );
			d.attr( 'class', ( d.attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean ).map( token => renamed.get( token ) ?? token ).join( ' ' ) );
			projected = true;
		}
		const desktopSizes = d.attr( 'sizes' );
		const mobileSizes = m.attr( 'sizes' );
		if ( desktopSizes && mobileSizes && desktopSizes !== mobileSizes ) {
			d.attr( 'sizes', `(max-width:${ switchWidth }px) ${ mobileSizes }, ${ desktopSizes }` );
			projected = true;
		}
		if ( projected ) projectedElements++;
		pairChildren( d, m, path );
	};
	const pairChildren = (
		d: cheerio.Cheerio< Element >,
		m: cheerio.Cheerio< Element >,
		path: string
	): void => {
		// Descend through id-less children only while both captures agree on
		// their shape; id-bearing children are paired by identity on their own.
		// Components only one capture rendered are placed by identity, not by
		// position, so they sit outside the positional pairing.
		const paired = ( $: cheerio.CheerioAPI ) => ( child: Element ): boolean => {
			if ( UNRENDERED_TAGS.has( child.tagName ) ) return false;
			const childId = identityOf( child );
			return ! childId || shared( childId );
		};
		// Mobile-only elements already placed in the desktop tree are islands, not counterparts.
		const desktopChildren = d.children().toArray().filter( paired( $d ) ).filter( child => ! $d( child ).hasClass( RESPONSIVE_MOBILE_ONLY_CLASS ) );
		const mobileChildren = m.children().toArray().filter( paired( $m ) );
		// A child that contains an identified component pairs with the child
		// holding the same component (a form grid whose phone layout drops
		// cells); otherwise align in document order: each mobile child pairs
		// with the next desktop child of the same tag and class list, so a
		// sibling only one capture rendered (a lightbox trigger, a hover layer)
		// does not stop the walk for the siblings both rendered.
		const anchorOf = ( $: cheerio.CheerioAPI, child: Element ): string | undefined =>
			$( child )
				.find( '*' )
				.toArray()
				.map( ( node ) => identityOf( node ) ?? '' )
				.find( ( id ) => shared( id ) );
		const desktopAnchors = desktopChildren.map( ( child ) => anchorOf( $d, child as Element ) );
		let cursor = 0;
		const pairedDesktop = new Map< Element, Element >();
		const settled = new Set< Element >();
		// An anchor-free child pairs only between the desktop positions of its
		// anchored neighbours: a wrapper the phone layout moved ahead of the
		// content (a sticky background) is a device-only island on each side,
		// not a pairing that renders it at the desktop position.
		const anchoredAt = mobileChildren.map( ( child ) => {
			const anchor = anchorOf( $m, child );
			const index = anchor ? desktopAnchors.indexOf( anchor ) : -1;
			return index >= 0 && ( desktopChildren[ index ] as Element ).tagName === child.tagName ? index : -1;
		} );
		for ( const [ position, mobileChild ] of mobileChildren.entries() ) {
			const mobileAnchor = anchorOf( $m, mobileChild );
			const bound = anchoredAt.slice( position + 1 ).find( ( index ) => index >= cursor ) ?? desktopChildren.length;
			if ( deviceKey && mobileAnchor && divergedRoots.has( mobileAnchor ) ) { settled.add( mobileChild ); continue; }
			const mobileClass = $m( mobileChild ).attr( 'class' ) ?? '';
			let match = mobileAnchor ? desktopAnchors.indexOf( mobileAnchor ) : -1;
			if ( match >= 0 && ( desktopChildren[ match ] as Element ).tagName !== mobileChild.tagName ) match = -1;
			for ( let index = cursor; match < 0 && index < ( mobileAnchor ? desktopChildren.length : bound ); index++ ) {
				const candidate = desktopChildren[ index ] as Element;
				if ( desktopAnchors[ index ] && mobileAnchor !== desktopAnchors[ index ] ) continue;
				if ( candidate.tagName !== mobileChild.tagName ) continue;
				if ( ( $d( candidate ).attr( 'class' ) ?? '' ) !== mobileClass && ( deviceKey || desktopChildren.length !== mobileChildren.length ) )
					continue;
				match = index;
			}
			if ( match < 0 ) continue;
			cursor = match + 1;
			const desktopChild = desktopChildren[ match ] as Element;
			pairedDesktop.set( mobileChild, desktopChild );
			if ( sharedIdsIn( $d, desktopChild ) !== sharedIdsIn( $m, mobileChild ) ) {
				if ( deviceKey && ( divergedRoots.has( desktopAnchors[ match ] ?? '' ) || divergedRoots.has( mobileAnchor ?? '' ) ) ) continue;
				// Below <body> the identity chains already proved each shared
				// component's ancestry; there is no component to split.
				if ( path !== BODY_PATH && ! path.startsWith( `${ BODY_PATH }/` ) ) divergedRoots.add( path.split( '/' )[ 0 ] as string );
				continue;
			}
			if ( identityOf( desktopChild ) ) continue;
			projectPair( $d( desktopChild ), $m( mobileChild ), `${ path }/${ match }` );
		}
		// An id-less sibling only one capture rendered (a phone menu toggle in
		// place of the desktop link row) belongs to that side alone: it holds no
		// identified component, so it travels as a device-only island instead
		// of disappearing on one side and leaking onto the other.
		const anonymous = ( $: cheerio.CheerioAPI, child: Element ): boolean =>
			! identityOf( child ) && ! $( child ).find( '*' ).toArray().some( node => identityOf( node ) );
		// Desktop-only components inside are hidden on the phone side anyway.
		const matchedDesktop = new Set( pairedDesktop.values() );
		if ( ! deviceKey ) for ( const child of desktopChildren ) {
			if ( matchedDesktop.has( child ) || identityOf( child ) || sharedIdsIn( $d, child ) !== '' ) continue;
			$d( child ).addClass( RESPONSIVE_DESKTOP_ONLY_CLASS );
			hiddenDesktopOnly++;
		}
		if ( ! deviceKey ) mobileChildren.forEach( ( mobileChild, index ) => {
			if ( pairedDesktop.has( mobileChild ) || settled.has( mobileChild ) || ! anonymous( $m, mobileChild ) ) return;
			const island = $m( mobileChild ).clone().addClass( RESPONSIVE_MOBILE_ONLY_CLASS );
			const next = mobileChildren.slice( index + 1 ).map( sibling => pairedDesktop.get( sibling ) ).find( Boolean );
			if ( next ) $d( next ).before( $m.html( island ) ?? '' );
			else d.append( $m.html( island ) ?? '' );
			anonymousMobileOnly++;
		} );
	};
	// Chrome no identified component encloses (a builder's navbar) pairs from
	// <body> down, like the content of a shared component. Device documents
	// place components by request identity instead, one component at a time.
	if ( ! deviceKey ) pairChildren( $d( 'body' ), $m( 'body' ), BODY_PATH );
	for ( const [ id, desktopElement ] of desktopIds ) {
		const mobileElement = mobileIds.get( id );
		if ( mobileElement ) projectPair( $d( desktopElement ), $m( mobileElement ), id );
	}
	if ( incompatibleEntrance ) return cannotMerge( 'Viewport entrance evidence is invalid or incompatible across device documents' );
	deviceInlineRestores.forEach( restore => restore() );
	const divergedComponents = splitDivergedComponents( $d, $m, divergedRoots, desktopIds, mobileIds, deviceKey, identityOf );
	if ( divergedComponents === undefined ) return cannotMerge( 'Divergent component anchor identity or placement cannot be preserved' );
	$d( '[class]' ).each( ( _index, node ) => {
		const element = $d( node );
		const phoneRendered = element.closest( `.${ RESPONSIVE_MOBILE_ONLY_CLASS }` ).length > 0;
		element.attr( 'class', ( element.attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean ).map( ( token ) => ( phoneRendered || ! retainedClassTokens.has( token ) ) ? classAliases.get( token ) ?? token : token ).join( ' ' ) );
	} );
	const css =
		( desktopRules.length > 0
			? `@media(min-width:${ switchWidth + 1 }px){${ desktopRules.join( '' ) }}`
			: '' ) +
		( mobileRules.length > 0 ? `@media(max-width:${ switchWidth }px){${ mobileRules.join( '' ) }}` : '' );
	return {
		body: $d( 'body' ).html() ?? desktopBody,
		matchedNodes: sharedIdCount,
		desktopOnlyElements: hiddenDesktopOnly,
		mobileOnlyElements: insertions.length + anonymousMobileOnly,
		projectedElements,
		css,
		classAliases,
		retainedClassTokens,
		desktopClassAliases,
		divergedComponents,
		identityBasis: 'ids',
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
			const desktopSegment = d.attr( 'data-blocks-engine-capture-fluid-segment' );
			const projectedMobileStyle = hasLearnedTransform( learnedTransforms, desktopSegment )
				? withoutTransform( mobileStyle )
				: mobileStyle;
			const id = d.attr( 'id' );
			let selector: string;
			if ( id && isStableIdentityId( id ) && idCounts.get( id ) === 1 ) selector = `#${ id }`;
			else {
				// Equal hooks must project equal rules, independent of document order.
				const hook = `${ RESPONSIVE_PROJECTION_CLASS_PREFIX }${ createHash( 'sha256' )
					.update( JSON.stringify( [ switchWidth, desktopStyle, projectedMobileStyle ] ) )
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

/** Move only body compounds whose class tokens were relocated to document wrappers. */
export function projectResponsiveBodyClassCss( source: string, moved: ReadonlyMap<string, string>, preserveBody = false, documentClasses: readonly string[] = [ DESKTOP_DOCUMENT_CLASS, MOBILE_DOCUMENT_CLASS ] ): string {
	if ( moved.size === 0 || ! /body/i.test( source ) ) return source;
	const css = parseCss( source );
	css.walkRules( rule => {
		const selectors = parseSelectorList( rule.selector );
		if ( ! selectors ) return;
		const originals = new Map<selectorParser.Selector, selectorParser.Selector>();
		selectors.walkTags( tag => {
			if ( tag.value.toLowerCase() !== 'body' ) return;
			const siblings = tag.parent?.nodes ?? [];
			const index = siblings.indexOf( tag );
			let start = index;
			let end = index + 1;
			while ( start > 0 && siblings[ start - 1 ].type !== 'combinator' ) start--;
			while ( end < siblings.length && siblings[ end ].type !== 'combinator' ) end++;
			const compound = siblings.slice( start, end );
			const wrapper = compound.flatMap( node => node.type === 'class' && moved.has( node.value ) ? [ moved.get( node.value )! ] : [] )[ 0 ];
			const negatesMovedClass = compound.some( node => {
				if ( node.type !== 'pseudo' || node.value !== ':not' ) return false;
				let found = false;
				node.walkClasses( token => { if ( moved.has( token.value ) ) found = true; } );
				return found;
			} );
			if ( ! wrapper && ! negatesMovedClass ) return;
			// Linked assets can also serve routes that did not move this class.
			let owner = tag.parent;
			while ( owner && owner.parent?.type !== 'root' ) owner = owner.parent;
			if ( preserveBody && owner && selectorParser.isSelector( owner ) && ! originals.has( owner ) ) {
				const original = owner.clone();
				// Negative body conditions still match the shared body on dual routes.
				// Retain the authored selector only outside assembled documents.
				if ( negatesMovedClass ) original.prepend( selectorParser.string( { value: `:where(html:not(:has(.${ DESKTOP_DOCUMENT_CLASS }))) ` } ) );
				originals.set( owner, original );
			}
			// A negative condition must test both documents, not the wrapper that
			// owns the excluded class. Keep the original compound's conditions.
			// With more than two documents a token can live on several wrappers;
			// the compound keeps the token, so any wrapper carrying it matches.
			const replacement = wrapper && documentClasses.length <= 2
				? selectorParser.className( { value: wrapper } )
				: selectorParser().astSync( `:is(${ documentClasses.map( name => `.${ name }` ).join( ',' ) })` ).first.first!;
			replacement.spaces = tag.spaces;
			tag.replaceWith( replacement );
		} );
		for ( const original of originals.values() ) selectors.append( original );
		rule.selector = selectors.toString();
	} );
	return css.toString();
}

/** Both wrappers retain the original classes; only their difference left body. */
export function responsiveMovedBodyClasses( desktopClasses: readonly string[], mobileClasses: readonly string[] ): Map<string, string> {
	const moved = new Map<string, string>();
	for ( const token of desktopClasses ) if ( ! mobileClasses.includes( token ) ) moved.set( token, DESKTOP_DOCUMENT_CLASS );
	for ( const token of mobileClasses ) if ( ! desktopClasses.includes( token ) ) moved.set( token, MOBILE_DOCUMENT_CLASS );
	return moved;
}

/** Keep device body gates width-local, including gates in linked stylesheets.
 * Desktop-only tokens are private on the merged body; phone-only tokens use
 * the reconciliation aliases. Mutable opened/closed tokens remain replayable.
 */
export function projectCollapsedBodyClassCss( css: string, moved: ReadonlyMap<string, string>, aliases: ReadonlyMap<string, string>, switchWidth: number ): string {
	if ( !moved.size ) return css;
	const root = parseCss( css );
	const rules: postcss.Rule[] = [];
	root.walkRules( rule => { rules.push( rule ); } );
	rules.forEach( rule => {
		const selectors = parseSelectorList( rule.selector );
		if ( !selectors ) return;
		let affected = false;
		selectors.walkClasses( token => { if ( moved.has( token.value ) ) affected = true; } );
		if ( !affected ) return;
		const phone = rule.clone();
		rule.selector = aliasResponsiveClasses( `${ rule.selector }{}`, new Map( [ ...moved ].filter( ( [ , scope ] ) => scope === DESKTOP_DOCUMENT_CLASS ).map( ( [ token ] ) => [ token, `${ RESPONSIVE_PROJECTION_CLASS_PREFIX }desktop-${ token }` ] ) ) ).replace( /\{\}$/, '' );
		phone.selector = aliasResponsiveClasses( `${ phone.selector }{}`, new Map( [ ...moved ].map( ( [ token, scope ] ) => [ token, scope === MOBILE_DOCUMENT_CLASS ? aliases.get( token ) ?? token : token ] ) ) ).replace( /\{\}$/, '' );
		const desktopMedia = postcss.atRule( { name: 'media', params: `(min-width:${ switchWidth + 1 }px)` } );
		const phoneMedia = postcss.atRule( { name: 'media', params: `(max-width:${ switchWidth }px)` } );
		rule.replaceWith( desktopMedia, phoneMedia );
		desktopMedia.append( rule );
		phoneMedia.append( phone );
	} );
	return root.toString();
}

function aliasResponsiveClasses( css: string, aliases: ReadonlyMap<string, string>, retained: ReadonlySet<string> = new Set() ): string {
	if ( aliases.size === 0 ) return css;
	try {
		const root = postcss.parse( css );
		root.walkRules( ( rule ) => {
			const aliased = selectorParser( ( selectors ) => {
				selectors.walkClasses( ( node ) => {
					const alias = aliases.get( node.value );
					if ( ! alias ) return;
					if ( retained.has( node.value ) ) {
						// Match either spelling at each position, including mixed
						// selectors such as .state .state. :is keeps specificity.
						const either = selectorParser().astSync( `:is(.${ cssIdentifier( node.value ) },.${ cssIdentifier( alias ) })` ).first!.first!;
						node.replaceWith( either.clone() );
					} else node.value = alias;
				} );
			} ).processSync( rule.selector );
			rule.selector = aliased;
		} );
		return root.toString();
	} catch {
		return css;
	}
}

/**
 * Each rule reaching a desktop-aliased token gains a desktop-scoped copy that
 * names the alias, right after the original so the cascade order holds.
 */
function projectDesktopClassAliases( html: string, aliases: ReadonlyMap<string, string>, switchWidth: number, onUnparseable?: UnparseableStylesheetSink ): string {
	if ( aliases.size === 0 ) return html;
	return html.replace( /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, ( match, open: string, css: string, close: string ) => {
		const projected = projectStylesheet( () => {
			const root = parseCss( css );
			root.walkRules( rule => {
				if ( rule.parent?.type === 'atrule' && /keyframes$/i.test( ( rule.parent as postcss.AtRule ).name ) ) return;
				const aliased = aliasResponsiveClasses( `${ rule.selector }{}`, aliases ).replace( /\{\}$/, '' );
				if ( aliased === rule.selector ) return;
				rule.after( postcss.atRule( { name: 'media', params: `(min-width:${ switchWidth + 1 }px)` } ).append( rule.clone( { selector: aliased } ) ) );
			} );
			return root.toString();
		}, onUnparseable );
		return projected === undefined ? match : `${ open }${ projected }${ close }`;
	} );
}

/** Attributes that name other elements by id, so a renamed subtree keeps its own references. */
const ID_REFERENCE_ATTRIBUTES = [ 'for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'list', 'form', 'headers' ];

/**
 * Ship each re-parented shared component once per viewport: the desktop
 * rendering stays in place and is hidden at phone width, and the phone
 * rendering follows it, hidden above the switch. The phone copy's ids take the
 * `--data-blocks-engine-capture-mobile` suffix, like a phone document's, and its references within
 * the copy follow them. Nested diverged components travel with their outermost
 * one. A component whose ids a link or anchor targets cannot be renamed
 * without moving that target, so the whole page stays dual instead.
 *
 * Returns the number of split components, or undefined to keep both documents.
 */
/** Elements that render no box; neither capture's copy is a device-only island. */
const UNRENDERED_TAGS = new Set( [ 'script', 'style', 'link', 'meta', 'noscript', 'template' ] );

function isUnrenderedElement( element: Element ): boolean {
	for ( let node: AnyNode | null = element; node; node = node.parent ) {
		if ( isElementNode( node ) && UNRENDERED_TAGS.has( node.tagName ) ) return true;
	}
	return false;
}

/** Hook path root for id-less chrome paired from <body>; no identity can take it. */
const BODY_PATH = 'body';

function splitDivergedComponents(
	$d: cheerio.CheerioAPI,
	$m: cheerio.CheerioAPI,
	roots: Set< string >,
	desktopIds: Map< string, Element >,
	mobileIds: Map< string, Element >,
	deviceKey?: string,
	identityOf: ( node: Element ) => string | undefined = node => node.attribs.id
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
			node.is( '[data-blocks-engine-capture-anchor-target]' ) || node.find( '[data-blocks-engine-capture-anchor-target]' ).length > 0 || idsIn( node, $ ).some( ( value ) => linkedFragments.has( value ) );
		if ( targeted( desktop, $d ) || targeted( $m( mobileElement ), $m ) ) return undefined;
		const renamed = new Map< string, string >();
		for ( const node of [ mobile, ...mobile.find( '[id]' ).toArray().map( ( child ) => $m( child ) ) ] ) {
			const value = node.attr( 'id' );
			if ( ! value ) continue;
			renamed.set( value, `${ value }--data-blocks-engine-capture-${ deviceKey ?? 'mobile' }` );
			node.attr( 'id', `${ value }--data-blocks-engine-capture-${ deviceKey ?? 'mobile' }` );
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
		if ( deviceKey ) {
			const path: Element[] = [];
			let ancestor = mobileElement.parent;
			while ( ancestor && isElementNode( ancestor ) && ancestor.tagName !== 'body' && ! identityOf( ancestor ) ) {
				path.unshift( ancestor ); ancestor = ancestor.parent;
			}
			let parent = ancestor && isElementNode( ancestor ) && ancestor.tagName !== 'body'
				? $d( desktopIds.get( identityOf( ancestor )! )! ) : $d( 'body' );
			for ( const step of path ) {
				const candidates = parent.children().filter( ( _i, node ) => node.tagName === step.tagName && ( $d( node ).attr( 'class' ) ?? '' ) === ( $m( step ).attr( 'class' ) ?? '' ) );
				if ( candidates.length !== 1 ) return undefined;
				parent = candidates.first();
			}
			const position = $m( mobileElement ).index();
			const children = parent.children();
			if ( position < children.length ) children.eq( position ).before( $m.html( mobile ) ?? '' );
			else parent.append( $m.html( mobile ) ?? '' );
		} else desktop.after( $m.html( mobile ) ?? '' );
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
	const serialized = $.html();
	const open = documentElementTags( serialized, 'body' ).open;
	return open ? serialized.slice( open.start, open.end ) : openTag;
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
	return hasHeadClose( html )
		? insertBeforeHeadClose( html, `<style>${ override }</style>` )
		: `${ html }<style>${ override }</style>`;
}

function responsiveHtml(
	desktopHtml: string,
	mobileHtml: string,
	switchWidth: number,
	resolved: ResolvedResponsivePair,
	bindingGate?: string,
	onUnparseable?: UnparseableStylesheetSink,
	middles: readonly ResponsiveWidthDocument[] = []
): { html: string; evidence: ResponsiveVariantEvidence } {
	const assembled = assembleResponsiveHtml( desktopHtml, mobileHtml, switchWidth, resolved, bindingGate, onUnparseable, middles );
	let html = withMobileLinkedStyles( assembled.html, mobileHtml, switchWidth );
	// A missing body ships the desktop document alone, without middle documents.
	if ( assembled.evidence.outcome === 'dual-structural' ) {
		for ( const middle of middles ) html = withVariantLinkedStyles( html, middle.html, middleMedia( middle ) );
	}
	return {
		html: withScrollDrivenAnimations( html ),
		evidence: assembled.evidence,
	};
}

export type ResponsivePortableNormalization = 'absent' | 'applied' | 'pending';

/** Content evidence excludes bootstrap payloads and authored hidden content. This
 * is a conservative completeness check, not an equivalence test: a large loss
 * of BOTH sections and text indicates a shell, not ordinary device reflow.
 */
export function incompleteDeviceDocument( desktopHtml: string, mobileHtml: string ) {
	const measure = ( html: string ) => {
		const $ = cheerio.load( html );
		$( 'script,style,noscript,template,[hidden],[aria-hidden="true"]' ).remove();
		return {
			sections: $( 'body section' ).length,
			textLength: $( 'body' ).text().replace( /\s+/g, ' ' ).trim().length,
			media: $( 'body img,body video,body svg,body canvas,body iframe' ).length,
		};
	};
	const desktop = measure( desktopHtml );
	const mobile = measure( mobileHtml );
	const deficient = ( a: typeof desktop, b: typeof desktop ) =>
		( b.sections >= 4 && a.sections <= b.sections / 4 && b.textLength >= 400 && a.textLength < b.textLength / 2 ) ||
		( a.textLength === 0 && a.media === 0 && ( b.textLength >= 100 || b.media >= 3 ) );
	const device = deficient( mobile, desktop ) ? 'mobile' : deficient( desktop, mobile ) ? 'desktop' : undefined;
	return device ? { device, desktop, mobile } : undefined;
}

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
	/**
	 * Portable documents of the source's middle width ranges (#1379), ordered,
	 * contiguous from `switchWidth + 1`, after the same portable normalization.
	 * Present only on a route whose source selects a third layout by width; the
	 * route then always ships every document.
	 */
	portableMiddleHtml?: readonly ResponsiveWidthDocument[];
	/** Told when a mobile stylesheet could not be parsed and was left out of the assembly. */
	onUnparseableStylesheet?: UnparseableStylesheetSink;
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
	// Last line of defence for old captures and unsuccessful capture retries:
	// never scope the only substantive document to just one device.
	const incomplete = incompleteDeviceDocument( input.rawDesktopHtml, input.rawMobileHtml );
	if ( incomplete ) {
		return {
			html: incomplete.device === 'mobile' ? input.portableDesktopHtml : ( input.portableMobileHtml ?? input.rawMobileHtml ),
			hasMobileDocument: false,
			portableNormalization: 'absent',
		};
	}
	const portableMobileHtml = input.portableMobileHtml ?? input.rawMobileHtml;
	const middles = input.portableMiddleHtml ?? [];
	const source = resolveResponsivePair( input.rawDesktopHtml, input.rawMobileHtml, switchWidth, 'source' );
	if ( source.gate ) {
		const assembled = responsiveHtml(
			input.portableDesktopHtml,
			portableMobileHtml,
			switchWidth,
			source,
			source.gate,
			input.onUnparseableStylesheet,
			middles
		);
		return emittedAssembly( assembled, 'applied' );
	}
	if ( source.dual || middles.length ) {
		const emitted = resolveResponsivePair(
			input.portableDesktopHtml,
			portableMobileHtml,
			switchWidth,
			'emitted'
		);
		return emittedAssembly(
			responsiveHtml( input.portableDesktopHtml, portableMobileHtml, switchWidth, emitted, undefined, input.onUnparseableStylesheet, middles ),
			'applied'
		);
	}
	return emittedAssembly(
		responsiveHtml( input.rawDesktopHtml, input.rawMobileHtml, switchWidth, source, undefined, input.onUnparseableStylesheet ),
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
		hasMobileDocument: assembled.evidence.outcome === 'dual-structural' && assembled.evidence.variants >= 2,
		portableNormalization,
	};
}

function withMobileLinkedStyles( html: string, mobileHtml: string, switchWidth: number ): string {
	return withVariantLinkedStyles( html, mobileHtml, `(max-width:${ switchWidth }px)` );
}

/** Linked stylesheets only a non-default document loads, imported under that document's width media. */
function withVariantLinkedStyles( html: string, mobileHtml: string, media: string ): string {
	const mobileHead = documentElement( mobileHtml, 'head' )?.content;
	if ( ! mobileHead || ! /<link\b/i.test( mobileHead ) ) return html;
	return replaceDocumentElement( html, 'head', ( { open, content: head, close } ) => {
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
				.text( `@import url(${ href }) ${ media };` );
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

function bodyStylesheetKey( link: cheerio.Cheerio<Element> ): string | undefined {
	const rel = ( link.attr( 'rel' ) ?? '' ).toLowerCase().split( /\s+/ );
	if ( ! rel.includes( 'stylesheet' ) || rel.includes( 'alternate' ) || ! link.attr( 'href' ) || link.attr( 'disabled' ) !== undefined ) return undefined;
	return JSON.stringify( [ link.attr( 'href' ), link.attr( 'media' ) ?? 'all' ] );
}

/**
 * A stylesheet linked from a document's body applies at every width, even
 * inside a hidden document wrapper. Import each one under its document's width
 * media, as head links from a non-default document already are. Sheets shared
 * by every document instead keep their original link once in the first body.
 */
function widthLocalBodyLinks( body: string, media: string, shared: ReadonlySet< string >, retainShared = false ): string {
	const retained = new Set< string >();
	return body.replace( /<link\b[^>]*>/gi, tag => {
		const link = cheerio.load( tag, undefined, false )( 'link' );
		const key = bodyStylesheetKey( link );
		if ( key === undefined ) return tag;
		if ( shared.has( key ) ) {
			if ( ! retainShared || retained.has( key ) ) return '';
			retained.add( key );
			return tag;
		}
		const href = JSON.stringify( link.attr( 'href' ) ).replace( /</g, '\\3c ' );
		return `<style media="${ escapeHtmlAttr( link.attr( 'media' ) ?? 'all' ) }">@import url(${ href }) ${ media };</style>`;
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
			node.attr( 'data-blocks-engine-capture-responsive-source', candidate.source );
		}
	}
	return {
		desktopBody: desktop.$( 'body' ).html() ?? desktopBody,
		mobileBody: mobile.$( 'body' ).html() ?? mobileBody,
	};
}

/** Authored fragments stay route-independent. Both device targets declare the
 * fragment in markup so consumers can select the visible copy; the portable
 * runtime applies that same contract on navigation and same-page clicks.
 */
export const RESPONSIVE_FRAGMENT_RUNTIME = `(function(){
function resolve(){var fragment;try{fragment=decodeURIComponent(location.hash.slice(1));}catch(_){return;}
var targets=Array.prototype.filter.call(document.querySelectorAll('[data-blocks-engine-capture-responsive-fragment]'),function(el){return el.getAttribute('data-blocks-engine-capture-responsive-fragment')===fragment&&el.getClientRects().length;});
if(targets.length===1)targets[0].scrollIntoView();}
function schedule(){requestAnimationFrame(resolve);}
window.addEventListener('hashchange',schedule);
document.addEventListener('click',function(event){var link=event.target.closest&&event.target.closest('a[href]');if(!link)return;if(link.origin===location.origin&&link.pathname===location.pathname&&link.hash)schedule();});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',schedule);else schedule();
})();`;

/** Inherited per-document URLs also cover shared, linked and imported CSS. */
export function projectResponsiveSvgCss( css: string, ids: ReadonlySet<string> ): string {
	return css.replace( /url\(\s*(['"]?)#([^\s'"()]+)\1\s*\)/gi, ( match, _quote, id: string ) =>
		ids.has( id ) ? `var(--capture-svg-${ Buffer.from( id ).toString( 'hex' ) }, ${ match })` : match );
}

/**
 * Each maximal run of characters other than `{`, `}` and `;` that opens a
 * block, with its `{`, joined by newlines: the matches of `/[^{};]+\{/g`.
 * One linear pass; the regular expression rescans every start position of a
 * long run (a data URI, say) that does not open a block.
 */
export function blockPreludes( css: string ): string {
	const preludes: string[] = [];
	let start = 0;
	for ( let index = 0; index < css.length; index++ ) {
		const code = css.charCodeAt( index );
		if ( code !== 123 && code !== 125 && code !== 59 ) continue;
		if ( code === 123 && index > start ) preludes.push( css.slice( start, index + 1 ) );
		start = index + 1;
	}
	return preludes.join( '\n' );
}

export function projectResponsiveIdentityCss( source: string, renamed: ReadonlyMap<string, string | readonly string[]>, namedAliases: boolean ): string {
	// Do not parse unrelated source CSS just because another stylesheet owns
	// a responsive anchor. Browsers may accept useful rules around a malformed
	// declaration; identity-free styles need no rewriting or recovery here.
	const preludes = blockPreludes( source.replace( /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '' ) );
	if ( ! preludes.includes( '#' ) && ! /\[\s*id\s*=/i.test( preludes ) && ( ! namedAliases || ! /\[\s*name\b/i.test( preludes ) ) ) return source;
	// CSS accepts legacy HTML-comment wrappers; PostCSS rejects the closing CDC.
	// Strip only outer tokens, preserving quoted content inside the stylesheet.
	const css = parseCss( source.replace( /^\s*<!--/, '' ).replace( /-->\s*$/, '' ) );
	css.walkRules( rule => {
		const selectors = parseSelectorList( rule.selector );
		if ( ! selectors ) return;
		const replacements: Array<{ node: selectorParser.Identifier | selectorParser.Attribute; aliases: Array<selectorParser.Identifier | selectorParser.Attribute> }> = [];
		selectors.walkIds( id => { const value = renamed.get( id.value ); if ( value?.length ) replacements.push( { node: id, aliases: [ value ].flat().map( name => selectorParser().astSync( `#${ cssIdentifier( name ) }` ).first.first as selectorParser.Identifier ) } ); } );
		// Exact attribute ids (`[id="x"]`, Wix mesh child rules) are the same identity.
		selectors.walkAttributes( attribute => { const value = attribute.attribute === 'id' && attribute.operator === '=' && ! attribute.insensitive && attribute.value ? renamed.get( attribute.value ) : undefined; if ( value?.length ) replacements.push( { node: attribute, aliases: [ value ].flat().map( name => { const alias = attribute.clone(); alias.setValue( name, { quoteMark: '"' } ); return alias; } ) } ); } );
		if ( namedAliases ) selectors.walkAttributes( attribute => { if ( attribute.attribute === 'name' ) { const alias = attribute.clone(); alias.attribute = 'data-blocks-engine-capture-anchor-alias'; replacements.push( { node: attribute, aliases: [ alias ] } ); } } );
		for ( const { node, aliases } of replacements ) node.replaceWith( selectorParser.pseudo( { value: ':is', nodes: [
			selectorParser.selector( { value: '', nodes: [ node.clone() ] } ), ...aliases.map( alias => selectorParser.selector( { value: '', nodes: [ alias ] } ) ),
		] } ) );
		rule.selector = selectors.toString();
	} );
	return css.toString();
}

export function routePhoneDocumentFragments( html: string, documentPath: string, identities?: { ids: Map<string, string | string[]>; namedAliases: boolean; svgIds?: Set<string> }, onUnparseable?: UnparseableStylesheetSink ): string {
	// Named aliases need reconciliation even when the responsive source
	// collapsed to a single document. Preserve the cheap path for other pages.
	if ( ! html.includes( MOBILE_DOCUMENT_CLASS ) && ! /<a\b[^>]*\bname\s*=/i.test( html ) ) return html;
	const $ = cheerio.load( html );
	// Every non-default document: the phone one, then middle width ranges.
	const variants: Array< { document: cheerio.Cheerio< Element >; suffix: string } > = [
		{ document: $( `.${ MOBILE_DOCUMENT_CLASS }` ).first() as cheerio.Cheerio< Element >, suffix: '--data-blocks-engine-capture-mobile' },
	];
	for ( let index = 0; ; index++ ) {
		const { key, className } = middleVariant( index );
		const document = $( `.${ className }` ).first() as cheerio.Cheerio< Element >;
		if ( ! document.length ) break;
		variants.push( { document, suffix: `--data-blocks-engine-capture-${ key }` } );
	}
	$( '[data-blocks-engine-capture-svg-source-id]' ).each( ( _index, element ) => {
		identities?.svgIds?.add( $( element ).attr( 'data-blocks-engine-capture-svg-source-id' )! );
	} );
	const sourceIds = new Map< string, string >();
	$( `.${ DESKTOP_DOCUMENT_CLASS } [data-blocks-engine-capture-anchor-target][data-blocks-engine-capture-anchor-source-id]` ).each( ( _index, element ) => {
		const fragment = $( element ).attr( 'data-blocks-engine-capture-anchor-target' );
		const sourceId = $( element ).attr( 'data-blocks-engine-capture-anchor-source-id' );
		if ( fragment && sourceId ) sourceIds.set( fragment, sourceId );
	} );
	let changed = false;
	const renamed = new Map< string, string[] >();
	const aliases = new Set< string >();
	// A legacy named anchor inside its identically named id target is an alias,
	// not another destination. Keep its styling token without duplicating the
	// native fragment identity; browsers already prefer the ancestor's id.
	$( 'a[name]' ).each( ( _index, element ) => {
		const node = $( element );
		const name = node.attr( 'name' )!;
		if ( ! name || node.parents( '[id]' ).filter( ( _i, parent ) => $( parent ).attr( 'id' ) === name ).length === 0 ) return;
		node.attr( 'data-blocks-engine-capture-anchor-alias', name ).removeAttr( 'name' );
		aliases.add( name );
		changed = true;
	} );
	const idCounts = new Map<string, number>();
	$( '[id]' ).each( ( _index, element ) => {
		const id = $( element ).attr( 'id' )!;
		idCounts.set( id, ( idCounts.get( id ) ?? 0 ) + 1 );
	} );
	let responsiveFragments = false;
	const variantTarget = ( { document, suffix }: typeof variants[ number ], fragment: string ): boolean => {
		const variantId = `${ fragment }${ suffix }`;
		const ownId = ( id: string ) => renamed.get( id )?.find( candidate => candidate.endsWith( suffix ) ) ?? id;
		if ( document.find( '[id]' ).filter( ( _i, candidate ) => $( candidate ).attr( 'id' ) === variantId ).length === 0 ) {
			// Ordinary authored fragments have no adapter marker. Their variant
			// target still carries the original id and collides with the desktop
			// copy; preserve its associations when assigning the variant identity.
			const authored = document.find( '[id]' ).filter( ( _i, candidate ) => $( candidate ).attr( 'id' ) === fragment );
			if ( authored.length === 1 && ( idCounts.get( fragment ) ?? 0 ) < 2 ) return false;
			if ( authored.length === 1 ) {
				authored.attr( 'id', variantId );
				renamed.set( fragment, [ ...( renamed.get( fragment ) ?? [] ), variantId ] );
				changed = true;
			}
			const sourceId = sourceIds.get( fragment );
			const counterpart = authored.length === 1 ? authored : sourceId
				? document.find( '[id]' ).filter( ( _i, candidate ) => $( candidate ).attr( 'id' ) === ownId( sourceId ) )
				: $();
			if ( counterpart.length !== 1 ) return false;
			if ( authored.length !== 1 ) counterpart.before(
				`<span id="${ escapeHtmlAttr( variantId ) }" data-blocks-engine-capture-anchor-target="${ escapeHtmlAttr( fragment ) }" aria-hidden="true"></span>`
			);
		}
		const desktopTarget = $( `.${ DESKTOP_DOCUMENT_CLASS } [id]` ).filter( ( _i, element ) => $( element ).attr( 'id' ) === fragment );
		const ownTarget = document.find( '[id]' ).filter( ( _i, element ) => $( element ).attr( 'id' ) === variantId );
		if ( ownTarget.length === 1 ) {
			if ( desktopTarget.length === 1 ) desktopTarget.attr( 'data-blocks-engine-capture-responsive-fragment', fragment );
			ownTarget.attr( 'data-blocks-engine-capture-responsive-fragment', fragment );
			responsiveFragments = true;
			changed = true;
		}
		return true;
	};
	for ( const variant of variants ) {
		// An id is a destination even when only another route links to it. Keep
		// every device copy unique, not just ids named by this page's links.
		for ( const element of variant.document.find( '[id]' ).toArray() ) {
			const id = $( element ).attr( 'id' )!;
			if ( ( idCounts.get( id ) ?? 0 ) > 1 ) variantTarget( variant, id );
		}
		// Register captured section targets independently of local links: another
		// route may be the only place linking here. Other authored ids become
		// fragment targets only when a local link names them (below).
		for ( const element of variant.document.find( '[data-blocks-engine-capture-anchor-target]' ).not( 'svg,svg *' ).toArray() ) {
			const fragment = $( element ).attr( 'data-blocks-engine-capture-anchor-target' )!;
			if ( fragment ) variantTarget( variant, fragment );
		}
		for ( const fragment of aliases ) variantTarget( variant, fragment );
		variant.document.find( 'a[href]' ).each( ( _index, element ) => {
			const href = $( element ).attr( 'href' ) ?? '';
			const hash = href.indexOf( '#' );
			if ( hash < 0 ) return;
			const path = href.slice( 0, hash );
			if ( path !== '' && path.split( '?' )[ 0 ] !== documentPath ) return;
			let fragment: string;
			try { fragment = decodeURIComponent( href.slice( hash + 1 ) ); } catch { return; }
			if ( fragment && ! fragment.endsWith( variant.suffix ) ) variantTarget( variant, fragment );
		} );
	}
	if ( renamed.size > 0 || aliases.size > 0 ) {
		for ( const variant of variants ) {
			const own = new Map( [ ...renamed ].flatMap( ( [ fragment, ids ] ) => ids.filter( id => id.endsWith( variant.suffix ) ).map( id => [ fragment, id ] as const ) ) );
			if ( ! own.size ) continue;
			variant.document.find( '*' ).each( ( _index, element ) => {
				const node = $( element );
				for ( const attribute of ID_REFERENCE_ATTRIBUTES ) {
					const value = node.attr( attribute );
					if ( value !== undefined ) node.attr( attribute, value.split( /\s+/ ).map( token => own.get( token ) ?? token ).join( ' ' ) );
				}
			} );
		}
		$( 'style' ).each( ( _index, element ) => {
			const node = $( element );
			const source = node.html() ?? '';
			const projected = projectStylesheet( () => projectResponsiveIdentityCss( source, renamed, aliases.size > 0 ), onUnparseable );
			if ( projected !== undefined ) node.html( projected );
		} );
		if ( identities ) {
			for ( const [ key, value ] of renamed ) {
				const known = identities.ids.get( key );
				const merged = [ ...new Set( [ ...( known === undefined ? [] : [ known ].flat() ), ...value ] ) ];
				identities.ids.set( key, merged.length === 1 ? merged[ 0 ] : merged );
			}
			identities.namedAliases ||= aliases.size > 0;
		}
	}
	if ( responsiveFragments ) $( 'body' ).append( `<script data-blocks-engine-capture-responsive-fragments>${ RESPONSIVE_FRAGMENT_RUNTIME }</script>` );
	return changed ? $.html() : html;
}

function assembleResponsiveHtml(
	desktopHtml: string,
	mobileHtml: string,
	switchWidth: number = DEFAULT_SWITCH_WIDTH,
	resolved: ResolvedResponsivePair,
	bindingGate?: string,
	onUnparseable?: UnparseableStylesheetSink,
	/** Middle width ranges, ordered and contiguous from `switchWidth + 1`. Ship as further dual documents. */
	middles: readonly ResponsiveWidthDocument[] = []
): { html: string; evidence: ResponsiveVariantEvidence } {
	const desktopBodyMatch = documentElement( desktopHtml, 'body' );
	let desktopBody = desktopBodyMatch?.content;
	const mobileBodyMatch = documentElement( mobileHtml, 'body' );
	let mobileBody = mobileBodyMatch?.content;
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
			: insertBeforeHeadClose( html, mobileViewport );
	};
	// A middle width range is a third structural layout: never collapse.
	if ( ! middles.length && gatedByMobileClass === undefined && ! resolved.dual && ! resolved.merge ) {
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
				? replaceDocumentElement( html, 'body', ( { open, close } ) => `${ open }${ projection.body }${ close }` )
				: html;
		// Projection rules are inserted before </head>; a document without one
		// would silently lose them.
		const withProjectionStyle = ( html: string ): string => {
			if ( ! projectionStyle ) return html;
			return insertBeforeHeadClose( withHeadElement( html ), projectionStyle );
		};
		if ( styleBlocks( desktopHtml ).join( '\n' ) === styleBlocks( mobileHtml ).join( '\n' ) )
			return { html: withMobileViewport( withProjectionStyle( withProjectedBody( desktopHtml ) ) ), evidence };
		// A stylesheet present in both captures must apply at every width, so it is
		// left out of both scoping passes below and kept exactly once, unscoped, from
		// the desktop copy that already carries it.
		const shared = sharedStyleContents( desktopHtml, mobileHtml );
		return {
			html: withProjectionStyle(
				insertBeforeHeadClose(
					withMobileViewport(
						scopedStyles( withProjectedBody( desktopHtml ), `(min-width:${ switchWidth + 1 }px)`, shared )
					),
					responsiveMobileStyles( mobileHtml, undefined, switchWidth, shared )
				)
			),
			evidence,
		};
	}
	const identitySubset = gatedByMobileClass || middles.length ? undefined : resolved.merge;
	if ( identitySubset ) {
		// One body carries both renderings: mobile-only elements join the desktop
		// tree under their mapped parents and width-scoped visibility hides each
		// side's unique elements on the other regime. Anchor, media, and
		// counterpart evidence stay single-document; no mobile namespacing.
		const classes = ( attributes: string ) => ( cheerio.load( `<body${ attributes }></body>` )( 'body' ).attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean );
		const moved = responsiveMovedBodyClasses( classes( desktopBodyMatch?.attributes ?? '' ), classes( mobileBodyMatch?.attributes ?? '' ) );
		const rewrite = ( html: string ) => html.replace( /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, ( _, open, css, close ) => `${ open }${ projectStylesheet( () => projectCollapsedBodyClassCss( css, moved, identitySubset.classAliases, switchWidth ), onUnparseable ) ?? css }${ close }` );
		desktopHtml = rewrite( desktopHtml );
		mobileHtml = rewrite( mobileHtml );
		const mergedBody = rewrite( identitySubset.body );
		const desktopBodyAliases = new Map( [ ...moved ].filter( ( [ , scope ] ) => scope === DESKTOP_DOCUMENT_CLASS ).map( ( [ token ] ) => [ token, `${ RESPONSIVE_PROJECTION_CLASS_PREFIX }desktop-${ token }` ] ) );
		const shared = sharedStyleContents( desktopHtml, mobileHtml );
		// Projection and visibility rules are inserted before </head>; a document
		// without one would silently lose them.
		const withBody = replaceDocumentElement(
			withMobileViewport( withHeadElement( scopedStyles( desktopHtml, `(min-width:${ switchWidth + 1 }px)`, shared ) ) ),
			'body',
			( { open, close } ) =>
				`${ withBodyClasses( open.replace( /class=(['"])(.*?)\1/i, ( _, quote, tokens ) => `class=${ quote }${ tokens.split( /\s+/ ).map( ( token: string ) => desktopBodyAliases.get( token ) ?? token ).join( ' ' ) }${ quote }` ), mobileBodyMatch?.attributes ?? '', identitySubset.classAliases ) }${ scopedStyles( mergedBody, `(min-width:${ switchWidth + 1 }px)`, shared ) }${ close }`
		);
		return {
			html: insertBeforeHeadClose(
				projectDesktopClassAliases( withBody, identitySubset.desktopClassAliases ?? new Map(), switchWidth, onUnparseable ),
				`${ responsiveMobileStyles( mobileHtml, undefined, switchWidth, shared, identitySubset.classAliases, onUnparseable, identitySubset.retainedClassTokens ) }${ identitySubsetVisibilityCss( switchWidth ) }${
					identitySubset.css ? `<style>${ identitySubset.css }</style>` : ''
				}`
			),
			evidence: resolved.evidence,
		};
	}
	( { desktopBody, mobileBody } = markResponsiveCounterparts( desktopBody, mobileBody ) );

	// Both documents ship in one file from here on, so their anchor targets would
	// collide on a shared id. Namespace the mobile targets, not authored links.
	const desktop = cheerio.load( `<body>${ desktopBody }</body>` );
	const desktopTargets = new Map< string, string >();
	desktop( '[data-blocks-engine-capture-anchor-target][data-blocks-engine-capture-anchor-source-id]' ).each( ( _index, element ) => {
		const target = desktop( element );
		const fragment = target.attr( 'data-blocks-engine-capture-anchor-target' );
		const sourceId = target.attr( 'data-blocks-engine-capture-anchor-source-id' );
		if ( fragment && sourceId ) desktopTargets.set( fragment, sourceId );
	} );
	const occupied = new Set( desktop( '[id]' ).toArray().map( node => ( node as Element ).attribs.id ) );
	const phone = namespaceVariantDocument( desktop, desktopTargets, mobileBody, mobileHtml, 'mobile', occupied );
	mobileBody = phone.body;
	mobileHtml = phone.html;
	// Middle width ranges (#1379) ship as further wrappers, each namespaced the
	// same way under its own id suffix.
	const middleDocuments = middles.flatMap( ( middle, index ) => {
		const match = documentElement( middle.html, 'body' );
		if ( match === undefined ) return [];
		const variant = middleVariant( index );
		const namespaced = namespaceVariantDocument( desktop, desktopTargets, match.content, middle.html, variant.key, occupied );
		return [ { ...middle, ...variant, attributes: match.attributes, body: namespaced.body, html: namespaced.html, variables: namespaced.variables } ];
	} );
	const documentClasses = middleDocuments.length ? [ DESKTOP_DOCUMENT_CLASS, MOBILE_DOCUMENT_CLASS, ...middleDocuments.map( middle => middle.className ) ] : undefined;
	// The desktop document starts above the widest middle range.
	const desktopMedia = `(min-width:${ ( middleDocuments.at( -1 )?.maxWidth ?? switchWidth ) + 1 }px)`;

	const wrapperAttributes = ( baseClass: string, bodyAttributes: string, variables: readonly string[] = [] ): string => {
		const body = cheerio.load( `<body${ bodyAttributes }></body>` )( 'body' );
		const className = [ baseClass, body.attr( 'class' ) ].filter( Boolean ).join( ' ' );
		const style = [ body.attr( 'style' ), variables.join( ';' ) ].filter( Boolean ).join( ';' );
		return `class="${ escapeHtmlAttr( className ) }"${
			style ? ` style="${ escapeHtmlAttr( style ) }"` : ''
		}`;
	};
	const bodyClasses = ( bodyAttributes: string ): string[] =>
		( cheerio.load( `<body${ bodyAttributes }></body>` )( 'body' ).attr( 'class' ) ?? '' )
			.split( /\s+/ )
			.filter( Boolean );
	const movedBodyClasses = responsiveMovedBodyClasses( bodyClasses( desktopBodyMatch?.attributes ?? '' ), bodyClasses( mobileBodyMatch?.attributes ?? '' ) );
	// With middle documents, a body token every document shares stays on the
	// real body; any other token moves to the wrapper of the document whose
	// stylesheet names it (another owner's wrapper otherwise).
	const documentBodies = [
		{ className: DESKTOP_DOCUMENT_CLASS, classes: bodyClasses( desktopBodyMatch?.attributes ?? '' ) },
		{ className: MOBILE_DOCUMENT_CLASS, classes: bodyClasses( mobileBodyMatch?.attributes ?? '' ) },
		...middleDocuments.map( middle => ( { className: middle.className, classes: bodyClasses( middle.attributes ) } ) ),
	];
	const movedFor = ( className: string ): Map< string, string > => {
		if ( ! middleDocuments.length ) return movedBodyClasses;
		const moved = new Map< string, string >();
		const own = documentBodies.find( body => body.className === className );
		for ( const body of [ ...( own ? [ own ] : [] ), ...documentBodies ] ) {
			for ( const token of body.classes ) {
				if ( moved.has( token ) || documentBodies.every( other => other.classes.includes( token ) ) ) continue;
				moved.set( token, body.className );
			}
		}
		return moved;
	};
	// Use the same stylesheet projection before either shared/scoped branch.
	// This includes styles inside the captured body content as well as head styles.
	const rewrite = ( html: string, className = DESKTOP_DOCUMENT_CLASS ) => scopedStyles( html, undefined, new Set(), movedFor( className ), onUnparseable, documentClasses );
	desktopHtml = rewrite( desktopHtml );
	mobileHtml = rewrite( mobileHtml, MOBILE_DOCUMENT_CLASS );
	for ( const middle of middleDocuments ) middle.html = rewrite( middle.html, middle.className );
	const shared = gatedByMobileClass
		? new Set< string >()
		: middleDocuments.length
			// A stylesheet every document carries applies at every width.
			? new Set( styleBlocks( mobileHtml ).filter( block => styleBlocks( desktopHtml ).includes( block ) && middleDocuments.every( middle => styleBlocks( middle.html ).includes( block ) ) ) )
			: sharedStyleContents( desktopHtml, mobileHtml );
	// The desktop body is replaced below: scope its retained styles just like
	// the head. Phone styles (including learned rules) have one owner in
	// responsiveMobileStyles, so none remain in the phone body.
	const bodyLinkKeys = [ desktopBody, ...middleDocuments.map( middle => middle.body ), mobileBody ].map( body => {
		const $ = cheerio.load( body, undefined, false );
		return new Set( $( 'link' ).toArray().map( node => bodyStylesheetKey( $( node ) ) ).filter( key => key !== undefined ) );
	} );
	const sharedBodyLinks = new Set( [ ...bodyLinkKeys[ 0 ] ].filter( key => bodyLinkKeys.every( keys => keys.has( key ) ) ) );
	desktopBody = widthLocalBodyLinks( scopedStyles( rewrite( desktopBody ), desktopMedia, shared ), desktopMedia, sharedBodyLinks, true );
	mobileBody = widthLocalBodyLinks( mobileBody.replace( /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '' ), `(max-width:${ switchWidth }px)`, sharedBodyLinks );
	const sharedBodyClasses = [ ...new Set( documentBodies[ 0 ].classes ) ].filter(
		( className ) => documentBodies.slice( 1 ).every( body => body.classes.includes( className ) )
	);
	// Linked stylesheets are not projected, so a body id every document shares
	// (`#dmRoot.responsiveTablet …`) must stay on the real body.
	const bodyIds = [ desktopBodyMatch?.attributes ?? '', mobileBodyMatch?.attributes ?? '', ...middleDocuments.map( middle => middle.attributes ) ]
		.map( attributes => cheerio.load( `<body${ attributes }></body>` )( 'body' ).attr( 'id' ) );
	const sharedBodyId = bodyIds[ 0 ] && bodyIds.every( id => id === bodyIds[ 0 ] ) ? bodyIds[ 0 ] : undefined;
	const outerBody = `<body${ sharedBodyId ? ` id="${ escapeHtmlAttr( sharedBodyId ) }"` : '' }${
		sharedBodyClasses.length > 0
			? ` class="${ escapeHtmlAttr( sharedBodyClasses.join( ' ' ) ) }"`
			: ''
	}>`;
	const responsiveBody = `<div ${ wrapperAttributes(
		DESKTOP_DOCUMENT_CLASS,
		desktopBodyMatch?.attributes ?? ''
	) } data-blocks-engine-capture-document-scope>${ desktopBody }</div>${ middleDocuments.map( middle => `<div ${ wrapperAttributes(
		middle.className,
		middle.attributes,
		middle.variables
	) } data-blocks-engine-capture-document-scope>${ widthLocalBodyLinks( middle.body.replace( /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '' ), middleMedia( middle ), sharedBodyLinks ) }</div>` ).join( '' ) }<div ${ wrapperAttributes(
		MOBILE_DOCUMENT_CLASS,
		mobileBodyMatch?.attributes ?? '',
		phone.variables
	) } data-blocks-engine-capture-document-scope>${ mobileBody }</div>`;
	const evidence = middleDocuments.length
		? widthRangeEvidence( gatedByMobileClass, switchWidth, middleDocuments )
		: dualStructuralEvidence( gatedByMobileClass );
	const mobileStyles = responsiveMobileStyles(
		mobileHtml,
		`.${ MOBILE_DOCUMENT_CLASS }`,
		switchWidth,
		shared,
		undefined,
		onUnparseable,
		undefined,
		documentClasses ? { documentClasses } : undefined
	);
	const middleStyles = middleDocuments.map( middle => responsiveMobileStyles(
		middle.html,
		`.${ middle.className }`,
		switchWidth,
		shared,
		undefined,
		onUnparseable,
		undefined,
		{ media: middleMedia( middle ), documentClasses }
	) ).join( '' );
	const middleSwitch = middleDocuments.map( middle =>
		`.${ middle.className }{display:none!important}@media${ middleMedia( middle ) }{.${ DESKTOP_DOCUMENT_CLASS }{display:none!important}.${ middle.className }{display:contents!important}}`
	).join( '' );
	return {
		html: replaceDocumentElement(
			insertBeforeHeadClose(
				insertAfterHeadOpen(
					withMobileViewport( scopedStyles( desktopHtml, desktopMedia, shared ) ),
					RESPONSIVE_DOCUMENT_RESET_CSS
				),
				`${ middleStyles }${ mobileStyles }<style>${ RESPONSIVE_DOCUMENT_CSS }${ middleSwitch }${ documentSwitchCss( switchWidth ) }</style>`
			),
			'body',
			( { close } ) => `${ outerBody }${ responsiveBody }${ close }`
		),
		evidence,
	};
}

/**
 * Namespace one non-default document against the desktop copy: its anchor
 * targets and colliding SVG resource ids take the variant's id suffix, its own
 * links follow them, and its stylesheets reach renamed SVG resources through
 * per-wrapper custom properties.
 */
function namespaceVariantDocument(
	desktop: cheerio.CheerioAPI,
	desktopTargets: ReadonlyMap< string, string >,
	body: string,
	html: string,
	key: string,
	occupied: Set< string >
): { body: string; html: string; variables: string[] } {
	const suffix = `--data-blocks-engine-capture-${ key }`;
	const variant = cheerio.load( `<body>${ body }</body>` );
	variant( 'a[data-blocks-engine-capture-anchor-fragment]' ).each( ( _index, element ) => {
		const fragment = variant( element ).attr( 'data-blocks-engine-capture-anchor-fragment' );
		const sourceId = fragment ? desktopTargets.get( fragment ) : undefined;
		if ( ! fragment || variant( `[data-blocks-engine-capture-anchor-target="${ fragment }"]` ).length > 0 ) return;
		if ( sourceId ) {
			const counterpart = variant( '[id]' )
				.filter( ( _i, candidate ) => variant( candidate ).attr( 'id' ) === sourceId )
				.first();
			if ( counterpart.length === 1 ) {
				counterpart.attr( 'data-blocks-engine-capture-anchor-target', fragment );
				return;
			}
		}
		const localTarget = variant( '[id]' )
			.filter( ( _i, candidate ) => variant( candidate ).attr( 'id' ) === fragment )
			.first();
		if ( localTarget.length === 1 ) localTarget.attr( 'data-blocks-engine-capture-anchor-target', fragment );
	} );
	variant( '[data-blocks-engine-capture-anchor-target]' ).each( ( _index, element ) => {
		const node = variant( element );
		const fragment = node.attr( 'data-blocks-engine-capture-anchor-target' );
		if ( fragment && desktop( '[id]' ).toArray().some( target => desktop( target ).attr( 'id' ) === fragment ) ) node.attr( 'id', `${ fragment }${ suffix }` );
	} );
	// Only SVG resources are private identities; authored HTML ids remain a contract.
	const svgIds = new Set<string>();
	for ( const node of variant( '[id]' ).toArray() ) occupied.add( ( node as Element ).attribs.id );
	const desktopIds = new Set( desktop( '[id]' ).toArray().map( node => desktop( node ).attr( 'id' ) ) );
	const variables: string[] = [];
	variant( 'svg [id]' ).filter( ( _index, element ) => [ 'clippath', 'mask', 'filter', 'lineargradient', 'radialgradient', 'pattern', 'marker', 'symbol' ].includes( element.name.toLowerCase() ) ).each( ( _index, element ) => {
		const node = variant( element );
		const id = node.attr( 'id' )!;
		if ( ! desktopIds.has( id ) ) return;
		let variantId = `${ id }${ suffix }`;
		for ( let counter = 2; occupied.has( variantId ); counter++ ) variantId = `${ id }${ suffix }-${ counter }`;
		occupied.add( variantId );
		svgIds.add( id );
		node.attr( 'id', variantId ).attr( 'data-blocks-engine-capture-svg-source-id', id );
		variables.push( `--capture-svg-${ Buffer.from( id ).toString( 'hex' ) }:url("#${ variantId }")` );
		variant( 'svg *' ).each( ( _i, reference ) => {
			for ( const attribute of [ 'href', 'xlink:href' ] ) {
				if ( variant( reference ).attr( attribute ) === `#${ id }` ) variant( reference ).attr( attribute, `#${ variantId }` );
			}
		} );
	} );
	variant( '*' ).each( ( _index, element ) => {
		const node = variant( element );
		for ( const attribute of [ 'style', 'clip-path', 'mask', 'filter', 'fill', 'stroke', 'marker', 'marker-start', 'marker-mid', 'marker-end' ] ) {
			const value = node.attr( attribute );
			if ( value ) node.attr( attribute, projectResponsiveSvgCss( value, svgIds ) );
		}
	} );
	return {
		body: variant( 'body' ).html() ?? body,
		html: html.replace( /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, ( _, open, css, close ) => `${ open }${ projectResponsiveSvgCss( css, svgIds ) }${ close }` ),
		variables,
	};
}

function equivalentEvidence(
	desktopHtml: string,
	mobileHtml: string,
	projection: EquivalentInlineProjection | undefined
): ResponsiveVariantEvidence {
	const sharedStyles = styleBlocks( desktopHtml ).join( '\n' ) === styleBlocks( mobileHtml ).join( '\n' );
	// Structural equivalence is total correspondence: every element of the one
	// tree has its counterpart in both captures.
	const desktopBody = responsiveBodyContent( desktopHtml );
	const matchedNodes = desktopBody === undefined ? 0 : cheerio.load( `<body>${ desktopBody }</body>` )( 'body *' ).length;
	return {
		variants: 1,
		outcome: 'collapsed-equivalent',
		reason:
			'mobile document is structurally equivalent to desktop once capture-infrastructure attributes are normalized; shipped one document',
		css: sharedStyles ? 'shared' : 'viewport-scoped',
		...( matchedNodes > 0 ? { matchedNodes } : {} ),
		...( projection && projection.projectedElements > 0
			? { projectedInlineStyles: projection.projectedElements }
			: {} ),
	};
}

function identitySubsetEvidence(
	desktopHtml: string,
	mobileHtml: string,
	merge: ViewportTreeReconciliation
): ResponsiveVariantEvidence {
	const sharedStyles = styleBlocks( desktopHtml ).join( '\n' ) === styleBlocks( mobileHtml ).join( '\n' );
	return {
		variants: 1,
		outcome: 'collapsed-identity-subset',
		reason: `mobile document reconciles with desktop by ${ merge.identityBasis === 'ids' ? 'element identity' : 'node correspondence (text and media identity)' } (${ merge.matchedNodes } matched nodes; ${ merge.mobileOnlyElements } mobile-only, ${ merge.desktopOnlyElements } desktop-only elements${
			merge.divergedComponents > 0 ? `, ${ merge.divergedComponents } re-parented component${ merge.divergedComponents === 1 ? '' : 's' } shipped per viewport` : ''
		}); shipped one document`,
		css: sharedStyles ? 'shared' : 'viewport-scoped',
		matchedNodes: merge.matchedNodes,
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

function widthRangeEvidence(
	gatedClass: string | undefined,
	switchWidth: number,
	middles: ReadonlyArray< { key: string; minWidth: number; maxWidth: number } >
): ResponsiveVariantEvidence {
	return {
		variants: 2 + middles.length,
		outcome: 'dual-structural',
		reason: `the source selects ${ 2 + middles.length } layouts by width${ gatedClass ? ` and a phone-only body class gates desktop CSS (body:not(.${ gatedClass }))` : '' }; every layout shipped and is selected at the source's own boundaries`,
		widthRanges: [
			{ document: 'mobile', maxWidth: switchWidth },
			...middles.map( middle => ( { document: middle.key, minWidth: middle.minWidth, maxWidth: middle.maxWidth } ) ),
			{ document: 'desktop', minWidth: ( middles.at( -1 )?.maxWidth ?? switchWidth ) + 1 },
		],
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
	const desktopBody = documentElement( desktopHtml, 'body' )?.content;
	const mobileBody = documentElement( mobileHtml, 'body' )?.content;
	if ( desktopBody === undefined || mobileBody === undefined ) {
		return { role, missingBody: true, dual: false, evidence: missingBodyEvidence() };
	}
	// Native effects bind target and subject within one source document. A tree
	// collapse must not discard one profile's effects or redirect its subjects.
	if ( /data-blocks-engine-capture-native-effects=/.test( desktopHtml + mobileHtml ) ) {
		return { role, missingBody: false, dual: true, evidence: { ...dualStructuralEvidence( undefined ), reason: 'Native view timelines retain profile-scoped target and subject identities.' } };
	}
	if ( requiresNativeInlineCascade( desktopHtml, mobileHtml ) ) {
		return {
			role,
			missingBody: false,
			dual: true,
			evidence: {
				...dualStructuralEvidence( undefined ),
				reason: 'Normal inline state conflicts with authored important CSS; both variants retain their native cascade without priority promotion.',
			},
		};
	}
	if ( responsiveBodySignature( desktopBody, desktopHtml + mobileHtml ) === responsiveBodySignature( mobileBody, desktopHtml + mobileHtml ) ) {
		const projection = equivalentInlineProjection( desktopHtml, mobileHtml, switchWidth );
		return {
			role,
			missingBody: false,
			dual: false,
			projection,
			evidence: equivalentEvidence( desktopHtml, mobileHtml, projection ),
		};
	}
	// Node correspondence (#1034 point 5) reconciles the pair that ships: the
	// source pair keeps the honest dual verdict, because rendering normalization
	// may still remove the very difference a raw-tree match would have recorded.
	const merge = identitySubsetMerge( desktopHtml, mobileHtml, switchWidth ) ??
		( role === 'emitted' ? correspondenceMerge( desktopHtml, mobileHtml, switchWidth ) : undefined );
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
class SharedStyles extends Set< string > {
	readonly desktop = new Map< string, Array< { common: boolean; css: string } > >();
	readonly mobile = new Map< string, string >();
}

function sharedStyleContents( desktopHtml: string, mobileHtml: string ): SharedStyles {
	const desktop = styleBlocks( desktopHtml );
	const mobile = styleBlocks( mobileHtml );
	const layout = ( html: string ): string => {
		const $ = cheerio.load( html );
		return $( 'head style,head link[rel~="stylesheet" i]' ).toArray().map( node => {
			const sheet = $( node );
			return sheet.is( 'style' ) ? `style:${ JSON.stringify( sheet.attr() ) }` : $.html( node );
		} ).join( '\n' );
	};
	const shared = new SharedStyles( mobile.filter( block => desktop.includes( block ) ) );
	// Pair only aligned source sheets. Moving rules between unrelated sheets
	// would lose the cascade information this optimization relies on.
	if ( desktop.length !== mobile.length || layout( desktopHtml ) !== layout( mobileHtml ) ) return shared;
	// Promoting a common rule from a later sheet could move it before the
	// preceding sheet's replay. Optimize one differing counterpart at a time;
	// multiple differing sheets retain the established viewport-only cascade.
	if ( mobile.filter( block => ! shared.has( block ) ).length !== 1 ) return shared;
	for ( let index = 0; index < mobile.length; index++ ) {
		if ( shared.has( mobile[ index ] ) ) continue;
		const projection = projectStylesheet( () => {
			const base = parseCss( desktop[ index ] );
			const phone = parseCss( mobile[ index ] );
			// Compare whole top-level nodes, including conditional blocks, font
			// faces and keyframes. Never split a block or promote order-sensitive
			// imports, layer declarations/blocks or charset declarations.
			let orderSensitive = false;
			for ( const sheet of [ base, phone ] ) sheet.walkAtRules( rule => {
				if ( /^(?:import|layer|charset)$/i.test( rule.name ) ) orderSensitive = true;
			} );
			if ( orderSensitive ) return;
			const keys = base.nodes.map( node => node.toString() );
			const phoneKeys = phone.nodes.map( node => node.toString() );
			// Duplicate keys and reordered common nodes cannot be identified by
			// content alone. Fall back rather than promote the wrong occurrence.
			if ( new Set( keys ).size !== keys.length || new Set( phoneKeys ).size !== phoneKeys.length ) return;
			let previous = -1;
			for ( const key of phoneKeys ) {
				const position = keys.indexOf( key );
				if ( position === -1 ) continue;
				if ( position < previous ) return;
				previous = position;
			}
			const retained = new Set< string >();
			let lastCommon = -1;
			let changed = false;
			for ( const node of [ ...phone.nodes ] ) {
				const key = node.toString();
				const position = keys.indexOf( key );
				// Once a delta has appeared, replay later common rules too: even
				// different selectors can match the same node, and shorthands,
				// custom properties and !important make property guesses unsafe.
				if ( ! changed && position > lastCommon ) {
					lastCommon = position;
					retained.add( key );
					node.remove();
				} else changed = true;
			}
			if ( retained.size === 0 ) return;
			const runs: Array< { common: boolean; css: string } > = [];
			for ( const node of base.nodes ) {
				const common = retained.has( node.toString() );
				const last = runs.at( -1 );
				if ( last?.common === common ) last.css += node.toString();
				else runs.push( { common, css: node.toString() } );
			}
			return { runs, delta: phone.toString() };
		} );
		if ( ! projection ) continue;
		shared.desktop.set( desktop[ index ], projection.runs );
		shared.mobile.set( mobile[ index ], projection.delta );
	}
	return shared;
}

function responsiveMobileStyles(
	mobileHtml: string,
	scope?: string,
	switchWidth: number = DEFAULT_SWITCH_WIDTH,
	skip: ReadonlySet< string > = new Set(),
	classAliases: ReadonlyMap<string, string> = new Map(),
	onUnparseable?: UnparseableStylesheetSink,
	retainedClassTokens: ReadonlySet<string> = new Set(),
	/** A middle range's own media, and every emitted document class. Default: the phone side of the switch. */
	range: { media?: string; documentClasses?: readonly string[] } = {}
): string {
	const media = range.media ?? `(max-width:${ switchWidth }px)`;
	const documentClasses = range.documentClasses ?? [ DESKTOP_DOCUMENT_CLASS, MOBILE_DOCUMENT_CLASS ];
	const mobileBodyAttributes = bodyAttributes( mobileHtml );
	const rootClasses = (
		cheerio.load( `<body${ mobileBodyAttributes }></body>` )( 'body' ).attr( 'class' ) ?? ''
	)
		.split( /\s+/ )
		.filter( Boolean );
	// Learned rules already carry their width conditions and document-specific
	// identities. Keep them intact alongside the scoped source styles.
	const fluidRules = [ ...mobileHtml.matchAll( /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi ) ]
		.filter( match => FLUID_RULES_STYLE_ATTRIBUTE.test( match[ 1 ] ?? '' ) )
		.map( match => match[ 0 ] )
		.join( '' );
	return fluidRules + styleBlocks( mobileHtml )
		.filter( ( style ) => style !== '' && ( ! skip.has( style ) || classAliases.size > 0 ) )
		.map(
			( original ) => {
				// Byte-identical counterparts have no raw delta, but aliasing can
				// still change individual selectors in their phone replay.
				const delta = ( skip instanceof SharedStyles ? skip.mobile.get( original ) : undefined ) ??
					( skip.has( original ) ? '' : undefined );
				// Common rules whose selector spelling changes still need a phone
				// copy. Select before aliasing, retaining their original source order.
				const selected = delta !== undefined && classAliases.size > 0
					? projectStylesheet( () => {
						const rules = parseCss( original );
						const deltaKeys = new Set( parseCss( delta ).nodes.map( node => node.toString() ) );
						// A common rule already reaches retained tokens unscoped; only
						// the phone-only delta needs them beside their alias.
						for ( const node of [ ...rules.nodes ] ) {
							const css = node.toString();
							const aliased = aliasResponsiveClasses( css, classAliases, deltaKeys.has( css ) ? retainedClassTokens : undefined );
							if ( aliased === css && ! deltaKeys.has( css ) ) node.remove();
							else if ( aliased !== css ) node.replaceWith( parseCss( aliased ).nodes );
						}
						return rules.toString();
					}, onUnparseable ) ?? original
					: undefined;
				const style = selected ?? aliasResponsiveClasses( delta ?? original, classAliases, retainedClassTokens );
				if ( ! style.trim() ) return '';
				const projected = scope ? projectStylesheet( () => scopeCss( style, { scope, rootClasses: [ ...rootClasses, ...documentClasses ] } ), onUnparseable ) : style;
				return projected === undefined ? '' : `<style media="${ media }">${ projected }</style>`;
			}
		)
		.join( '' );
}

function scopedStyles(
	html: string,
	media: string | undefined,
	skip: ReadonlySet< string > = new Set(),
	movedBodyClasses: ReadonlyMap<string, string> = new Map(),
	onUnparseable?: UnparseableStylesheetSink,
	documentClasses?: readonly string[]
): string {
	return html.replace(
		/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi,
		( match, attributes: string, css: string ) => {
			if ( movedBodyClasses.size ) {
				// An unparseable stylesheet is reported and kept as authored.
				const projected = projectStylesheet( () => projectResponsiveBodyClassCss( css, movedBodyClasses, false, documentClasses ), onUnparseable );
				if ( projected !== undefined ) {
					css = projected;
					match = `<style${ attributes }>${ css }</style>`;
				}
			}
			if ( media === undefined ) return match;
			// Capture-generated rules carry their own media conditions and are
			// width-independent by construction; narrowing them to one side of
			// the switch would strand the other regime's rule.
			if ( FLUID_RULES_STYLE_ATTRIBUTE.test( attributes ) ) return match;
			const runs = skip instanceof SharedStyles ? skip.desktop.get( css.trim() ) : undefined;
			if ( runs ) {
				return runs.map( run =>
					run.common ? `<style${ attributes }>${ run.css }</style>` : scopedStyles( `<style${ attributes }>${ run.css }</style>`, media )
				).join( '' );
			}
			if ( skip.has( css.trim() ) ) return `<style${ attributes }>${ css }</style>`;
			const existingMedia = /\bmedia\s*=\s*(["'])(.*?)\1/i.exec( attributes );
			if ( ! existingMedia ) return `<style${ attributes } media="${ media }">${ css }</style>`;
			const combined = combineMediaQueries( media, existingMedia[ 2 ]! );
			// Independent gates preserve whole-query negation, including query lists.
			if ( combined === undefined ) return `<style${ attributes }>@media ${ media }{${ css }}</style>`;
			const scopedAttributes = attributes.replace(
				existingMedia[ 0 ],
				`media=${ existingMedia[ 1 ] }${ combined }${ existingMedia[ 1 ] }`
			);
			return `<style${ scopedAttributes }>${ css }</style>`;
		}
	);
}

function responsiveBodySignature( body: string, stylesHtml: string ): string {
	// A styled state token changes rendering even when the element tree agrees.
	// Ignore unstyled runtime markers, but send presentation differences through
	// correspondence so each viewport keeps its captured classes.
	const styledClasses = new Set( [ ...styleBlocks( stylesHtml ).join( '' ).matchAll( /\.(-?[_a-zA-Z][\w-]*)/g ) ].map( match => match[ 1 ] as string ) );
	const $ = cheerio.load( `<body>${ body }</body>` );
	$( 'script,style,noscript,iframe' ).remove();
	// Consent managers lay out their own chrome per viewport; it is not the page.
	$( 'body *' )
		.filter( ( _index, element ) => $( element ).is( CONSENT_OVERLAY_DIALOG_SELECTOR ) || CONSENT_VENDOR_RE.test( `${ $( element ).attr( 'id' ) ?? '' } ${ $( element ).attr( 'class' ) ?? '' }` ) )
		.filter( ( _index, element ) => isConsentOverlayRoot( {
			tag: element.tagName,
			id: $( element ).attr( 'id' ) ?? '',
			className: $( element ).attr( 'class' ) ?? '',
			role: $( element ).attr( 'role' ) ?? null,
			ariaModal: $( element ).attr( 'aria-modal' ) === 'true',
			ariaLabel: $( element ).attr( 'aria-label' ) ?? null,
			text: $( element ).text().slice( 0, 4000 ),
		} ) )
		.remove();
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
			if ( attribute === 'class' ) {
				const tokens = ( node.attr( 'class' ) ?? '' ).split( /\s+/ ).filter( token => styledClasses.has( token ) ).sort();
				if ( tokens.length ) node.attr( 'class', tokens.join( ' ' ) );
				else node.removeAttr( 'class' );
			} else if ( ! STRUCTURAL_SIGNATURE_ATTRIBUTES.has( attribute ) ) node.removeAttr( attribute );
		}
		for ( const attribute of [ 'id', 'name' ] ) {
			const value = node.attr( attribute );
			if ( value && isUnstableResponsiveId( value ) ) node.removeAttr( attribute );
		}
		// Hydration can write an anchor's resolved .href back to its attribute
		// in only one viewport. URL-equivalent spellings are not a second
		// document (host casing, default ports, an empty root path). Compare
		// them canonically in this private signature, never in the shipped DOM.
		// Without a document base, relative and scheme-relative references must
		// stay literal. Do not use route-key normalization: /path and /path/,
		// query strings and fragments can name genuinely different destinations.
		for ( const attribute of [ 'href', 'action' ] ) {
			const value = node.attr( attribute );
			if ( ! value || ! /^https?:\/\//i.test( value ) ) continue;
			try {
				node.attr( attribute, new URL( value ).href );
			} catch {
				// Invalid source references still compare by their authored bytes.
			}
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
