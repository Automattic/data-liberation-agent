import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { srcsetCandidates } from './srcset.js';
import { elementDescriptor, templateFingerprint, TEMPLATE_FINGERPRINT_VERSION, type TemplateStyleNormalization } from './template-groups.js';

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
	| 'cluster_key_mismatch' /** H_M's fingerprint is not the cluster's key. */
	| 'slot_anchor_unmapped' /** a slot has no matching anchor in `D_R`. */
	| 'runtime_slot_content' /** a slot carries scripts, handlers or embeds capture never observed. */;

export interface SlotStats {
	/** Total mapped slots (subtree + text + attribute + head). */
	slots: number;
	/** Subtree slots among the mapped ones. */
	subtreeSlots: number;
}

export interface MemberGate {
	code: GateCode;
	reason: string;
}

export type MemberDerivation =
	| { ok: true; html: string; stats: SlotStats; unobservedSlots: number }
	| { ok: false; gate: MemberGate };

const isElement = ( node: AnyNode ): node is Element => node.type === 'tag' || node.type === 'script' || node.type === 'style';

const SKIPPED_ELEMENTS = new Set( [ 'script', 'style', 'noscript', 'template', 'br', 'wbr', 'link', 'meta', 'base' ] );

/** Inline (phrasing) elements: presence follows the text, so they never split slots by themselves. */
const INLINE_ELEMENTS = new Set( [ 'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'img', 'ins', 'kbd', 'label', 'mark', 'picture', 'q', 's', 'samp', 'small', 'source', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr' ] );

/** Attributes whose difference is authored content, per §3.1. */
const SLOT_ATTRIBUTES = [ 'href', 'src', 'srcset', 'sizes', 'datetime', 'alt', 'id', 'class' ] as const;

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
interface SlotAnchor {
	attribute: 'id' | 'data-testid' | 'body';
	value: string;
	/** Element path below the anchor, over slot-eligible children. */
	path: number[];
	/** The same path as `[tag, classes, ordinal among siblings that match them]`, immune to runtime-inserted siblings. */
	descriptors: Array< [ string, string[], number ] >;
}

/** Anchor attributes, most stable first. */
const ANCHOR_ATTRIBUTES = [ 'id', 'data-testid' ] as const;

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
const serializeNode = ( node: AnyNode ): string => html$( '<w></w>' ).html( node as never ) ?? '';

/** Every child node, text included, as HTML; skipped elements (scripts, styles) stay out. */
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
 * documents, so script/style/template children are skipped on both sides.
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

