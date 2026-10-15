import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import type { SiteRouteScope } from '../platform/types.js';
import { mapPool } from './concurrency.js';
import { BodyTooLargeError, safeFetch } from './media-fetch/safe-fetch.js';
import { isRouteDrift } from './screenshot/document-integrity.js';
import { SOURCE_DOCUMENT_MAX_BYTES } from './source-document-policy.js';
import { spreadSample } from './route-budget.js';
import { routeInScope } from './url/route-scope.js';

/**
 * Template grouping (#784, slice 0).
 *
 * Fetches the server HTML of every discovered route (bounded), computes a
 * structural fingerprint of each document, and groups routes that share one.
 * Each group has a representative: its first member in discovery order. The
 * report is evidence for route selection (`routeSelection:
 * 'template-coverage'`); nothing in the website artifact depends on it.
 */
export const TEMPLATE_GROUPS_SCHEMA = 'data-liberation-agent/template-groups/v1';

/** Report file name, next to `website/` in the capture output (never inside it). */
export const TEMPLATE_GROUPS_FILE = 'template-groups.json';

/** Version of the fingerprint rules below; bump when they change. */
export const TEMPLATE_FINGERPRINT_VERSION = 2;

export const TEMPLATE_GROUPING_LIMITS = {
	/** Routes fetched at most; a larger inventory is fetched as an even spread. */
	maxRoutes: 1000,
	/** Requests in flight at once. All routes share the entry origin, so this is a per-origin limit, as in rendered inspection (#746). */
	concurrency: 6,
	requestTimeoutMs: 15_000,
	/** Wall time for the whole pass; routes not fetched by then are left unfingerprinted. */
	timeBudgetMs: 120_000,
	maxDocumentBytes: SOURCE_DOCUMENT_MAX_BYTES,
	/** Response bytes for the whole pass; no new fetch starts past it. */
	maxTotalBytes: 256 * 1024 * 1024,
} as const;

export type TemplateGroupingLimits = { -readonly [ K in keyof typeof TEMPLATE_GROUPING_LIMITS ]: number };

/** Elements that carry no template structure. */
const SKIPPED_ELEMENTS = new Set( [ 'script', 'style', 'noscript', 'template', 'svg', 'link', 'meta', 'br', 'wbr' ] );

