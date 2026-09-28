import { describe, expect, it } from 'vitest';
import { canonicalizeWixCapturedHtml, canonicalizeWixFormControlIds, canonicalizeWixInstanceIds } from './instance-ids.js';

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

describe( 'canonicalizeWixFormControlIds', () => {
	const consent = ( counter: number, before = '' ) =>
		`<form>${ before }<div data-hook="form-field-form_field_92f1"><input type="checkbox" id="checkbox-${ counter }"><label for="checkbox-${ counter }">Subscribe</label></div></form>`;

	it( 'names a render-counter checkbox after its form field, so every page and viewport agrees', () => {
		const home = canonicalizeWixFormControlIds( consent( 23, '<div data-hook="form-field-email"><input id="checkbox-3" type="checkbox"></div>' ) );
		const privacy = canonicalizeWixFormControlIds( consent( 5 ) );
		const token = /id="(checkbox-dla[0-9a-f]{8})"/.exec( privacy )?.[ 1 ];
		expect( token ).toBeDefined();
		expect( home ).toContain( `id="${ token }"` );
		expect( home ).not.toMatch( /checkbox-(23|5|3)(?![0-9a-z-])/ );
		// Another field's checkbox gets its own name.
		expect( home.match( /id="checkbox-dla[0-9a-f]{8}"/g ) ).toHaveLength( 2 );
	} );

	it( 'rewrites references to the counter id and leaves ids that only start with it alone', () => {
		const html = canonicalizeWixFormControlIds( consent( 5, '<span id="checkbox-5-hint">Hint</span>' ) );
		const token = /id="(checkbox-dla[0-9a-f]{8})"/.exec( html )?.[ 1 ];
		expect( html ).toContain( `for="${ token }"` );
		expect( html ).toContain( 'id="checkbox-5-hint"' );
	} );

	it( 'keeps a document unchanged when a counter checkbox has no enclosing field', () => {
		const html = '<form><input type="checkbox" id="checkbox-4"></form>';
		expect( canonicalizeWixFormControlIds( html ) ).toBe( html );
	} );

	it( 'runs after instance canonicalization in the captured-HTML hook', () => {
		expect( canonicalizeWixCapturedHtml( page( 'comp-aaaa1111', consent( 9 ) ) ) ).toBe( canonicalizeWixCapturedHtml( page( 'comp-bbbb2222', consent( 12 ) ) ) );
	} );
} );
