import { createHash } from 'node:crypto';
import type { StructuredContentEntry, StructuredContentSource } from '../platform/types.js';

export const CONTENT_INDEX_SCHEMA = 'data-liberation-agent/content-index/v1';

export interface ContentIndexTerm {
	name: string;
	kind: 'term-archive';
	sourceUrl: string;
	path: string;
}

export interface ContentIndex {
	schema: typeof CONTENT_INDEX_SCHEMA;
	/** Entry facts without their bodies: each post's body ships in its own exported document. */
	posts: Array< Omit< StructuredContentEntry, 'contentHtml' > & { path: string } >;
	terms: ContentIndexTerm[];
	redirects: Array< { from: string; to: string } >;
}

/**
 * Portable semantic index of a platform's structured content (`website/content-index.json`).
 * Paths come from the exporter's allocated routes; a term without a captured
 * archive gets a deterministic generated path.
 */
export function structuredContentIndex( entries: StructuredContentEntry[], routes: Array< { url: string; path: string } >, source: Pick< StructuredContentSource, 'termArchiveUrl' | 'termName' >, sourceUrl: string ): ContentIndex {
	const paths = new Map( routes.map( route => [ route.url, `/${ route.path.replace( /^website\//, '' ) }` ] ) );
	const terms: ContentIndexTerm[] = routes.flatMap( route => {
		const name = source.termName( route.url );
		return name === undefined ? [] : [ { name, kind: 'term-archive' as const, sourceUrl: route.url, path: paths.get( route.url )! } ];
	} );
	for ( const name of new Set( entries.flatMap( entry => entry.terms ) ) ) {
		if ( terms.some( term => term.name === name ) ) continue;
		terms.push( { name, kind: 'term-archive', sourceUrl: source.termArchiveUrl( name, sourceUrl ), path: `/terms/${ createHash( 'sha256' ).update( name ).digest( 'hex' ) }.html` } );
	}
	const posts = entries.filter( entry => paths.has( entry.permalink ) ).map( ( { contentHtml: _body, ...entry } ) => ( { ...entry, path: paths.get( entry.permalink )! } ) );
	return {
		schema: CONTENT_INDEX_SCHEMA,
		posts,
		terms,
		redirects: [ ...posts.map( post => ( { from: post.permalink, to: post.path } ) ), ...terms.map( term => ( { from: term.sourceUrl, to: term.path } ) ) ],
	};
}
