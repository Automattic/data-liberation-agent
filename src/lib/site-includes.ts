import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { adapter } from 'parse5-htmlparser2-tree-adapter';

// Parse HTML comments, not lookalike strings inside scripts, attributes or raw text.
export interface HtmlRange { start: number; end: number }
export function sourceRange( node: AnyNode ): HtmlRange | undefined {
	const location = ( node as AnyNode & { sourceCodeLocation?: { startOffset: number; endOffset: number; endTag?: unknown } } ).sourceCodeLocation;
	return location && { start: location.startOffset, end: location.endOffset };
}
export function parseLocatedStructure( html: string ) {
	// This index consumes structure, comments and source ranges, never text or
	// serialization. Preserve parse5's tree construction and text-node positions,
	// but release character tokens instead of retaining all CSS/script/editorial
	// text in a second DOM. Authored bytes still come from the original source.
	return cheerio.load( html, { sourceCodeLocationInfo: true, treeAdapter: {
		...adapter,
		insertText: ( parent, _text ) => adapter.insertText( parent, '' ),
		insertTextBefore: ( parent, _text, before ) => adapter.insertTextBefore( parent, '', before ),
	} } );
}

export function includeReferences( html: string ): Array< HtmlRange & { path: string } > {
	const $ = parseLocatedStructure( html );
	const includes: Array< HtmlRange & { path: string } > = [];
	function visit( node: AnyNode ) {
		if ( node.type === 'comment' && /^\s*#include/i.test( node.data ) ) {
			const range = sourceRange( node );
			const match = range && /^<!--#include virtual="(\/parts\/[a-zA-Z0-9_-]+\.html)" -->$/.exec( html.slice( range.start, range.end ) );
			if ( ! match || ! range ) throw new Error( 'Malformed site include' );
			includes.push( { ...range, path: match[ 1 ] } );
		}
		if ( 'children' in node ) for ( const child of node.children ) visit( child );
	}
	for ( const node of $.root().contents().toArray() ) visit( node );
	return includes.sort( ( a, b ) => a.start - b.start );
}

export const SITE_INCLUDE_LIMITS = { fileBytes: 16 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024, depth: 16, reads: 1024 };

/** Bounded reads reject symlinks in every path component, including the root. */
function readContained( root: string, file: string, limit: number ): string {
	const base = resolve( root );
	const rel = relative( base, resolve( file ) );
	if ( ! rel || rel === '..' || rel.startsWith( `..${ sep }` ) || rel.startsWith( sep ) ) throw new Error( 'Site include path escapes root' );
	if ( lstatSync( base ).isSymbolicLink() ) throw new Error( 'Site include root symlink' );
	let cursor: string = realpathSync( base );
	for ( const component of rel.split( sep ) ) {
		cursor = resolve( cursor, component );
		if ( lstatSync( cursor ).isSymbolicLink() ) throw new Error( `Site include symlink: ${ cursor }` );
	}
	const fd = openSync( cursor, constants.O_RDONLY | constants.O_NOFOLLOW );
	try {
		const stat = fstatSync( fd );
		if ( ! stat.isFile() || stat.size > limit ) throw new Error( 'Site include file exceeds size limit or is not a file' );
		const bytes = Buffer.alloc( stat.size + 1 );
		let length = 0;
		while ( length < bytes.length ) {
			const count = readSync( fd, bytes, length, bytes.length - length, null );
			if ( ! count ) break;
			length += count;
		}
		if ( length !== stat.size ) throw new Error( 'Site include file changed during read' );
		return bytes.subarray( 0, length ).toString( 'utf8' );
	} finally { closeSync( fd ); }
}

/** Compile a route in memory. No expanded copy or browser assembly is persisted. */
export function readResolvedPage( root: string, file: string, limits = SITE_INCLUDE_LIMITS ): string {
	return resolvePage( root, file, limits ).html;
}

/** A compiled route and every file whose bytes it was assembled from. */
export interface ResolvedPage { html: string; files: string[] }

