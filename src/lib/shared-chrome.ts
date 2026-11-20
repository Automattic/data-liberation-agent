import type { WebsiteInventory } from './website-inventory.js';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnyNode, Element } from 'domhandler';
import { includeReferences, parseLocatedStructure, sourceRange, type HtmlRange } from './site-includes.js';

/** Route-local attributes: per-document node identity and the current-page
 * state. Copies of one region that differ only here are one region seen from
 * different routes, not variants of it. */
const ROUTE_LOCAL_ATTRIBUTES = /\s(?:data-blocks-engine-node-id|aria-current|aria-selected)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi;

/** Class tokens that mark the served item (Blocks Engine's
 * `SourceClassIdentity::CURRENT_STATE_CLASSES`). A class naming one of them by
 * any token (`header-nav-item--active`, `is-current`, `current-menu-item`) is
 * the class-marked counterpart of `aria-current`. */
const CURRENT_STATE_CLASSES = new Set( [ 'current', 'active', 'selected' ] );
const CLASS_ATTRIBUTE = /(\sclass\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;

function containsCurrentStateToken( value: string ): boolean {
	return value.toLowerCase().split( /[^a-z0-9]+/ ).some( token => CURRENT_STATE_CLASSES.has( token ) );
}

/** Grouping key bytes only: route-local attributes and current-state classes
 * removed. Emitted parts and route documents keep their authored bytes. */
export function routeNeutralFragment( fragment: string ): string {
	return fragment.replace( ROUTE_LOCAL_ATTRIBUTES, '' ).replace( CLASS_ATTRIBUTE, ( _match, prefix: string, double?: string, single?: string, bare?: string ) => {
		const value = double ?? single ?? bare ?? '';
		return `${ prefix }"${ value.split( /\s+/ ).filter( token => token && ! containsCurrentStateToken( token ) ).join( ' ' ) }"`;
	} );
}

/** Only exact, site-level semantic landmarks are shared; authored bytes survive. */
export function extractSharedChrome( root: string, routePaths: string[], inventory?: WebsiteInventory ): void {
	const index: ChromeIndex = new Map();
	const sources = new Set( [ ...routePaths, ...shareChrome( root, routePaths, false, inventory, index ) ] );
	// Route-current links can vary while the brand, menus and footer content
	// remain identical. Factor common subtrees from the actual source owners,
	// including the parts just created, rather than freezing or stripping state.
	// Each pass rewrites only the few documents it shares from; every unchanged
	// document answers from the index instead of being parsed again.
	for ( let pass = 0; pass < 16; pass++ ) {
		for ( const path of sources ) for ( const reference of indexedIncludes( root, path, index ) ) sources.add( reference.path.slice( 1 ) );
		const added = shareChrome( root, [ ...sources ], true, inventory, index );
		if ( ! added.length ) break;
		for ( const path of added ) sources.add( path );
	}
}

/** One shareable region of a source document, without its sliced bytes. */
interface ChromeCandidate extends HtmlRange { id: string; key: string }
/** Per source path: derived structure for one exact document version (by digest). */
type ChromeIndex = Map< string, { digest: string; includes?: Array< HtmlRange & { path: string } >; candidates: Map< boolean, ChromeCandidate[] > } >;

function indexEntry( index: ChromeIndex, path: string, html: string ) {
	const digest = createHash( 'sha256' ).update( html ).digest( 'hex' );
	let entry = index.get( path );
	if ( entry?.digest !== digest ) index.set( path, entry = { digest, candidates: new Map() } );
	return entry;
}

function indexedIncludes( root: string, path: string, index: ChromeIndex ): Array< HtmlRange & { path: string } > {
	const html = readFileSync( join( root, path ), 'utf8' );
	const entry = indexEntry( index, path, html );
	if ( ! entry.includes ) {
		const $ = parseLocatedStructure( html );
		entry.includes = includeReferences( html, $ );
		// The next shareChrome pass reads this same document for its descendants.
		if ( ! entry.candidates.has( true ) ) entry.candidates.set( true, chromeCandidates( html, path, true, $ ) );
	}
	return entry.includes;
}

function chromeCandidates( html: string, path: string, descendants: boolean, $ = parseLocatedStructure( html ) ): ChromeCandidate[] {
	const candidates: ChromeCandidate[] = [];
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
		const id = `${ role }-${ createHash( 'sha256' ).update( fragment ).digest( 'hex' ) }`;
		const key = `${ role }-${ createHash( 'sha256' ).update( routeNeutralFragment( fragment ) ).digest( 'hex' ) }`;
		candidates.push( { ...range, id, key } );
	} );
	return candidates;
}

