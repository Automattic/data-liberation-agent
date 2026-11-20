import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { srcsetCandidates } from './srcset.js';
import { elementDescriptor, styleBlocks, templateFingerprint, TEMPLATE_FINGERPRINT_VERSION, type TemplateStyleBlock, type TemplateStyleNormalization } from './template-groups.js';

/**
 * Template-clustered capture, phase 1 (#784).
 *
 * Phase 0 (#786, `template-groups.ts`) groups the inventory by a structural
 * fingerprint of the server HTML. Phase 1 produces every non-sampled member
 * of a verified multi-member cluster by transplanting its HTTP-acquired
 * content (`H_M`) into the representative's captured, processed DOM (`D_R`):
 * the slot walk between `H_R` and `H_M` finds content slots, each slot is
 * anchored on its nearest identified ancestor (`id`, then `data-testid`) plus
 * a short path below it, and that anchor is resolved in `D_R` by identity —
 * builder runtimes rebuild the DOM around ids, so server positions never
 * survive. Each member is admitted only through cheap per-member gates. A member that fails a gate never ships as derived: it
 * escalates to the browser pipeline or is omitted by budget with a reason.
 */

export const TEMPLATE_CLUSTERS_SCHEMA = 'data-liberation-agent/template-clusters/v1';

/** Receipt file name, next to `website/` (never inside it). */
export const TEMPLATE_CLUSTERS_FILE = 'template-clusters.json';

export const TEMPLATE_CLUSTER_LIMITS = {
	/** Members derived at most per capture; HTTP throughput bounds the rest. */
	maxDerivedRoutes: 2000,
	/** Per-member document fetch timeout, as in template grouping. */
	requestTimeoutMs: 15_000,
} as const;

/**
 * Why a member was not derived. `route_template_escalated` names these in
 * `metrics.gate`; the loss-ledger codes live in capture.ts.
 */
export type GateCode =
	| 'runtime_media_unmapped' /** Adapter could not resolve member runtime media. */
	| 'cluster_key_mismatch' /** H_M's fingerprint is not the cluster's key. */
	| 'slot_anchor_unmapped' /** a slot has no matching anchor in `D_R`. */
	| 'runtime_slot_content' /** a slot carries scripts, handlers or embeds capture never observed. */
	| 'runtime_mount_member_keyed' /** a runtime-filled mount has different member attributes. */;

export interface SlotStats {
	/** Total mapped slots (subtree + text + attribute + head). */
	slots: number;
	/** Subtree slots among the mapped ones. */
	subtreeSlots: number;
}

export interface MemberGate {
	code: GateCode;
	reason: string;
	/** The runtime region that a bounded member render must observe. */
	runtimeAnchor?: SlotAnchor;
}

export type MemberDerivation =
	| { ok: true; html: string; stats: SlotStats; unobservedSlots: number }
	| { ok: false; gate: MemberGate };

const isElement = ( node: AnyNode ): node is Element => node.type === 'tag' || node.type === 'script' || node.type === 'style';

// Body styles carry member content too (for example selectors for a block id).
const SKIPPED_ELEMENTS = new Set( [ 'script', 'noscript', 'template', 'br', 'wbr', 'link', 'meta', 'base' ] );

/** Inline (phrasing) elements: presence follows the text, so they never split slots by themselves. */
const INLINE_ELEMENTS = new Set( [ 'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'img', 'ins', 'kbd', 'label', 'mark', 'picture', 'q', 's', 'samp', 'small', 'source', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr' ] );

/** Attributes whose difference is authored content, per §3.1. */
const SLOT_ATTRIBUTES = [ 'href', 'src', 'srcset', 'sizes', 'datetime', 'alt', 'id', 'class', 'aria-current' ] as const;

/**
 * Head slots: `<title>`, description, canonical, and the Open Graph, Twitter
 * and article metadata, under either `property` or `name`.
 */
const HEAD_SLOT_META = /^(?:description|(?:og|twitter|article):.+)$/i;

/** Resolve an asset reference the way a browser would, for capture comparisons. */
function resolveUrl( value: string, baseUrl: string ): string {
	if ( ! value || /^[a-z][a-z\d+.-]*:/i.test( value ) || value.startsWith( '#' ) ) return value;
	try {
		return new URL( value, baseUrl ).href;
	} catch {
		try {
			return new URL( value, pathToFileURL( baseUrl + '/' ).href ).href;
		} catch {
			return value;
		}
	}
}

const normalizedWhitespace = ( value: string ): string => value.replace( /\s+/g, ' ' ).trim();

/**
 * Slot-eligible element children, in order, skipping head noise. Capture
 * annotates source elements in place (`data-blocks-engine-capture-geometry-id`
 * and friends), so an annotated element is still the source's element and
 * keeps its position. A node capture inserted shifts the path below its
 * anchor; the anchor's tag and text check then escalates the member.
 */
const slotChildren = ( element: Element ): Element[] =>
	element.children.filter( ( node ): node is Element => isElement( node ) && ! SKIPPED_ELEMENTS.has( node.name ) );

/** The element's text including inline children, normalized; attributes ignored. */
const inlineText = ( element: Element ): string => {
	const parts: string[] = [];
	for ( const node of element.children ) {
		if ( node.type === 'text' ) parts.push( normalizedWhitespace( node.data ) );
		else if ( isElement( node ) && INLINE_ELEMENTS.has( node.name ) ) parts.push( inlineText( node ) );
	}
	return normalizedWhitespace( parts.join( ' ' ) );
};

interface Slot {
	/** The representative's server node (`H_R`) the slot replaces. */
	repNode: Element;
	/** The member's server node (`H_M`) at the same place in the walk. */
	memberNode: Element;
	/**
	 * `element`: the member element replaces the anchor (outer HTML).
	 * `subtree`: the member's child nodes, text included, replace the anchor's.
	 * `text`: the member's own text nodes replace the anchor's, one for one, so
	 * inline children (links, emphasis) stay in place and are walked as slots.
	 */
	kind: 'element' | 'subtree' | 'text' | 'attribute';
	/** Member-side replacement: outer or inner HTML, own text nodes, or attribute map. */
	replacement: string | string[] | Array< { attribute: string; value: string } >;
	/** Bytes the member contributed; verification sampling orders members by this. */
	bytes: number;
}

/**
 * Where a slot lives, independent of its server-document position: the nearest
 * ancestor-or-self carrying an `id` (fallback `data-testid`) unique in `H_R`,
 * plus the element path below it. Builder runtimes rebuild the DOM around
 * these identities, so a position from the body root never survives into the
 * captured document; the identity does. A slot with no identified ancestor is
 * anchored on `<body>` itself.
 */