/** Does the member's slot subtree hold behaviour capture never observed in the browser? */
function slotRuntimeObservation( element: Element ): { runtime: boolean; unobserved: boolean } {
	let runtime = false;
	let unobserved = false;
	const walk = ( node: Element ): void => {
		if ( [ 'iframe', 'video', 'canvas', 'object', 'embed' ].includes( node.name ) ) runtime = true;
		for ( const attribute of Object.keys( node.attribs ) ) {
			if ( /^on[a-z]+$/i.test( attribute ) ) runtime = true;
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
}

/**
 * The text a slot anchor must carry in `D_R`: every descendant text node
 * outside skipped and capture-owned elements, whitespace removed so that
 * serialization differences between server and captured HTML do not count.
 */
function anchorText( element: Element ): string {
	const parts: string[] = [];
	const walk = ( node: Element ): void => {
		for ( const child of node.children ) {
			if ( child.type === 'text' ) parts.push( ( child as unknown as { data: string } ).data );
			else if ( isElement( child ) && slotChildren( node ).includes( child ) ) walk( child );
		}
	};
	walk( element );
	return parts.join( '' ).replace( /\s+/g, '' );
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
	/** Adapter-declared per-member head elements (never executable scripts). */
	memberHeadSlotSelector?: string;
	/** The adapter's template normalization, the same one that grouped the cluster. */
	styleNormalization?: TemplateStyleNormalization;
	templateIdentity?: import('./template-groups.js').TemplateIdentity;
} ): MemberDerivation {
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
	const repKey = keyOf( input.repServerHtml );
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
	const slots: Slot[] = [];
	findServerSlots( repBody, memberBody, slots );
	if ( ! slots.length ) {
		// Nothing to transplant: the member is the representative byte for byte
		// in content. That is a legitimate derived member with zero slots.
		return { ok: true, html: input.repProcessedHtml, stats: { slots: 0, subtreeSlots: 0 }, unobservedSlots: 0 };
	}
	const anchorCounts = anchorValueCounts( repBody );
	const located = slots.map( slot => ( { slot, anchor: slotAnchor( slot.repNode, repBody, anchorCounts ) } ) );
	// Content gate before any mapping: one runtime-only slot escalates the member.
	for ( const { slot, anchor } of located ) {
		if ( slot.kind !== 'subtree' && slot.kind !== 'element' ) continue;
		const parsed = html$( `<body>${ slot.replacement as string }</body>` )( 'body' ).children().toArray() as Element[];
		for ( const element of parsed ) {
			if ( element.name === 'script' ) {
				return { ok: false, gate: { code: 'runtime_slot_content', reason: `member slot at ${ describeAnchor( anchor ) } carries a script element capture never observed` } };
			}
			const runtime = slotRuntimeObservation( element );
			if ( runtime.runtime ) {
				return { ok: false, gate: { code: 'runtime_slot_content', reason: `member slot at ${ describeAnchor( anchor ) } carries an embed, handler or hydration marker capture never observed` } };
			}
		}
	}
	// Resolve every anchor in the processed document before any slot applies:
	// an attribute slot may rewrite an anchor's own id. The resolved node must
	// carry the representative's server text; a runtime that rewrote it makes
	// the transplant unsafe, so the member escalates.
	let subtreeSlots = 0;
	let unobservedSlots = 0;
	const mapped: Array< { slot: Slot; anchor: SlotAnchor; node: Element } > = [];
	for ( const { slot, anchor } of located ) {
		const node = resolveAnchor( processedBody, anchor, candidate => candidate.name === slot.repNode.name && anchorText( candidate ) === anchorText( slot.repNode ) );
		if ( ! node || node.name !== slot.repNode.name ) {
			return { ok: false, gate: { code: 'slot_anchor_unmapped', reason: `slot at ${ describeAnchor( anchor ) } has no matching anchor in the representative's captured document` } };
		}
		if ( anchorText( node ) !== anchorText( slot.repNode ) ) {
			return { ok: false, gate: { code: 'slot_anchor_unmapped', reason: `slot at ${ describeAnchor( anchor ) } carries different text in the representative's captured document than in its server document` } };
		}
		if ( slot.kind === 'subtree' || slot.kind === 'element' ) {
			subtreeSlots++;
			const parsed = html$( `<body>${ serializeNode( slot.memberNode as unknown as AnyNode ) }</body>` )( 'body' ).children().toArray() as Element[];
			for ( const element of parsed ) {
				const runtime = slotRuntimeObservation( element );
				if ( runtime.runtime ) {
					return { ok: false, gate: { code: 'runtime_slot_content', reason: `member slot at ${ describeAnchor( anchor ) } carries an embed, handler or hydration marker capture never observed` } };
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
	return { ok: true, html: repProcessed.html(), stats: { slots: slots.length, subtreeSlots }, unobservedSlots };
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
	baseUrl: string;
} ): { equal: boolean; checks: Record< 'text' | 'links' | 'images' | 'skeleton' | 'fluidRules' | 'headStyles', boolean > } {
	const derived = cheerio.load( input.derivedHtml );
	const real = cheerio.load( input.realHtml );
	// Rendered text only: inline script and style bodies carry per-request
	// values (render timestamps, nonces) that no two documents share.
	const documentText = ( $: cheerio.CheerioAPI ): string => {
		const body = $( 'body' ).clone();
		body.find( 'script, style, noscript, template' ).remove();
		return normalizedWhitespace( body.text() );
	};
	// Relative URLs in the member's server HTML resolve like a browser would:
	// the real capture carries absolute, localized URLs.
	const collect = ( $: cheerio.CheerioAPI, selector: string, attribute: string ): string[] =>
		$( selector ).toArray()
			.map( element => resolveUrl( ( element as Element ).attribs[ attribute ] ?? '', input.baseUrl ) )
			.filter( value => value !== '' )
			.sort();
	const images = ( $: cheerio.CheerioAPI ): string => JSON.stringify(
		$( 'img, picture > source[srcset]' ).toArray().map( element => {
			const node = element as Element;
			return [ node.name, resolveUrl( node.attribs.src ?? '', input.baseUrl ),
				srcsetCandidates( node.attribs.srcset ?? '' ).map( candidate =>
					[ resolveUrl( candidate.url, input.baseUrl ), candidate.size, candidate.density ] ) ];
		} ).map( image => JSON.stringify( image ) ).sort(),
	);
	const styles = ( $: cheerio.CheerioAPI ): string[] =>
		[ ...$( 'style' ).toArray().map( element => normalizedWhitespace( $( element ).text() ) ),
			...collect( $, 'link[rel~="stylesheet"]', 'href' ) ].filter( value => value !== '' ).sort();
	const fluidSheets = ( $: cheerio.CheerioAPI ): string[] =>
		$( 'style[data-blocks-engine-capture-fluid-sheet-rules]' ).toArray()
			.map( element => normalizedWhitespace( $( element ).text() ) )
			.filter( value => value !== '' )
			.sort();
	const skeleton = ( $: cheerio.CheerioAPI ): string => {
		// Same collapsed skeleton the grouping uses: compare across members of
		// the same cluster, so a different fingerprint version is fine here.
		const { skeleton: hash } = templateFingerprint( $.html(), input.baseUrl );
		return hash;
	};
	const checks = {
		text: documentText( derived ) === documentText( real ),
		links: collect( derived, 'a[href]', 'href' ).join( '\n' ) === collect( real, 'a[href]', 'href' ).join( '\n' ),
		images: images( derived ) === images( real ),
		skeleton: skeleton( derived ) === skeleton( real ),
		headStyles: styles( derived ).join( '\n' ) === styles( real ).join( '\n' ),
		fluidRules: fluidSheets( derived ).join( '\n' ) === fluidSheets( real ).join( '\n' ),
	};
	return { equal: Object.values( checks ).every( value => value ), checks };
}

export interface TemplateClusterRecord {
	/** Group id from template-groups.json. */
	id: string;
	key: string;
	representative: string;
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