function shareChrome( root: string, paths: string[], descendants: boolean, inventory: WebsiteInventory | undefined, index: ChromeIndex ): string[] {
	const partsDir = join( root, 'parts' );
	if ( existsSync( partsDir ) && ( lstatSync( partsDir ).isSymbolicLink() || ! lstatSync( partsDir ).isDirectory() ) ) return [];
	// Candidate landmarks overlap, often deeply. Retaining every candidate's
	// sliced HTML makes memory scale with the sum of all ancestor subtrees, not
	// the source bytes. Index their original ranges and materialize only an
	// admitted part. Source documents stay unchanged until all ranges are chosen.
	// Group by route-neutral bytes. A region whose route copies differ only in
	// route-local attributes is shared on no route, so every route keeps the same
	// structure (and its own landmark) instead of a route-dependent partition.
	const groups = new Map< string, { id: string; length: number; exact: Set< string >; occurrences: Array< HtmlRange & { path: string } > } >();
	const physicalPaths = new Set< string >();
	for ( const path of new Set( paths ) ) {
		const identity = realpathSync( join( root, path ) );
		if ( physicalPaths.has( identity ) ) continue;
		physicalPaths.add( identity );
		const html = readFileSync( join( root, path ), 'utf8' );
		const entry = indexEntry( index, path, html );
		let candidates = entry.candidates.get( descendants );
		if ( ! candidates ) entry.candidates.set( descendants, candidates = chromeCandidates( html, path, descendants ) );
		for ( const { id, key, start, end } of candidates ) {
			const group = groups.get( key ) ?? { id, length: end - start, exact: new Set(), occurrences: [] };
			group.exact.add( id );
			group.occurrences.push( { start, end, path } );
			groups.set( key, group );
		}
	}
	const replacements = new Map< string, Array< HtmlRange & { include: string; digest: string } > >();
	const created: string[] = [];
	// Prefer maximal shared regions and avoid overlapping source ranges.
	for ( const group of [ ...groups.values() ].sort( ( a, b ) => b.length - a.length || a.id.localeCompare( b.id ) ) ) {
		if ( group.exact.size > 1 ) continue;
		const id = group.id;
		const occurrences = group.occurrences.filter( item => !( replacements.get( item.path ) ?? [] ).some( used => item.start < used.end && used.start < item.end ) );
		if ( new Set( occurrences.map( item => item.path ) ).size < 2 ) continue;
		const include = `<!--#include virtual="/parts/${ id }.html" -->`;
		const source = group.occurrences[ 0 ];
		const fragment = readFileSync( join( root, source.path ), 'utf8' ).slice( source.start, source.end );
		const bytes = Buffer.byteLength( fragment );
		if ( occurrences.length * ( bytes - Buffer.byteLength( include ) ) <= bytes ) continue;
		const destination = join( root, 'parts', `${ id }.html` );
		// Never clobber a source resource, even a same-named one.
		if ( existsSync( destination ) ) continue;
		mkdirSync( partsDir, { recursive: true } );
		writeFileSync( destination, fragment, { flag: 'wx' } );
		inventory?.add( `parts/${ id }.html` );
		created.push( `parts/${ id }.html` );
		for ( const occurrence of occurrences ) {
			const list = replacements.get( occurrence.path ) ?? [];
			list.push( { ...occurrence, include, digest: createHash( 'sha256' ).update( fragment ).digest( 'hex' ) } );
			replacements.set( occurrence.path, list );
		}
	}
	for ( const [ path, ranges ] of replacements ) {
		let html = readFileSync( join( root, path ), 'utf8' );
		for ( const range of ranges.sort( ( a, b ) => b.start - a.start ) ) {
			// Never apply stale offsets to a document changed since indexing.
			if ( createHash( 'sha256' ).update( html.slice( range.start, range.end ) ).digest( 'hex' ) !== range.digest ) continue;
			html = html.slice( 0, range.start ) + range.include + html.slice( range.end );
		}
		writeFileSync( join( root, path ), html );
		inventory?.add( path );
	}
	return created;
}