/** Inline (phrasing) elements: their presence follows the text, not the template. */
const INLINE_ELEMENTS = new Set( [ 'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'img', 'ins', 'kbd', 'label', 'mark', 'picture', 'q', 's', 'samp', 'small', 'source', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'u', 'var' ] );

/** Prose blocks. Without a stable class or role they are authored content, and all hash alike. */
const PROSE_ELEMENTS = new Set( [ 'address', 'blockquote', 'dl', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'ol', 'p', 'pre', 'table', 'ul' ] );

/**
 * Content containers: the template places them, the author fills them. Their
 * own tag and classes count; what is inside does not. Interactive or styled
 * content inside them is still seen by the divergence fingerprint.
 */
const CONTENT_CONTAINER_CLASS = /^(?:entry-content|post-content|page-content|article-content|article-body|post-body|entry-body|wp-block-post-content|comments-area|comment-list|commentlist|rte)$/;

/** Deeper structure is page content, not template. */
const MAX_SKELETON_DEPTH = 32;

/**
 * Class tokens that change per page or per build rather than per template:
 * anything with a digit (`postid-12`, `wp-image-34`, generated hashes),
 * CSS-in-JS prefixes, leading underscores (CSS modules), taxonomy and author
 * terms (`category-news`, `tag-travel`, `author-matt`), comment parity, and
 * state words (`active`, `current-menu-item`, `is-open`).
 */
const VOLATILE_CLASS = /\d|^(?:css|sc|jsx|svelte|emotion|styled)-|^_|^(?:category|tag|post_tag|author|comment-author|term|product_cat|product_tag|product_type|tax|taxonomy)-|^(?:odd|even|alt|thread-odd|thread-even|thread-alt|bypostauthor|byuser)$|current[-_]|^(?:is-|has-)?(?:active|open|opened|closed|current|selected|expanded|collapsed|hidden|visible|loaded|loading|focus|focused|hover|show|showing)$/i;

const JAVASCRIPT_TYPES = new Set( [ '', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript', 'application/ecmascript' ] );

const digest = ( value: string, length = 16 ) => createHash( 'sha256' ).update( value ).digest( 'hex' ).slice( 0, length );

/**
 * One inline `<style>` element as the template fingerprint sees it.
 *
 * `id` and the other attributes are exposed so a platform can recognize the
 * blocks its own runtime produces; Wix's per-page CSS mappers are keyed by
 * `<style id=…>` and its inlined viewer-widget chunks carry the fetched URL
 * in `data-href` (#836).
 */
export interface TemplateStyleBlock {
	/** The `<style>` element's `id`, or null. */
	id: string | null;
	/** The element's attributes, lower-cased names, as they appear in the document. */
	attributes: Readonly< Record< string, string > >;
	/** The block's declared CSS text, unchanged. */
	text: string;
}

/**
 * Adapter-owned aggregation of a page's inline `<style>` blocks for the
 * template fingerprint's `pageStyles` divergence signal (#836).
 *
 * Platforms whose runtime writes per-item CSS into page-local style blocks on
 * every request declare here which blocks are content rather than template,
 * and drop request-dependent churn (generation marker comments, block order)
 * that would otherwise split routes sharing one template. A site's own
 * authored template CSS must survive; only generated, per-item composition is
 * normalized.
 */
export interface TemplateStyleNormalization {
	/**
	 * Reduce the page's inline `<style>` blocks (document order) to the text the
	 * fingerprint hashes, or null when the page has no template style evidence.
	 * Called with the blocks of one server document; must be deterministic.
	 */
	pageStyles( styles: readonly TemplateStyleBlock[] ): string | null;
}

/** What a skeleton cannot see, compared exactly between members of a group. */
export interface TemplateDivergence {
	/** Hash of the page's own `<style>` text (whitespace-normalized), or null when it has none. */
	pageStyles: string | null;
	/** Hash of the sorted, resolved `<link rel=stylesheet>` URLs. */
	stylesheets: string;
	/** Hash of the sorted, resolved `<script src>` URLs. */
	scripts: string;
	/** The page has an executable inline `<script>`. */
	inlineScripts: boolean;
	/** Sorted distinct forms, as `form.<stable classes>[role]`; a site-wide search form is the same on every page. */
	forms: string[];
	/** Sorted distinct interactive controls, as `<kind>:<tag.stable classes[role]>`; kinds are `details`, `dialog`, `disclosure`, `tab`. */
	controls: string[];
	/** Sorted embed elements present: `audio`, `canvas`, `embed`, `iframe`, `object`, `video`. */
	embeds: string[];
}

export interface TemplateFingerprint {
	/** Group key: the skeleton plus the divergence fingerprint. */
	key: string;
	/** Hash of the collapsed body skeleton. */
	skeleton: string;
	divergence: TemplateDivergence;
}

function stableClassTokens( element: Element ): string[] {
	return [ ...new Set( ( element.attribs.class ?? '' ).split( /\s+/ ).filter( token => token && ! VOLATILE_CLASS.test( token ) ) ) ].sort();
}

const isElement = ( node: AnyNode ): node is Element => node.type === 'tag' || node.type === 'script' || node.type === 'style';

const isContentContainer = ( element: Element ): boolean => element.name === 'article' || element.attribs.id === 'comments' ||
	element.attribs.itemprop === 'articleBody' || ( element.attribs.class ?? '' ).split( /\s+/ ).some( token => CONTENT_CONTAINER_CLASS.test( token ) );

const PROSE_SKELETON = digest( '~prose' );

/** `tag.stable.classes[role=…]`: an element's template identity. */
const elementDescriptor = ( element: Element ): string =>
	`${ element.name }${ stableClassTokens( element ).map( token => `.${ token }` ).join( '' ) }${ element.attribs.role ? `[role=${ element.attribs.role }]` : '' }`;

/**
 * Collapsed skeleton hash of one element: tag, stable classes and `role`, then
 * the set of distinct child skeletons in sorted order. Text, inline elements
 * and attributes other than class and role are ignored; repeated siblings
 * collapse to one, so 4 vs 9 paragraphs or 1 vs 3 figures hash alike;
 * classless prose blocks and the inside of content containers are content.
 */
function skeletonHash( element: Element, depth: number ): string {
	const classes = stableClassTokens( element );
	if ( PROSE_ELEMENTS.has( element.name ) && ! classes.length && ! element.attribs.role ) return PROSE_SKELETON;
	const self = elementDescriptor( element );
	if ( depth >= MAX_SKELETON_DEPTH || isContentContainer( element ) ) return digest( self );
	const children = new Set< string >();
	for ( const child of element.children ) {
		if ( isElement( child ) && ! SKIPPED_ELEMENTS.has( child.name ) && ! INLINE_ELEMENTS.has( child.name ) ) children.add( skeletonHash( child, depth + 1 ) );
	}
	return digest( children.size ? `${ self }(${ [ ...children ].sort().join( ',' ) })` : self );
}

function resolvedSet( values: Array< string | undefined >, baseUrl: string ): string {
	const resolved = new Set< string >();
	for ( const value of values ) {
		if ( ! value?.trim() ) continue;
		try {
			resolved.add( new URL( value.trim(), baseUrl ).href );
		} catch {
			resolved.add( value.trim() );
		}
	}
	return digest( [ ...resolved ].sort().join( '\n' ) );
}

/**
 * One server document's inline `<style>` blocks, as attributes and text, in
 * document order.
 */
function styleBlocks( $: cheerio.CheerioAPI ): TemplateStyleBlock[] {
	return $( 'style' ).toArray().flatMap( element => {
		if ( ! isElement( element ) ) return [];
		return [ { id: element.attribs.id ?? null, attributes: { ...element.attribs }, text: $( element ).text() } ];
	} );
}

/**
 * The fingerprint's page-local style text: document-ordered style texts when no
 * platform normalization is declared, otherwise the adapter's aggregation.
 */
function pageStyleText( styles: readonly TemplateStyleBlock[], normalization?: TemplateStyleNormalization ): string | null {
	if ( normalization ) return normalization.pageStyles( styles );
	if ( ! styles.length ) return null;
	return styles.map( style => style.text ).join( '\n' );
}

/** Fingerprint one server HTML document. Pure and deterministic. */
export function templateFingerprint( html: string, baseUrl: string, normalization?: TemplateStyleNormalization ): TemplateFingerprint {
	const $ = cheerio.load( html );
	const body = $( 'body' ).get( 0 );
	const skeleton = body ? skeletonHash( body, 0 ) : digest( '' );
	const styleText = pageStyleText( styleBlocks( $ ), normalization );
	const describe = ( selector: string, kind?: string ) => $( selector ).toArray().filter( isElement ).map( element => `${ kind ? `${ kind }:` : '' }${ elementDescriptor( element ) }` );
	const controls = [
		...describe( '[role=tab],[role=tablist],[role=tabpanel]', 'tab' ),
		...describe( '[aria-controls],[aria-expanded]', 'disclosure' ),
		...describe( 'details', 'details' ),
		...describe( 'dialog,[role=dialog]', 'dialog' ),
	];
	const embeds = [ 'audio', 'canvas', 'embed', 'iframe', 'object', 'video' ].filter( tag => $( tag ).length > 0 );
	const divergence: TemplateDivergence = {
		pageStyles: styleText ? digest( styleText.replace( /\s+/g, ' ' ).trim() ) : null,
		stylesheets: resolvedSet( $( 'link[rel~="stylesheet" i]' ).map( ( _index, element ) => $( element ).attr( 'href' ) ).get(), baseUrl ),
		scripts: resolvedSet( $( 'script[src]' ).map( ( _index, element ) => $( element ).attr( 'src' ) ).get(), baseUrl ),
		inlineScripts: $( 'script:not([src])' ).toArray().some( element => JAVASCRIPT_TYPES.has( ( element.attribs.type ?? '' ).trim().toLowerCase() ) && $( element ).text().trim() !== '' ),
		forms: [ ...new Set( describe( 'form' ) ) ].sort(),
		controls: [ ...new Set( controls ) ].sort(),
		embeds,
	};
	return { key: digest( JSON.stringify( { version: TEMPLATE_FINGERPRINT_VERSION, skeleton, divergence } ) ), skeleton, divergence };
}

/** Why a route has no fingerprint. */
export type UnfingerprintedReason =
	| 'not_sampled' // over `maxRoutes`
	| 'time_budget' // the pass ran out of time before or while fetching it
	| 'byte_budget' // the pass ran out of response bytes before fetching it
	| 'rate_limited' // the source throttled (429/503) again after a Retry-After pause; the pass stopped
	| 'http_status' // non-2xx response
	| 'not_html' // response is not text/html
	| 'redirected' // the response is another route's document
	| 'too_large' // over `maxDocumentBytes`
	| 'fetch_failed'; // network, SSRF or scope refusal, decode error

export interface TemplateGroup {
	/** `t1`, `t2`, … in order of each group's first member in the inventory. */
	id: string;
	key: string;
	skeleton: string;
	divergence: TemplateDivergence;
	/** First member in inventory order. */
	representative: string;
	size: number;
	/** Every member, in inventory order. */
	members: string[];
}

export interface TemplateGroupsSelection {
	mode: 'template-coverage' | 'discovery-order';
	/** Route budget, entrypoint included; null when the whole inventory is captured. */
	limit: number | null;
	selected: number;
	groupsRepresented: number;
	/** Ids of groups with no selected member. */
	groupsOmitted: string[];
}

export interface TemplateGroupsReport {
	schema: typeof TEMPLATE_GROUPS_SCHEMA;
	sourceUrl: string;
	fingerprint: { version: number; maxSkeletonDepth: number };
	limits: TemplateGroupingLimits;
	coverage: {
		/** Deduplicated inventory, entrypoint included. */
		routes: number;
		fingerprinted: number;
		unfingerprinted: number;
		groups: number;
		/** Groups with exactly one member. */
		singletons: number;
	};
	groups: TemplateGroup[];
	/** Routes with no fingerprint, in inventory order. They belong to no group. */
	unfingerprinted: Array< { url: string; reason: UnfingerprintedReason; httpStatus?: number } >;
	/** Set by capture once the route budget has selected. */
	selection?: TemplateGroupsSelection;
}

export interface TemplateGroupingInput {
	sourceUrl: string;
	/** Deduplicated inventory, entrypoint first. */
	urls: readonly string[];
	routeScope?: SiteRouteScope;
	limits?: Partial< TemplateGroupingLimits >;
	/** Platform-owned `<style>` aggregation for the divergence fingerprint. */
	styleNormalization?: TemplateStyleNormalization;
}

/**
 * Fetch order in which every prefix is an even spread: the entrypoint, then
 * the midpoints of ever smaller intervals of the rest, breadth first. A pass cut short by
 * its time budget still fingerprints routes from across the inventory.
 */
export function progressiveOrder( length: number ): number[] {
	if ( length <= 0 ) return [];
	const order = [ 0 ];
	const intervals: Array< [ number, number ] > = [ [ 1, length - 1 ] ];
	for ( let index = 0; index < intervals.length; index++ ) {
		const [ low, high ] = intervals[ index ]!;
		if ( low > high ) continue;
		const middle = ( low + high ) >> 1;
		order.push( middle );
		intervals.push( [ low, middle - 1 ], [ middle + 1, high ] );
	}
	return order;
}

const THROTTLE_STATUSES = new Set( [ 429, 503 ] );

/** Retry-After in ms (seconds or an HTTP date), default 1 s, at most `maxMs`. */
function retryAfterMs( header: string | null, maxMs: number ): number {
	const seconds = header === null ? Number.NaN : Number( header );
	const requested = Number.isFinite( seconds ) ? seconds * 1000 : header ? Date.parse( header ) - Date.now() : 1000;
	return Math.min( maxMs, Math.max( 0, Number.isFinite( requested ) ? requested : 1000 ) );
}

function abortableDelay( ms: number, signal: AbortSignal ): Promise< void > {
	return new Promise( resolve => {
		const done = () => {
			clearTimeout( timer );
			signal.removeEventListener( 'abort', done );
			resolve();
		};
		const timer = setTimeout( done, ms );
		signal.addEventListener( 'abort', done, { once: true } );
	} );
}

type RouteOutcome = { fingerprint: TemplateFingerprint } | { reason: UnfingerprintedReason; httpStatus?: number };

/** Fetch and fingerprint the inventory within `limits`, then group it. Never throws for a route; per-route problems are recorded. */
export async function buildTemplateGroups( input: TemplateGroupingInput, dependencies = { fetch: safeFetch } ): Promise< TemplateGroupsReport > {
	const limits: TemplateGroupingLimits = { ...TEMPLATE_GROUPING_LIMITS, ...input.limits };
	const urls = [ ...input.urls ];
	const outcomes: RouteOutcome[] = urls.map( () => ( { reason: 'not_sampled' } ) );
	const sampled = new Set( spreadSample( urls, limits.maxRoutes ) );
	const order = progressiveOrder( urls.length ).filter( index => sampled.has( urls[ index ]! ) );
	const deadline = new AbortController();
	const timer = setTimeout( () => deadline.abort(), limits.timeBudgetMs );
	let bytes = 0;
	// After the source throttles (429/503) the pass slows to one request at a
	// time and honours Retry-After; a second refusal stops it, so grouping never
	// spends the rate limit the browser capture needs.
	let throttled = false;
	let rateLimited = false;
	let pausedUntil = 0;
	let queue: Promise< unknown > = Promise.resolve();
	try {
		await mapPool( order, limits.concurrency, async index => {
			outcomes[ index ] = await fingerprintRoute( urls[ index ]! );
		} );
	} finally {
		clearTimeout( timer );
	}

	function admit< T >( task: () => Promise< T > ): Promise< T > {
		const run = async () => {
			const wait = pausedUntil - Date.now();
			if ( wait > 0 ) await abortableDelay( wait, deadline.signal );
			return task();
		};
		if ( ! throttled ) return run();
		const result = queue.then( run );
		queue = result.catch( () => undefined );
		return result;
	}

	function request( url: string ) {
		return dependencies.fetch( url, {
			timeoutMs: limits.requestTimeoutMs, maxBytes: limits.maxDocumentBytes, signal: deadline.signal,
			...( input.routeScope ? { authorizeUrl: ( target: string ) => {
				if ( ! routeInScope( target, input.routeScope ) ) throw new Error( 'Template grouping request is outside the adapter route scope' ); // failure-class: operational
			} } : {} ),
		} );
	}

	async function fingerprintRoute( url: string ): Promise< RouteOutcome > {
		if ( deadline.signal.aborted ) return { reason: 'time_budget' };
		if ( rateLimited ) return { reason: 'rate_limited' };
		if ( bytes >= limits.maxTotalBytes ) return { reason: 'byte_budget' };
		let response;
		try {
			response = await admit( () => request( url ) );
			if ( THROTTLE_STATUSES.has( response.status ) ) {
				throttled = true;
				pausedUntil = Math.max( pausedUntil, Date.now() + retryAfterMs( response.headers.get( 'retry-after' ), limits.requestTimeoutMs ) );
				response = await admit( () => request( url ) );
				if ( THROTTLE_STATUSES.has( response.status ) ) {
					rateLimited = true;
					return { reason: 'rate_limited', httpStatus: response.status };
				}
			}
		} catch ( error ) {
			if ( deadline.signal.aborted ) return { reason: 'time_budget' };
			return { reason: error instanceof BodyTooLargeError ? 'too_large' : 'fetch_failed' };
		}
		bytes += response.body.length;
		if ( response.status < 200 || response.status >= 300 ) return { reason: 'http_status', httpStatus: response.status };
		const contentType = response.headers.get( 'content-type' ) ?? '';
		if ( ! /^text\/html(?:;|$)/i.test( contentType ) ) return { reason: 'not_html' };
		if ( isRouteDrift( response.finalUrl, url ) ) return { reason: 'redirected' };
		try {
			const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec( contentType )?.[ 1 ] ?? 'utf-8';
			let decoder: TextDecoder;
			try {
				decoder = new TextDecoder( charset );
			} catch {
				decoder = new TextDecoder( 'utf-8' );
			}
			return { fingerprint: templateFingerprint( decoder.decode( response.body ), response.finalUrl, input.styleNormalization ) };
		} catch {
			return { reason: 'fetch_failed' };
		}
	}

	return groupTemplates( input.sourceUrl, urls, outcomes, limits );
}

function groupTemplates( sourceUrl: string, urls: string[], outcomes: RouteOutcome[], limits: TemplateGroupingLimits ): TemplateGroupsReport {
	const byKey = new Map< string, TemplateGroup >();
	const unfingerprinted: TemplateGroupsReport['unfingerprinted'] = [];
	urls.forEach( ( url, index ) => {
		const outcome = outcomes[ index ]!;
		if ( ! ( 'fingerprint' in outcome ) ) {
			unfingerprinted.push( { url, reason: outcome.reason, ...( outcome.httpStatus !== undefined ? { httpStatus: outcome.httpStatus } : {} ) } );
			return;
		}
		const { key, skeleton, divergence } = outcome.fingerprint;
		const group = byKey.get( key );
		if ( group ) {
			group.members.push( url );
			group.size++;
		} else byKey.set( key, { id: `t${ byKey.size + 1 }`, key, skeleton, divergence, representative: url, size: 1, members: [ url ] } );
	} );
	const groups = [ ...byKey.values() ];
	const fingerprinted = urls.length - unfingerprinted.length;
	return {
		schema: TEMPLATE_GROUPS_SCHEMA,
		sourceUrl,
		fingerprint: { version: TEMPLATE_FINGERPRINT_VERSION, maxSkeletonDepth: MAX_SKELETON_DEPTH },
		limits,
		coverage: { routes: urls.length, fingerprinted, unfingerprinted: unfingerprinted.length, groups: groups.length, singletons: groups.filter( group => group.size === 1 ).length },
		groups,
		unfingerprinted,
	};
}

/**
 * Representatives in the order the route budget should prefer them: larger
 * groups first (they stand for more routes), then inventory order.
 */
export function templateRepresentatives( report: TemplateGroupsReport ): string[] {
	return report.groups
		.map( ( group, index ) => ( { group, index } ) )
		.sort( ( a, b ) => b.group.size - a.group.size || a.index - b.index )
		.map( ( { group } ) => group.representative );
}

/** Which groups a route selection covers. */
export function templateSelectionCoverage( report: TemplateGroupsReport, selected: readonly string[], mode: TemplateGroupsSelection['mode'], limit: number | undefined ): TemplateGroupsSelection {
	const kept = new Set( selected );
	const omitted = report.groups.filter( group => ! group.members.some( url => kept.has( url ) ) ).map( group => group.id );
	return { mode, limit: limit ?? null, selected: selected.length, groupsRepresented: report.groups.length - omitted.length, groupsOmitted: omitted };
}

/** Write the report next to `website/`; returns its path. */
export function writeTemplateGroups( outputDir: string, report: TemplateGroupsReport ): string {
	const path = join( outputDir, TEMPLATE_GROUPS_FILE );
	writeFileSync( path, `${ JSON.stringify( report, null, 2 ) }\n` );
	return path;
}

/** Compact counts for the capture receipt and logs. */
export function templateGroupsSummary( report: TemplateGroupsReport ) {
	return {
		schema: report.schema,
		report: TEMPLATE_GROUPS_FILE,
		...report.coverage,
		...( report.selection ? { selection: { mode: report.selection.mode, groupsRepresented: report.selection.groupsRepresented, groupsOmitted: report.selection.groupsOmitted.length } } : {} ),
	};
}
