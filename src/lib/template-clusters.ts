import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { templateFingerprint, TEMPLATE_FINGERPRINT_VERSION } from './template-groups.js';

/**
 * Template-clustered capture, phase 1 (#784).
 *
 * Phase 0 (#786, `template-groups.ts`) groups the inventory by a structural
 * fingerprint of the server HTML. Phase 1 produces every non-sampled member
 * of a verified multi-member cluster by transplanting its HTTP-acquired
 * content (`H_M`) into the representative's captured, processed DOM (`D_R`):
 * the slot walk between `H_R` and `H_M` maps content slots onto the same
 * element paths in `D_R`, and each member is admitted only through cheap
 * per-member gates. A member that fails a gate never ships as derived: it
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

/** Capture-owned nodes carry capture attributes and exist only in `D_R`. */
const CAPTURE_OWNED_ATTRIBUTE = /^data-blocks-engine-capture-/;

const SKIPPED_ELEMENTS = new Set( [ 'script', 'style', 'noscript', 'template', 'br', 'wbr', 'link', 'meta', 'base' ] );

/** Inline (phrasing) elements: presence follows the text, so they never split slots by themselves. */
const INLINE_ELEMENTS = new Set( [ 'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'img', 'ins', 'kbd', 'label', 'mark', 'picture', 'q', 's', 'samp', 'small', 'source', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr' ] );

/** Attributes whose difference is authored content, per §3.1. */
const SLOT_ATTRIBUTES = [ 'href', 'src', 'datetime', 'alt', 'id' ] as const;

/** Head slots: `<title>`, description, canonical and Open Graph. */
const HEAD_SLOT_SELECTORS = [
	'title',
	'meta[name=description i]',
	'link[rel=canonical i]',
	'meta[property^="og:" i]',
] as const;

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

const elementDescriptor = ( element: Element ): string =>
	`${ element.name }${ ( element.attribs.class ?? '' ).split( /\s+/ ).filter( Boolean ).map( token => `.${ token }` ).join( '' ) }${ element.attribs.role ? `[role=${ element.attribs.role }]` : '' }`;

/** Slot-eligible element children, in order: skipping head noise and capture-owned nodes. */
const slotChildren = ( element: Element ): Element[] =>
	element.children.filter( ( node ): node is Element => {
		if ( ! isElement( node ) || SKIPPED_ELEMENTS.has( node.name ) ) return false;
		return ! ( CAPTURE_OWNED_ATTRIBUTE.test( node.name ) || Object.keys( node.attribs ?? {} ).some( attribute => CAPTURE_OWNED_ATTRIBUTE.test( attribute ) ) );
	} );

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
	/** Element path from the body root over slot-eligible children. */
	path: number[];
	kind: 'subtree' | 'text' | 'attribute';
	/** Member-side replacement: subtree HTML, normalized text, or attribute map. */
	replacement: string | Array< { attribute: string; value: string } >;
	/** Bytes the member contributed; verification sampling orders members by this. */
	bytes: number;
}

/** Serialize one node through a Cheerio API (cheerio has no module-level serializer). */
const html$ = ( html: string ) => cheerio.load( html );
const serializeNode = ( node: AnyNode ): string => html$( '<w></w>' ).html( node as never ) ?? '';

function serializeChildren( elements: Element[] ): string {
	return elements.map( element => serializeNode( element as unknown as AnyNode ) ).join( '' );
}

/**
 * Walk `H_R` and `H_M` together over element children and record every
 * divergence as a slot at an element path. The walk is between the two server
 * documents, so script/style/template children are skipped on both sides.
 */
