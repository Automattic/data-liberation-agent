import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportWebsiteCapture } from './capture-export.js';
import { buildSourceFindings } from './source-findings.js';
import { isUsableCapture, missingRoutes } from './capture-usability.js';
import { DEFAULT_MAX_FILE_BYTES, validateMaxFileBytes } from './export-file-limit.js';
import { MediaStubStore } from './resume-state/index.js';

const SOURCE = 'https://example.com/';
const VIDEO = 'https://example.com/media/clip.mp4';
const POSTER = 'https://cdn.example/poster.png';

const dirs: string[] = [];
afterEach( () => {
	for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } );
} );

function websiteFiles( dir: string ): string[] {
	return readdirSync( dir, { withFileTypes: true } ).flatMap( entry =>
		entry.isDirectory() ? websiteFiles( join( dir, entry.name ) ) : [ join( dir, entry.name ) ] );
}

/**
 * A two-route capture: the homepage references a captured 4 KiB video (page
 * resource) and a 3 KiB poster (media stub); `/about` is a plain page whose
 * HTML can be padded past a limit.
 */
function fixture( aboutBytes = 0 ): string {
	const outputDir = mkdtempSync( join( tmpdir(), 'liberation-file-limit-' ) );
	dirs.push( outputDir );
	for ( const path of [ 'html', 'resources/media', 'media', 'screenshots' ] ) mkdirSync( join( outputDir, path ), { recursive: true } );
	writeFileSync( join( outputDir, 'html/homepage.html' ), `<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1><video src="${ VIDEO }" muted></video><img src="${ POSTER }" alt="Poster"><a href="/about">About</a></body></html>` );
	writeFileSync( join( outputDir, 'html/about.html' ), `<!doctype html><html><head><title>About</title></head><body><h1>About</h1><p>${ 'x'.repeat( aboutBytes ) }</p></body></html>` );
	writeFileSync( join( outputDir, 'resources/media/clip.mp4' ), Buffer.alloc( 4096, 1 ) );
	writeFileSync( join( outputDir, 'media/poster.png' ), Buffer.alloc( 3072, 2 ) );
	writeFileSync( join( outputDir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: {
		[ SOURCE ]: { html: 'html/homepage.html' },
		'https://example.com/about': { html: 'html/about.html' },
	} } ) );
	writeFileSync( join( outputDir, 'resources/manifest.json' ), JSON.stringify( { version: 1, failures: [], resources: {
		[ VIDEO ]: { path: 'resources/media/clip.mp4', contentType: 'video/mp4' },
	} } ) );
	const media = MediaStubStore.load( outputDir );
	media.markSuccess( POSTER, join( outputDir, 'media/poster.png' ) );
	media.flush();
	return outputDir;
}

const summary = { routesDiscovered: 2, routesCaptured: 2, routesSkipped: 0, routesFailed: 0, routesOmitted: 0 };

function receiptOf( outputDir: string ) {
	return JSON.parse( readFileSync( join( outputDir, 'capture-receipt.json' ), 'utf8' ) ) as {
		discoveryDiagnostics: Array< { code: string; url: string; unit?: string; metrics?: Record< string, number > } >;
		summary: { routesCaptured: number; routesFailed: number; complete: boolean };
		routes: Array< { url: string } >;
	};
}

