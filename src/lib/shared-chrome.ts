import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnyNode, Element } from 'domhandler';
import { includeReferences, parseLocatedHtml, sourceRange, type HtmlRange } from './site-includes.js';

/** Only exact, site-level semantic landmarks are shared; authored bytes survive. */
export function extractSharedChrome( root: string, routePaths: string[] ): void {
	const sources = new Set( [ ...routePaths, ...shareChrome( root, routePaths, false ) ] );
	// Route-current links can vary while the brand, menus and footer content
	// remain identical. Factor common subtrees from the actual source owners,
	// including the parts just created, rather than freezing or stripping state.
	for ( let pass = 0; pass < 16; pass++ ) {
		for ( const path of sources ) for ( const reference of includeReferences( readFileSync( join( root, path ), 'utf8' ) ) ) sources.add( reference.path.slice( 1 ) );
		const added = shareChrome( root, [ ...sources ], true );
		if ( ! added.length ) break;
		for ( const path of added ) sources.add( path );
	}
}

function shareChrome( root: string, paths: string[], descendants: boolean ): string[] {
	const partsDir = join( root, 'parts' );
	if ( existsSync( partsDir ) && ( lstatSync( partsDir ).isSymbolicLink() || ! lstatSync( partsDir ).isDirectory() ) ) return [];
	const documents = new Map( paths.map( path => [ path, readFileSync( join( root, path ), 'utf8' ) ] ) );
	const groups = new Map< string, { html: string; occurrences: Array< HtmlRange & { path: string } > } >();
	for ( const [ path, html ] of documents ) {
		const $ = parseLocatedHtml( html );
		const partRole = /^parts\/(header|footer)-[a-f0-9]+\.html$/.exec( path )?.[ 1 ];
		$( descendants ? '*' : 'header,footer,[role="banner"],[role="contentinfo"]' ).each( ( _index, node ) => {
			if ( descendants && 'name' in node && [ 'script', 'style', 'template' ].includes( node.name ) ) return;
			let landmark: Element | undefined;
			let candidate: AnyNode | null = node;
			while ( candidate && candidate.type !== 'root' ) {
				if ( 'name' in candidate ) {
					const element = candidate as Element;
					if ( [ 'script', 'style', 'template', 'main', 'article', 'section' ].includes( element.name ) ) return;
					if ( [ 'header', 'footer' ].includes( element.name ) || [ 'banner', 'contentinfo' ].includes( element.attribs.role ) ) {
						landmark = element;
						break;
					}
				}
				candidate = candidate.parent;
			}
			if ( ! landmark && ! partRole ) return;
			const role = landmark ? ( landmark.name === 'header' || landmark.attribs.role === 'banner' ? 'header' : 'footer' ) : partRole;
			// Ordinary root wrappers (including responsive document scopes) are neutral.
			let parent: AnyNode | null = landmark?.parent ?? null;
			while ( parent && parent.type !== 'root' ) {
				if ( 'name' in parent ) {
					const element = parent as Element;
					if ( ! [ 'html', 'body', 'div' ].includes( element.name ) ||
						( element.attribs.role && ! [ 'generic', 'group', 'presentation', 'none' ].includes( element.attribs.role ) ) ) return;
				}
				parent = parent.parent;
			}
			const range = sourceRange( node );
			// Implied/unclosed elements have no reliable byte-preserving end tag.
			if ( ! range || !( node as Element & { sourceCodeLocation?: { endTag?: unknown } } ).sourceCodeLocation?.endTag ) return;
			const fragment = html.slice( range.start, range.end );
			const key = `${ role }-${ createHash( 'sha256' ).update( fragment ).digest( 'hex' ) }`;
			const group = groups.get( key ) ?? { html: fragment, occurrences: [] };
			group.occurrences.push( { ...range, path } );
			groups.set( key, group );
		} );
	}
	const replacements = new Map< string, Array< HtmlRange & { include: string } > >();
	const created: string[] = [];
	// Prefer maximal shared regions and avoid overlapping source ranges.
	for ( const [ id, group ] of [ ...groups ].sort( ( a, b ) => b[ 1 ].html.length - a[ 1 ].html.length || a[ 0 ].localeCompare( b[ 0 ] ) ) ) {
		const occurrences = group.occurrences.filter( item => !( replacements.get( item.path ) ?? [] ).some( used => item.start < used.end && used.start < item.end ) );
		if ( new Set( occurrences.map( item => item.path ) ).size < 2 ) continue;
		const include = `<!--#include virtual="/parts/${ id }.html" -->`;
		if ( occurrences.length * ( Buffer.byteLength( group.html ) - Buffer.byteLength( include ) ) <= Buffer.byteLength( group.html ) ) continue;
		const destination = join( root, 'parts', `${ id }.html` );
		// Never clobber a source resource, even a same-named one.
		if ( existsSync( destination ) ) continue;
		mkdirSync( partsDir, { recursive: true } );
		writeFileSync( destination, group.html, { flag: 'wx' } );
		created.push( `parts/${ id }.html` );
		for ( const occurrence of occurrences ) {
			const list = replacements.get( occurrence.path ) ?? [];
			list.push( { ...occurrence, include } );
			replacements.set( occurrence.path, list );
		}
	}
	for ( const [ path, ranges ] of replacements ) {
		let html = documents.get( path )!;
		for ( const range of ranges.sort( ( a, b ) => b.start - a.start ) ) html = html.slice( 0, range.start ) + range.include + html.slice( range.end );
		writeFileSync( join( root, path ), html );
	}
	return created;
}
