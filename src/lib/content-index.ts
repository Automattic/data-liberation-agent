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
	/** generic/products/v1 catalog rows, including products without captured pages. */
	products?: import('./product-row.js').ProductRow[];
	/** Entry facts without their bodies: each post's body ships in its own exported document. */
	posts: Array< Omit< StructuredContentEntry, 'contentHtml' | 'product' > & { path: string } >;
	terms: ContentIndexTerm[];
	redirects: Array< { from: string; to: string } >;
}

/** Each term's archive in the collection of every entry carrying it; the inventory's term routes. */
export function structuredTermArchiveUrls( entries: StructuredContentEntry[], source: Pick< StructuredContentSource, 'termArchiveUrl' > ): string[] {
	return [ ...new Set( entries.flatMap( entry => entry.terms.map( term => source.termArchiveUrl( term, entry.permalink ) ) ) ) ];
}

/**
 * Portable semantic index of a platform's structured content (`website/content-index.json`).
 * Paths come from the exporter's allocated routes; a term without a captured
 * archive gets a deterministic generated path.
 */
export function structuredContentIndex( entries: StructuredContentEntry[], routes: Array< { url: string; path: string } >, source: Pick< StructuredContentSource, 'termArchiveUrl' | 'termName' >, sourceUrl: string, mediaPaths: ReadonlyMap<string, string> = new Map(), diagnostic: (url: string, reason: string) => void = () => {} ): ContentIndex {
	const paths = new Map( routes.map( route => [ route.url, `/${ route.path.replace( /^website\//, '' ) }` ] ) );
	// A term's archive belongs to the collection of the entries carrying it.
	const archiveUrl = ( name: string ) => source.termArchiveUrl( name, entries.find( entry => entry.terms.includes( name ) )?.permalink ?? sourceUrl );
	const capturedTerms = new Map< string, ContentIndexTerm >();
	for ( const route of routes ) {
		const name = source.termName( route.url );
		if ( name === undefined ) continue;
		if ( ! capturedTerms.has( name ) || route.url === archiveUrl( name ) ) {
			capturedTerms.set( name, { name, kind: 'term-archive', sourceUrl: route.url, path: paths.get( route.url )! } );
		}
	}
	const terms = [ ...capturedTerms.values() ];
	for ( const name of new Set( entries.flatMap( entry => entry.terms ) ) ) {
		if ( terms.some( term => term.name === name ) ) continue;
		terms.push( { name, kind: 'term-archive', sourceUrl: archiveUrl( name ), path: `/terms/${ createHash( 'sha256' ).update( name ).digest( 'hex' ) }.html` } );
	}
	const posts = entries.filter( entry => paths.has( entry.permalink ) ).map( ( { contentHtml: _body, product: _product, ...entry } ) => ( { ...entry, path: paths.get( entry.permalink )! } ) );
	const products = entries.flatMap(entry => {
		if (!entry.product) return [];
		const { images, source_path: _path, ...row } = entry.product;
		const localized = images?.flatMap(image => {
			const path = mediaPaths.get(image.src);
			if (!path) { diagnostic(image.src, 'Catalog image could not be materialized within portable limits'); return []; }
			return [{ ...image, src: path.replace(/^\/?website\//, '').replace(/^\//, '') }];
		});
		return [{ ...row, ...(localized?.length ? { images: localized } : {}), ...(paths.has(entry.permalink) ? { source_path: paths.get(entry.permalink)! } : {}) }];
	});
	return {
		schema: CONTENT_INDEX_SCHEMA,
		...(products.length ? { products } : {}),
		posts,
		terms,
		redirects: [ ...posts.map( post => ( { from: post.permalink, to: post.path } ) ), ...terms.map( term => ( { from: term.sourceUrl, to: term.path } ) ) ],
	};
}
