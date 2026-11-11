import { expect, it } from 'vitest';
import { indexRuntimeIdReferences } from './runtime-id-references.js';

it( 'matches the previous external substring audit, including prefixes and encoded declarations', () => {
	const texts = [
		{ path: '/a.html', text: '<p id="yui_1">a</p><p id="yui_12">b</p><p id="yui_&#51;">c</p><p id="YUI_4">d</p><p id="yui_😀5">e</p>' },
		{ path: '/b.html', text: '<p id="yui_12">same</p>' },
		{ path: '/asset.css', text: '#yui_3 {} /* longer-yui_😀5-suffix */' },
		{ path: '/asset.js', text: 'const id = "YUI_4";' },
	];
	const referenced = indexRuntimeIdReferences( texts );
	for ( const id of [ 'yui_1', 'yui_12', 'yui_3', 'YUI_4', 'yui_😀5' ] ) {
		for ( const { path } of texts ) {
			expect( referenced( id, path ) ).toBe( texts.some( item => item.path !== path && item.text.includes( id ) ) );
		}
	}
} );
