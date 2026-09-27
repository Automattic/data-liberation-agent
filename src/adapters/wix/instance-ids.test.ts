import { describe, expect, it } from 'vitest';
import { canonicalizeWixInstanceIds } from './instance-ids.js';

const page = ( instance: string, extra = '' ) =>
	`<html><head><style>#${ instance }{position:sticky}.${ instance }-container{margin:0}` +
	`.${ instance }_r_comp-nav{color:red}#${ instance }_r_comp-logo{width:10px}</style></head>` +
	`<body><header id="${ instance }" class="${ instance }-container"><div id="${ instance }_r_comp-logo" class="${ instance }_r_comp-nav"><a href="/">Home</a></div></header>${ extra }</body></html>`;

describe( 'canonicalizeWixInstanceIds', () => {
	it( 'gives identical chrome under different page instance prefixes the same markup', () => {
		const first = canonicalizeWixInstanceIds( page( 'comp-aaaa1111' ) );
		const second = canonicalizeWixInstanceIds( page( 'comp-bbbb2222' ) );
		expect( first ).toBe( second );
		expect( first ).not.toContain( 'comp-aaaa1111' );
	} );

	it( 'rewrites stylesheet selectors together with the elements they style', () => {
		const out = canonicalizeWixInstanceIds( page( 'comp-aaaa1111' ) );
		const id = /id="(comp-dla[0-9a-f]{8})_r_comp-logo"/.exec( out )?.[ 1 ];
		expect( id ).toBeDefined();
		expect( out ).toContain( `#${ id }_r_comp-logo{width:10px}` );
		expect( out ).toContain( `.${ id }_r_comp-nav{color:red}` );
	} );

	it( 'rewrites the instance element itself and its derived classes with the same token', () => {
		const out = canonicalizeWixInstanceIds( page( 'comp-aaaa1111' ) );
		const id = /id="(comp-dla[0-9a-f]{8})_r_comp-logo"/.exec( out )?.[ 1 ];
		expect( out ).toContain( `<header id="${ id }" class="${ id }-container">` );
		expect( out ).toContain( `#${ id }{position:sticky}.${ id }-container{margin:0}` );
		expect( out ).not.toContain( 'comp-aaaa1111' );
	} );

	it( 'does not rewrite an id that merely starts with an instance id', () => {
		const out = canonicalizeWixInstanceIds( page( 'comp-aaaa1111', '<i id="comp-aaaa11112"></i>' ) );
		expect( out ).toContain( 'id="comp-aaaa11112"' );
	} );

	it( 'keeps distinct instances on one page distinct', () => {
		const out = canonicalizeWixInstanceIds(
			page( 'comp-aaaa1111', '<footer><p class="comp-cccc3333_r_comp-copyright">©</p></footer>' )
		);
		const tokens = new Set( [ ...out.matchAll( /(comp-dla[0-9a-f]{8})_r_/g ) ].map( ( match ) => match[ 1 ] ) );
		expect( tokens.size ).toBe( 2 );
	} );

	it( 'leaves a page untouched when two instances scope the same components', () => {
		const html = page( 'comp-aaaa1111', '<div class="comp-cccc3333_r_comp-nav comp-cccc3333_r_comp-logo"></div>' );
		expect( canonicalizeWixInstanceIds( html ) ).toBe( html );
	} );

	it( 'leaves markup without instance references unchanged', () => {
		const html = '<div id="comp-abc" class="comp-abc-container">x</div>';
		expect( canonicalizeWixInstanceIds( html ) ).toBe( html );
	} );
} );
