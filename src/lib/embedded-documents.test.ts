import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { observeRuntimeRegions } from './runtime-regions.js';
import { stageRuntimeRegions } from './embedded-documents.js';
import { materializeHttpDocuments } from './http-materialization.js';
import { serveCapture } from './serve-capture.js';

let browser: Browser;
const dirs: string[] = [];
const tempRoot = join( process.cwd(), '.tmp-test' );
const sourceUrl = 'https://parent.test/article/';
const sha = ( html: string ) => createHash( 'sha256' ).update( html ).digest( 'hex' );
beforeAll( async () => { mkdirSync( tempRoot, { recursive: true } ); browser = await chromium.launch(); } );
afterAll( async () => { await browser?.close(); } );
afterEach( () => { for ( const path of dirs.splice( 0 ) ) rmSync( path, { recursive: true, force: true } ); } );

async function fixture( border = '0', width = 768 ) {
	const outputDir = mkdtempSync( join( tempRoot, 'dla-embedded-' ) ); dirs.push( outputDir );
	mkdirSync( join( outputDir, 'source-documents' ) );
	const prepared = '<html><head><title>Article</title></head><body><div id="host"></div><div id="legacy"><a name="legacy"></a></div></body></html>';
	writeFileSync( join( outputDir, 'source-documents/article.html' ), prepared );
	writeFileSync( join( outputDir, 'http-acquisition.json' ), JSON.stringify( { schema: 'data-liberation/http-acquisition/v1', sourceUrl, documents: [ { url: sourceUrl, variant: 'desktop', status: 'acquired', documentPath: 'source-documents/article.html', documentContentType: 'text/html; charset=utf-8', documentSha256: sha( prepared ), browserRegions: [ { selector: '#host', reason: 'Runtime child' } ] } ] } ) );
	const page = await browser.newPage( { viewport: { width, height: 900 } } );
	await page.route( '**/*', route => route.fulfill( { contentType: 'text/html', body: route.request().url().startsWith( 'https://child.test/' )
		? '<html><head><base href="https://cdn.test/"><link rel="stylesheet" href="style.css"></head><body><p>Child text</p><button onclick="alert(1)">Action</button><script>window.provider=true</script></body></html>'
		: `<html><body style="margin:8px"><div id="host"><iframe id="editor" src="https://child.test/editor?view=${ width }" width="100%" height="${ width < 768 ? 104 : 86 }" frameborder="${ border }"></iframe></div></body></html>` } ) );
	await page.goto( sourceUrl, { waitUntil: 'load' } );
	const observation = await observeRuntimeRegions( page, sourceUrl, [ { selector: '#host', reason: 'Runtime child' } ] );
	await page.close();
	const fetch = async ( url: string ) => ( { finalUrl: url, status: 200, headers: new Headers( { 'content-type': 'text/css' } ), body: Buffer.from( 'body{margin:0;color:rgb(255,0,0)}' ) } );
	const stage = () => stageRuntimeRegions( { outputDir, attachments: [ { variant: 'desktop', observation } ] }, { fetch } );
	const run = () => materializeHttpDocuments( { outputDir, sourceUrl, platform: 'generic', desktopVariant: 'desktop', embeddedDocuments: true } );
	return { outputDir, observation, stage, run };
}

