import { it, expect } from 'vitest';
import { inlineCodeShape, inlineRuntimeHash } from './device-mode.js';

const page = ( path: string, context: string, extra = '' ) => `<html><body>
<script>window.Static = window.Static || {}; Static.CONTEXT = ${ context };</script>
<script type="application/json" id="form">${ JSON.stringify( { route: path, fields: [ 1, 2, 3 ] } ) }</script>
<script type="module">var url = '' || '${ path }'; init(url, ${ path.length });${ extra }</script></body></html>`;

it( 'ignores per-route embedded data and self references, but not code or code strings', () => {
	const about = page( '/about', '{"page":{"id":"a1","title":"About"},"items":[]}' );
	const collection = page( '/collection', '{"page":{"id":"b2","title":"Collection","items":[{"id":7,"tags":["x"]}]},"pager":{"next":null}}' );
	expect( inlineRuntimeHash( about, 'https://example.test/about' ) ).toBe( inlineRuntimeHash( collection, 'https://example.test/collection' ) );
	// Another route's path is not a self reference.
	expect( inlineRuntimeHash( about, 'https://example.test/other' ) ).not.toBe( inlineRuntimeHash( collection, 'https://example.test/other' ) );
	// The home path is not a prefix match for its children.
	expect( inlineRuntimeHash( '<script>go("/blog")</script>', 'https://example.test/blog' ) ).not.toBe( inlineRuntimeHash( '<script>go("/blog")</script>', 'https://example.test/blog/post' ) );
	expect( inlineRuntimeHash( '<script>go("/blog/post")</script>', 'https://example.test/blog' ) ).toBe( inlineRuntimeHash( '<script>go("/blog/post")</script>', 'https://example.test/other' ) );
	// Same data, different code: a route-local branch must not inherit.
	expect( inlineRuntimeHash( page( '/a', '{}', 'if(/iPhone/.test(navigator.userAgent))document.body.classList.add("p");' ), 'https://example.test/a' ) )
		.not.toBe( inlineRuntimeHash( page( '/a', '{}' ), 'https://example.test/a' ) );
	// Strings in code are behaviour (selectors), so they are kept.
	expect( inlineCodeShape( 'document.querySelector(".second")' ) ).not.toBe( inlineCodeShape( "document.querySelector('.ghost-menu')" ) );
	expect( inlineCodeShape( 'f({a:y}, [1, "x"]); X = {"k": "v", n: [true, null]}' ) ).toBe( 'f({a:y}, D); X = D' );
	expect( inlineCodeShape( 'window.firstPageId = "c1dmp"\nif (a) go("x"); window.n = 3; window.s = "a" + b; window.location = "/x"' ) )
		.toBe( 'window.firstPageId = D if (a) go("x"); window.n = D; window.s = "a" + b; window.location = "/x"' );
	expect( inlineCodeShape( "var s = 'it\\'s'; // don't\n/* 'x' */ g(0x1f, 1.5e3)" ) ).toBe( 'var s = "it\\\\\'s"; g(0, 0)' );
} );