export interface SlotAnchor {
	attribute: 'id' | 'data-testid' | 'body';
	value: string;
	/** Element path below the anchor, over slot-eligible children. */
	path: number[];
	/** The same path as `[tag, classes, ordinal among siblings that match them]`, immune to runtime-inserted siblings. */
	descriptors: Array< [ string, string[], number ] >;
}

/** Anchor attributes, most stable first. */
const ANCHOR_ATTRIBUTES = [ 'id', 'data-testid' ] as const;

/** Resolve the gate's anchor with the same mapping used by derivation. */
export function runtimeMountSelector( html: string, anchor: SlotAnchor ): string | undefined {
	const $ = cheerio.load( html );
	const body = $( 'body' )[ 0 ];
	if ( ! body ) return undefined;
	let node = resolveAnchor( body, anchor, () => true );
	if ( ! node ) return undefined;
	const path: string[] = [];
	while ( node !== body ) {
		path.unshift( `:nth-child(${ $( node ).index() + 1 })` );
		node = node.parent && isElement( node.parent ) ? node.parent : undefined;
		if ( ! node ) return undefined;
	}
	return [ 'body', ...path ].join( ' > ' );
}

/**
 * Splice the live mount's children into the server document's mount, resolved
 * through the same anchor. Every byte outside the mount's element content is
 * the server document's own, so preparation and identity stay intact.
 */
export function transplantRuntimeMount( serverHtml: string, liveHtml: string, anchor: SlotAnchor ): string | undefined {
	const live = cheerio.load( liveHtml );
	const liveBody = live( 'body' )[ 0 ];
	const liveMount = liveBody && resolveAnchor( liveBody, anchor, () => true );
	const server = cheerio.load( serverHtml, { sourceCodeLocationInfo: true } );
	const serverBody = server( 'body' )[ 0 ];
	const serverMount = serverBody && resolveAnchor( serverBody, anchor, () => true );
	const location = serverMount?.sourceCodeLocation;
	if ( ! liveMount || ! location?.startTag || ! location.endTag ) return undefined;
	return serverHtml.slice( 0, location.startTag.endOffset ) + ( live( liveMount ).html() ?? '' ) + serverHtml.slice( location.endTag.startOffset );
}

/** A script tag alone is not a filled mount; text, images and other markup are. */
export function runtimeMountObserved( html: string, anchor: SlotAnchor ): boolean {
	const selector = runtimeMountSelector( html, anchor );
	if ( ! selector ) return false;
	const $ = cheerio.load( html );
	const mount = $( selector ).clone();
	mount.find( 'script, style, template' ).remove();
	return normalizedWhitespace( mount.text() ) !== '' || mount.children().length > 0;
}

const describeAnchor = ( anchor: SlotAnchor ): string =>
	`${ anchor.attribute === 'body' ? 'body' : `[${ anchor.attribute }="${ anchor.value }"]` }${ anchor.path.map( index => `/${ index }` ).join( '' ) }`;

/** Elements of a document carrying one anchor attribute value. */
function elementsWithAttribute( root: Element, attribute: string, value: string ): Element[] {
	const found: Element[] = [];
	const walk = ( node: Element ): void => {
		if ( node.attribs?.[ attribute ] === value ) found.push( node );
		for ( const child of node.children ) if ( isElement( child ) ) walk( child );
	};
	walk( root );
	return found;
}

/** Count of each anchor attribute value in one document, for uniqueness. */
function anchorValueCounts( root: Element ): Map< string, number > {
	const counts = new Map< string, number >();
	const walk = ( node: Element ): void => {
		for ( const attribute of ANCHOR_ATTRIBUTES ) {
			const value = node.attribs?.[ attribute ];
			if ( value ) counts.set( `${ attribute }\u0000${ value }`, ( counts.get( `${ attribute }\u0000${ value }` ) ?? 0 ) + 1 );
		}
		for ( const child of node.children ) if ( isElement( child ) ) walk( child );
	};
	walk( root );
	return counts;
}

const classTokens = ( element: Element ): string[] => ( element.attribs.class ?? '' ).split( /\s+/ ).filter( Boolean );
/** A runtime adds classes and siblings; it keeps the server element's tag and classes. */
const describes = ( element: Element, tag: string, classes: readonly string[] ): boolean => {
	const own = new Set( classTokens( element ) );
	return element.name === tag && classes.every( token => own.has( token ) );
};

/** The slot's anchor in `H_R`: nearest ancestor-or-self with an identity unique in `H_R`. */
function slotAnchor( node: Element, body: Element, counts: Map< string, number > ): SlotAnchor {
	const path: number[] = [];
	const descriptors: Array< [ string, string[], number ] > = [];
	let current: Element = node;
	while ( current !== body ) {
		for ( const attribute of ANCHOR_ATTRIBUTES ) {
			const value = current.attribs[ attribute ];
			if ( value && counts.get( `${ attribute }\u0000${ value }` ) === 1 ) return { attribute, value, path, descriptors };
		}
		const parent = current.parent as Element | null;
		if ( ! parent || ! isElement( parent ) ) break;
		const siblings = slotChildren( parent );
		const tag = current.name, classes = classTokens( current );
		path.unshift( siblings.indexOf( current ) );
		descriptors.unshift( [ tag, classes, siblings.slice( 0, siblings.indexOf( current ) ).filter( sibling => describes( sibling, tag, classes ) ).length ] );
		current = parent;
	}
	return { attribute: 'body', value: '', path, descriptors };
}

/**
 * Resolve an anchor in the representative's processed document; undefined when
 * absent or ambiguous. Positions come first; when they miss the server element
 * (a runtime inserted a sibling ahead of it), descriptor ordinals resolve it.
 */
function resolveAnchor( body: Element, anchor: SlotAnchor, matches: ( node: Element ) => boolean ): Element | undefined {
	let root: Element;
	if ( anchor.attribute === 'body' ) root = body;
	else {
		const found = elementsWithAttribute( body, anchor.attribute, anchor.value );
		if ( found.length !== 1 ) return undefined;
		root = found[ 0 ]!;
	}
	const walk = ( step: ( children: Element[], depth: number ) => Element | undefined ): Element | undefined => {
		let node: Element | undefined = root;
		for ( let depth = 0; node && depth < anchor.path.length; depth++ ) node = step( slotChildren( node ), depth );
		return node;
	};
	const positional = walk( ( children, depth ) => children[ anchor.path[ depth ]! ] );
	if ( positional && matches( positional ) ) return positional;
	return walk( ( children, depth ) => {
		const [ tag, classes, ordinal ] = anchor.descriptors[ depth ]!;
		return children.filter( child => describes( child, tag, classes ) )[ ordinal ];
	} ) ?? positional;
}

/** Serialize one node through a Cheerio API (cheerio has no module-level serializer). */
const html$ = ( html: string ) => cheerio.load( html );
const serializer = html$( '<w></w>' );
const serializeNode = ( node: AnyNode ): string => serializer.html( node as never ) ?? '';

