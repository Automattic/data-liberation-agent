import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, expect, it } from 'vitest';
import { captureSitePreview } from './site-preview.js';
import { extractSharedChrome } from './shared-chrome.js';
import { readResolvedPage } from './site-includes.js';
import { startStaticServer } from './replicate/local-site/static-server.js';

const root = join( process.cwd(), '.tmp-test', 'site-preview' );
afterEach( () => rmSync( root, { recursive: true, force: true } ) );

it( 'renders a portable homepage preview at 1200x900 with local assets', async () => {
	mkdirSync( root, { recursive: true } );
	writeFileSync( join( root, 'index.html' ), '<!doctype html><link rel="stylesheet" href="style.css"><h1>Portable homepage</h1>' );
	writeFileSync( join( root, 'style.css' ), 'body{background:rgb(20,40,60)}' );
	const preview = await captureSitePreview( root );
	const png = PNG.sync.read( readFileSync( join( root, 'site-preview.png' ) ) );
	expect( [ png.width, png.height ] ).toEqual( [ 1200, 900 ] );
	expect( Array.from( png.data.subarray( png.data.length - 4 ) ) ).toEqual( [ 20, 40, 60, 255 ] );
	expect( preview.origin ).toBe( 'portable_render' );
}, 45_000 );

it( 'shares editable brand content across route-current header variants', async () => {
	mkdirSync( root, { recursive: true } );
	const brand = `<div class="brand"><h2>Shared studio heading</h2><p>${ 'Studio identity '.repeat( 40 ) }</p></div>`;
	const paths = Array.from( { length: 8 }, ( _, index ) => `route-${ index }.html` );
	const originals = paths.map( ( path, index ) => `<!doctype html><html><body><header>${ brand }<nav><a href="/${ path }" aria-current="page" class="route-${ index } active">Route ${ index }<span class="underline"></span></a></nav></header><main>Unique ${ index }</main><footer>Footer ${ index }</footer></body></html>` );
	paths.forEach( ( path, index ) => writeFileSync( join( root, path ), originals[ index ] ) );
	extractSharedChrome( root, paths );
	paths.forEach( ( path, index ) => expect( readResolvedPage( root, join( root, path ) ) ).toBe( originals[ index ] ) );
	const parts = readdirSync( join( root, 'parts' ) );
	const owners = parts.filter( path => readFileSync( join( root, 'parts', path ), 'utf8' ).includes( 'Shared studio heading' ) );
	expect( owners ).toHaveLength( 1 );
	const owner = join( root, 'parts', owners[ 0 ] );
	writeFileSync( owner, readFileSync( owner, 'utf8' ).replace( 'Shared studio heading', 'Edited studio heading' ) );
	const server = await startStaticServer( root );
	try {
		for ( const [ index, path ] of paths.entries() ) {
			const html = await ( await fetch( `${ server.url }/${ path }` ) ).text();
			expect( html ).toContain( 'Edited studio heading' );
			expect( html ).toContain( `class="route-${ index } active"` );
			expect( html ).toContain( `<main>Unique ${ index }</main>` );
		}
	} finally { await server.close(); }
} );

it( 'renders identical browser pixels before and after sharing both landmarks', async () => {
	mkdirSync( root, { recursive: true } );
	const header = `<header style="background:rgb(90,120,150);height:100px">${ 'Brand '.repeat( 100 ) }</header>`;
	const footer = `<footer style="background:rgb(150,120,90);height:100px">${ 'Copyright '.repeat( 100 ) }</footer>`;
	for ( const [ i, path ] of [ 'index.html', 'about.html' ].entries() ) writeFileSync( join( root, path ), `<!doctype html><html><body><div>${ header }<main>Route ${ i }</main>${ footer }</div></body></html>` );
	await captureSitePreview( root );
	const before = readFileSync( join( root, 'site-preview.png' ) );
	extractSharedChrome( root, [ 'index.html', 'about.html' ] );
	expect( readFileSync( join( root, 'index.html' ), 'utf8' ).match( /<!--#include/g ) ).toHaveLength( 2 );
	await captureSitePreview( root );
	expect( readFileSync( join( root, 'site-preview.png' ) ).equals( before ) ).toBe( true );
}, 45_000 );
