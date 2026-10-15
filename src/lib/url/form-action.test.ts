import { describe, expect, it } from 'vitest';
import { FORM_ACTION_REMOVED, FORM_ACTION_SOURCE_HANDLER, portableFormAction } from './form-action.js';

const page = 'https://www.site.example/blog/post';

describe( 'portableFormAction', () => {
	it( 'keeps a third-party endpoint as an absolute URL', () => {
		expect( portableFormAction( 'action', 'https://payments.example/cgi-bin/donate', page, page ) ).toEqual( { value: 'https://payments.example/cgi-bin/donate' } );
		expect( portableFormAction( 'action', '//lists.example/subscribe?u=1', page, page ) ).toEqual( { value: 'https://lists.example/subscribe?u=1' } );
	} );

	it( 'rewrites a source-site handler to its root-relative path and records it', () => {
		for ( const raw of [ '/apps/search', 'search', 'https://site.example/apps/search', 'http://www.site.example/apps/search' ] ) {
			const result = portableFormAction( 'action', raw, page, page );
			expect( result.value ).toBe( raw === 'search' ? '/blog/search' : '/apps/search' );
			expect( result.diagnostic?.code ).toBe( FORM_ACTION_SOURCE_HANDLER );
		}
		expect( portableFormAction( 'action', '/apps/search', page, page ).diagnostic?.reason ).toContain( 'https://www.site.example/apps/search' );
	} );

	it( 'resolves a relative action against the document base', () => {
		expect( portableFormAction( 'action', 'subscribe', 'https://lists.example/forms/', page ) ).toEqual( { value: 'https://lists.example/forms/subscribe' } );
	} );

	it( 'removes script, document and credential-bearing destinations with a record', () => {
		for ( const raw of [ 'javascript:submit()', ' java\tscript:submit()', 'data:text/html,<p>x</p>', 'vbscript:x', 'blob:https://site.example/1', 'https://user:secret@payments.example/' ] ) {
			const result = portableFormAction( 'formaction', raw, page, page );
			expect( result.value ).toBeUndefined();
			expect( result.diagnostic?.code ).toBe( FORM_ACTION_REMOVED );
			expect( result.diagnostic?.reason ).not.toContain( 'secret' );
		}
	} );

	it( 'keeps mailto and drops an empty action without a record', () => {
		expect( portableFormAction( 'action', 'mailto:hello@site.example', page, page ) ).toEqual( { value: 'mailto:hello@site.example' } );
		expect( portableFormAction( 'action', '  ', page, page ) ).toEqual( {} );
	} );

	it( 'cannot resolve a relative action without a page', () => {
		expect( portableFormAction( 'action', '/apps/search', undefined, undefined ).value ).toBeUndefined();
		expect( portableFormAction( 'action', 'https://payments.example/', undefined, undefined ).value ).toBe( 'https://payments.example/' );
	} );
} );
