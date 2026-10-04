import { describe, expect, it } from 'vitest';
import { wireCapturedCollections } from '../static-collections.js';
import { bindObservedEmpty, classifyCollectionResponse, collectionItemHasResource, deriveObservedStatus, isCollectionShaped, isOrderedSubsequence, requestCarriesQuery, sharedOrderQuery, snapshotCollectionItems, type StatusObservation } from './finite-bootstrap.js';

describe( 'finite bootstrap completeness', () => {
	it( 'accepts an explicit finite page and rejects length guesses', () => {
		const finite = JSON.stringify( { records: [ { id: 'a' }, { id: 'b' } ], paging: { hasNext: false, count: 2 } } );
		expect( classifyCollectionResponse( finite ) ).toEqual( { completeness: 'declared-finite', declaredCount: 2 } );
		expect( classifyCollectionResponse( JSON.stringify( { records: [ { id: 'a' }, { id: 'b' }, { id: 'c' } ] } ) ) ).toEqual( { completeness: 'undeclared', declaredCount: null } );
		expect( isCollectionShaped( JSON.stringify( { records: [ { id: 'a' }, { id: 'b' } ] } ) ) ).toBe( true );
		expect( isCollectionShaped( '{}' ) ).toBe( false );
	} );
	it( 'derives a shared order query and rejects resource-bearing item markup', () => {
		expect( sharedOrderQuery( [ 'Question alpha apricot', 'Question beta berry' ] ) ).toBe( 'q' );
		expect( sharedOrderQuery( [ 'alpha', 'beta' ] ) ).toBe( 'a' );
		expect( sharedOrderQuery( [ 'aaa', 'bbb' ] ) ).toBeNull();
		expect( isOrderedSubsequence( [ '0', '1', '2', '3' ], [ '0', '2' ] ) ).toBe( true );
		expect( isOrderedSubsequence( [ '0', '1', '2' ], [ '2', '0' ] ) ).toBe( false );
		expect( collectionItemHasResource( '<article><h2>Question</h2><p>Answer text</p></article>' ) ).toBe( false );
		expect( collectionItemHasResource( '<article><img src="https://cdn.example/photo.png" alt=""></article>' ) ).toBe( true );
		expect( bindObservedEmpty( '<p>Showing results for dla-no-match-7f39b2</p>', 'dla-no-match-7f39b2', '<p>Showing results for zzzzmissing</p>', 'zzzzmissing' ) ).toEqual( { html: '<p>Showing results for __DLA_QUERY__</p>', bindsQuery: true } );
		expect( bindObservedEmpty( '<p>No FAQs found</p>', 'dla-no-match-7f39b2', '<p>No FAQs found</p>', 'zzzzmissing' ).bindsQuery ).toBe( false );
	} );
	it( 'wires each assembled copy when the capture selector no longer matches', () => {
		const copy = `<section><input type="text" aria-label="Browse"><div role="tablist"><button role="tab">One</button><button role="tab">Two</button></div><div><article>Alpha question Alpha answer</article></div></section>`;
		const html = `<body>${ copy }${ copy }</body>`;
		const evidence = {
			field: { selector: '#missing', value: '' },
			target: { selector: '#missing-target', html: '' },
			items: [
				{ key: '0', text: 'Alpha question Alpha answer', html: '<article><h2>Alpha question</h2><p>Alpha answer</p></article>', categories: [0] },
				{ key: '1', text: 'Beta question Beta answer', html: '<article><h2>Beta question</h2><p>Beta answer</p></article>', categories: [1] },
			],
			categories: [
				{ selector: '#missing-tab', label: 'One', index: 0, activeHtml: '<button role="tab">One</button>', inactiveHtml: '<button role="tab">One</button>' },
				{ selector: '#missing-tab', label: 'Two', index: 1, activeHtml: '<button role="tab">Two</button>', inactiveHtml: '<button role="tab">Two</button>' },
			],
			initialCategory: 0,
			predicate: 'normalized-text-includes' as const,
			mode: 'category-or-global-search' as const,
			emptyHtml: '<p>None</p>',
			emptyPlacement: 'inside' as const,
			probes: [],
			restoration: 'verified' as const,
			replay: 'verified' as const,
			network: { dataRequests: 'observed-response-replay' as const, verification: 'intercepted-observed-responses' as const, blockedRequests: 1 },
			finiteBootstrap: {
				schema: 'data-liberation/finite-bootstrap/v1' as const,
				mode: 'category-or-global-search' as const,
				queryIndependent: true as const,
				completeness: 'declared-finite' as const,
				declaredCount: 2,
				observedItemCount: 2,
				coverage: 'complete' as const,
				verification: 'intercepted-observed-responses' as const,
				replayedResponses: 1,
				blockedFollowUps: 1,
				sourceFollowUpsBlocked: 0,
				unmatchedProbeBlocked: true as const,
				categoryControlsDuringSearch: 'hidden' as const,
				emptyQueryRestoresCategory: true as const,
				answers: 'observed' as const,
				answerOnly: 'verified' as const,
				resources: 'text-only' as const,
				order: { proof: 'universal-query' as const, query: 'a', keys: ['0', '1'], categoriesAgree: true, categoryKeys: [['0'], ['1']] },
				probes: { global: [], categories: [] },
			},
		};
		const wired = wireCapturedCollections( html, [ { status: 'captured', kind: 'typed-search', trigger: { selector: 'input', tag: 'input', ariaHaspopup: '', dataBindings: {} }, collectionFilter: evidence } ] );
		expect( wired.match( /data-dla-collection-item=/g ) ).toHaveLength( 4 );
		expect( wired ).not.toContain( 'dla-no-match' );
	} );
	it( 'reads repeated items through a single wrapper without treating the wrapper as the item', () => {
		const wrapped = '<section><div><article><h2>One</h2><p>Apricot answer</p></article><article><h2>Two</h2><p>Berry answer</p></article></div></section>';
		expect( snapshotCollectionItems( wrapped ) ).toMatchObject( { itemDepth: 1, items: [ { text: 'One Apricot answer' }, { text: 'Two Berry answer' } ] } );
		expect( snapshotCollectionItems( '<div><article>Alpha answer text</article><article>Beta answer text</article></div>' ).itemDepth ).toBe( 0 );
	} );
	it( 'derives status templates only from proven count and raw-query substitutions', () => {
		const node = ( signature: string, text: string, html: string ) => ( { signature, text, html, before: true } );
		const observations: StatusObservation[] = [
			{ query: 's', count: 19, nodes: [ node( 'count', '19 matching results found', '<div role="status" class="count">19 matching results found</div>' ), node( 'query', 'Showing results for: s', '<div class="query">Showing results for: s</div>' ) ] },
			{ query: 'SESSION', count: 4, nodes: [ node( 'count', '4 matching results found', '<div role="status" class="count">4 matching results found</div>' ), node( 'query', 'Showing results for: SESSION', '<div class="query">Showing results for: SESSION</div>' ) ] },
			{ query: 'session', count: 4, nodes: [ node( 'count', '4 matching results found', '<div role="status" class="count">4 matching results found</div>' ), node( 'query', 'Showing results for: session', '<div class="query">Showing results for: session</div>' ) ] },
			{ query: 'book', count: 1, nodes: [ node( 'count', '1 matching results found', '<div role="status" class="count">1 matching results found</div>' ), node( 'query', 'Showing results for: book', '<div class="query">Showing results for: book</div>' ) ] },
			{ query: 'dla-no-match-7f39b2', count: 0, nodes: [ node( 'count', '0 matching results found', '<div role="status" class="count">0 matching results found</div>' ) ] },
			{ query: '', count: 5, nodes: [] },
		];
		const status = deriveObservedStatus( observations, { emptyHtml: '<p>0 matching results found</p><p>No FAQs found</p>', universe: 19, answerQuery: 'book' } );
		expect( status?.nodes.map( item => item.template ) ).toEqual( [ '{count} matching results found', 'Showing results for: {query}' ] );
		expect( status?.nodes.every( item => item.hidesAtZero && item.placement === 'before-items' ) ).toBe( true );
		expect( status?.nodes[ 1 ]?.html ).toContain( 'class="query"' );
		const contradictory: StatusObservation[] = observations.map( item => item.count === 0 || ! item.query ? item : { ...item, nodes: [ node( 'count', item.count === 4 ? 'Located four' : `${ item.count } hits`, '<div>x</div>' ) ] } );
		expect( deriveObservedStatus( contradictory, { emptyHtml: '<p>None</p>', universe: 19, answerQuery: 'book' } ) ).toBeNull();
		const lowercased = observations.map( item => ( { ...item, nodes: item.nodes.map( entry => entry.signature === 'query' ? node( 'query', `Showing results for: ${ item.query.toLowerCase() }`, `<div class="query">Showing results for: ${ item.query.toLowerCase() }</div>` ) : entry ) } ) );
		expect( deriveObservedStatus( lowercased, { emptyHtml: '<p>0 matching results found</p>', universe: 19, answerQuery: 'book' } )?.nodes.find( item => item.binds.includes( 'query' ) ) ).toBeUndefined();
	} );
	it( 'keeps a partial page and a query-bearing request unsupported', () => {
		expect( classifyCollectionResponse( JSON.stringify( { records: [ { id: 'a' } ], paging: { hasNext: true, count: 1 } } ) ) ).toEqual( { completeness: 'paginated', declaredCount: null } );
		expect( classifyCollectionResponse( JSON.stringify( { records: [ { id: 'a' } ], paging: { hasNext: false, count: 4 } } ) ) ).toEqual( { completeness: 'undeclared', declaredCount: null } );
		expect( requestCarriesQuery( 'https://fixture.invalid/collection', '{"query":"dla-finite-probe-7f39b2"}', 'dla-finite-probe-7f39b2' ) ).toBe( true );
		expect( requestCarriesQuery( 'https://fixture.invalid/collection', '{"filter":{}}', 'dla-finite-probe-7f39b2' ) ).toBe( false );
	} );
} );
