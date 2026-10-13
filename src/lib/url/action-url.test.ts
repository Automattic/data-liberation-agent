import { expect, it } from 'vitest';
import { actionUrlExclusion, stateChangingAction, STATE_CHANGING_QUERY_KEYS } from './action-url.js';

it.each( [
	[ 'https://shop.test/?add-to-cart=12', 'add-to-cart' ],
	[ 'https://shop.test/product/mug/?ADD-TO-CART=12&quantity=1', 'add-to-cart' ],
	[ 'https://shop.test/?add_to_wishlist=7', 'add_to_wishlist' ],
	[ 'https://shop.test/cart/?remove_item=abc&_wpnonce=1', 'remove_item' ],
	[ 'https://shop.test/cart/?undo_item=abc', 'undo_item' ],
	[ 'https://shop.test/?wc-ajax=get_refreshed_fragments', 'wc-ajax' ],
	[ 'https://shop.test/my-account/?customer-logout', 'customer-logout' ],
	[ 'https://blog.test/post/?replytocom=5#respond', 'replytocom' ],
	[ 'https://blog.test/post/?unapproved=9&moderation-hash=f00', 'unapproved' ],
	[ 'https://blog.test/post/?moderation-hash=f00', 'moderation-hash' ],
	[ 'https://blog.test/wp-login.php?action=logout&_wpnonce=1', 'action=logout' ],
	[ 'https://blog.test/account/?action=LogOut', 'action=logout' ],
] )( 'names %s as a state-changing action', ( url, action ) => {
	expect( stateChangingAction( url ) ).toBe( action );
} );

it.each( [
	'https://blog.test/?page=2',
	'https://blog.test/?s=query',
	'https://blog.test/page/2/',
	'https://blog.test/catalog/?tag=Research#items',
	'https://blog.test/wp-login.php',
	'https://blog.test/?action=view',
	'https://blog.test/add-to-cart/',
	'https://blog.test/?q=add-to-cart',
	'https://blog.test/#replytocom=5',
	'not a url',
] )( 'admits %s as an ordinary route', url => {
	expect( stateChangingAction( url ) ).toBeUndefined();
	expect( actionUrlExclusion( url ) ).toBeUndefined();
} );

it( 'records a request-identity diagnostic and matches query keys on any host', () => {
	expect( actionUrlExclusion( 'https://blog.test/post/?replytocom=5#respond' ) ).toEqual( {
		code: 'route_excluded_action_url', url: 'https://blog.test/post/?replytocom=5', reason: 'State-changing action URL (query replytocom)',
	} );
	for ( const key of STATE_CHANGING_QUERY_KEYS ) expect( stateChangingAction( `http://127.0.0.1:8080/any/path?${ key }=1` ) ).toBe( key );
} );