/**
 * An identity per node, equal exactly when two nodes serialize alike, built
 * bottom-up from interned child identities: linear in the nodes, where
 * comparing serializations of every subtree is quadratic in the document.
 */
function structuralIdentity(): ( node: AnyNode ) => number {
	const ids = new Map< string, number >();
	const memo = new WeakMap< AnyNode, number >();
	const intern = ( key: string ): number => {
		let id = ids.get( key );
		if ( id === undefined ) ids.set( key, id = ids.size );
		return id;
	};
	const identity = ( node: AnyNode ): number => {
		let id = memo.get( node );
		if ( id !== undefined ) return id;
		if ( isElement( node ) ) id = intern( `${ node.type } ${ node.name }${ Object.entries( node.attribs ).map( ( [ name, value ] ) => ` ${ name }=${ JSON.stringify( value ) }` ).join( '' ) } [${ node.children.map( identity ).join( ',' ) }]` );
		else if ( node.type === 'text' || node.type === 'comment' ) id = intern( `${ node.type } ${ ( node as unknown as { data: string } ).data }` );
		else id = intern( serializeNode( node ) );
		memo.set( node, id );
		return id;
	};
	return identity;
}

/** Every child node, text and styles included, as HTML; skipped elements stay out. */
function serializeChildNodes( element: Element ): string {
	return element.children
		.filter( node => node.type === 'text' || ( isElement( node ) && ! SKIPPED_ELEMENTS.has( node.name ) ) )
		.map( node => node.type === 'text' ? html$( '<w></w>' )( 'w' ).text( ( node as unknown as { data: string } ).data ).html() ?? '' : serializeNode( node ) )
		.join( '' );
}

/** Direct, non-blank text nodes: the element's own words, without its children's. */
const ownTextNodes = ( element: Element ): Array< { data: string } > =>
	element.children.filter( node => node.type === 'text' && normalizedWhitespace( ( node as unknown as { data: string } ).data ) !== '' ) as unknown as Array< { data: string } >;

/**
 * Walk `H_R` and `H_M` together over element children and record every
 * divergence as a slot at an element path. The walk is between the two server
 * documents, so script/noscript/template children are skipped on both sides.
 * Body style text is walked like any other text, including member selectors.
 */
function findServerSlots( repElement: Element, memberElement: Element, slots: Slot[] ): void {
	const at = { repNode: repElement, memberNode: memberElement };
	if ( elementDescriptor( repElement ) !== elementDescriptor( memberElement ) ) {
		slots.push( { ...at, kind: 'element', replacement: serializeNode( memberElement as unknown as AnyNode ), bytes: inlineText( memberElement ).length } );
		return;
	}
	let attributeBytes = 0;
	const attributeDiffs: Array< { attribute: string; value: string } > = [];
	const isImage = repElement.name === 'img' || ( repElement.name === 'source' && ( repElement.parent as Element | null )?.name === 'picture' );
	const attributes = isImage ? [ ...SLOT_ATTRIBUTES, 'width', 'height' ] : SLOT_ATTRIBUTES;
	for ( const attribute of attributes ) {
		const repValue = repElement.attribs[ attribute ] ?? '';
		const memberValue = memberElement.attribs[ attribute ] ?? '';
		if ( repValue !== memberValue ) {
			attributeDiffs.push( { attribute, value: memberValue } );
			attributeBytes += memberValue.length;
		}
	}
	// Per-member images a server paints into inline style (a pagination
	// thumbnail's background) are slots too; the rest of the style is
	// capture-owned and stays.
	const repStyleUrls = styleUrls( repElement.attribs.style );
	const memberStyleUrls = styleUrls( memberElement.attribs.style );
	if ( repStyleUrls.join( '\n' ) !== memberStyleUrls.join( '\n' ) ) {
		attributeDiffs.push( { attribute: 'style', value: memberElement.attribs.style ?? '' } );
		attributeBytes += memberStyleUrls.join( '' ).length;
	}
	if ( attributeDiffs.length ) slots.push( { ...at, kind: 'attribute', replacement: attributeDiffs, bytes: attributeBytes } );
	const repChildren = slotChildren( repElement );
	const memberChildren = slotChildren( memberElement );
	const repOwn = ownTextNodes( repElement ).map( node => node.data );
	const memberOwn = ownTextNodes( memberElement ).map( node => node.data );
	if ( repChildren.length !== memberChildren.length || repOwn.length !== memberOwn.length ) {
		slots.push( { ...at, kind: 'subtree', replacement: serializeChildNodes( memberElement ), bytes: inlineText( memberElement ).length } );
		return;
	}
	if ( repOwn.some( ( data, index ) => normalizedWhitespace( data ) !== normalizedWhitespace( memberOwn[ index ]! ) ) ) {
		slots.push( { ...at, kind: 'text', replacement: memberOwn, bytes: memberOwn.join( '' ).length } );
	}
	for ( let index = 0; index < repChildren.length; index++ ) {
		findServerSlots( repChildren[ index ]!, memberChildren[ index ]!, slots );
	}
}

/**
 * Does a member's slot subtree hold behaviour capture never observed in the
 * browser? One observer per derivation: slots under the same representative
 * element share its observed identities.
 */
function slotRuntimeObserver(): ( element: Element, representative: Element ) => { runtime: boolean; unobserved: boolean } {
	const identity = structuralIdentity();
	const observedBy = new WeakMap< Element, Set< number > >();
	return ( element, representative ) => {
		// Exact server elements share capture's observation. Changed handlers and
		// embeds still need a browser pass; lazy media and hydration stay guarded.
		let observed = observedBy.get( representative );
		if ( ! observed ) {
			const identities = new Set< number >();
			const collect = ( node: Element ): void => {
				identities.add( identity( node ) );
				for ( const child of node.children ) if ( isElement( child ) ) collect( child );
			};
			collect( representative );
			observedBy.set( representative, observed = identities );
		}
		let runtime = false;
		let unobserved = false;
		const walk = ( node: Element ): void => {
			const shared = observed.has( identity( node ) );
			if ( ! shared && [ 'iframe', 'video', 'canvas', 'object', 'embed' ].includes( node.name ) ) runtime = true;
			for ( const attribute of Object.keys( node.attribs ) ) {
				if ( ! shared && /^on[a-z]+$/i.test( attribute ) ) runtime = true;
				// Media swapped by a runtime (lazy loaders, background rotators): the
				// rendered URL was never observed for this member, so the transplant
				// would ship the placeholder instead of the asset.
				if ( /^data-(?:src|srcset|lazy|original|poster|video|bg|background)$/i.test( attribute ) ) unobserved = true;
				if ( /^data-(?:reactroot|hydrat|astro|vue|svelte|n-)/i.test( attribute ) ) runtime = true;
			}
			for ( const child of node.children ) if ( isElement( child ) ) walk( child );
		};
		walk( element );
		return { runtime, unobserved };
	};
}