describe( 'export per-file limit (maxFileBytes)', () => {
	it( 'defaults to the importer per-file intake limit and validates overrides', () => {
		expect( DEFAULT_MAX_FILE_BYTES ).toBe( 52_428_800 );
		expect( () => validateMaxFileBytes( undefined ) ).not.toThrow();
		for ( const invalid of [ 0, -1, 1.5, Number.NaN, '1' ] ) expect( () => validateMaxFileBytes( invalid ) ).toThrow( RangeError );
	} );

	it( 'leaves output unchanged by default: assets under the limit are written', () => {
		const outputDir = fixture();
		exportWebsiteCapture( { outputDir, sourceUrl: SOURCE, platform: 'generic', summary, failures: [] } );
		const files = websiteFiles( join( outputDir, 'website' ) );
		expect( files.some( file => file.endsWith( '.mp4' ) ) ).toBe( true );
		expect( files.some( file => file.endsWith( '.png' ) ) ).toBe( true );
		expect( receiptOf( outputDir ).discoveryDiagnostics.some( row => row.code === 'asset_exceeds_file_limit' ) ).toBe( false );
	} );

	it( 'does not write an oversized asset, leaves its references unresolved, records the finding and keeps the page', () => {
		const outputDir = fixture();
		const limit = 2048;
		exportWebsiteCapture( { outputDir, sourceUrl: SOURCE, platform: 'generic', summary, failures: [], limits: { maxFileBytes: limit } } );

		const websiteDir = join( outputDir, 'website' );
		const files = websiteFiles( websiteDir );
		expect( files.filter( file => /\.(?:mp4|png)$/.test( file ) ) ).toEqual( [] );
		expect( files.every( file => statSync( file ).size <= limit || /\.html$/.test( file ) ) ).toBe( true );
		const home = readFileSync( join( websiteDir, 'index.html' ), 'utf8' );
		expect( home ).toContain( '<h1>Home</h1>' );
		// Unresolved like any missing asset: an uncaptured video keeps its source
		// URL, an unlocalized image becomes the transparent placeholder.
		expect( home ).toContain( `<video src="${ VIDEO }"` );
		expect( home ).not.toContain( POSTER );
		expect( home ).toContain( 'src="data:image/gif;base64,' );
		const diagnostics = JSON.parse( readFileSync( join( outputDir, 'diagnostics.json' ), 'utf8' ) ) as {
			unresolvedDependencies: Array< { url: string; error: string } >;
			unresolvedMedia: Array< { url: string; error: string } >;
		};
		expect( diagnostics.unresolvedDependencies ).toContainEqual( { url: VIDEO, sourceUrl: SOURCE, error: `captured dependency is 4096 bytes, over the ${ limit }-byte per-file export limit` } );
		expect( diagnostics.unresolvedMedia ).toContainEqual( { url: POSTER, error: 'removed because media exceeds the per-file export limit' } );

		const receipt = receiptOf( outputDir );
		expect( receipt.routes.map( route => route.url ) ).toEqual( [ SOURCE, 'https://example.com/about' ] );
		const rows = receipt.discoveryDiagnostics.filter( row => row.code === 'asset_exceeds_file_limit' );
		expect( rows ).toEqual( expect.arrayContaining( [
			expect.objectContaining( { url: VIDEO, unit: 'asset', severity: 'warning', metrics: { bytes: 4096, limit } } ),
			expect.objectContaining( { url: POSTER, unit: 'asset', severity: 'warning', metrics: { bytes: 3072, limit } } ),
		] ) );
		expect( rows ).toHaveLength( 2 );
		// An asset loss neither drops a route nor makes the capture incomplete.
		expect( receipt.summary ).toMatchObject( { routesCaptured: 2, routesFailed: 0, complete: true } );

		const findings = buildSourceFindings( { complete: true, entrypointCaptured: true, summary, unresolvedAnchors: [], discoveryDiagnostics: receipt.discoveryDiagnostics as never } );
		// Sorted by URL, so the same capture writes the same bytes.
		expect( findings.findings.filter( finding => finding.code === 'asset_exceeds_file_limit' ) ).toEqual( [
			expect.objectContaining( { location: { url: POSTER }, unit: 'asset', loss_class: 'omitted_unit', metrics: { bytes: 3072, limit } } ),
			expect.objectContaining( { location: { url: VIDEO }, unit: 'asset', loss_class: 'omitted_unit', metrics: { bytes: 4096, limit } } ),
		] );
		expect( findings.usable ).toBe( true );
	} );

	it( 'fails a page document over the limit as route_export_failed and keeps the rest', () => {
		const outputDir = fixture( 64 * 1024 );
		const limit = 32 * 1024;
		exportWebsiteCapture( { outputDir, sourceUrl: SOURCE, platform: 'generic', summary, failures: [], limits: { maxFileBytes: limit } } );

		const receipt = receiptOf( outputDir );
		expect( receipt.routes.map( route => route.url ) ).toEqual( [ SOURCE ] );
		expect( missingRoutes( receipt.discoveryDiagnostics ) ).toEqual( [ {
			url: 'https://example.com/about', code: 'route_export_failed',
			reason: expect.stringContaining( `over the ${ limit }-byte per-file export limit` ),
		} ] );
		expect( receipt.summary ).toMatchObject( { routesCaptured: 1, routesFailed: 1, complete: false } );
		expect( existsSync( join( outputDir, 'website', 'index.html' ) ) ).toBe( true );
		expect( isUsableCapture( { complete: false, entrypointCaptured: true, missingRoutes: missingRoutes( receipt.discoveryDiagnostics ), summary } ) ).toBe( true );
	} );
} );
