/**
 * Canonical route-alias dedupe (#835).
 *
 * Route inventory dedupes only by document request identity, so discovery can
 * hold the same document under two inventory routes that differ by query string
 * alone (a sitemap URL and an in-page link, for example). Each spent route pays
 * the full browser pipeline and export then confirms with the captured
 * `rel=canonical` that the pair was one document all along (`routes.duplicates`).
 *
 * Here the confirmation happens before capture, on the cheapest evidence:
 * candidates — routes that differ from another inventory route by query string
 * alone — are fetched as server HTML with the same bounded policy as template
 * grouping. A candidate whose `rel=canonical` resolves, by document request
 * identity, to another inventory route is dropped from capture and recorded as
 * an alias of that route. Every uncertain case keeps the route; routes without
 * such a sibling are never fetched.
 */
import * as cheerio from 'cheerio';
import type { SiteRouteScope } from '../platform/types.js';
import { mapPool } from './concurrency.js';
import { safeFetch } from './media-fetch/safe-fetch.js';
import { SOURCE_DOCUMENT_MAX_BYTES } from './source-document-policy.js';
import { documentRequestUrl } from './url/route-key.js';
import { routeInScope } from './url/route-scope.js';
import { isRouteDrift } from './screenshot/document-integrity.js';

export const ROUTE_ALIAS_LIMITS = {
	/** Requests in flight at once, as in rendered inspection (#746). */
	concurrency: 6,
	requestTimeoutMs: 15_000,
	maxDocumentBytes: SOURCE_DOCUMENT_MAX_BYTES,
} as const;

/** Discovery diagnostic code for a route skipped because its canonical is another inventory route. */
export const ROUTE_ALIAS_CANONICAL = 'route_alias_canonical';

export interface CanonicalRouteAlias {
	/** The inventory route (query rendition) that was skipped. */
	url: string;
	/** The inventory route its `rel=canonical` resolves to. */
	canonicalUrl: string;
}

export interface RouteAliasProbeInput {
	sourceUrl: string;
	/** Deduplicated inventory, entrypoint included. */
	urls: readonly string[];
	routeScope?: SiteRouteScope;
	limits?: Partial< typeof ROUTE_ALIAS_LIMITS >;
}

export interface RouteAliasProbeResult {
	aliases: CanonicalRouteAlias[];
	/** How many candidates were fetched to decide them. */
	probes: number;
}

/** Why a candidate was kept (no evidence to drop it). */
export type RouteAliasKept = 'fetch_failed' | 'http_status' | 'not_html' | 'redirected' | 'no_canonical' | 'canonical_not_in_inventory' | 'canonical_self' | 'canonical_not_captured' | 'drifted' | 'unreadable';

export interface RouteAliasProbeDetail extends RouteAliasProbeResult {
	kept: Array< { url: string; reason: RouteAliasKept } >;
}

const identity = ( url: string ): string | undefined => {
	try {
		return documentRequestUrl( url );
	} catch {
		return undefined;
	}
};

/**
 * Candidates: routes that differ from another inventory route on origin and
 * path by the query string alone. Ordered first, so a probe budget can sample
 * from the front.
 */
export function queryOnlyAliasCandidates( urls: readonly string[] ): string[] {
	const byDocument = new Map< string, string >();
	const byPath = new Map< string, string[] >();
	for ( const url of urls ) {
		const key = identity( url );
		if ( ! key || byDocument.has( key ) ) continue;
		byDocument.set( key, url );
		try {
			const route = new URL( url );
			const pathKey = `${ route.origin }${ route.pathname }`;
			const group = byPath.get( pathKey ) ?? [];
			group.push( url );
			byPath.set( pathKey, group );
		} catch {
			// An unparseable inventory entry cannot be a candidate; keep it as-is.
		}
	}
	return [ ...byPath.values() ].filter( group => group.length > 1 ).flatMap( group => group.filter( url => new URL( url ).search !== '' ) );
}

