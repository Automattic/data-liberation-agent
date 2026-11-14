import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WebsiteInventoryFile {
	/** Website-root-relative, slash-separated path. */
	path: string;
	bytes: number;
	isSymlink: boolean;
}

let walks = 0;
/** Test instrumentation: take a delta around the operation under test. */
export function inventoryWalks(): number { return walks; }

/** One directory traversal; contents remain owned by their consumers. */
export class WebsiteInventory {
	private readonly entries = new Map< string, WebsiteInventoryFile >();
	private readonly directories = new Map< string, string[] >();
	private complete = true;

	constructor( readonly root: string ) {
		walks++;
		const visit = ( directory: string ): void => {
			let children;
			try {
				children = readdirSync( join( root, directory ), { withFileTypes: true } );
			} catch {
				this.complete = false;
				return;
			}
			this.directories.set( directory, children.map( entry => directory ? `${ directory }/${ entry.name }` : entry.name ) );
			for ( const entry of children ) {
				const path = directory ? `${ directory }/${ entry.name }` : entry.name;
				if ( entry.isDirectory() ) visit( path );
				else if ( entry.isFile() || entry.isSymbolicLink() ) this.add( path );
			}
		};
		visit( '' );
	}

	get files(): WebsiteInventoryFile[] {
		return [ ...this.entries.values() ].sort( ( a, b ) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0 );
	}

	/** Original readdir depth-first order, for consumers that did not sort. */
	get traversalFiles(): WebsiteInventoryFile[] { return [ ...this.entries.values() ]; }

	/** Refresh size and type after writing, or register a new file. */
	add( path: string ): void {
		const stat = lstatSync( join( this.root, path ) );
		this.entries.set( path, { path, bytes: stat.size, isSymlink: stat.isSymbolicLink() } );
	}

	remove( path: string ): void { this.entries.delete( path ); }

	/** The reference audit historically visits directories from a LIFO stack. */
	textReferences(): Array< { path: string; text: string } > | null {
		if ( ! this.complete ) return null;
		const texts: Array< { path: string; text: string } > = [];
		let totalBytes = 0;
		const pending = [ '' ];
		try {
			while ( pending.length ) {
				for ( const path of this.directories.get( pending.pop()! ) ?? [] ) {
					if ( this.directories.has( path ) ) { pending.push( path ); continue; }
					const file = this.entries.get( path );
					if ( ! file ) continue;
					if ( file.isSymlink ) return null;
					if ( ! /\.(?:css|js|mjs|json|svg|xml|txt|html)$/i.test( path ) ) continue;
					totalBytes += file.bytes;
					if ( file.bytes > 32 * 1024 * 1024 || totalBytes > 128 * 1024 * 1024 ) return null;
					texts.push( { path: join( this.root, path ), text: readFileSync( join( this.root, path ), 'utf8' ) } );
				}
			}
		} catch { return null; }
		return texts;
	}
}
