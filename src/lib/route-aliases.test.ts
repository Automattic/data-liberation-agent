import { describe, expect, it } from 'vitest';
import type { SafeFetchResult } from './media-fetch/safe-fetch.js';
import {
	canonicalLinkHref,
	probeCanonicalRouteAliases,
	queryOnlyAliasCandidates,
} from './route-aliases.js';

function document( html: string, finalUrl = 'https://fixture.test/x' ): SafeFetchResult {
	return { finalUrl, status: 200, headers: new Headers( { 'content-type': 'text/html; charset=utf-8' } ), body: Buffer.from( html ) };
}

/** A safeFetch stand-in recording every request it saw. */
function fetchFixture( respond: ( url: string ) => SafeFetchResult | Error | Promise< SafeFetchResult | Error > ) {
	const seen: string[] = [];
	const fetch = ( async ( url: string ) => {
		seen.push( url );
		const outcome = await respond( url );
		if ( outcome instanceof Error ) throw outcome;
		return outcome;
	} ) as unknown as typeof import('./media-fetch/safe-fetch.js').safeFetch;
	return { seen, fetch };
}

describe( 'canonical route-alias candidates', () => {
	it( 'names query-only siblings of another inventory route; singletons and base routes are never candidates', () => {
		const urls = [
			'https://fixture.test/', // singleton path: never a candidate
			'https://fixture.test/challenge-page/12', // base of a pair: not a candidate (no query)
			'https://fixture.test/challenge-page/12?programId=12', // candidate
		];
		expect( queryOnlyAliasCandidates( urls ) ).toEqual( [ 'https://fixture.test/challenge-page/12?programId=12' ] );
		const pair = queryOnlyAliasCandidates( [ 'https://fixture.test/articles/', 'https://fixture.test/articles/?lang=fr' ] );
		expect( pair ).toEqual( [ 'https://fixture.test/articles/?lang=fr' ] );
	} );
} );

describe( 'canonical link parsing', () => {
	it( 'resolves the first rel=canonical href against the response URL', () => {
		expect( canonicalLinkHref(
			'<link rel="icon" href="/f.ico"><link rel="canonical" href="/challenge-page/12">',
			'https://fixture.test/challenge-page/12?programId=12'
		) ).toBe( 'https://fixture.test/challenge-page/12' );
	} );
	it( 'is undefined without a canonical link', () => {
		expect( canonicalLinkHref( '<title>x</title>', 'https://fixture.test/' ) ).toBeUndefined();
	} );
} );

describe( 'canonical route-alias probe', () => {
	it( 'drops a query-only alias whose canonical is another inventory route and keeps every uncertain case', async () => {
		const ok = document( '<head><link rel="canonical" href="/challenge-page/12"></head><body></body>',
			'https://fixture.test/challenge-page/12?programId=12' );
		const urls = [
			'https://fixture.test/',
			'https://fixture.test/challenge-page/12',
			'https://fixture.test/challenge-page/12?programId=12',
			'https://fixture.test/kept-no-canonical',
			'https://fixture.test/kept-no-canonical?lang=fr',
			'https://fixture.test/kept-external-canonical',
			'https://fixture.test/kept-external-canonical?lang=de',
			'https://fixture.test/kept-failing',
			'https://fixture.test/kept-failing?lang=es',
		];
		const { seen, fetch } = fetchFixture( ( url ) => {
			if ( url.includes( 'kept-no-canonical' ) ) return document( '<body></body>', url );
			if ( url.includes( 'kept-external-canonical' ) ) return document( '<head><link rel="canonical" href="https://elsewhere.test/x"></head><body></body>', url );
			if ( url.includes( 'kept-failing' ) ) return new Error( 'network down' );
			return ok;
		} );
		const result = await probeCanonicalRouteAliases( { sourceUrl: 'https://fixture.test/', urls }, { fetch } );
		// Only query-only candidates with a sibling were fetched; the base route,
		// the singleton and the entrypoint were never requested.
		expect( seen ).toHaveLength( 4 );
		expect( seen.filter( url => url.includes( 'kept-' ) ) ).toHaveLength( 3 );
		expect( result.probes ).toBe( 4 );
		expect( result.aliases ).toEqual( [ { url: 'https://fixture.test/challenge-page/12?programId=12', canonicalUrl: 'https://fixture.test/challenge-page/12' } ] );
		expect( result.kept.map( ( { url, reason } ) => ( { reason, kept: url.includes( 'kept-' ) } ) ).filter( row => row.kept ) )
			.toEqual( [
				{ reason: 'no_canonical', kept: true },
				{ reason: 'canonical_not_in_inventory', kept: true },
				{ reason: 'fetch_failed', kept: true },
			] );
	} );

	it( 'keeps an alias that only declares itself canonical and never fetches anything without candidates', async () => {
		const self = document( '<head><link rel="canonical" href="/challenge-page/12?programId=12"></head><body></body>',
			'https://fixture.test/challenge-page/12?programId=12' );
		const { seen, fetch } = fetchFixture( () => self );
		const pointed = await probeCanonicalRouteAliases( { sourceUrl: 'https://fixture.test/',
			urls: [ 'https://fixture.test/', 'https://fixture.test/challenge-page/12', 'https://fixture.test/challenge-page/12?programId=12' ] }, { fetch } );
		expect( pointed.aliases ).toEqual( [] );
		expect( pointed.kept ).toEqual( [ { url: 'https://fixture.test/challenge-page/12?programId=12', reason: 'canonical_self' } ] );

		const none = fetchFixture( () => { throw new Error( 'must not fetch' ); } );
		const without = await probeCanonicalRouteAliases( { sourceUrl: 'https://fixture.test/',
			urls: [ 'https://fixture.test/', 'https://fixture.test/challenge-page/12' ] }, { fetch: none.fetch } );
		expect( without ).toEqual( { aliases: [], probes: 0, kept: [] } );
		expect( none.seen ).toEqual( [] );
	} );

	it( 'keeps query renditions that name each other as canonical instead of dropping the document', async () => {
		// Two query renditions of one path, each declaring the other canonical:
		// dropping both would leave the capture with neither.
		const urls = [ 'https://fixture.test/', 'https://fixture.test/list?sort=a', 'https://fixture.test/list?sort=b' ];
		const { fetch } = fetchFixture( ( url ) => document(
			`<head><link rel="canonical" href="${ url.endsWith( 'sort=a' ) ? '/list?sort=b' : '/list?sort=a' }"></head><body></body>`, url ) );
		const result = await probeCanonicalRouteAliases( { sourceUrl: 'https://fixture.test/', urls }, { fetch } );
		expect( result.aliases ).toEqual( [] );
		expect( result.kept.map( ( { reason } ) => reason ) ).toEqual( [ 'canonical_not_captured', 'canonical_not_captured' ] );
	} );

	it( 'keeps a route whose probe response cannot be read instead of failing the capture', async () => {
		const fetch = async ( url: string ) => ( { finalUrl: url } ) as unknown as Awaited< ReturnType< typeof import( './media-fetch/safe-fetch.js' ).safeFetch > >;
		const result = await probeCanonicalRouteAliases( { sourceUrl: 'https://fixture.test/',
			urls: [ 'https://fixture.test/', 'https://fixture.test/a', 'https://fixture.test/a?b=1' ] }, { fetch } );
		expect( result ).toEqual( { aliases: [], probes: 1, kept: [ { url: 'https://fixture.test/a?b=1', reason: 'unreadable' } ] } );
	} );
} );
