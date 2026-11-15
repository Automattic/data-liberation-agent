import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { exportWebsiteCapture } from './capture-export.js';
import { startStaticServer } from './replicate/local-site/static-server.js';

it( 'loads rebased CSS offline without stale integrity and retains unchanged integrity', async () => {
	mkdirSync( '.tmp-test', { recursive: true } );
	const directory = mkdtempSync( '.tmp-test/resource-integrity-' );
	const source = 'https://source.example/';
	const css = 'body { color: rgb(12, 34, 56); font-family: sans-serif; background-image: url(https://source.example/pixel.svg) }';
	const unchanged = 'body { padding-top: 7px }';
	const integrity = ( text: string ) => `sha384-${ createHash( 'sha384' ).update( text ).digest( 'base64' ) }`;
	for ( const name of [ 'html', 'screenshots', 'resources' ] ) mkdirSync( join( directory, name ) );
	const html = `<!doctype html><html><head><link id="changed" rel="stylesheet" href="${ source }site.css" integrity="${ integrity( css ) }"><link id="unchanged" rel="stylesheet" href="${ source }unchanged.css" integrity="${ integrity( unchanged ) }"></head><body>Offline styling</body></html>`;
	writeFileSync( join( directory, 'html/home.html' ), html );
	writeFileSync( join( directory, 'screenshots/manifest.json' ), JSON.stringify( { version: 1, entries: { [ source ]: { html: 'html/home.html' } } } ) );
	const resources = Object.fromEntries( [ [ 'site.css', css, 'text/css' ], [ 'unchanged.css', unchanged, 'text/css' ], [ 'pixel.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', 'image/svg+xml' ] ].map( ( [ name, bytes, contentType ] ) => {
		writeFileSync( join( directory, 'resources', name ), bytes );
		return [ source + name, { path: `resources/${ name }`, contentType } ];
	} ) );
	writeFileSync( join( directory, 'resources/manifest.json' ), JSON.stringify( { version: 1, failures: [], resources } ) );
	let browser;
	let preview;
	try {
		exportWebsiteCapture( { outputDir: directory, sourceUrl: source, platform: 'generic', summary: {}, failures: [] } );
		preview = await startStaticServer( join( directory, 'website' ) );
		browser = await chromium.launch();
		const page = await browser.newPage();
		await page.route( '**/*', route => route.request().url().startsWith( preview!.url ) ? route.continue() : route.abort() );
		await page.goto( preview.url );
		expect( await page.locator( '#unchanged' ).getAttribute( 'integrity' ) ).toBe( integrity( unchanged ) );
		expect( await page.evaluate( () => ( document.querySelector( '#changed' ) as HTMLLinkElement ).sheet !== null ) ).toBe( true );
		expect( await page.locator( 'body' ).evaluate( element => getComputedStyle( element ).color ) ).toBe( 'rgb(12, 34, 56)' );
		expect( await page.locator( 'body' ).evaluate( element => getComputedStyle( element ).paddingTop ) ).toBe( '7px' );
		expect( readFileSync( join( directory, 'website/index.html' ), 'utf8' ) ).not.toContain( integrity( css ) );
	} finally {
		await browser?.close();
		await preview?.close();
		rmSync( directory, { recursive: true, force: true } );
	}
}, 30_000 );
