import type { Page, Route } from 'playwright';
import * as cheerio from 'cheerio';
import { hydrateDisclosureContent } from './dynamic-content.js';
import { dismissOverlays } from './page-helpers.js';
import type { CapturedCollectionFilter } from './typed-search-capture.js';

export const FINITE_BOOTSTRAP_SCHEMA = 'data-liberation/finite-bootstrap/v1' as const;
export const BOOTSTRAP_PROBE = 'dla-finite-probe-7f39b2';
const NO_MATCH = 'dla-no-match-7f39b2';
const NO_MATCH_AGAIN = 'dla-no-match-2c81e4';
const MAX_BODY_BYTES = 256 * 1024;

export type CollectionCompleteness = 'declared-finite' | 'paginated' | 'undeclared';

export interface FiniteBootstrapContract {
	schema: typeof FINITE_BOOTSTRAP_SCHEMA;
	mode: 'category-or-global-search';
	queryIndependent: true;
	completeness: 'declared-finite';
	declaredCount: number;
	observedItemCount: number;
	coverage: 'complete';
	verification: 'intercepted-observed-responses';
	replayedResponses: number;
	blockedFollowUps: number;
	sourceFollowUpsBlocked: number;
	unmatchedProbeBlocked: true;
	categoryControlsDuringSearch: 'hidden';
	emptyQueryRestoresCategory: true;
	answers: 'observed' | 'pending-disclosure-integration';
	answerOnly: 'verified' | 'pending-disclosure-integration';
	resources: 'text-only';
	order: {
		proof: 'universal-query';
		query: string;
		keys: string[];
		categoriesAgree: boolean;
		categoryKeys: string[][];
	};
	probes: {
		global: Array<{ query: string; keys: string[] }>;
		categories: Array<{ category: number; keys: string[] }>;
	};
}

interface Exchange {
	method: string;
	url: string;
	postData: string;
	status: number;
	contentType: string;
	body: string;
	phase: 'search' | 'category';
	truncated: boolean;
	carriesQuery: boolean;
	completeness: CollectionCompleteness;
	declaredCount: number | null;
	collectionShaped: boolean;
}

const normalize = ( text: string ) => text.replace( /\s+/g, ' ' ).trim();

export function sharedOrderQuery( texts: string[] ): string | null {
	if ( texts.length < 2 ) return null;
	const normalized = texts.map( text => text.toLowerCase() );
	const shared = [ ...normalized[ 0 ] ].filter( ( character, index, all ) => character.trim() && all.indexOf( character ) === index && normalized.every( text => text.includes( character ) ) );
	return shared.find( character => /\p{L}/u.test( character ) ) ?? shared[ 0 ] ?? null;
}

export function isOrderedSubsequence( order: string[], subset: string[] ): boolean {
	let index = 0;
	for ( const key of order ) {
		if ( key === subset[ index ] ) index++;
		if ( index === subset.length ) return true;
	}
	return index === subset.length;
}

export function bindObservedEmpty( firstHtml: string, firstQuery: string, secondHtml: string, secondQuery: string ): { html: string; bindsQuery: boolean } {
	const swap = ( html: string, from: string, to: string ) => html.split( from ).join( to );
	if ( firstHtml.includes( firstQuery ) && secondHtml.includes( secondQuery ) && swap( firstHtml, firstQuery, secondQuery ) === secondHtml ) {
		return { html: swap( firstHtml, firstQuery, '__DLA_QUERY__' ), bindsQuery: true };
	}
	const strip = ( html: string ) => swap( swap( html, firstQuery, '' ), secondQuery, '' );
	return { html: strip( firstHtml ), bindsQuery: false };
}