/** First `<link rel="canonical">` of a server-HTML fragment, resolved against the response. */
export function canonicalLinkHref( html: string, baseUrl: string ): string | undefined {
	const $ = cheerio.load( html );
	for ( const element of $( 'link[rel]' ).toArray() ) {
		const relations = ( element.attribs.rel ?? '' ).toLowerCase().split( /\s+/ );
		if ( ! relations.includes( 'canonical' ) ) continue;
		const href = ( element.attribs.href ?? '' ).trim();
		if ( ! href ) continue;
		try {
			return new URL( href, baseUrl ).href;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Drop inventory routes whose server-HTML `rel=canonical` resolves to another
 * route in the same inventory. Bounded and advisory: any fetch, status, parse,
 * scope or resolution problem keeps the candidate, as does a source redirect.
 */
export async function probeCanonicalRouteAliases(
	input: RouteAliasProbeInput,
	dependencies: { fetch: typeof safeFetch } = { fetch: safeFetch }
): Promise< RouteAliasProbeDetail > {
	const limits: typeof ROUTE_ALIAS_LIMITS = { ...ROUTE_ALIAS_LIMITS, ...input.limits };
	const candidates = queryOnlyAliasCandidates( input.urls );
	if ( ! candidates.length ) return { aliases: [], probes: 0, kept: [] };
	const sourceIdentity = identity( input.sourceUrl );
	const inventoryIdentities = new Map< string, string >();
	for ( const url of input.urls ) {
		const key = identity( url );
		if ( key ) inventoryIdentities.set( key, url );
	}
	const kept: Array< { url: string; reason: RouteAliasKept } > = [];
	const aliases: CanonicalRouteAlias[] = [];
	let probes = 0;
	const probe = async ( url: string ): Promise< unknown > => {
		if ( identity( url ) === sourceIdentity || ! routeInScope( url, input.routeScope ) ) return;
		probes++;
		let response;
		try {
			response = await dependencies.fetch( url, {
				timeoutMs: limits.requestTimeoutMs,
				maxBytes: limits.maxDocumentBytes,
				authorizeUrl: ( target: string ) => {
					if ( ! routeInScope( target, input.routeScope ) ) throw new Error( 'Canonical alias request is outside the adapter route scope' ); // failure-class: operational
				},
			} );
		} catch {
			kept.push( { url, reason: 'fetch_failed' } );
			return;
		}
		if ( response.status < 200 || response.status >= 300 ) return kept.push( { url, reason: 'http_status' } );
		const contentType = response.headers.get( 'content-type' ) ?? '';
		if ( ! /^text\/html(?:;|$)/i.test( contentType ) ) return kept.push( { url, reason: 'not_html' } );
		if ( isRouteDrift( response.finalUrl, url ) ) return kept.push( { url, reason: 'drifted' } );
		let canonical;
		try {
			canonical = canonicalLinkHref( response.body.toString( 'utf8' ), response.finalUrl );
		} catch {
			return kept.push( { url, reason: 'no_canonical' } );
		}
		if ( ! canonical ) return kept.push( { url, reason: 'no_canonical' } );
		const canonicalIdentity = identity( canonical );
		if ( ! canonicalIdentity || ! routeInScope( canonical, input.routeScope ) ) return kept.push( { url, reason: 'canonical_not_in_inventory' } );
		if ( canonicalIdentity === identity( url ) ) return kept.push( { url, reason: 'canonical_self' } );
		const target = inventoryIdentities.get( canonicalIdentity );
		if ( ! target ) return kept.push( { url, reason: 'canonical_not_in_inventory' } );
		aliases.push( { url, canonicalUrl: target } );
	};
	// Advisory: a malformed response from any candidate keeps that route rather
	// than ending the capture.
	await mapPool( candidates, limits.concurrency, url => probe( url ).catch( () => { kept.push( { url, reason: 'unreadable' } ); } ) );
	// A route survives only as some alias's target if it is itself captured: when
	// candidates name each other (or a chain ends on a dropped candidate), keep
	// them all rather than drop the document.
	const dropped = new Set( aliases.map( ( { url } ) => identity( url ) ) );
	const surviving = aliases.filter( ( { canonicalUrl } ) => ! dropped.has( identity( canonicalUrl ) ) );
	for ( const { url } of aliases ) if ( ! surviving.some( alias => alias.url === url ) ) kept.push( { url, reason: 'canonical_not_captured' } );
	return { aliases: surviving, probes, kept };
}
