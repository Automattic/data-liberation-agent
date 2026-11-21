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

	it( 'leaves a page untouched when two instances scope the same components, even if a linked sheet selects one', () => {
		const html = page( 'comp-aaaa1111', '<div id="comp-cccc3333" class="comp-cccc3333_r_comp-nav comp-cccc3333_r_comp-logo"></div><p class="comp-dddd4444_r_comp-promo"></p>' );
		expect( canonicalizeWixInstanceIds( html, html, [ '.comp-aaaa1111_r_comp-nav{color:blue}' ] ) ).toBe( html );
	} );

	it( 'keeps an instance name once given, even when later markup shows fewer of its components', () => {
		// The export canonicalizes each route again after its stylesheets became
		// linked files. The markup alone then names only some of the instance's
		// components; the linked rules still use the first name.
		// The page stylesheet also styles a component the route does not render.
		const source = page( 'comp-aaaa1111' ).replace( '</style>', '.comp-aaaa1111_r_comp-cart{display:none}</style>' );
		const captured = canonicalizeWixInstanceIds( source );
		const id = /id="(comp-dla[0-9a-f]{8})_r_comp-logo"/.exec( captured )?.[ 1 ];
		expect( captured ).toContain( `.${ id }_r_comp-cart{display:none}` );
		const exported = captured.replace( /<style>[\s\S]*?<\/style>/, '<link rel="stylesheet" href="/assets/css/page.css">' );
		expect( exported ).toContain( `class="${ id }_r_comp-nav"` );
		expect( canonicalizeWixInstanceIds( exported ) ).toBe( exported );
		expect( canonicalizeWixCapturedHtml( exported ) ).toBe( exported );
	} );

	it( 'keeps the name of an instance its linked stylesheets select', () => {
		const exported = page( 'comp-aaaa1111' ).replace( /<style>[\s\S]*?<\/style>/, '<link rel="stylesheet" href="/assets/css/page.css">' ) +
			'<p class="comp-cccc3333_r_comp-copyright">©</p>';
		const out = canonicalizeWixCapturedHtml( exported, undefined, [ '.unrelated{color:blue}', '.comp-aaaa1111_r_comp-nav{color:red}' ] );
		expect( out ).toContain( 'class="comp-aaaa1111_r_comp-nav"' );
		expect( out ).toMatch( /class="comp-dla[0-9a-f]{8}_r_comp-copyright"/ );
		expect( canonicalizeWixCapturedHtml( exported, undefined, [ '#comp-aaaa11112{top:0}' ] ) ).not.toContain( 'comp-aaaa1111_r_' );
	} );

	it( 'leaves a page untouched when a new instance would take a name already on the page', () => {
		const captured = canonicalizeWixInstanceIds( page( 'comp-aaaa1111' ) );
		const html = `${ captured }<div class="comp-cccc3333_r_comp-nav comp-cccc3333_r_comp-logo"></div>`;
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

	it( 'keeps a counter id a linked stylesheet selects, but not one it only starts', () => {
		const kept = canonicalizeWixFormControlIds( consent( 5 ), undefined, [ '#checkbox-5{margin:0}' ] );
		expect( kept ).toContain( 'id="checkbox-5"' );
		const named = canonicalizeWixFormControlIds( consent( 5 ), undefined, [ '#checkbox-5-hint{margin:0}' ] );
		expect( named ).toMatch( /id="checkbox-dla[0-9a-f]{8}"/ );
	} );

	it( 'keeps a document unchanged when a generated checkbox name is already selected by a linked stylesheet', () => {
		const token = /id="(checkbox-dla[0-9a-f]{8})"/.exec( canonicalizeWixFormControlIds( consent( 5 ) ) )?.[ 1 ];
		expect( canonicalizeWixFormControlIds( consent( 5 ), undefined, [ `#${ token }{display:none}` ] ) ).toBe( consent( 5 ) );
	} );

	it( 'keeps a document unchanged when a counter checkbox has no enclosing field', () => {
		const html = '<form><input type="checkbox" id="checkbox-4"></form>';
		expect( canonicalizeWixFormControlIds( html ) ).toBe( html );
	} );

	it( 'runs after instance canonicalization in the captured-HTML hook', () => {
		expect( canonicalizeWixCapturedHtml( page( 'comp-aaaa1111', consent( 9 ) ) ) ).toBe( canonicalizeWixCapturedHtml( page( 'comp-bbbb2222', consent( 12 ) ) ) );
	} );

	it( 'names markup captured from a page, such as an opened dialog, as the page names it', () => {
		const document = page( 'comp-aaaa1111', consent( 9 ) );
		const canonical = canonicalizeWixCapturedHtml( document );
		// The open menu holds one of the instance's components and the consent control.
		const dialog = '<nav id="comp-aaaa1111_r_comp-logo" class="comp-aaaa1111_r_comp-nav"><label for="checkbox-9">Subscribe</label></nav>';
		const out = canonicalizeWixCapturedHtml( dialog, document );
		const instance = /id="(comp-dla[0-9a-f]{8})_r_comp-logo"/.exec( canonical )?.[ 1 ];
		const checkbox = /id="(checkbox-dla[0-9a-f]{8})"/.exec( canonical )?.[ 1 ];
		expect( out ).toBe( `<nav id="${ instance }_r_comp-logo" class="${ instance }_r_comp-nav"><label for="${ checkbox }">Subscribe</label></nav>` );
	} );
} );