/** Compile a route in memory, reporting the page and include files it read. */
export function resolvePage( root: string, file: string, limits = SITE_INCLUDE_LIMITS ): ResolvedPage {
	const files = new Set< string >();
	let reads = 0;
	let readBytes = 0;
	function expand( path: string, stack: string[] ): string {
		const absolute = resolve( path );
		if ( stack.includes( absolute ) ) throw new Error( 'Site include cycle' );
		if ( stack.length >= limits.depth || ++reads > limits.reads ) throw new Error( 'Site include expansion limit' );
		const html = readContained( root, absolute, Math.min( limits.fileBytes, limits.expandedBytes ) );
		files.add( absolute );
		readBytes += Buffer.byteLength( html );
		if ( readBytes > limits.expandedBytes ) throw new Error( 'Site include expansion exceeds byte read limit' );
		const chunks: string[] = [];
		let offset = 0;
		let size = 0;
		function append( value: string ) {
			size += Buffer.byteLength( value );
			if ( size > limits.expandedBytes ) throw new Error( 'Site include expansion exceeds byte limit' );
			chunks.push( value );
		}
		for ( const reference of includeReferences( html ) ) {
			append( html.slice( offset, reference.start ) );
			append( expand( resolve( root, reference.path.slice( 1 ) ), [ ...stack, absolute ] ) );
			offset = reference.end;
		}
		append( html.slice( offset ) );
		return chunks.join( '' );
	}
	const html = expand( file, [] );
	return { html, files: [ ...files ] };
}

/** Identity of one file's on-disk state; any replacement, rename or write changes it. */
function fileState( path: string ): { identity: string; changedNs: bigint } | null {
	try {
		const stat = lstatSync( path, { bigint: true } );
		return stat.isFile() ? { identity: `${ stat.dev }:${ stat.ino }:${ stat.size }:${ stat.mtimeNs }:${ stat.ctimeNs }`, changedNs: stat.ctimeNs } : null;
	} catch {
		return null;
	}
}

// Coarse filesystem timestamps can date a change made during a read before it.
const TIMESTAMP_GRANULARITY_NS = 2_000_000_000n;

/**
 * Resolve each route once and reuse its bytes until the page or any include it
 * read changes on disk. Parsing a multi-megabyte page is synchronous work; a
 * server sharing its event loop with the browser driver must not repeat it for
 * every request of an unchanged route. A changed, missing or replaced file
 * re-runs full resolution, so its bounds, symlink and cycle checks still apply.
 */
export function createResolvedPageCache( root: string, { maxBytes = 256 * 1024 * 1024, timestampGranularityNs = TIMESTAMP_GRANULARITY_NS } = {} ) {
	const entries = new Map< string, { html: Buffer; files: Array< [ string, string ] > } >();
	let bytes = 0;
	return ( file: string ): Buffer => {
		const key = resolve( file );
		const cached = entries.get( key );
		if ( cached && cached.files.every( ( [ path, identity ] ) => fileState( path )?.identity === identity ) ) {
			// Refresh recency for eviction.
			entries.delete( key );
			entries.set( key, cached );
			return cached.html;
		}
		if ( cached ) {
			entries.delete( key );
			bytes -= cached.html.length;
		}
		const startedNs = BigInt( Date.now() ) * 1_000_000n;
		const page = resolvePage( root, key );
		const html = Buffer.from( page.html );
		// A file changed while (or just before) it was read may not match the
		// identity taken now; serve those bytes once, but never reuse them.
		const files: Array< [ string, string ] > = [];
		for ( const path of page.files ) {
			const state = fileState( path );
			if ( ! state || state.changedNs >= startedNs - timestampGranularityNs ) return html;
			files.push( [ path, state.identity ] );
		}
		if ( html.length <= maxBytes ) {
			entries.set( key, { html, files } );
			bytes += html.length;
			for ( const [ oldest, entry ] of entries ) {
				if ( bytes <= maxBytes ) break;
				entries.delete( oldest );
				bytes -= entry.html.length;
			}
		}
		return html;
	};
}
