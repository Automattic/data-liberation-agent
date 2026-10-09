import { expect, it } from 'vitest';
import { LinkedFrontier } from '../screenshot/linked-frontier.js';
import { soloistAdapter } from '../../adapters/soloist/index.js';
import { routeInScope, validateRouteScope } from './route-scope.js';

it( 'uses adapter-owned segment boundaries before required frontier accounting, preserving queries and exact addresses', () => {
	const scope = soloistAdapter.routeScope!( 'https://soloist.ai/customer/about' );
	const frontier = new LinkedFrontier( {maxPages: 3}, Date.now(), scope );
	for ( const url of [ 'https://soloist.ai/', 'https://soloist.ai/?utm_source=badge', 'https://soloist.ai/customer-two', 'https://soloist.ai/other/', 'https://elsewhere.test/customer' ] ) expect( frontier.admit(url, 0) ).toBe(false);
	for ( const url of [ 'https://soloist.ai/customer', 'https://soloist.ai/customer?view=one', 'https://soloist.ai/customer?view=two' ] ) expect( frontier.admit(url, 0) ).toBe(true);
	expect( frontier.required.size ).toBe(3);
	expect( frontier.diagnostics ).toEqual([]);
	expect( routeInScope('https://soloist.ai/customer/../other', scope) ).toBe(false);
	expect( routeInScope('https://ordinary.test/about') ).toBe(true);
} );

it( 'refuses malformed declarations rather than widening ownership', () => {
	for ( const pathPrefixes of [ [], ['tenant'], ['/tenant/'], ['/tenant/../other'], ['/tenant?view=one'], ['//elsewhere.test/tenant'] ] ) expect( () => validateRouteScope( {origin: 'https://source.test', pathPrefixes} ) ).toThrow();
} );
