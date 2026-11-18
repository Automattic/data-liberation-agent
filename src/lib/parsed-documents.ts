import * as cheerio from 'cheerio';
import { cloneNode } from 'domhandler';

/**
 * Export runs many independent stages over the same route documents, and each
 * stage takes HTML as a string. Parsing one string twice builds the same tree
 * twice, so inside a scope opened by `withParsedDocuments` a parsed document
 * is kept for the next stage that asks for the identical string.
 *
 * - `readDocument` returns a shared tree. Callers must not mutate it.
 * - `ownDocument` returns a tree the caller may mutate: a deep copy of the
 *   shared tree, which stays cached for later readers.
 * - `releaseDocument` hands a tree a reader already holds to that reader for
 *   mutation; later callers parse again.
 *
 * Both parse exactly as `cheerio.load( html )` does, so results are unchanged.
 * Outside a scope they are plain `cheerio.load( html )`. The cache is a small
 * LRU, released when the outermost scope closes: it only bridges consecutive
 * stages, never holds a run's documents.
 */
const MAX_DOCUMENTS = 4;

let depth = 0;
const documents = new Map< string, cheerio.CheerioAPI >();
const serializations = new WeakMap< cheerio.CheerioAPI, string >();

export function withParsedDocuments< T >( run: () => T ): T {
	depth++;
	try {
		return run();
	} finally {
		if ( --depth === 0 ) documents.clear();
	}
}

export function readDocument( html: string ): cheerio.CheerioAPI {
	if ( depth === 0 ) return cheerio.load( html );
	const cached = documents.get( html );
	if ( cached ) {
		// Most recently used last, so eviction drops the oldest.
		documents.delete( html );
		documents.set( html, cached );
		return cached;
	}
	const $ = cheerio.load( html );
	documents.set( html, $ );
	if ( documents.size > MAX_DOCUMENTS ) documents.delete( documents.keys().next().value! );
	return $;
}

export function ownDocument( html: string ): cheerio.CheerioAPI {
	if ( depth === 0 ) return cheerio.load( html );
	// A deep copy of the shared tree is the tree a fresh parse would build
	// (domhandler copies every property parse5's tree adapter sets), for a
	// fraction of the cost, and later readers keep the shared tree.
	return cheerio.load( cloneNode( readDocument( html ).root()[ 0 ], true ) );
}

/**
 * A reader that decides to mutate the tree `readDocument( html )` gave it
 * takes it over: no later reader receives it. Its own node references stay valid.
 */
export function releaseDocument( html: string, $: cheerio.CheerioAPI ): void {
	if ( documents.get( html ) === $ ) documents.delete( html );
	serializations.delete( $ );
}

/** `$.html()` of an unmutated `readDocument( html )` tree, serialized once while it is shared. */
export function serializedDocument( html: string, $: cheerio.CheerioAPI ): string {
	if ( documents.get( html ) !== $ ) return $.html();
	let serialized = serializations.get( $ );
	if ( serialized === undefined ) serializations.set( $, serialized = $.html() );
	return serialized;
}
