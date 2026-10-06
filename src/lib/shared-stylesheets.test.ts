import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { expect, it } from 'vitest';
import { capturedStyleHoistContext, materializeSharedStylesheets } from './shared-stylesheets.js';

it( 'localizes and deduplicates shared CSS while preserving media, source restrictions and cascade positions in private staged pages', () => {
	const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
	const root = mkdtempSync( join( parent, 'shared-stylesheet-stage-' ) );
	try {
		const websiteDir = join( root, 'website' ); mkdirSync( websiteDir );
		const css = '.tile{background:url("https://cdn.test/image.png")}';
		const localized = '.tile{background:url("/media/image.png")}';
		const hash = createHash( 'sha256' ).update( localized ).digest( 'hex' );
		const source = `<html><head><style id="runtime">${ css }</style><style media="print">${ css }</style><style>.relative{background:url('./image.png')}</style><style data-dla-geometry>.geometry{width:50vw}</style></head><body><main>Content</main></body></html>`;
		const staged = source.replace( "url('./image.png')", "url('/media/image.png')" );
		const sourcePath = join( root, 'source.html' ); writeFileSync( sourcePath, source );
		const entries = [ 'a', 'b' ].map( name => {
			const htmlPath = join( root, `${ name }.html` ); writeFileSync( htmlPath, staged );
			return { url: `https://example.test/${ name }/`, htmlPath, styleHoistContext: capturedStyleHoistContext( source ) };
		} );
		const mediaReplacements = new Map( [ [ 'https://cdn.test/image.png', '/media/image.png' ] ] );
		const result = materializeSharedStylesheets( { entries, websiteDir, sourceUrl: 'https://example.test/', mediaReplacements, resourceReplacements: new Map(), rejectedReplacementKeys: new Set() } );
		expect( result.assets ).toEqual( [ { sourceUrl: `https://example.test/#inline-style-${ hash }`, path: `website/assets/css/capture-${ hash }.css` } ] );
		expect( result.servedPaths ).toEqual( [ `/assets/css/capture-${ hash }.css`, `/assets/css/capture-${ hash }.css` ] );
		expect( readdirSync( join( websiteDir, 'assets/css' ) ) ).toEqual( [ `capture-${ hash }.css` ] );
		expect( readFileSync( join( websiteDir, 'assets/css', `capture-${ hash }.css` ), 'utf8' ) ).toBe( localized );
		for ( const entry of entries ) {
			const $ = cheerio.load( readFileSync( entry.htmlPath, 'utf8' ) );
			expect( $( 'head' ).children().map( ( _, node ) => node.tagName ).get() ).toEqual( [ 'link', 'link', 'style', 'style' ] );
			expect( $( 'link' ).eq( 0 ).attr( 'media' ) ).toBeUndefined();
			expect( $( 'link' ).eq( 1 ).attr( 'media' ) ).toBe( 'print' );
			expect( $( 'style' ).eq( 0 ).html() ).toBe( ".relative{background:url('/media/image.png')}" );
			expect( $( 'style[data-dla-geometry]' ).html() ).toBe( '.geometry{width:50vw}' );
		}
		expect( result.diagnostics.diagnosticCounts ).toEqual( { relative_css_url: 2, unsafe_attributes: 2 } );
		expect( result.diagnostics.hoistedStylesheets ).toBe( 1 );
		expect( readFileSync( sourcePath, 'utf8' ) ).toBe( source );
		expect( [ ...mediaReplacements ] ).toEqual( [ [ 'https://cdn.test/image.png', '/media/image.png' ] ] );
	} finally { rmSync( root, { recursive: true, force: true } ); }
} );
