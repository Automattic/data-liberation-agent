import { describe, expect, it } from 'vitest';
import { deriveMemberDocument } from '../lib/template-clusters.js';
import { wixAdapter } from './wix/index.js';
import { shopifyAdapter } from './shopify/index.js';
import { canonicalizeWixCapturedHtml } from './wix/instance-ids.js';

const baseUrl = 'https://fixture.test/';

describe( 'platform runtime widget declarations', () => {
	it( 'declares Wix engagement controls without hiding authored card content', () => {
		const page = ( title: string, hydrated: boolean, extra = '' ) => `<body><main id="gallery"><h1>${ title }</h1><footer data-hook="post-footer"><div data-hook="post-stats">${ hydrated ? '13 views' : 'Views' }</div><div class="wChIrD">${ hydrated ? '<button>Post not marked as liked</button>1 like.' : 'Like' }</div></footer>${ extra }</main></body>`;
		const input = { baseUrl, repServerHtml: page( 'First', false ), repProcessedHtml: page( 'First', true ), memberServerHtml: page( 'Second', false, '<p>New content</p>' ) };
		expect( deriveMemberDocument( input ) ).toMatchObject( { ok: false, gate: { code: 'slot_anchor_unmapped' } } );
		const result = deriveMemberDocument( { ...input, runtimeWidgetSelectors: wixAdapter.liberation!.runtimeWidgetSelectors } );
		expect( result.ok ).toBe( true );
		if ( result.ok ) {
			expect( result.html ).toContain( '<h1>Second</h1>' );
			expect( result.html ).toContain( '<p>New content</p>' );
			expect( result.html ).toContain( 'Post not marked as liked</button>1 like.' );
		}
	} );

	it( 'uses capture canonicalization for server checkbox anchors', () => {
		const page = ( counter: number, title: string ) => `<body><main><h1>${ title }</h1><div data-hook="form-field-consent"><input type="checkbox" id="checkbox-${ counter }"><label for="checkbox-${ counter }">Subscribe</label></div></main></body>`;
		const input = { baseUrl, repServerHtml: page( 2096, 'First' ), memberServerHtml: page( 312, 'Second' ), repProcessedHtml: canonicalizeWixCapturedHtml( page( 27, 'First' ) ) };
		expect( deriveMemberDocument( input ) ).toMatchObject( { ok: false, gate: { code: 'slot_anchor_unmapped' } } );
		const result = deriveMemberDocument( { ...input, canonicalizeHtml: wixAdapter.liberation!.canonicalizeHtml } );
		expect( result.ok ).toBe( true );
		if ( result.ok ) {
			expect( result.html ).toContain( '<h1>Second</h1>' );
			expect( result.html ).toContain( 'id="checkbox-dla' );
			expect( result.html ).not.toContain( 'checkbox-312' );
		}
	} );

	it( 'declares Shopify app blocks, not arbitrary shopify-prefixed elements', () => {
		for ( const [ id, expected ] of [ [ 'shopify-block-AVFk1SEJJU3FEbC9sV__judge_me_reviews_review_widget_dcb6rX', true ], [ 'shopify-block-authored', false ] ] as const ) {
			const page = ( title: string, text: string, extra = '' ) => `<body><main id="product"><h1>${ title }</h1><div id="${ id }">${ text }</div>${ extra }</main></body>`;
			const result = deriveMemberDocument( { baseUrl, repServerHtml: page( 'First', 'Reviews' ), repProcessedHtml: page( 'First', 'Five reviews' ), memberServerHtml: page( 'Second', 'Reviews', '<p>Member</p>' ), runtimeWidgetSelectors: shopifyAdapter.liberation!.runtimeWidgetSelectors } );
			expect( result.ok ).toBe( expected );
			if ( result.ok ) expect( result.html ).toContain( 'Five reviews' );
		}
	} );
} );
