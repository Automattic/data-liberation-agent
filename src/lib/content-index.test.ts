import { expect, it } from 'vitest';
import { structuredContentIndex } from './content-index.js';

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
