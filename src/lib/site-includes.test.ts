import * as cheerio from 'cheerio';
import { expect, it } from 'vitest';
import { includeReferences, parseLocatedStructure, sourceRange } from './site-includes.js';
import { isElementNode } from './html-nodes.js';
import type { AnyNode } from 'domhandler';

it( 'locates the same repaired HTML structure without retaining source text', () => {
	for ( const html of [
		'<header>Before<div>Inside</div>After</header><footer>Footer</footer>',
		'<table>Fostered text<tr><td>Cell<div>Nested</table><footer>After</footer>',
		'<p><b>Formatting<i>Adoption</b>Continued</i><header>End</header>',
		'<svg><foreignObject><header>HTML</header></foreignObject><text>SVG</text></svg>',
		'<template><table>Text<tr><td>Cell</table><!--#include virtual="/parts/template.html" --></template>',
		'<style>a::before{content:"<!--#include bad -->"}</style><script>"<!--#include bad -->"</script><noscript><!--#include bad --></noscript><textarea><!--#include bad --></textarea><!--#include virtual="/parts/real.html" -->',
	] ) {
		const expected = cheerio.load( html, { sourceCodeLocationInfo: true } );
		const actual = parseLocatedStructure( html );
		const structure = ( $: cheerio.CheerioAPI ) => $( '*' ).toArray().filter( isElementNode ).map( node => ( {
			name: node.name, attributes: node.attribs, range: sourceRange( node ),
			ancestors: $( node ).parents().toArray().map( parent => parent.name ),
		} ) );
		expect( structure( actual ) ).toEqual( structure( expected ) );
		const topology = ( node: AnyNode ): unknown => ( {
			type: node.type, range: sourceRange( node ),
			...( node.type === 'comment' ? { comment: node.data } : {} ),
			children: 'children' in node ? node.children.map( topology ) : [],
		} );
		expect( topology( actual.root()[ 0 ] ) ).toEqual( topology( expected.root()[ 0 ] ) );
		expect( actual.root().text() ).toBe( '' );
	}
	const source = '<style>/* <!--#include bad --> */</style><script>"<!--#include bad -->"</script><textarea><!--#include bad --></textarea><p>Emoji 🌊</p><!--#include virtual="/parts/real.html" -->';
	const references = includeReferences( source );
	expect( references ).toHaveLength( 1 );
	expect( source.slice( references[ 0 ].start, references[ 0 ].end ) ).toBe( '<!--#include virtual="/parts/real.html" -->' );
	expect( () => includeReferences( '<table>Text<tr><td><!--#include invalid --></td></tr></table>' ) ).toThrow( 'Malformed site include' );
} );
