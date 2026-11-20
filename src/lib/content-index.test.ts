import { expect, it } from 'vitest';
import { structuredContentIndex } from './content-index.js';
import type { StructuredContentEntry } from '../platform/types.js';

it('omits unresolved catalog images with diagnostics and retains products outside route coverage', () => {
	const entry: StructuredContentEntry = { permalink: 'https://shop.test/products/cup', slug: 'cup', title: 'Cup', kind: 'page', contentHtml: '', published: '', updated: '', author: '', terms: [],
		product: { name: 'Cup', slug: 'cup', regular_price: '9.00', stock_status: 'instock', images: [{ src: 'https://cdn.test/cup.jpg', alt: 'Cup' }] } };
	const diagnostics: string[] = [];
	const content = structuredContentIndex([entry], [], { termName: () => undefined, termArchiveUrl: () => '' }, 'https://shop.test/', new Map(), url => diagnostics.push(url));
	expect(content.products).toEqual([{ name: 'Cup', slug: 'cup', regular_price: '9.00', stock_status: 'instock' }]);
	expect(content.posts).toEqual([]);
	expect(diagnostics).toEqual(['https://cdn.test/cup.jpg']);
	expect(structuredContentIndex([], [], { termName: () => undefined, termArchiveUrl: () => '' }, 'https://shop.test/')).not.toHaveProperty('products');
});

it( 'prefers the canonical captured archive over a query variant for the same term', () => {
	const sourceUrl = 'https://example.test/';
	const archiveUrl = `${ sourceUrl }search/label/Blog`;
	const index = structuredContentIndex( [], [
		{ url: `${ archiveUrl }?max-results=7`, path: 'website/search/label/Blog/index-query-1.html' },
		{ url: archiveUrl, path: 'website/search/label/Blog/index.html' },
	], {
		termArchiveUrl: name => `${ sourceUrl }search/label/${ name }`,
		termName: url => new URL( url ).pathname.split( '/search/label/' )[ 1 ],
	}, sourceUrl );

	expect( index.terms ).toEqual( [ {
		name: 'Blog', kind: 'term-archive', sourceUrl: archiveUrl, path: '/search/label/Blog/index.html',
	} ] );
	expect( index.redirects ).toEqual( [ { from: archiveUrl, to: '/search/label/Blog/index.html' } ] );
} );
