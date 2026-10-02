import { describe, expect, it } from 'vitest';
import { classifyCollectionResponse, isCollectionShaped, requestCarriesQuery, snapshotCollectionItems } from './finite-bootstrap.js';

describe( 'finite bootstrap completeness', () => {
	it( 'accepts an explicit finite page and rejects length guesses', () => {
		const finite = JSON.stringify( { records: [ { id: 'a' }, { id: 'b' } ], paging: { hasNext: false, count: 2 } } );
		expect( classifyCollectionResponse( finite ) ).toEqual( { completeness: 'declared-finite', declaredCount: 2 } );
		expect( classifyCollectionResponse( JSON.stringify( { records: [ { id: 'a' }, { id: 'b' }, { id: 'c' } ] } ) ) ).toEqual( { completeness: 'undeclared', declaredCount: null } );
		expect( isCollectionShaped( JSON.stringify( { records: [ { id: 'a' }, { id: 'b' } ] } ) ) ).toBe( true );
		expect( isCollectionShaped( '{}' ) ).toBe( false );
	} );
	it( 'reads repeated items through a single wrapper without treating the wrapper as the item', () => {
		const wrapped = '<section><div><article><h2>One</h2><p>Apricot answer</p></article><article><h2>Two</h2><p>Berry answer</p></article></div></section>';
		expect( snapshotCollectionItems( wrapped ) ).toMatchObject( { itemDepth: 1, items: [ { text: 'One Apricot answer' }, { text: 'Two Berry answer' } ] } );
		expect( snapshotCollectionItems( '<div><article>Alpha answer text</article><article>Beta answer text</article></div>' ).itemDepth ).toBe( 0 );
	} );
	it( 'keeps a partial page and a query-bearing request unsupported', () => {
		expect( classifyCollectionResponse( JSON.stringify( { records: [ { id: 'a' } ], paging: { hasNext: true, count: 1 } } ) ) ).toEqual( { completeness: 'paginated', declaredCount: null } );
		expect( classifyCollectionResponse( JSON.stringify( { records: [ { id: 'a' } ], paging: { hasNext: false, count: 4 } } ) ) ).toEqual( { completeness: 'undeclared', declaredCount: null } );
		expect( requestCarriesQuery( 'https://fixture.invalid/collection', '{"query":"dla-finite-probe-7f39b2"}', 'dla-finite-probe-7f39b2' ) ).toBe( true );
		expect( requestCarriesQuery( 'https://fixture.invalid/collection', '{"filter":{}}', 'dla-finite-probe-7f39b2' ) ).toBe( false );
	} );
} );
