import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WebsiteInventory, inventoryWalks } from './website-inventory.js';
import { exportWebsiteCapture } from './capture-export.js';
import { measureWebsite } from './export-total-budget.js';

const roots: string[] = [];
function fixture(): string {
	mkdirSync( '.tmp-test', { recursive: true } );
	const root = mkdtempSync( '.tmp-test/website-inventory-' );
	roots.push( root );
	return root;
}
afterEach( () => { for ( const root of roots.splice( 0 ) ) rmSync( root, { recursive: true, force: true } ); } );

it( 'takes exactly one website inventory walk through the public export entry point for six routes', () => {
	const outputDir = fixture();
	mkdirSync( join( outputDir, 'html' ) );
	mkdirSync( join( outputDir, 'screenshots' ) );
	const sourceUrl = 'https://example.test/';
	const header = `<header>${ 'Shared brand '.repeat( 100 ) }</header>`;
	const entries = Object.fromEntries( Array.from( { length: 6 }, ( _, index ) => {
		const html = `html/${ index }.html`;
		writeFileSync( join( outputDir, html ), `<html><body>${ header }<main><h1>Page ${ index }</h1><p id="yui_${ index }_1">Text</p></main></body></html>` );
		return [ index ? `${ sourceUrl }page-${ index }/` : sourceUrl, { html } ];
	} ) );
	writeFileSync( join( outputDir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries } ) );
	const before = inventoryWalks();
	const receipt = JSON.parse( readFileSync( exportWebsiteCapture( { outputDir, sourceUrl, platform: 'generic', summary: {}, failures: [] } ), 'utf8' ) );
	expect( inventoryWalks() - before ).toBe( 1 );
	expect( receipt.routes ).toHaveLength( 6 );
	const measured = measureWebsite( join( outputDir, 'website' ) );
	expect( receipt.exportBudget.totalBytes ).toBe( measured.totalBytes );
	expect( receipt.exportBudget.files ).toBe( measured.files.length );
	expect( measured.files.some( file => file.path.startsWith( 'parts/' ) ) ).toBe( true );
} );

it( 'sorts files, retains traversal order, and refreshes additions, sizes and removals without walking', () => {
	const root = fixture();
	mkdirSync( join( root, 'a' ) );
	writeFileSync( join( root, 'a/child.txt' ), 'child' );
	writeFileSync( join( root, 'z.txt' ), 'z' );
	const before = inventoryWalks();
	const inventory = new WebsiteInventory( root );
	expect( inventory.files ).toEqual( [ { path: 'a/child.txt', bytes: 5, isSymlink: false }, { path: 'z.txt', bytes: 1, isSymlink: false } ] );
	expect( inventory.textReferences()?.map( file => file.text ) ).toEqual( [ 'z', 'child' ] );
	writeFileSync( join( root, 'z.txt' ), 'changed' );
	inventory.add( 'z.txt' );
	writeFileSync( join( root, 'new.css' ), 'css' );
	inventory.add( 'new.css' );
	rmSync( join( root, 'a/child.txt' ) );
	inventory.remove( 'a/child.txt' );
	expect( measureWebsite( root, inventory ) ).toEqual( { files: [ { path: 'new.css', bytes: 3 }, { path: 'z.txt', bytes: 7 } ], totalBytes: 10 } );
	expect( inventoryWalks() - before ).toBe( 1 );
} );

it( 'refuses a reference audit containing any symlink, even a non-text or directory link', () => {
	const root = fixture();
	mkdirSync( join( root, 'dir' ) );
	writeFileSync( join( root, 'dir/file.txt' ), 'text' );
	symlinkSync( 'dir', join( root, 'link' ) );
	const inventory = new WebsiteInventory( root );
	expect( inventory.files.find( file => file.path === 'link' )?.isSymlink ).toBe( true );
	expect( inventory.textReferences() ).toBeNull();
	expect( measureWebsite( root, inventory ).files ).toEqual( [ { path: 'dir/file.txt', bytes: 4 } ] );
} );

it( 'refuses incomplete and over-limit reference audits', () => {
	const root = fixture();
	expect( new WebsiteInventory( join( root, 'missing' ) ).textReferences() ).toBeNull();
	writeFileSync( join( root, 'large.txt' ), '' );
	truncateSync( join( root, 'large.txt' ), 32 * 1024 * 1024 + 1 );
	expect( new WebsiteInventory( root ).textReferences() ).toBeNull();
} );
