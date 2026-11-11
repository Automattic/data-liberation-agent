import * as cheerio from 'cheerio';
import { isYuiRuntimeId } from './html-nodes.js';

interface Node {
	next: Map< string, number >;
	fail: number;
	output: string[];
}

/** Audit all candidate IDs together, preserving substring (not token) semantics.
 * Each text is scanned once, rather than once per ID on every other route.
 */
export function indexRuntimeIdReferences( texts: readonly { path: string; text: string }[] ): ( id: string, path: string ) => boolean {
	const candidates = new Set< string >();
	for ( const { path, text } of texts ) {
		if ( ! /\.html?$/i.test( path ) || ! /yui_/i.test( text ) ) continue;
		const $ = cheerio.load( text );
		$( '[id]' ).each( ( _, node ) => {
			const id = $( node ).attr( 'id' )!;
			if ( isYuiRuntimeId( id ) ) candidates.add( id );
		} );
	}
	if ( ! candidates.size ) return () => false;
	const nodes: Node[] = [ { next: new Map(), fail: 0, output: [] } ];
	for ( const id of candidates ) {
		let state = 0;
		for ( const char of id ) {
			let next = nodes[ state ].next.get( char );
			if ( next === undefined ) {
				next = nodes.length;
				nodes[ state ].next.set( char, next );
				nodes.push( { next: new Map(), fail: 0, output: [] } );
			}
			state = next;
		}
		nodes[ state ].output.push( id );
	}
	const queue = [ ...nodes[ 0 ].next.values() ];
	for ( let i = 0; i < queue.length; i++ ) {
		const state = queue[ i ];
		for ( const [ char, child ] of nodes[ state ].next ) {
			let fail = nodes[ state ].fail;
			while ( fail && ! nodes[ fail ].next.has( char ) ) fail = nodes[ fail ].fail;
			nodes[ child ].fail = nodes[ fail ].next.get( char ) ?? 0;
			nodes[ child ].output.push( ...nodes[ nodes[ child ].fail ].output );
			queue.push( child );
		}
	}
	// null means at least two files: no caller can exclude both as itself.
	const owners = new Map< string, string | null >();
	for ( const { path, text } of texts ) {
		let state = 0;
		for ( const char of text ) {
			while ( state && ! nodes[ state ].next.has( char ) ) state = nodes[ state ].fail;
			state = nodes[ state ].next.get( char ) ?? 0;
			for ( const id of nodes[ state ].output ) {
				if ( ! owners.has( id ) ) owners.set( id, path );
				else if ( owners.get( id ) !== path ) owners.set( id, null );
			}
		}
	}
	return ( id, path ) => owners.has( id ) && owners.get( id ) !== path;
}
