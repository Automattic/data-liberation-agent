import { expect, it } from 'vitest';
import { templateFingerprint } from '../../lib/template-groups.js';
import { squarespaceAdapter } from './index.js';

it( 'groups Squarespace item churn without hiding authored CSS or other script dependencies', () => {
	const font = ( name: string ) => `@font-face{font-family:${ name };src:url(${ name }.woff2)}`;
	const page = ( id: string, fonts: string[], hash: string, count: number ) => `
		<script src="//assets.squarespace.com/universal/scripts-compressed/common-${ hash }-min.en-US.js"></script>
		<style data-sqsp-font-ids="${ fonts.join( ',' ) }">${ fonts.map( font ).join( '\n' ) }</style>
		<style>.authored{color:red}</style><style>.authored{color:blue}</style>
		<body><article>${ Array.from( { length: count }, ( _, i ) => `
			<style id="container-styles">#block-${ id }${ i }{}</style>
			<style id="override-container-styles">@media(max-width:767px){#block-${ id }${ i }{}}</style>
			<style class="other transform-vars">:root{--x:${ i }}</style>
			<style class="transform-overrides-vars"></style>
			<style>#block-${ id }${ i } .content{color:inherit}@media(max-width:767px){#block-${ id }${ i },#block-${ id }${ i } p{color:red}}</style>
			<p>Post ${ id }</p>` ).join( '' ) }</article></body>`;
	const a = page( 'a', [ 'A', 'B' ], 'a1b2c3d4e5f60718', 2 );
	const b = page( 'b', [ 'B', 'A' ], '9f8e7d6c5b4a3210', 5 );
	const fingerprint = ( html: string ) => templateFingerprint( html, 'https://example.com/blog/post', squarespaceAdapter.templateStyleNormalization ).key;
	expect( fingerprint( b ) ).toBe( fingerprint( a ) );
	for ( const changed of [
		b.replace( 'color:blue', 'color:green' ),
		b.replace( '<style>.authored{color:red}</style><style>.authored{color:blue}</style>', '<style>.authored{color:blue}</style><style>.authored{color:red}</style>' ),
		b + '<style>#block-b p,.site{color:red}</style>',
		b + '<style>@media(min-width:1px){.site{color:red}}</style>',
		b.replace( font( 'A' ), font( 'A' ) + font( 'A' ) ),
		b.replace( '/common-', '/performance-' ),
		b.replace( 'assets.squarespace.com', 'other.example.com' ),
	] ) expect( fingerprint( changed ) ).not.toBe( fingerprint( a ) );
} );