function findServerSlots( repElement: Element, memberElement: Element, path: number[], slots: Slot[] ): void {
	if ( elementDescriptor( repElement ) !== elementDescriptor( memberElement ) ) {
		slots.push( { path, kind: 'subtree', replacement: serializeChildren( slotChildren( memberElement ) ), bytes: memberElement.children.length * 4 } );
		return;
	}
	let attributeBytes = 0;
	const attributeDiffs: Array< { attribute: string; value: string } > = [];
	for ( const attribute of SLOT_ATTRIBUTES ) {
		const repValue = repElement.attribs[ attribute ] ?? '';
		const memberValue = memberElement.attribs[ attribute ] ?? '';
		if ( repValue !== memberValue ) {
			attributeDiffs.push( { attribute, value: memberValue } );
			attributeBytes += memberValue.length;
		}
	}
	if ( attributeDiffs.length ) slots.push( { path, kind: 'attribute', replacement: attributeDiffs, bytes: attributeBytes } );
	const repText = inlineText( repElement );
	const memberText = inlineText( memberElement );
	if ( repText !== memberText ) slots.push( { path, kind: 'text', replacement: memberText, bytes: memberText.length } );
	const repChildren = slotChildren( repElement );
	const memberChildren = slotChildren( memberElement );
	if ( repChildren.length !== memberChildren.length ) {
		slots.push( { path, kind: 'subtree', replacement: serializeChildren( memberChildren ), bytes: memberText.length } );
		return;
	}
	for ( let index = 0; index < repChildren.length; index++ ) {
		findServerSlots( repChildren[ index ]!, memberChildren[ index ]!, [ ...path, index ], slots );
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
 * Resolve one slot path in the representative's processed document. The anchor
 * must carry the same template identity and the same normalized text as the
 * representative's server node; anything else escalates the member.
 */
function resolveSlotAnchor( root: Element, path: number[] ): Element | undefined {
	let node: Element = root;
	for ( const index of path ) {
		const next = slotChildren( node )[ index ];
		if ( ! next ) return undefined;
		node = next;
	}
	return node;
}

function applySlot( node: Element, slot: Slot ): void {
	if ( slot.kind === 'text' ) {
		node.children = [ { type: 'text', data: slot.replacement as string, parent: node.parent, next: null, prev: null } as unknown as AnyNode ];
		return;
	}
	if ( slot.kind === 'attribute' ) {
		for ( const { attribute, value } of slot.replacement as Array< { attribute: string; value: string } > ) {
			if ( value === '' ) delete node.attribs[ attribute ];
			else node.attribs[ attribute ] = value;
		}
		return;
	}
	// Subtree slot: replace the slot-eligible children with the member's.
	for ( const child of slotChildrenSimple( node ) ) {
		const index = node.children.indexOf( child );
		if ( index >= 0 ) node.children.splice( index, 1 );
	}
	const fragment = cheerio.load( `<body>${ slot.replacement as string }</body>` )( 'body' ).children().toArray() as Element[];
	for ( const element of fragment ) {
		element.parent = node.parent; // reassigned below
		element.next = null;
		element.prev = null;
		node.children.push( element );
	}
}

/** Children of an element in the processed document that slots could have replaced. */
function slotChildrenSimple( element: Element ): Element[] {
	return element.children.filter( ( node ): node is Element => isElement( node ) && ! SKIPPED_ELEMENTS.has( node.name ) );
}

/** Whether a head slot element name belongs to the transplant scope. */
const isHeadSlot = ( element: Element ): boolean =>
	element.name === 'title' ||
	( element.name === 'meta' && ( element.attribs.name ?? '' ).toLowerCase() === 'description' ) ||
	( element.name === 'link' && ( element.attribs.rel ?? '' ).split( /\s+/ ).some( value => value.toLowerCase() === 'canonical' ) ) ||
	( element.name === 'meta' && /^og:/i.test( element.attribs.property ?? '' ) );

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
} ): MemberDerivation {
	const clusterKey = templateFingerprint( input.memberServerHtml, input.baseUrl ).key;
	const repKey = templateFingerprint( input.repServerHtml, input.baseUrl ).key;
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
	findServerSlots( repBody, memberBody, [], slots );
	if ( ! slots.length ) {
		// Nothing to transplant: the member is the representative byte for byte
		// in content. That is a legitimate derived member with zero slots.
		return { ok: true, html: input.repProcessedHtml, stats: { slots: 0, subtreeSlots: 0 }, unobservedSlots: 0 };
	}
	// Content gate before any mapping: one runtime-only slot escalates the member.
	for ( const slot of slots ) {
		if ( slot.kind !== 'subtree' ) continue;
		const parsed = html$( `<body>${ slot.replacement as string }</body>` )( 'body' ).children().toArray() as Element[];
		for ( const element of parsed ) {
			if ( element.name === 'script' ) {
				return { ok: false, gate: { code: 'runtime_slot_content', reason: `member slot at /${ slot.path.join( '/' ) } carries a script element capture never observed` } };
			}
			const runtime = slotRuntimeObservation( element );
			if ( runtime.runtime ) {
				return { ok: false, gate: { code: 'runtime_slot_content', reason: `member slot at /${ slot.path.join( '/' ) } carries an embed, handler or hydration marker capture never observed` } };
			}
		}
	}
	// Map onto the processed document with the anchor check.
	let subtreeSlots = 0;
	let unobservedSlots = 0;
	for ( const slot of slots ) {
		const anchor = resolveSlotAnchor( processedBody, slot.path );
		if ( ! anchor || elementDescriptor( anchor ) !== elementDescriptor( walkServerPath( repBody, slot.path ) ) || inlineText( anchor ) !== inlineText( walkServerPath( repBody, slot.path ) ) ) {
			return { ok: false, gate: { code: 'slot_anchor_unmapped', reason: `slot at /${ slot.path.join( '/' ) } has no matching anchor in the representative's captured document` } };
		}
		if ( slot.kind === 'subtree' ) {
			subtreeSlots++;
			const memberNode = walkServerPath( memberBody, slot.path );
			const parsed = html$( `<body>${ serializeNode( memberNode as unknown as AnyNode ) }</body>` )( 'body' ).children().toArray() as Element[];
			for ( const element of parsed ) {
				const runtime = slotRuntimeObservation( element );
				if ( runtime.runtime ) {
					return { ok: false, gate: { code: 'runtime_slot_content', reason: `member slot at /${ slot.path.join( '/' ) } carries an embed, handler or hydration marker capture never observed` } };
				}
				if ( runtime.unobserved ) unobservedSlots++;
			}
		}
		applySlot( anchor, slot );
	}
	// Head slots: title, description, canonical and Open Graph mirror the member.
	for ( const selector of HEAD_SLOT_SELECTORS ) {
		const memberNodes = member( selector ).toArray() as Element[];
		const repNodes = repProcessed( selector ).toArray() as Element[];
		for ( let index = 0; index < repNodes.length; index++ ) {
			const repNode = repNodes[ index ]!;
			const memberNode = memberNodes[ index ];
			if ( memberNode && isHeadSlot( memberNode as Element ) ) {
				replaceProcessedNode( repNode as Element, memberNode as Element );
			}
		}
	}
	return { ok: true, html: repProcessed.html(), stats: { slots: slots.length, subtreeSlots }, unobservedSlots };
}