/**
 * The text a slot anchor must carry in `D_R`: every descendant text node
 * outside skipped and capture-owned elements, whitespace removed so that
 * serialization differences between server and captured HTML do not count.
 */
function anchorText( element: Element, ignored: ReadonlySet< Element > = new Set() ): string {
	const parts: string[] = [];
	const walk = ( node: Element ): void => {
		if ( ignored.has( node ) ) return;
		for ( const child of node.children ) {
			if ( child.type === 'text' ) parts.push( ( child as unknown as { data: string } ).data );
			else if ( isElement( child ) && slotChildren( node ).includes( child ) ) walk( child );
		}
	};
	walk( element );
	return parts.join( '' ).replace( /\s+/g, '' );
}

/**
 * Map server-empty subtrees to their captured counterparts. Only their text is
 * ignored by the anchor gate: the hydrated DOM stays intact for verification.
 * Use the same identity/descriptor resolution as slots, not a text-prefix test
 * that could hide a rewrite of authored content elsewhere in the anchor.
 */
function hydratedMounts( serverBody: Element, processedBody: Element, counts: Map< string, number > ): Set< Element > {
	const mounts = new Set< Element >();
	const walk = ( node: Element ): void => {
		if ( anchorText( node ) === '' ) {
			const matches = ( candidate: Element ) => describes( candidate, node.name, classTokens( node ) );
			const counterpart = resolveAnchor( processedBody, slotAnchor( node, serverBody, counts ), matches );
			if ( counterpart && matches( counterpart ) ) mounts.add( counterpart );
		}
		// Descendants are mapped too: a slot nested inside a mount needs its
		// own counterpart ignored.
		for ( const child of slotChildren( node ) ) walk( child );
	};
	walk( serverBody );
	return mounts;
}

/**
 * Empty server mounts filled in capture cannot be reused with a different key
 * or replaced by a member's pre-hydration content. Check even when the slot
 * walk sees no differences: runtime keys can live in any attribute.
 */
function runtimeMountGate( serverBody: Element, memberBody: Element, processedBody: Element, counts: Map< string, number > ): MemberGate | undefined {
	const hasContent = ( node: Element ): boolean => node.children.some( child => isElement( child ) || ( child.type === 'text' && normalizedWhitespace( child.data ) !== '' ) );
	const walk = ( representative: Element, member: Element ): MemberGate | undefined => {
		if ( ! hasContent( representative ) ) {
			const anchor = slotAnchor( representative, serverBody, counts );
			const matches = ( candidate: Element ) => describes( candidate, representative.name, classTokens( representative ) );
			const captured = resolveAnchor( processedBody, anchor, matches );
			if ( captured && matches( captured ) && hasContent( captured ) ) {
				const attributes = new Set( [ ...Object.keys( representative.attribs ), ...Object.keys( member.attribs ) ] );
				if ( [ ...attributes ].some( attribute => representative.attribs[ attribute ] !== member.attribs[ attribute ] ) ) {
					return { code: 'runtime_mount_member_keyed', runtimeAnchor: anchor, reason: `runtime-filled mount at ${ describeAnchor( anchor ) } has different member attributes` };
				}
				if ( hasContent( member ) ) {
					return { code: 'runtime_slot_content', runtimeAnchor: anchor, reason: `member content at ${ describeAnchor( anchor ) } replaces a runtime-filled mount capture never observed for this member` };
				}
			}
		}
		// Follow the server slot walk only while children still correspond.
		if ( elementDescriptor( representative ) !== elementDescriptor( member ) ) return;
		const repChildren = slotChildren( representative ), memberChildren = slotChildren( member );
		if ( repChildren.length !== memberChildren.length ) return;
		for ( let index = 0; index < repChildren.length; index++ ) {
			const gate = walk( repChildren[ index ]!, memberChildren[ index ]! );
			if ( gate ) return gate;
		}
	};
	return walk( serverBody, memberBody );
}

