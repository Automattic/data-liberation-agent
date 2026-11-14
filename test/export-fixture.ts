import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MediaStubStore } from '../src/lib/resume-state/index.js';

/** Disk inputs only: tests still exercise the public exportWebsiteCapture entry point.
 * Raw files/manifests deliberately permit incomplete and malformed capture evidence.
 * Directories are removed after each test, including when export throws.
 */
const directoriesToRemove: string[] = [];
afterEach( () => {
	for ( const directory of directoriesToRemove.splice( 0 ) ) rmSync( directory, { recursive: true, force: true } );
} );

export function exportFixture( { sourceUrl = 'https://example.com/', directories = [] }: { sourceUrl?: string; directories?: string[] } = {} ) {
	const outputDir = mkdtempSync( join( tmpdir(), 'liberation-export-' ) );
	directoriesToRemove.push( outputDir );
	for ( const directory of directories ) mkdirSync( join( outputDir, directory ), { recursive: true } );
	let entries: Record< string, Record< string, unknown > > = {};
	const resources: Record< string, { path: string; contentType: string } > = {};
	const fixture = {
		build: () => outputDir,
		directories( ...paths: string[] ) {
			for ( const path of paths ) fixture.directory( path );
			return fixture;
		},
		directory( path: string ) {
			mkdirSync( join( outputDir, path ), { recursive: true } );
			return fixture;
		},
		file( path: string, body: string | NodeJS.ArrayBufferView ) {
			mkdirSync( dirname( join( outputDir, path ) ), { recursive: true } );
			writeFileSync( join( outputDir, path ), body );
			return fixture;
		},
		json( path: string, value: unknown ) {
			return fixture.file( path, JSON.stringify( value ) );
		},
		manifest( value: unknown ) {
			return fixture.json( 'screenshots/manifest.json', value );
		},
		page( route: string, html: string, options: { mobile?: string; sections?: unknown; entry?: Record< string, unknown > } = {} ) {
			const slug = `page-${ Object.keys( entries ).length }`;
			const path = options.entry?.html as string ?? `html/${ slug }.html`;
			fixture.file( path, html );
			const entry: Record< string, unknown > = { html: path, ...options.entry };
			if ( options.mobile !== undefined ) fixture.file( path.replace( /^html\//, 'html-mobile/' ), options.mobile );
			if ( options.sections !== undefined ) {
				entry.sections = `sections/${ slug }.json`;
				fixture.json( entry.sections as string, options.sections );
			}
			entries = { ...entries, [ new URL( route, sourceUrl ).href ]: entry };
			return fixture.manifest( { version: 1, entries } );
		},
		resource( url: string, body: string | NodeJS.ArrayBufferView, contentType: string, path = `resources/captured/${ Object.keys( resources ).length }` ) {
			fixture.file( path, body );
			resources[ url ] = { path, contentType };
			return fixture.json( 'resources/manifest.json', { version: 1, resources, failures: [] } );
		},
		media( url: string, path: string, body: string | NodeJS.ArrayBufferView, media = MediaStubStore.load( outputDir ) ) {
			fixture.file( path, body );
			media.markSuccess( url, join( outputDir, path ) );
			media.flush();
			return fixture;
		},
	};
	return fixture;
}