export function collectionItemHasResource( html: string ): boolean {
	return /<(?:img|video|audio|source|iframe|embed|object|picture)\b/i.test( html )
		|| /\s(?:src|srcset|poster)\s*=\s*["'](?!data:|#)/i.test( html )
		|| /url\s*\(\s*['"]?(?!data:)/i.test( html );
}

export function requestCarriesQuery( url: string, postData: string, query: string ): boolean {
	return query.length > 0 && `${ url }\n${ postData }`.includes( query );
}

export function isCollectionShaped( body: string ): boolean {
	let parsed: unknown;
	try { parsed = JSON.parse( body ); } catch { return false; }
	return hasRecordArray( parsed, 0 );
}

function hasRecordArray( value: unknown, depth: number ): boolean {
	if ( ! value || typeof value !== 'object' || depth > 6 ) return false;
	if ( Array.isArray( value ) ) return value.length >= 2 && value.every( entry => entry && typeof entry === 'object' && ! Array.isArray( entry ) ) || value.some( entry => hasRecordArray( entry, depth + 1 ) );
	return Object.values( value ).some( entry => hasRecordArray( entry, depth + 1 ) );
}

export function classifyCollectionResponse( body: string ): { completeness: CollectionCompleteness; declaredCount: number | null } {
	let parsed: unknown;
	try { parsed = JSON.parse( body ); } catch { return { completeness: 'undeclared', declaredCount: null }; }
	const declarations = pagingDeclarations( parsed, 0 );
	if ( declarations.some( item => item.hasNext && item.recordCount === item.count ) ) return { completeness: 'paginated', declaredCount: null };
	const finite = declarations.filter( item => ! item.hasNext && item.recordCount === item.count && item.count >= 1 );
	if ( ! finite.length ) return { completeness: 'undeclared', declaredCount: null };
	return { completeness: 'declared-finite', declaredCount: Math.max( ...finite.map( item => item.count ) ) };
}

function pagingDeclarations( value: unknown, depth: number ): Array<{ hasNext: boolean; count: number; recordCount: number }> {
	if ( ! value || typeof value !== 'object' || depth > 6 ) return [];
	if ( Array.isArray( value ) ) return value.flatMap( entry => pagingDeclarations( entry, depth + 1 ) );
	const record = value as Record<string, unknown>;
	const arrays = Object.values( record ).filter( ( entry ): entry is unknown[] => Array.isArray( entry ) && entry.length > 0 && entry.every( item => item && typeof item === 'object' && ! Array.isArray( item ) ) );
	const found: Array<{ hasNext: boolean; count: number; recordCount: number }> = [];
	for ( const entry of Object.values( record ) ) {
		if ( ! entry || typeof entry !== 'object' || Array.isArray( entry ) ) continue;
		const paging = entry as Record<string, unknown>;
		if ( typeof paging.hasNext !== 'boolean' || typeof paging.count !== 'number' || ! Number.isFinite( paging.count ) ) continue;
		const matched = arrays.find( list => list.length === paging.count );
		found.push( { hasNext: paging.hasNext, count: paging.count, recordCount: matched ? matched.length : -1 } );
	}
	for ( const entry of Object.values( record ) ) found.push( ...pagingDeclarations( entry, depth + 1 ) );
	return found;
}

const snapshotItems = ( html: string ) => snapshotCollectionItems( html ).items;

export function snapshotCollectionItems( html: string ): { items: Array<{ text: string; html: string }>; itemDepth: number } {
	const $ = cheerio.load( html, null, false );
	const text = ( element: import('domhandler').AnyNode ): string => element.type === 'text' ? element.data : 'children' in element ? element.children.map( text ).join( ' ' ) : '';
	let node = $( '*' ).first();
	let itemDepth = 0;
	while ( node.children().length === 1 ) {
		const only = node.children().first();
		const grandchildren = only.children().toArray().filter( child => child.type === 'tag' );
		const tag = grandchildren[ 0 ] && 'tagName' in grandchildren[ 0 ] ? grandchildren[ 0 ].tagName : '';
		if ( grandchildren.length < 2 || ! tag || grandchildren.some( child => ! ( 'tagName' in child ) || child.tagName !== tag ) ) break;
		node = only;
		itemDepth++;
	}
	return {
		itemDepth,
		items: node.children().toArray().map( element => ( { text: normalize( text( element ) ), html: $.html( element ) } ) ).filter( item => item.text ),
	};
}

function answerCoverage( items: Array<{ text: string; html: string }> ): 'observed' | 'pending-disclosure-integration' {
	const pending = items.some( item => {
		const $ = cheerio.load( item.html, null, false );
		const trigger = $( '[aria-expanded]' ).first();
		if ( ! trigger.length ) return false;
		const label = normalize( trigger.text() );
		return label.length > 0 && label === item.text;
	} );
	return pending ? 'pending-disclosure-integration' : 'observed';
}

async function visible( page: Page, selector: string ): Promise<boolean> {
	return page.locator( selector ).evaluate( element => {
		const style = getComputedStyle( element );
		const rect = element.getBoundingClientRect();
		return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && ! element.closest( '[hidden]' );
	} ).catch( () => false );
}

async function controlsVisible( page: Page, selectors: string[] ): Promise<boolean> {
	const checks = await Promise.all( selectors.map( selector => visible( page, selector ) ) );
	return checks.every( Boolean );
}

export async function captureFiniteBootstrap(
	page: Page,
	field: { selector: string; value: string },
	group: Array<{ trigger: { selector: string; label?: string }; dialog?: { selector: string } }>,
	initialCategory: number,
	options: { settleMs: number; deadline: number; maxHtmlBytes: number }
): Promise<CapturedCollectionFilter | null> {
	const targetSelector = group[ 0 ]?.dialog?.selector;
	if ( ! targetSelector || initialCategory < 0 ) return null;
	const input = page.locator( field.selector );
	const target = page.locator( targetSelector );
	if ( await input.count() !== 1 || await target.count() !== 1 ) return null;
	await dismissOverlays( page );
	const triggers = group.map( state => state.trigger.selector );
	const observed: Exchange[] = [];
	const onResponse = async ( response: import('playwright').Response ) => {
		const request = response.request();
		if ( ! [ 'fetch', 'xhr' ].includes( request.resourceType() ) ) return;
		const postData = request.postData() ?? '';
		const body = await response.text().catch( () => '' );
		const classified = classifyCollectionResponse( body );
		observed.push( {
			method: request.method(), url: request.url(), postData, status: response.status(),
			contentType: response.headers()[ 'content-type' ] ?? '',
			body: Buffer.byteLength( body ) > MAX_BODY_BYTES ? '' : body,
			truncated: Buffer.byteLength( body ) > MAX_BODY_BYTES,
			phase,
			carriesQuery: requestCarriesQuery( request.url(), postData, BOOTSTRAP_PROBE ),
			collectionShaped: isCollectionShaped( body ),
			...classified,
		} );
	};
	const settle = async () => { await page.waitForTimeout( options.settleMs ); };
	const activateControl = async ( selector: string ) => {
		const control = page.locator( selector );
		await control.evaluate( element => {
			element.scrollIntoView( { block: 'center', inline: 'center' } );
			if ( element instanceof HTMLElement ) element.click();
		} );
	};
	const drive = async ( action: () => Promise<void> ) => {
		if ( Date.now() >= options.deadline ) throw new Error( 'Finite bootstrap drive budget exceeded' );
		const pending = page.waitForResponse( response => [ 'fetch', 'xhr' ].includes( response.request().resourceType() ), { timeout: Math.max( options.settleMs * 8, 1_000 ) } ).catch( () => null );
		await action();
		await pending;
		await settle();
	};
	let phase: 'search' | 'category' = 'search';
	page.on( 'response', onResponse );
	try {
		await drive( () => input.fill( BOOTSTRAP_PROBE ) );
		phase = 'category';
		await drive( () => input.fill( '' ) );
		for ( const selector of triggers ) await drive( () => activateControl( selector ) );
		await drive( () => activateControl( triggers[ initialCategory ]! ) );
	} catch ( error ) {
		page.off( 'response', onResponse );
		return unsupported( field, targetSelector, initialCategory, group, String( error ) );
	}
	page.off( 'response', onResponse );
	const searchExchanges = observed.filter( item => item.carriesQuery || item.completeness !== 'undeclared' || item.collectionShaped );
	if ( searchExchanges.some( item => item.carriesQuery ) ) return unsupported( field, targetSelector, initialCategory, group, 'Query-dependent data request; finite bootstrap is not server search', 'query-dependent' );
	const searchFinite = observed.filter( item => item.phase === 'search' && ! item.carriesQuery && item.completeness === 'declared-finite' && item.declaredCount !== null && ! item.truncated );
	const finiteResponses = searchFinite.length ? searchFinite : observed.filter( item => ! item.carriesQuery && item.completeness === 'declared-finite' && item.declaredCount !== null && ! item.truncated );
	if ( ! finiteResponses.length ) {
		if ( observed.some( item => item.completeness === 'paginated' ) ) return unsupported( field, targetSelector, initialCategory, group, 'Paginated data response; completeness cannot be guessed from one page', 'incomplete' );
		if ( observed.some( item => item.collectionShaped ) ) return unsupported( field, targetSelector, initialCategory, group, 'Undeclared completeness; response length is not proof of a finite collection', 'incomplete' );
		return null;
	}
	let declaredCount = Math.max( ...finiteResponses.map( item => item.declaredCount ?? 0 ) );
	if ( ! finiteResponses.some( item => item.declaredCount === declaredCount ) ) return unsupported( field, targetSelector, initialCategory, group, 'Declared finite response did not include a matching record list', 'incomplete' );
	let replayed = 0;
	let blocked = 0;
	const replay = async ( route: Route ) => {
		const request = route.request();
		if ( ! [ 'fetch', 'xhr' ].includes( request.resourceType() ) ) {
			await route.fallback();
			return;
		}
		const postData = request.postData() ?? '';
		const match = [ ...observed ].reverse().find( item => item.method === request.method() && item.url === request.url() && item.postData === postData && item.body && ! item.truncated );
		if ( match ) {
			replayed++;
			await route.fulfill( { status: match.status, contentType: match.contentType || 'application/octet-stream', body: match.body } );
			return;
		}
		blocked++;
		await route.abort();
	};
	await page.route( '**/*', replay );
	const evidence: CapturedCollectionFilter = {
		field, target: { selector: targetSelector, html: '' }, items: [], categories: [], initialCategory,
		predicate: 'normalized-text-includes', mode: 'category-or-global-search', emptyHtml: '', emptyPlacement: 'inside', probes: [],
		restoration: 'unverified', replay: 'unsupported',
		network: { dataRequests: 'observed-response-replay', verification: 'intercepted-observed-responses', blockedRequests: 0, replayedResponses: 0, blockedFollowUps: 0 },
	};
	try {
		const snapshots: Array<{ category: number; items: Array<{ text: string; html: string }>; visible: boolean }> = [];
		for ( let category = 0; category < triggers.length; category++ ) {
			await drive( async () => { await input.fill( '' ); await activateControl( triggers[ category ]! ); } );
			await hydrateDisclosureContent( page, targetSelector );
			const activeHtml = await page.locator( triggers[ category ]! ).evaluate( element => element.outerHTML );
			evidence.categories.push( { selector: triggers[ category ]!, label: group[ category ]?.trigger.label ?? '', index: category, activeHtml, inactiveHtml: '' } );
			const snap = snapshotCollectionItems( await target.evaluate( element => element.outerHTML ) );
			evidence.itemDepth = snap.itemDepth;
			snapshots.push( { category, items: snap.items, visible: await controlsVisible( page, triggers ) } );
		}
		if ( snapshots.some( snapshot => ! snapshot.visible || snapshot.items.length === 0 ) ) throw new Error( 'Empty-query category did not restore visible controls and items' );
		const byText = new Map<string, { html: string; categories: number[] }>();
		for ( const snapshot of snapshots ) {
			const seen = new Set<string>();
			for ( const item of snapshot.items ) {
				if ( seen.has( item.text ) ) throw new Error( 'Ambiguous item identity' );
				seen.add( item.text );
				const existing = byText.get( item.text );
				if ( existing && existing.html !== item.html ) throw new Error( 'Ambiguous item identity' );
				if ( existing ) existing.categories.push( snapshot.category );
				else byText.set( item.text, { html: item.html, categories: [ snapshot.category ] } );
			}
		}
		if ( byText.size !== declaredCount ) {
			const partition = [ ...new Map( observed.filter( item => item.phase === 'category' && item.completeness === 'declared-finite' ).map( item => [ item.postData, item.declaredCount ?? 0 ] ) ).values() ].reduce( ( sum, count ) => sum + count, 0 );
			if ( partition === byText.size && partition >= declaredCount && ! observed.some( item => item.completeness === 'paginated' ) ) declaredCount = partition;
			else throw new Error( `Finite coverage mismatch: declared ${ declaredCount }, observed ${ byText.size }` );
		}
		if ( [ ...byText.values() ].some( item => collectionItemHasResource( item.html ) ) ) throw new Error( 'Resource-bearing collection items are not portable without localization' );
		const orderQuery = sharedOrderQuery( [ ...byText.keys() ] );
		if ( ! orderQuery ) throw new Error( 'Source order unsupported: no shared query matches every finite item' );
		await drive( () => input.fill( orderQuery ) );
		if ( await controlsVisible( page, triggers ) ) throw new Error( 'Alternate-mode unproven: category controls stayed visible during global search' );
		const ordered = snapshotItems( await target.evaluate( element => element.outerHTML ) );
		if ( ordered.length !== byText.size || new Set( ordered.map( item => item.text ) ).size !== byText.size || ordered.some( item => ! byText.has( item.text ) ) ) throw new Error( 'Source order incomplete: shared query did not return every finite item' );
		evidence.items = ordered.map( ( item, index ) => ( { key: String( index ), text: item.text, html: byText.get( item.text )!.html, categories: byText.get( item.text )!.categories } ) );
		const keyByText = new Map( evidence.items.map( item => [ item.text, item.key ] ) );
		const answers = answerCoverage( evidence.items );
		const labelOf = ( html: string ) => {
			const $ = cheerio.load( html, null, false );
			return normalize( $( 'button,[role="button"],h1,h2,h3,h4,h5,h6' ).first().text() ).toLowerCase();
		};
		const tokens = [ ...new Set( evidence.items.flatMap( item => item.text.toLowerCase().match( /[\p{L}]{5,}/gu ) ?? [] ) ) ];
		const useful = tokens.filter( token => {
			const count = evidence.items.filter( item => item.text.toLowerCase().includes( token ) ).length;
			return count > 0 && count < evidence.items.length;
		} );
		const answerOnly = answers === 'observed' ? evidence.items.flatMap( item => useful.filter( token => item.text.toLowerCase().includes( token ) && ! labelOf( item.html ).includes( token ) ) )[ 0 ] : undefined;
		const matching = [ ...new Set( [ useful[ 0 ], answerOnly, useful[ useful.length - 1 ] ].filter( ( query ): query is string => Boolean( query ) ) ) ].slice( 0, 3 );
		const queries = [ ...matching, useful[ 0 ]?.toUpperCase(), NO_MATCH, NO_MATCH_AGAIN ].filter( ( query ): query is string => Boolean( query ) );
		if ( matching.length < 1 || ! queries.includes( NO_MATCH ) ) throw new Error( 'Finite collection did not yield a discriminating probe' );
		const siblingTexts = await target.evaluate( element => Array.from( element.parentElement?.children ?? [] ).filter( node => node !== element ).map( node => ( node.textContent ?? '' ).replace( /\s+/g, ' ' ).trim() ) );
		const global: Array<{ query: string; keys: string[] }> = [];
		for ( const query of queries ) {
			const before = blocked;
			await drive( () => input.fill( query ) );
			if ( await controlsVisible( page, triggers ) ) throw new Error( 'Alternate-mode unproven: category controls stayed visible during global search' );
			const actual = snapshotItems( await target.evaluate( element => element.outerHTML ) );
			const expected = evidence.items.filter( item => item.text.toLowerCase().includes( query.toLowerCase() ) ).map( item => item.key );
			const actualKeys = actual.map( item => evidence.items.find( candidate => candidate.text === item.text )?.key );
			if ( expected.length === 0 ) {
				let html = await target.evaluate( element => element.innerHTML );
				if ( ! html.trim() ) {
					const siblings = await target.evaluate( ( element, beforeTexts ) => Array.from( element.parentElement?.children ?? [] ).filter( node => node !== element && ! beforeTexts.includes( ( node.textContent ?? '' ).replace( /\s+/g, ' ' ).trim() ) && node.getBoundingClientRect().height > 0 ).map( node => node.outerHTML ), siblingTexts );
					if ( ! siblings.length ) throw new Error( 'No empty-state content was observed' );
					html = siblings.join( '' );
					evidence.emptyPlacement = 'after';
				}
				if ( ! evidence.emptyHtml ) evidence.emptyHtml = html;
				else {
					const bound = bindObservedEmpty( evidence.emptyHtml, NO_MATCH, html, query );
					if ( ! bound.bindsQuery && normalize( snapshotItems( `<div>${ bound.html }</div>` ).map( item => item.text ).join( ' ' ) ) !== normalize( snapshotItems( `<div>${ evidence.emptyHtml }</div>` ).map( item => item.text ).join( ' ' ) ) && ! evidence.emptyHtml.includes( NO_MATCH ) ) throw new Error( 'Empty-state content depends on query' );
					evidence.emptyHtml = bound.html;
					if ( bound.bindsQuery ) evidence.emptyBindsQuery = true;
				}
				global.push( { query, keys: [] } );
			} else if ( JSON.stringify( actualKeys ) !== JSON.stringify( expected ) ) {
				throw new Error( 'Global search results do not match the source order' );
			} else global.push( { query, keys: actualKeys as string[] } );
			if ( blocked > before ) evidence.network.blockedFollowUps = blocked;
		}
		const categories = snapshots.map( snapshot => ( {
			category: snapshot.category,
			keys: snapshot.items.map( item => keyByText.get( item.text ) ).filter( ( key ): key is string => Boolean( key ) ),
		} ) );
		const sourceKeys = evidence.items.map( item => item.key );
		const categoriesAgree = categories.every( probe => isOrderedSubsequence( sourceKeys, probe.keys ) );
		evidence.probes = categories.map( probe => ( { query: '', category: probe.category, keys: probe.keys } ) );
		await drive( async () => { await input.fill( '' ); await activateControl( triggers[ initialCategory ]! ); } );
		await drive( () => input.fill( BOOTSTRAP_PROBE ) );
		await drive( () => input.fill( '' ) );
		if ( ! await controlsVisible( page, triggers ) ) throw new Error( 'Unverified restoration: empty query did not restore category controls' );
		const cleared = snapshotItems( await target.evaluate( element => element.outerHTML ) ).map( item => item.text );
		const restoredCategory = snapshots[ initialCategory ]!.items.map( item => item.text );
		if ( JSON.stringify( cleared ) !== JSON.stringify( restoredCategory ) ) throw new Error( 'Unverified restoration: empty query did not return the selected category' );
		const blockedBeforeSentinel = blocked;
		await page.evaluate( () => fetch( 'https://fixture.invalid/dla-finite-follow-up', { method: 'POST', body: '{"dla":"follow-up"}' } ).catch( () => null ) );
		await settle();
		if ( blocked <= blockedBeforeSentinel ) throw new Error( 'Unmatched data request was not blocked' );
		const sourceFollowUpsBlocked = blockedBeforeSentinel;
		evidence.finiteBootstrap = {
			schema: FINITE_BOOTSTRAP_SCHEMA,
			mode: 'category-or-global-search',
			queryIndependent: true,
			completeness: 'declared-finite',
			declaredCount,
			observedItemCount: evidence.items.length,
			coverage: 'complete',
			verification: 'intercepted-observed-responses',
			replayedResponses: replayed,
			blockedFollowUps: blocked,
			sourceFollowUpsBlocked,
			unmatchedProbeBlocked: true,
			categoryControlsDuringSearch: 'hidden',
			emptyQueryRestoresCategory: true,
			answers,
			answerOnly: answerOnly ? 'verified' : 'pending-disclosure-integration',
			resources: 'text-only',
			order: { proof: 'universal-query', query: orderQuery, keys: sourceKeys, categoriesAgree, categoryKeys: categories.map( probe => probe.keys ) },
			probes: { global: [ { query: orderQuery, keys: sourceKeys }, ...global.filter( probe => probe.query !== orderQuery ) ], categories },
		};
		evidence.network.replayedResponses = replayed;
		evidence.network.blockedFollowUps = blocked;
		evidence.network.blockedRequests = blocked;
		if ( replayed < 1 ) throw new Error( 'Observed responses were not replayed' );
		evidence.replay = 'verified';
	} catch ( error ) {
		evidence.reason = String( error ).slice( 0, 500 );
		evidence.replay = 'unsupported';
		evidence.finiteBootstrap = undefined;
	} finally {
		await page.unroute( '**/*', replay ).catch( () => undefined );
		await input.fill( '' ).catch( () => undefined );
		await activateControl( triggers[ initialCategory ]! ).catch( () => undefined );
		await settle();
		await hydrateDisclosureContent( page, targetSelector );
		evidence.target.html = await target.evaluate( element => element.outerHTML ).catch( () => '' );
		const restored = snapshotItems( evidence.target.html ).map( item => item.text );
		const expected = evidence.items.filter( item => item.categories.includes( initialCategory ) ).map( item => item.text );
		if ( expected.length > 0 && restored.length === expected.length && restored.every( text => expected.includes( text ) ) ) evidence.restoration = 'verified';
		for ( const category of evidence.categories ) if ( category.index !== initialCategory ) category.inactiveHtml = await page.locator( category.selector ).evaluate( element => element.outerHTML ).catch( () => '' );
		if ( evidence.categories.length === triggers.length ) {
			await activateControl( triggers[ ( initialCategory + 1 ) % triggers.length ]! ).catch( () => undefined );
			await settle();
			evidence.categories[ initialCategory ]!.inactiveHtml = await page.locator( triggers[ initialCategory ]! ).evaluate( element => element.outerHTML ).catch( () => '' );
		await activateControl( triggers[ initialCategory ]! ).catch( () => undefined );
			await settle();
			await hydrateDisclosureContent( page, targetSelector );
			evidence.target.html = await target.evaluate( element => element.outerHTML ).catch( () => '' );
			const finalItems = snapshotItems( evidence.target.html ).map( item => item.text );
			if ( expected.length === 0 || finalItems.length !== expected.length || finalItems.some( text => ! expected.includes( text ) ) ) evidence.restoration = 'unverified';
		}
	}
	if ( Buffer.byteLength( JSON.stringify( evidence ) ) > options.maxHtmlBytes ) {
		evidence.replay = 'unsupported';
		evidence.reason = 'Collection evidence exceeds byte budget';
		evidence.target.html = '';
		evidence.items = [];
		evidence.emptyHtml = '';
		evidence.finiteBootstrap = undefined;
	}
	return evidence;
}

function unsupported(
	field: { selector: string; value: string },
	targetSelector: string,
	initialCategory: number,
	group: Array<{ trigger: { selector: string; label?: string } }>,
	reason: string,
	dataRequests: 'query-dependent' | 'incomplete' = 'incomplete'
): CapturedCollectionFilter {
	return {
		field, target: { selector: targetSelector, html: '' }, items: [], categories: group.map( ( state, index ) => ( { selector: state.trigger.selector, label: state.trigger.label ?? '', index, activeHtml: '', inactiveHtml: '' } ) ),
		initialCategory, predicate: 'normalized-text-includes', mode: 'category-or-global-search', emptyHtml: '', emptyPlacement: 'inside', probes: [],
		restoration: 'unverified', replay: 'unsupported', reason,
		network: { dataRequests, verification: 'unverified', blockedRequests: 0 },
	};
}