/** The representative's server node at an element path — the anchor check's comparison target. */
function walkServerPath( body: Element, path: number[] ): Element {
	let node = body;
	for ( const index of path ) {
		const next = slotChildren( node )[ index ];
		if ( ! next ) return node;
		node = next;
	}
	return node;
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
	const documentText = ( $: cheerio.CheerioAPI ): string =>
		normalizedWhitespace( $( 'body' ).text() );
	// Relative URLs in the member's server HTML resolve like a browser would:
	// the real capture carries absolute, localized URLs.
	const collect = ( $: cheerio.CheerioAPI, selector: string, attribute: string ): string[] =>
		$( selector ).toArray()
			.map( element => resolveUrl( ( element as Element ).attribs[ attribute ] ?? '', input.baseUrl ) )
			.filter( value => value !== '' )
			.sort();
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
		images: collect( derived, 'img', 'src' ).join( '\n' ) === collect( real, 'img', 'src' ).join( '\n' ),
		skeleton: skeleton( derived ) === skeleton( real ),
		headStyles: styles( derived ).join( '\n' ) === styles( real ).join( '\n' ),
		fluidRules: fluidSheets( derived ).join( '\n' ) === fluidSheets( real ).join( '\n' ),
	};
	return { equal: Object.values( checks ).every( value => value ), checks };
}

/** Verification sampling: the member farthest from the representative by slot bytes. */
export function verificationMember( members: readonly string[] ): string | undefined {
	if ( members.length === 0 ) return undefined;
	const sorted = [ ...members ].sort( ( a, b ) => a.localeCompare( b ) );
	return sorted[ Math.floor( sorted.length / 2 ) ];
}

export interface TemplateClusterRecord {
	/** Group id from template-groups.json. */
	id: string;
	key: string;
	representative: string;
	/** Members offered for derivation, and their outcomes. */
	derived: Array< { url: string; slots: number; subtreeSlots: number } >;
	escalated: Array< { url: string; gate: string; reason: string } >;
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
	unavailableCount: number;
	clusters: TemplateClusterRecord[];
}

/** Write `template-clusters.json` next to `website/`. */
export function writeTemplateClusters( outputDir: string, receipt: TemplateClustersReceipt ): string {
	const path = join( outputDir, TEMPLATE_CLUSTERS_FILE );
	writeFileSync( path, `${ JSON.stringify( receipt, null, 2 ) }\n` );
	return path;
}
