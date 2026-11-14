import { expect, it } from 'vitest';
import { scopedRouteKey } from '../../lib/url/route-scope.js';
import { bloggerAdapter } from './index.js';

it('collapses listing pagination without changing post or device routes', () => {
	const origin = 'https://example.blogspot.com';
	const scope = bloggerAdapter.routeScope?.( origin );
	expect( scope ).toMatchObject( { origin, pathPrefixes: [ '/' ] } );
	for ( const [ variant, route ] of [
		[ '/search/label/Blog?updated-max=2023-12-12T13:55:00-08:00&max-results=20&start=3&by-date=false', '/search/label/Blog' ],
		[ '/search?max-results=7', '/search' ],
		[ '/search?updated-min=2023-01-01&reverse-paginate=true', '/search' ],
		[ '/2023/11/post.html', '/2023/11/post.html' ],
		[ '/2023/11/post.html?m=1', '/2023/11/post.html?m=1' ],
	] ) {
		expect( scopedRouteKey( origin + variant, scope ) ).toBe( scopedRouteKey( origin + route, scope ) );
	}
} );
