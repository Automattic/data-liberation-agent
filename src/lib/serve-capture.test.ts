import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { serveCapture } from '../index.js';

describe( 'public capture preview', () => {
	it( 'serves owned nested routes and assets and closes its HTTP lifecycle', async () => {
		const root = mkdtempSync( join( tmpdir(), 'dla-public-preview-' ) );
		mkdirSync( join( root, 'website', 'about' ), { recursive: true } );
		writeFileSync( join( root, 'capture-receipt.json' ), JSON.stringify( { websiteRoot: 'website', source: { url: 'https://fixture.example/' }, routes: [ { url: 'https://fixture.example/', path: 'website/index.html' }, { url: 'https://fixture.example/about/', path: 'website/about/index.html' } ] } ) );
		writeFileSync( join( root, 'website', 'index.html' ), '<h1>Owned home</h1>' );
		writeFileSync( join( root, 'website', 'about', 'index.html' ), '<h1>Owned about</h1>' );
		writeFileSync( join( root, 'website', 'site.css' ), 'h1{color:blue}' );
		const server = await serveCapture( root );
		try {
			expect( await ( await fetch( server.url ) ).text() ).toContain( 'Owned home' );
			expect( await ( await fetch( `${ server.url }/about/` ) ).text() ).toContain( 'Owned about' );
			const css = await fetch( `${ server.url }/site.css` );
			expect( css.headers.get( 'content-type' ) ).toContain( 'text/css' );
			expect( await css.text() ).toBe( 'h1{color:blue}' );
			expect( ( await fetch( `${ server.url }/missing.html` ) ).status ).toBe( 404 );
		} finally {
			await server.close();
			rmSync( root, { recursive: true, force: true } );
		}
		await expect( fetch( server.url ) ).rejects.toThrow();
	} );
} );