/** The `url()` values of an inline style, in order. */
function styleUrls( style: string | undefined ): string[] {
	return [ ...( style ?? '' ).matchAll( /url\(\s*["']?([^"')]+)/g ) ].map( match => match[ 1 ]!.trim() );
}

/** Apply one slot to its anchor in the processed document; false when the anchor cannot take it. */
function applySlot( $: cheerio.CheerioAPI, node: Element, slot: Slot ): boolean {
	if ( slot.kind === 'text' ) {
		const own = ownTextNodes( node );
		const replacement = slot.replacement as string[];
		if ( own.length !== replacement.length ) return false;
		own.forEach( ( textNode, index ) => { textNode.data = replacement[ index ]!; } );
		return true;
	}
	if ( slot.kind === 'attribute' ) {
		for ( const { attribute, value } of slot.replacement as Array< { attribute: string; value: string } > ) {
			if ( attribute === 'class' ) {
				// Swap only the tokens that differ between the two server documents;
				// classes capture or the runtime added to the processed node stay.
				const tokens = ( classes: string | undefined ) => ( classes ?? '' ).split( /\s+/ ).filter( Boolean );
				const repTokens = new Set( tokens( slot.repNode.attribs.class ) );
				const memberTokens = tokens( value );
				const kept = tokens( node.attribs.class ).filter( token => ! repTokens.has( token ) || memberTokens.includes( token ) );
				const merged = [ ...kept, ...memberTokens.filter( token => ! kept.includes( token ) ) ];
				if ( merged.length ) node.attribs.class = merged.join( ' ' );
				else delete node.attribs.class;
				continue;
			}
			if ( attribute === 'style' ) {
				// Swap the representative's style URLs for the member's, in place.
				const from = styleUrls( slot.repNode.attribs.style );
				const to = styleUrls( value );
				let style = node.attribs.style ?? '';
				if ( from.length !== to.length || from.some( url => ! style.includes( url ) ) ) return false;
				from.forEach( ( url, index ) => { style = style.split( url ).join( to[ index ]! ); } );
				node.attribs.style = style;
				continue;
			}
			if ( value === '' ) delete node.attribs[ attribute ];
			else node.attribs[ attribute ] = value;
		}
		return true;
	}
	if ( slot.kind === 'element' ) $( node ).replaceWith( slot.replacement as string );
	else $( node ).html( slot.replacement as string );
	return true;
}

/** The identity a head-slot element is paired by, or null outside the transplant scope. */
const headSlotKey = ( element: Element ): string | null => {
	if ( element.name === 'link' ) {
		return ( element.attribs.rel ?? '' ).split( /\s+/ ).some( value => value.toLowerCase() === 'canonical' ) ? 'link:canonical' : null;
	}
	if ( element.name !== 'meta' ) return null;
	const key = ( element.attribs.property ?? element.attribs.name ?? '' ).toLowerCase();
	return HEAD_SLOT_META.test( key ) ? `meta:${ key }` : null;
};

/**
 * Document-wide head slots by identity. A parser closes `<head>` early on
 * markup some templates (Blogger) put there, leaving these elements in the
 * body, so they are found wherever `document.title` would find them.
 */
function headSlots( $: cheerio.CheerioAPI ): Map< string, Element[] > {
	const slots = new Map< string, Element[] >();
	for ( const element of $( 'meta, link[rel]' ).toArray() as Element[] ) {
		const key = headSlotKey( element );
		if ( key ) slots.set( key, [ ...( slots.get( key ) ?? [] ), element ] );
	}
	return slots;
}

/**
 * Derive one member's processed document from the representative's.
 *
 * Gates run in order; the first failure names the gate and escalates the
 * member. On success the returned HTML is the representative's processed
 * document with every mapped slot replaced by the member's HTTP-acquired
 * content, including the head slots capture records as metadata.
 */
let representativeKey: { html: string; identity: string; normalization?: TemplateStyleNormalization; templateIdentity?: unknown; key: string } | undefined;

export function deriveMemberDocument( input: {
	/** The representative's server HTML (`H_R`). */
	repServerHtml: string;
	/** The representative's captured, processed document (`D_R`). */
	repProcessedHtml: string;
	/** The member's server HTML (`H_M`), of the same cluster key. */
	memberServerHtml: string;
	baseUrl: string;
	/**
	 * Set only when `memberServerHtml` was synthesized from the representative's
	 * server document (`StructuredContentSource.memberDocument`): the cluster key
	 * is then compared with this content slot emptied in both documents, so the
	 * member's body markup never decides template identity.
	 */
	contentSlotSelector?: string;
	/** Adapter-declared opaque runtime islands; captured markup is retained. */
	runtimeWidgetSelectors?: readonly string[];
	/** The same adapter canonicalization already applied to captured documents. */
	canonicalizeHtml?: ( html: string ) => string;
	/** Adapter-declared per-member head elements (never executable scripts). */
	memberHeadSlotSelector?: string;
	/** The adapter's template normalization, the same one that grouped the cluster. */
	styleNormalization?: TemplateStyleNormalization;
	templateIdentity?: import('./template-groups.js').TemplateIdentity;
	/**
	 * The two documents' featured images from structured content. A runtime
	 * paints the representative's (a hero background, say) from per-item data
	 * the server diff never sees; the member shows its own there (#1813).
	 */
	featuredImages?: { representative?: string; member?: string };
	memberRenderedHtml?: string;
	rewriteDerivedMedia?: import('../adapters/page-actions.js').LiberationHooks['rewriteDerivedMedia'];
} ): MemberDerivation {
	const finish = ( html: string, stats: SlotStats, unobservedSlots: number ): MemberDerivation => {
		const derivedHtml = withMemberFeaturedImage( html, input.featuredImages );
		const rewritten = input.rewriteDerivedMedia ? input.rewriteDerivedMedia( { ...input, derivedHtml } ) : derivedHtml;
		return rewritten === undefined
			? { ok: false, gate: { code: 'runtime_media_unmapped', reason: 'member runtime media unavailable or unresolved in light render' } }
			: { ok: true, html: rewritten, stats, unobservedSlots };
	};
	if ( input.canonicalizeHtml ) {
		input = {
			...input,
			repServerHtml: input.canonicalizeHtml( input.repServerHtml ),
			memberServerHtml: input.canonicalizeHtml( input.memberServerHtml ),
		};
	}
	const keyOf = ( html: string ): string => {
		let normalized = input.contentSlotSelector ? withEmptySlot( html, input.contentSlotSelector ) : html;
		if ( input.memberHeadSlotSelector ) {
			const $ = cheerio.load( normalized );
			$( input.memberHeadSlotSelector ).filter( 'style' ).remove();
			normalized = $.html();
		}
		return templateFingerprint( normalized, input.baseUrl, input.styleNormalization, input.templateIdentity ).key;
	};
	const clusterKey = keyOf( input.memberServerHtml );
	// Every member of a cluster compares against the same representative key.
	const repIdentity = JSON.stringify( [ input.baseUrl, input.contentSlotSelector, input.memberHeadSlotSelector ] );
	if ( representativeKey?.html !== input.repServerHtml || representativeKey.identity !== repIdentity || representativeKey.normalization !== input.styleNormalization || representativeKey.templateIdentity !== input.templateIdentity ) {
		representativeKey = { html: input.repServerHtml, identity: repIdentity, normalization: input.styleNormalization, templateIdentity: input.templateIdentity, key: keyOf( input.repServerHtml ) };
	}
	const repKey = representativeKey.key;
	// The member fetched while the cluster was grouped re-checks its key against
	// the representative's server document: an A/B variant or a rotating hash in
	// a head asset diverges exactly here.
	if ( clusterKey !== repKey ) {
		return { ok: false, gate: { code: 'cluster_key_mismatch', reason: 'the member server document no longer matches its cluster fingerprint' } };
	}
	const repServer = cheerio.load( input.repServerHtml );
	const repProcessed = cheerio.load( input.repProcessedHtml );
	const member = cheerio.load( input.memberServerHtml );
	const repBody = repServer( 'body' ).get( 0 ) as Element | undefined;
	const memberBody = member( 'body' ).get( 0 ) as Element | undefined;
	const processedBody = repProcessed( 'body' ).get( 0 ) as Element | undefined;
	if ( ! repBody || ! memberBody || ! processedBody ) {
		return { ok: false, gate: { code: 'slot_anchor_unmapped', reason: 'the representative or member document has no body element' } };
	}
	// Make declared islands identical opaque shells for the existing slot walk.
	// Restore the captured island even when an enclosing subtree is transplanted.
	// Anchor identity, not selector order, pairs islands across documents.
	const islands: Array< { marker: string; html: string } > = [];
	const selector = input.runtimeWidgetSelectors?.join( ',' );
	if ( selector ) {
		const counts = anchorValueCounts( repBody );
		const roots = repServer( selector ).toArray().filter( isElement ).filter( node => ! repServer( node ).parents( selector ).length );
		for ( const root of roots ) {
			const anchor = slotAnchor( root, repBody, counts );
			const captured = resolveAnchor( processedBody, anchor, node => repProcessed( node ).is( selector ) );
			const memberRoot = resolveAnchor( memberBody, anchor, node => member( node ).is( selector ) );
			if ( ! captured || ! repProcessed( captured ).is( selector ) || ! memberRoot || ! member( memberRoot ).is( selector ) ) {
				return { ok: false, gate: { code: 'slot_anchor_unmapped', reason: `declared runtime island at ${ describeAnchor( anchor ) } has no matching captured or member anchor` } };
			}
			const marker = `<!--blocks-engine-runtime-island-${ islands.length }-->`;
			if ( [ input.repServerHtml, input.repProcessedHtml, input.memberServerHtml ].some( html => html.includes( marker ) ) ) {
				return { ok: false, gate: { code: 'slot_anchor_unmapped', reason: 'runtime island marker collides with source content' } };
			}
			islands.push( { marker, html: repProcessed.html( captured ) } );
			const shell = repServer( root ).clone().empty().append( marker );
			repProcessed( captured ).replaceWith( repServer.html( shell ) );
			member( memberRoot ).replaceWith( repServer.html( shell ) );
			repServer( root ).empty().append( marker );
		}
	}
	const restoreIslands = (): string => {
		for ( const { marker, html } of islands ) {
			const walk = ( node: Element ): void => {
				if ( node.children.some( child => child.type === 'comment' && `<!--${ child.data }-->` === marker ) ) repProcessed( node ).replaceWith( html );
				else for ( const child of node.children ) if ( isElement( child ) ) walk( child );
			};
			walk( processedBody );
		}
		return repProcessed.html();
	};
	const anchorCounts = anchorValueCounts( repBody );
	const mountGate = runtimeMountGate( repBody, memberBody, processedBody, anchorCounts );
	if ( mountGate ) return { ok: false, gate: mountGate };
	const slots: Slot[] = [];
	findServerSlots( repBody, memberBody, slots );
	if ( ! slots.length ) {
		// Nothing to transplant: the member is the representative byte for byte
		// in content. That is a legitimate derived member with zero slots.
		return finish( islands.length ? restoreIslands() : input.repProcessedHtml, { slots: 0, subtreeSlots: 0 }, 0 );
	}
	const mounts = hydratedMounts( repBody, processedBody, anchorCounts );
	const located = slots.map( slot => ( { slot, anchor: slotAnchor( slot.repNode, repBody, anchorCounts ) } ) );
	const slotRuntimeObservation = slotRuntimeObserver();
	// Content gate before any mapping: one runtime-only slot escalates the member.
	for ( const { slot, anchor } of located ) {
		if ( slot.kind !== 'subtree' && slot.kind !== 'element' ) continue;
		const parsed = html$( `<body>${ slot.replacement as string }</body>` )( 'body' ).children().toArray() as Element[];
		for ( const element of parsed ) {
			if ( element.name === 'script' ) {
				return { ok: false, gate: { code: 'runtime_slot_content', runtimeAnchor: anchor, reason: `member slot at ${ describeAnchor( anchor ) } carries a script element capture never observed` } };
			}
			const runtime = slotRuntimeObservation( element, slot.repNode );
			if ( runtime.runtime ) {
				return { ok: false, gate: { code: 'runtime_slot_content', runtimeAnchor: anchor, reason: `member slot at ${ describeAnchor( anchor ) } carries an embed, handler or hydration marker capture never observed` } };
			}
		}
	}
	// Resolve every anchor in the processed document before any slot applies:
	// an attribute slot may rewrite an anchor's own id. Content slots must also
	// carry the representative's server text; a runtime that rewrote it makes
	// the transplant unsafe. Attribute slots only need the element resolved.
	let subtreeSlots = 0;
	let unobservedSlots = 0;
	const mapped: Array< { slot: Slot; anchor: SlotAnchor; node: Element } > = [];
	for ( const { slot, anchor } of located ) {
		const matchesText = ( candidate: Element ): boolean => slot.kind === 'attribute' || anchorText( candidate, mounts ) === anchorText( slot.repNode );
		const node = resolveAnchor( processedBody, anchor, candidate => candidate.name === slot.repNode.name && matchesText( candidate ) );
		if ( ! node || node.name !== slot.repNode.name ) {
			return { ok: false, gate: { code: 'slot_anchor_unmapped', reason: `slot at ${ describeAnchor( anchor ) } has no matching anchor in the representative's captured document` } };
		}
		if ( ! matchesText( node ) ) {
			return { ok: false, gate: { code: 'slot_anchor_unmapped', reason: `slot at ${ describeAnchor( anchor ) } carries different text in the representative's captured document than in its server document` } };
		}
		if ( slot.kind === 'subtree' || slot.kind === 'element' ) {
			subtreeSlots++;
			const parsed = html$( `<body>${ serializeNode( slot.memberNode as unknown as AnyNode ) }</body>` )( 'body' ).children().toArray() as Element[];
			for ( const element of parsed ) {
				const runtime = slotRuntimeObservation( element, slot.repNode );
				if ( runtime.runtime ) {
					return { ok: false, gate: { code: 'runtime_slot_content', runtimeAnchor: anchor, reason: `member slot at ${ describeAnchor( anchor ) } carries an embed, handler or hydration marker capture never observed` } };
				}
				if ( runtime.unobserved ) unobservedSlots++;
			}
		}
		mapped.push( { slot, anchor, node } );
	}
	for ( const { slot, anchor, node } of mapped ) {
		if ( ! applySlot( repProcessed, node, slot ) ) {
			return { ok: false, gate: { code: 'slot_anchor_unmapped', reason: `slot at ${ describeAnchor( anchor ) } has a different text layout in the representative's captured document` } };
		}
	}
	// Head slots mirror the member. The member's title is the first `<title>`
	// anywhere, as `document.title` reads it, even one a malformed template
	// leaves in the body. Metadata pairs by identity: a slot only the
	// representative declares describes the representative and is dropped; one
	// only the member declares joins the head.
	const memberTitle = member( 'title' ).first().toArray()[ 0 ] as Element | undefined;
	const repTitle = repProcessed( 'head title' ).toArray()[ 0 ] as Element | undefined;
	if ( memberTitle && repTitle ) {
		// A runtime can copy the document title into the body; each copy is the title slot too.
		const repTitleText = repProcessed( repTitle ).text();
		for ( const copy of repProcessed( 'body title' ).toArray() ) if ( repProcessed( copy ).text() === repTitleText ) repProcessed( copy ).text( member( memberTitle ).text() );
		replaceProcessedNode( repTitle, memberTitle );
	}
	const memberSlots = headSlots( member );
	const repSlots = headSlots( repProcessed );
	for ( const [ key, repNodes ] of repSlots ) {
		const memberNodes = memberSlots.get( key ) ?? [];
		repNodes.forEach( ( repNode, index ) => {
			const memberNode = memberNodes[ index ];
			if ( memberNode ) replaceProcessedNode( repNode, memberNode );
			else repProcessed( repNode ).remove();
		} );
	}
	for ( const [ key, memberNodes ] of memberSlots ) {
		for ( const memberNode of memberNodes.slice( repSlots.get( key )?.length ?? 0 ) ) {
			repProcessed( 'head' ).append( repProcessed( member.html( memberNode ) ) );
		}
	}
	if ( input.memberHeadSlotSelector ) {
		const selector = input.memberHeadSlotSelector;
		// Keep the representative's cascade position; this contract only admits styles.
		const replacements = member( selector ).toArray().filter( node => 'name' in node && node.name === 'style' );
		const originals = repProcessed( selector );
		if ( originals.length ) originals.first().before( replacements.map( node => member.html( node ) ).join( '' ) );
		else repProcessed( 'head' ).append( replacements.map( node => member.html( node ) ).join( '' ) );
		originals.remove();
	}
	return finish( restoreIslands(), { slots: slots.length, subtreeSlots }, unobservedSlots );
}

/**
 * Every rendering of the representative's featured image, as a URL (any
 * rendition query kept) or URL-encoded in inline data, becomes the member's.
 */
export function withMemberFeaturedImage( html: string, images: { representative?: string; member?: string } | undefined ): string {
	const from = images?.representative?.split( '?' )[ 0 ];
	const to = images?.member?.split( '?' )[ 0 ];
	if ( ! from || ! to || from === to ) return html;
	const escape = ( value: string ) => value.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
	// A URL ends where its path ends: `banner.jpg` must not match `banner.jpg2`.
	// Encoded, it ends at an escape (`%22`, `%3F`) instead of a raw delimiter.
	const replaced = ( text: string, a: string, b: string, pathCharacters: string ) => text.replace( new RegExp( `${ escape( a ) }(?![${ pathCharacters }])`, 'g' ), b );
	return replaced( replaced( html, from, to, '\\w.~/%-' ), encodeURIComponent( from ), encodeURIComponent( to ), '\\w.~-' );
}

/** The document with every element matching the content slot emptied. */
function withEmptySlot( html: string, selector: string ): string {
	const $ = cheerio.load( html );
	$( selector ).empty();
	return $.html();
}

/** Replace one processed node's attributes and content with the member's head-slot node. */
function replaceProcessedNode( repNode: Element, memberNode: Element ): void {
	if ( repNode.name === 'title' || memberNode.name === 'title' ) {
		// Text content for <title>.
		const text = inlineText( memberNode );
		repNode.children = [ { type: 'text', data: text, parent: null, next: null, prev: null } as unknown as AnyNode ];
		return;
	}
	for ( const attribute of Object.keys( repNode.attribs ) ) {
		if ( memberNode.attribs[ attribute ] !== undefined ) repNode.attribs[ attribute ] = memberNode.attribs[ attribute ];
		else if ( attribute === 'content' || attribute === 'href' || attribute === 'property' || attribute === 'name' || attribute === 'rel' || attribute === 'title' ) delete repNode.attribs[ attribute ];
	}
	for ( const attribute of Object.keys( memberNode.attribs ) ) {
		if ( repNode.attribs[ attribute ] !== memberNode.attribs[ attribute ] ) repNode.attribs[ attribute ] = memberNode.attribs[ attribute ];
	}
}

/**
 * Only capture-fitted affine lengths tolerate measurement noise. Everything
 * around them (selectors, properties, media bounds, order) stays exact. The
 * difference of two affine fits reaches its maximum at a sweep endpoint, so
 * checking 320–1920px covers every default sampled width, not just one pose.
 * Unknown expressions deliberately fall back to exact comparison.
 */
function equivalentFluidStyles( left: string[], right: string[] ): boolean {
	if ( left.length !== right.length ) return false;
	const affine = /calc\(\s*([+-]?(?:\d*\.)?\d+)vw\s*([+-])\s*((?:\d*\.)?\d+)px\s*\)/g;
	return left.every( ( text, index ) => {
		const fits = ( css: string ) => [ ...css.matchAll( affine ) ].map( match => ( {
			slope: Number( match[ 1 ] ) / 100,
			offset: Number( match[ 3 ] ) * ( match[ 2 ] === '-' ? -1 : 1 ),
		} ) );
		const other = right[ index ]!;
		const a = fits( text );
		const b = fits( other );
		return text.replace( affine, '<affine-length>' ) === other.replace( affine, '<affine-length>' ) &&
			a.length === b.length && a.every( ( fit, i ) => [ 320, 1920 ].every( width =>
				Math.abs( ( fit.slope - b[ i ]!.slope ) * width + fit.offset - b[ i ]!.offset ) <= 1 ) );
	} );
}

/**
 * Compare a derived member against its real browser capture, on the six
 * acceptance checks of #784 phase 1: text, links, images, skeleton, fluid
 * rules and head styles. Runs offline, no browser: the checks diff the two
 * processed documents with the same normalization capture applies.
 */
export function compareDerivedWithCapture( input: {
	/** The derived document. */
	derivedHtml: string;
	/** The member's real captured, processed document. */
	realHtml: string;
	/** Both server documents are required to distinguish runtime-only stylesheet links. */
	repServerHtml?: string;
	memberServerHtml?: string;
	/** Runtime-only class token patterns, shared with template grouping. */
	runtimeStateClasses?: readonly RegExp[];
	/** The adapter's style canonicalization, e.g. for server-shuffled @font-face rules. */
	styleNormalization?: TemplateStyleNormalization;
	baseUrl: string;
} ): { equal: boolean; checks: Record< 'text' | 'links' | 'images' | 'skeleton' | 'fluidRules' | 'headStyles', boolean > } {
	const derived = cheerio.load( input.derivedHtml );
	const real = cheerio.load( input.realHtml );
	// Rendered text only: inline script and style bodies carry per-request
	// values (render timestamps, nonces) that no two documents share. So does
	// a clock a runtime prints at capture time ("Last refreshed at: <Date>"):
	// the two documents were captured at different moments, not derived wrong.
	const documentText = ( $: cheerio.CheerioAPI ): string => {
		const body = $( 'body' ).clone();
		body.find( 'script, style, noscript, template' ).remove();
		return normalizedWhitespace( body.text() )
			.replace( /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}(?: \([^)]*\))?/g, '<clock>' )
			.replace( /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/g, '<clock>' );
	};
	// Relative URLs in the member's server HTML resolve like a browser would:
	// the real capture carries absolute, localized URLs.
	const collect = ( $: cheerio.CheerioAPI, selector: string, attribute: string ): string[] =>
		$( selector ).toArray()
			.map( element => resolveUrl( ( element as Element ).attribs[ attribute ] ?? '', input.baseUrl ) )
			.filter( value => value !== '' )
			.sort();
	// Images include inline-style backgrounds: a hero a runtime paints from
	// per-member data lives there, and the server diff never sees it (#1813).
	const images = ( $: cheerio.CheerioAPI ): string => JSON.stringify( [
		...$( 'img, picture > source[srcset]' ).toArray().map( element => {
			const node = element as Element;
			return [ node.name, resolveUrl( node.attribs.src ?? '', input.baseUrl ),
				srcsetCandidates( node.attribs.srcset ?? '' ).map( candidate =>
					[ resolveUrl( candidate.url, input.baseUrl ), candidate.size, candidate.density ] ) ];
		} ),
		...$( 'body [style*="url("]' ).toArray().flatMap( element =>
			[ ...( ( element as Element ).attribs.style ?? '' ).matchAll( /url\(\s*(?:&quot;|["'])?([^"')&]+)/g ) ]
				.map( match => [ 'background', resolveUrl( match[ 1 ]!, input.baseUrl ) ] ) ),
	].map( image => JSON.stringify( image ) ).sort() );
	const serverStyles = input.repServerHtml !== undefined && input.memberServerHtml !== undefined
		? new Set( [ input.repServerHtml, input.memberServerHtml ].flatMap( html => collect( cheerio.load( html ), 'link[rel~="stylesheet"]', 'href' ) ) )
		: undefined;
	const styleText = ( block: TemplateStyleBlock ): string => normalizedWhitespace( input.styleNormalization?.pageStyles( [ block ] ) ?? block.text );
	const serverStyleTexts = serverStyles && new Set( [ input.repServerHtml!, input.memberServerHtml! ].flatMap( html => styleBlocks( cheerio.load( html ) ).map( styleText ) ) );
	// Inline styles a runtime probe injected into one capture only (for
	// example a comments widget's sheet): absent from both server documents,
	// not written by the capture, and with nothing differing on the other side.
	const runtimeOnly = ( block: TemplateStyleBlock ): boolean => !! serverStyleTexts &&
		! serverStyleTexts.has( styleText( block ) ) && ! Object.keys( block.attributes ).some( name => name.startsWith( 'data-blocks-engine-capture' ) );
	const isFluidStyle = ( block: TemplateStyleBlock ): boolean => 'data-blocks-engine-capture-fluid-rules' in block.attributes;
	const fluidStyles = ( $: cheerio.CheerioAPI ): string[] => styleBlocks( $ ).filter( isFluidStyle ).map( block => normalizedWhitespace( block.text ) );
	const inlineStyles = ( $: cheerio.CheerioAPI ) => styleBlocks( $ ).filter( block => ! isFluidStyle( block ) ).map( block => ( { text: styleText( block ), runtimeOnly: runtimeOnly( block ) } ) );
	const [ derivedInline, realInline ] = [ inlineStyles( derived ), inlineStyles( real ) ];
	const unmatched = ( side: typeof derivedInline, other: typeof derivedInline ) => {
		const texts = new Set( other.map( style => style.text ) );
		return side.filter( style => ! texts.has( style.text ) );
	};
	const derivedOnly = unmatched( derivedInline, realInline );
	const realOnly = unmatched( realInline, derivedInline );
	const ignored = new Set( derivedOnly.length === 0 || realOnly.length === 0
		? [ ...derivedOnly, ...realOnly ].filter( style => style.runtimeOnly ).map( style => style.text )
		: [] );
	const styles = ( $: cheerio.CheerioAPI, inline: typeof derivedInline ): string[] =>
		[ ...inline.map( style => style.text ).filter( text => ! ignored.has( text ) ),
			...collect( $, 'link[rel~="stylesheet"]', 'href' ).filter( href => ! serverStyles || serverStyles.has( href ) ) ].filter( value => value !== '' ).sort();
	const fluidSheets = ( $: cheerio.CheerioAPI ): string[] =>
		$( 'style[data-blocks-engine-capture-fluid-sheet-rules]' ).toArray()
			.map( element => normalizedWhitespace( $( element ).text() ) )
			.filter( value => value !== '' )
			.sort();
	const skeleton = ( $: cheerio.CheerioAPI ): string => {
		// Same collapsed skeleton the grouping uses: compare across members of
		// the same cluster, so a different fingerprint version is fine here.
		const { skeleton: hash } = templateFingerprint( $.html(), input.baseUrl, undefined, undefined, input.runtimeStateClasses );
		return hash;
	};
	const checks = {
		text: documentText( derived ) === documentText( real ),
		links: collect( derived, 'a[href]', 'href' ).join( '\n' ) === collect( real, 'a[href]', 'href' ).join( '\n' ),
		images: images( derived ) === images( real ),
		skeleton: skeleton( derived ) === skeleton( real ),
		headStyles: styles( derived, derivedInline ).join( '\n' ) === styles( real, realInline ).join( '\n' ) &&
			equivalentFluidStyles( fluidStyles( derived ), fluidStyles( real ) ),
		fluidRules: fluidSheets( derived ).join( '\n' ) === fluidSheets( real ).join( '\n' ),
	};
	return { equal: Object.values( checks ).every( value => value ), checks };
}

export interface TemplateClusterRecord {
	/** Group id from template-groups.json, or `<group id>.<n>` for a member-shape sub-cluster. */
	id: string;
	key: string;
	representative: string;
	/** Group id this member-shape sub-cluster belongs to (#1805). */
	parent?: string;
	/** Adapter-declared member shape shared by the sub-cluster's members. */
	shape?: string;
	/**
	 * Set on a group partitioned by member shape: its sub-clusters, each with
	 * the representative chosen for that shape. The group's own `escalated`
	 * rows are its unclustered (singleton-shape or unshaped) members.
	 */
	subClusters?: Array< { id: string; shape: string; representative: string; size: number } >;
	/** Members offered for derivation, and their outcomes. */
	derived: Array< { url: string; slots: number; subtreeSlots: number } >;
	escalated: Array< { url: string; gate: string; reason: string; fallback?: { acquired: boolean; reason?: string } } >;
	unavailable: Array< { url: string; reason: string } >;
	verification?: {
		url: string;
		captured: boolean;
		/** Derived-vs-real acceptance checks; absent when not comparable. */
		checks?: Record< string, boolean >;
		equal?: boolean;
		/** `rendered`: slot documents are light renders, the runtime rewrites server content. */
		documents?: 'rendered';
	};
}

export interface TemplateClustersReceipt {
	schema: typeof TEMPLATE_CLUSTERS_SCHEMA;
	fingerprint: { version: typeof TEMPLATE_FINGERPRINT_VERSION };
	sourceUrl: string;
	derivedCount: number;
	escalatedCount: number;
	/** Escalated members shipped through governed HTTP acquisition instead of omission. */
	httpAcquiredCount?: number;
	unavailableCount: number;
	clusters: TemplateClusterRecord[];
}

/** Write `template-clusters.json` next to `website/`. */
export function writeTemplateClusters( outputDir: string, receipt: TemplateClustersReceipt ): string {
	const path = join( outputDir, TEMPLATE_CLUSTERS_FILE );
	writeFileSync( path, `${ JSON.stringify( receipt, null, 2 ) }\n` );
	return path;
}
