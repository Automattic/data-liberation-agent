import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { exportWebsiteCapture } from './capture-export.js';
import { checkSelfConsistency } from './fidelity/self-consistency.js';
import { serveCapture } from './serve-capture.js';

it( 'reconciles a single-document named alias while preserving linked author CSS and independent anchors', async () => {
	const root = join( process.cwd(), '.tmp-test' ); mkdirSync( root, { recursive: true } );
	const outputDir = mkdtempSync( join( root, 'single-alias-' ) );
	try {
		for ( const dir of [ 'html', 'screenshots', 'resources' ] ) mkdirSync( join( outputDir, dir ) );
		writeFileSync( join( outputDir, 'html/home.html' ), '<html><head><link rel="stylesheet" href="https://example.com/style.css"></head><body><a href="#comments">Comments</a><main id="comments"><a name="comments">Alias</a></main><a name="standalone">Independent</a></body></html>' );
		writeFileSync( join( outputDir, 'resources/style.css' ), 'a[name="comments"]{color:rgb(255,0,0);display:block}' );
		writeFileSync( join( outputDir, 'resources/manifest.json' ), JSON.stringify( { version: 1, resources: { 'https://example.com/style.css': { path: 'resources/style.css', contentType: 'text/css' } }, failures: [] } ) );
		writeFileSync( join( outputDir, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { 'https://example.com/': { html: 'html/home.html' } } } ) );
		exportWebsiteCapture( { outputDir, sourceUrl: 'https://example.com/', platform: 'generic', summary: {}, failures: [] } );
		const $ = cheerio.load( readFileSync( join( outputDir, 'website/index.html' ), 'utf8' ) );
		expect( $( '[id="comments"],a[name="comments"]' ) ).toHaveLength( 1 );
		expect( $( 'a[data-dla-anchor-alias="comments"]' ) ).toHaveLength( 1 );
		expect( $( 'a[name="standalone"]' ) ).toHaveLength( 1 );
		expect( checkSelfConsistency( join( outputDir, 'website' ), new Map( [ [ '/', 'index.html' ] ] ) ).findings.filter( finding => finding.kind === 'anchor-ambiguous' ) ).toEqual( [] );
		const server = await serveCapture( outputDir );
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage(); await page.goto( server.url, { waitUntil: 'load' } );
			expect( await page.locator( 'a[data-dla-anchor-alias="comments"]' ).evaluate( element => getComputedStyle( element ).color ) ).toBe( 'rgb(255, 0, 0)' );
		} finally { await browser.close(); await server.close(); }
	} finally { rmSync( outputDir, { recursive: true, force: true } ); }
} );
