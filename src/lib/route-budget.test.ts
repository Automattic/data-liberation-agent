import { expect, it } from 'vitest';
import { rankTemplateClusterRoutes } from './route-budget.js';

it.each( [ 'initial inventory', 'rendered navigation' ] )( 'ranks cluster admission tiers for %s', phase => {
	const url = ( path: string ) => `https://example.com${ path }`;
	const members = Array.from( { length: 400 }, ( _, index ) => url( `/post/${ String( index ).padStart( 3, '0' ) }` ) );
	const groups = [
		{ size: 2, representative: url( '/small/rep' ), members: [ url( '/small/rep' ), url( '/small/verify' ) ] },
		{ size: 400, representative: members[ 0 ], members },
		{ size: 1, representative: url( '/about' ), members: [ url( '/about' ) ] },
		{ size: 1, representative: url( '/form' ), members: [ url( '/form' ) ] },
		{ size: 2, representative: url( '/tag/seed' ), members: [ url( '/tag/seed' ), url( '/category/verify' ) ] },
	];
	const expected = [
		'/',
		'/post/000', '/post/001', '/small/rep', '/small/verify', '/tag/seed', '/category/verify',
		'/about', '/contact', '/form', '/blog/tag/nav', '/blog/category/nav', '/custom-archive',
		'/post/002', '/post/003',
		'/other', '/tag/other', '/post/004',
	].map( url );
	const navigation = new Set( [ '/about', '/contact', '/blog/tag/nav', '/blog/category/nav', '/custom-archive', '/post/002', '/post/003' ].map( url ) );
	// Scramble tiers while retaining inventory order within each tier.
	const inventory = [
		'/tag/other', '/blog/tag/nav', '/blog/category/nav', '/custom-archive', '/tag/seed', '/category/verify',
		'/other', '/post/004', '/about', '/contact', '/form', '/post/002', '/post/003',
		'/small/rep', '/small/verify', '/post/001', '/post/000', '/',
	].map( url );
	const pending = phase === 'rendered navigation' ? inventory.filter( route => route !== url( '/' ) ) : inventory;
	const original = [ ...pending ];
	expect( rankTemplateClusterRoutes( pending, url( '/' ), groups, navigation, route => route === url( '/custom-archive' ) ? '' : undefined ) )
		.toEqual( phase === 'rendered navigation' ? expected.slice( 1 ) : expected );
	expect( pending ).toEqual( original );
} );
