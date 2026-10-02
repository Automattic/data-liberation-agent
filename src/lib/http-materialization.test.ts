import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeHttpDocuments } from './http-materialization.js';
import type { AcquiredHttpDocument } from './http-acquisition.js';

const dirs: string[] = [];
const sourceUrl = 'https://example.test/';
afterEach( () => { for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } ); } );

function fixture() {
	const outputDir = mkdtempSync( join( tmpdir(), 'dla-http-materialization-' ) ); dirs.push( outputDir );
	mkdirSync( join( outputDir, 'source-documents' ) );
	mkdirSync( join( outputDir, 'resources' ) );
	const documents: AcquiredHttpDocument[] = [];
	for ( const [ index, url ] of [ sourceUrl, `${ sourceUrl }article/` ].entries() ) for ( const variant of [ 'desktop', 'mobile' ] ) {
		const html = `<html><head><link rel="stylesheet" href="https://cdn.example.test/site.css"></head><body><main><h1>${ index ? 'Article' : 'Home' }</h1><a href="${ sourceUrl }article/">Read article</a><img src="https://cdn.example.test/photo.png"><iframe id="editor"></iframe></main></body></html>`;
		const documentPath = `source-documents/${ index }-${ variant }.html`;
		writeFileSync( join( outputDir, documentPath ), html );
		documents.push( { url, variant, status: 'acquired', documentPath, documentSha256: createHash( 'sha256' ).update( html ).digest( 'hex' ), documentContentType: 'text/html; charset=utf-8', attempts: 1, durationMs: 1, browserRegions: [ { selector: '#editor', reason: 'Requires runtime observation' } ] } );
	}
	writeFileSync( join( outputDir, 'resources/site.css' ), 'main{color:red;background:url("https://cdn.example.test/photo.png")}' );
	writeFileSync( join( outputDir, 'resources/photo.png' ), Buffer.from( [ 1, 2, 3 ] ) );
	writeFileSync( join( outputDir, 'resources/manifest.json' ), JSON.stringify( { version: 1, resources: {
		'https://cdn.example.test/site.css': { path: 'resources/site.css', contentType: 'text/css' },
		'https://cdn.example.test/photo.png': { path: 'resources/photo.png', contentType: 'image/png' },
	}, failures: [] } ) );
	const save = () => writeFileSync( join( outputDir, 'http-acquisition.json' ), JSON.stringify( { schema: 'data-liberation/http-acquisition/v1', sourceUrl, documents } ) );
	save();
	return { outputDir, documents, save, run: () => materializeHttpDocuments( { outputDir, sourceUrl, platform: 'generic', desktopVariant: 'desktop', mobileVariant: 'mobile' } ) };
}

describe( 'HTTP review materialization', () => {
	it( 'localizes routes and shared dependencies without inventing browser evidence', () => {
		const { outputDir, run } = fixture();
		const receipt = JSON.parse( readFileSync( run(), 'utf8' ) );
		const home = readFileSync( join( outputDir, 'website/index.html' ), 'utf8' );
		const article = readFileSync( join( outputDir, 'website/article/index.html' ), 'utf8' );
		expect( home ).toContain( '/article/' );
		expect( article ).toContain( 'Article' );
		expect( home ).not.toContain( 'https://cdn.example.test/' );
		expect( receipt.assets ).toHaveLength( 2 );
		const css = receipt.assets.find( ( asset: { sourceUrl: string } ) => asset.sourceUrl.endsWith( '.css' ) );
		expect( readFileSync( join( outputDir, css.path ), 'utf8' ) ).not.toContain( 'https://cdn.example.test/' );
		expect( receipt.summary.complete ).toBe( false );
		expect( receipt.sourceProfile.geometry ).toBe( 'unverified' );
		expect( receipt.acquisition ).toMatchObject( { kind: 'http', path: 'http-acquisition.json', verification: { rendering: 'unverified', interactions: 'unverified', geometry: 'unverified' } } );
		expect( receipt.discoveryDiagnostics.filter( ( row: { code: string } ) => row.code === 'http_browser_region_unobserved' ) ).toHaveLength( 4 );
		expect( receipt.cleanup ).toBeUndefined();
		expect( existsSync( join( outputDir, 'screenshots/manifest.json' ) ) ).toBe( false );
		expect( existsSync( join( outputDir, 'layout-geometry-proof.json' ) ) ).toBe( false );
	} );

	it( 'retains failed and missing variants as diagnostics', () => {
		const { documents, save, run } = fixture();
		documents.splice( 3, 1 );
		documents[ 1 ] = { ...documents[ 1 ]!, status: 'browser_required', error: 'Canvas runtime' };
		save();
		const receipt = JSON.parse( readFileSync( run(), 'utf8' ) );
		expect( receipt.discoveryDiagnostics ).toEqual( expect.arrayContaining( [
			expect.objectContaining( { code: 'http_browser_required', url: sourceUrl, reason: 'mobile: Canvas runtime' } ),
			expect.objectContaining( { code: 'http_variant_missing', url: `${ sourceUrl }article/`, reason: 'mobile' } ),
		] ) );
		expect( receipt.summary.complete ).toBe( false );
	} );

	it.each( [ 'hash', 'symlink', 'variant', 'duplicate', 'browser-evidence' ] )( 'rejects invalid %s evidence before replacing existing candidate files', kind => {
		const { outputDir, documents, save, run } = fixture();
		mkdirSync( join( outputDir, 'website' ) );
		writeFileSync( join( outputDir, 'website/index.html' ), 'Preserve this candidate' );
		if ( kind === 'hash' ) documents[ 0 ]!.documentSha256 = '0'.repeat( 64 );
		if ( kind === 'variant' ) documents[ 0 ]!.variant = 'unmapped';
		if ( kind === 'duplicate' ) documents.push( documents[ 0 ]! );
		if ( kind === 'browser-evidence' ) writeFileSync( join( outputDir, 'fidelity-reference.json' ), '{}' );
		if ( kind === 'symlink' ) {
			const external = mkdtempSync( join( tmpdir(), 'dla-http-external-' ) ); dirs.push( external );
			writeFileSync( join( external, 'outside.html' ), 'external' );
			symlinkSync( join( external, 'outside.html' ), join( outputDir, 'source-documents/linked.html' ) );
			documents[ 0 ]!.documentPath = 'source-documents/linked.html';
		}
		save();
		expect( run ).toThrow();
		expect( readFileSync( join( outputDir, 'website/index.html' ), 'utf8' ) ).toBe( 'Preserve this candidate' );
	} );
} );
