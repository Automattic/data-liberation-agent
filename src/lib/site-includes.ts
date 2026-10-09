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
	let reads = 0;
	let readBytes = 0;
	function expand( path: string, stack: string[] ): string {
		const absolute = resolve( path );
		if ( stack.includes( absolute ) ) throw new Error( 'Site include cycle' );
		if ( stack.length >= limits.depth || ++reads > limits.reads ) throw new Error( 'Site include expansion limit' );
		const html = readContained( root, absolute, Math.min( limits.fileBytes, limits.expandedBytes ) );
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
	return expand( file, [] );
}