describe( 'observed embedded document export', () => {
	it( 'localizes a runtime-mounted cross-origin child and its base-relative CSS through shared export', async () => {
		const { outputDir, stage, run } = await fixture();
		await stage();
		const receipt = JSON.parse( readFileSync( run(), 'utf8' ) );
		expect( receipt.summary.complete ).toBe( false );
		expect( receipt.embeddedDocuments.verification.interactions ).toBe( 'unverified' );
		const html = readFileSync( join( outputDir, 'website/index.html' ), 'utf8' );
		expect( html ).toContain( '<iframe' );
		expect( html ).toContain( 'width="100%"' );
		expect( html ).not.toContain( 'https://child.test/' );
		const server = await serveCapture( outputDir );
		const page = await browser.newPage( { viewport: { width: 390, height: 900 } } );
		const external: string[] = [];
		try {
			await page.route( '**/*', route => { if ( new URL( route.request().url() ).origin !== new URL( server.url ).origin ) { external.push( route.request().url() ); return route.abort(); } return route.continue(); } );
			await page.goto( server.url, { waitUntil: 'load' } );
			const frame = page.frames()[ 1 ]!;
			expect( await frame.locator( 'p' ).innerText() ).toBe( 'Child text' );
			expect( await frame.locator( 'p' ).evaluate( node => getComputedStyle( node ).color ) ).toBe( 'rgb(255, 0, 0)' );
			expect( await frame.evaluate( () => 'provider' in window ) ).toBe( false );
			expect( await frame.locator( 'button' ).getAttribute( 'onclick' ) ).toBeNull();
			expect( external ).toEqual( [] );
			expect( ( await page.locator( 'iframe' ).boundingBox() )!.height ).toBe( 86 );
		} finally { await page.close(); await server.close(); }
	} );

	it( 'rejects modified child bytes and stale parent identities before replacing the candidate', async () => {
		const { outputDir, stage, run } = await fixture();
		await stage();
		mkdirSync( join( outputDir, 'website' ) );
		writeFileSync( join( outputDir, 'website/index.html' ), 'Preserve candidate' );
		const path = join( outputDir, 'embedded-documents.json' );
		const receipt = JSON.parse( readFileSync( path, 'utf8' ) );
		receipt.regions[ 0 ].documentSha256 = '0'.repeat( 64 );
		writeFileSync( path, JSON.stringify( receipt ) );
		expect( run ).toThrow( 'hash mismatch' );
		expect( readFileSync( join( outputDir, 'website/index.html' ), 'utf8' ) ).toBe( 'Preserve candidate' );
		await stage();
		const doc = Object.values( JSON.parse( readFileSync( path, 'utf8' ) ).documents )[ 0 ] as { path: string };
		writeFileSync( join( outputDir, doc.path ), 'Changed child' );
		expect( run ).toThrow( 'mismatch' );
		expect( readFileSync( join( outputDir, 'website/index.html' ), 'utf8' ) ).toBe( 'Preserve candidate' );
	} );

	it( 'preserves authored border geometry without adding border thickness twice', async () => {
		const { outputDir, observation, stage, run } = await fixture( '1' );
		await stage(); run();
		const server = await serveCapture( outputDir );
		const page = await browser.newPage();
		try {
			await page.goto( server.url, { waitUntil: 'load' } );
			expect( ( await page.locator( 'iframe' ).boundingBox() )!.height ).toBe( observation.regions[ 0 ]!.nodes[ 0 ]!.frames[ 0 ]!.box!.height );
		} finally { await page.close(); await server.close(); }
	} );

	it( 'rejects ambiguous viewport selection and child file symlinks', async () => {
		const { outputDir, observation, stage, run } = await fixture();
		await expect( stageRuntimeRegions( { outputDir, attachments: [ { variant: 'desktop', observation }, { variant: 'desktop', observation } ] } ) ).rejects.toThrow( 'explicit selection' );
		await stage();
		const receiptPath = join( outputDir, 'embedded-documents.json' );
		const receipt = JSON.parse( readFileSync( receiptPath, 'utf8' ) );
		const external = mkdtempSync( join( tempRoot, 'dla-embedded-outside-' ) ); dirs.push( external );
		writeFileSync( join( external, 'child.html' ), 'Outside' );
		symlinkSync( join( external, 'child.html' ), join( outputDir, 'embedded-documents/linked.html' ) );
		const doc = Object.values( receipt.documents )[ 0 ] as { path: string };
		doc.path = 'embedded-documents/linked.html';
		writeFileSync( receiptPath, JSON.stringify( receipt ) );
		expect( run ).toThrow( 'containment mismatch' );
	} );

	it( 'preserves child presentation variants when parent documents are structurally equivalent', async () => {
		const desktop = await fixture();
		const mobile = await fixture( '0', 390 );
		const acquisitionPath = join( desktop.outputDir, 'http-acquisition.json' );
		const acquisition = JSON.parse( readFileSync( acquisitionPath, 'utf8' ) );
		acquisition.documents.push( { ...acquisition.documents[ 0 ], variant: 'mobile' } );
		writeFileSync( acquisitionPath, JSON.stringify( acquisition ) );
		await stageRuntimeRegions( { outputDir: desktop.outputDir, attachments: [ { variant: 'desktop', observation: desktop.observation }, { variant: 'mobile', observation: mobile.observation } ] }, { fetch: async url => ( { finalUrl: url, status: 200, headers: new Headers( { 'content-type': 'text/css' } ), body: Buffer.from( '<!--\nbody{margin:0}body::before{content:"<!--"}\n-->' ) } ) } );
		materializeHttpDocuments( { outputDir: desktop.outputDir, sourceUrl, platform: 'generic', desktopVariant: 'desktop', mobileVariant: 'mobile', embeddedDocuments: true } );
		const server = await serveCapture( desktop.outputDir );
		try {
			for ( const [ width, height ] of [ [ 390, 104 ], [ 768, 86 ], [ 1440, 86 ] ] ) {
				const page = await browser.newPage( { viewport: { width: width!, height: 900 } } );
				try {
					await page.goto( server.url, { waitUntil: 'load' } );
					expect( await page.locator( 'iframe:visible' ).count() ).toBe( 1 );
					expect( ( await page.locator( 'iframe:visible' ).boundingBox() )!.height ).toBe( height );
					expect( await page.frameLocator( 'iframe:visible' ).locator( 'body' ).evaluate( node => getComputedStyle( node, '::before' ).content ) ).toBe( '"<!--"' );
				} finally { await page.close(); }
			}
		} finally { await server.close(); }
	} );
} );
