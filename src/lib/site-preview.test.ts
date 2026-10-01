import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, expect, it } from 'vitest';
import { captureSitePreview } from './site-preview.js';

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
