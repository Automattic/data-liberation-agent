import { createHash } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { observeRuntimeRegions } from './runtime-regions.js';

let browser: Browser;
const source = 'https://example.test/article';
beforeAll( async () => { browser = await chromium.launch(); } );
afterAll( async () => { await browser?.close(); } );
async function fixture( html: string, run: ( page: Page ) => Promise<void> ) {
	const page = await browser.newPage( { viewport: { width: 390, height: 900 } } );
	try {
		await page.route( '**/*', route => route.fulfill( { contentType: 'text/html', body: route.request().url().startsWith( 'https://child.test/' ) ? '<html><body><button>Sign in</button><p>Child editorial content</p></body></html>' : html } ) );
		await page.goto( source, { waitUntil: 'load' } );
		await run( page );
	} finally { await page.close(); }
}

describe( 'bounded runtime-region evidence', () => {
	it( 'observes real runtime-mounted cross-origin child DOM without mutating or claiming projection', async () => {
		await fixture( '<main><div id="widget"></div><script>document.getElementById("widget").innerHTML=\'<h2>Followers</h2><iframe src="https://child.test/frame" style="height:104px;width:100%"></iframe>\';</script></main>', async page => {
			const before = await page.content();
			const report = await observeRuntimeRegions( page, source, [ { selector: '#widget', reason: 'Runtime mount' }, { selector: '#widget iframe', reason: 'Child document' }, { selector: '#absent', reason: 'Missing' } ] );
			expect( await page.content() ).toBe( before );
			expect( report.viewport ).toEqual( { width: 390, height: 900 } );
			expect( report.regions.map( region => region.status ) ).toEqual( [ 'observed', 'observed', 'missing' ] );
			const node = report.regions[ 0 ]!.nodes[ 0 ]!;
			expect( node.sha256 ).toBe( createHash( 'sha256' ).update( node.html! ).digest( 'hex' ) );
			expect( node.frames[ 0 ]!.html ).toContain( 'Child editorial content' );
			expect( node.frames[ 0 ]!.url ).toBe( 'https://child.test/frame' );
			expect( report.regions[ 1 ]!.nodes[ 0 ]!.box.height ).toBe( 108 );
			expect( report.verification ).toEqual( { rendering: 'unverified', interactions: 'unverified', projection: 'not_materialized' } );
		} );
	} );

	it( 'reports blank child documents, excessive HTML and excessive matches rather than promoting partial evidence', async () => {
		await fixture( `<div id="empty"><iframe></iframe></div><div id="large">${ 'x'.repeat( 270000 ) }</div>${ '<span class="many">Node</span>'.repeat( 17 ) }`, async page => {
			const report = await observeRuntimeRegions( page, source, [ { selector: '#empty', reason: 'Blank frame' }, { selector: '#large', reason: 'Large' }, { selector: '.many', reason: 'Many' } ] );
			expect( report.regions.every( region => region.status === 'partial' ) ).toBe( true );
			expect( report.regions[ 0 ]!.nodes[ 0 ]!.frames[ 0 ]!.error ).toContain( 'not initialized' );
			expect( report.regions[ 1 ]!.nodes[ 0 ]!.html ).toBeUndefined();
			expect( report.regions[ 2 ]!.nodes ).toHaveLength( 16 );
		} );
	} );

	it( 'isolates invalid selectors and rejects route drift', async () => {
		await fixture( '<div id="valid">Content</div>', async page => {
			const report = await observeRuntimeRegions( page, source, [ { selector: '[invalid', reason: 'Invalid' }, { selector: '#valid', reason: 'Valid' } ] );
			expect( report.regions.map( region => region.status ) ).toEqual( [ 'failed', 'observed' ] );
			await page.evaluate( () => history.replaceState( {}, '', '/different' ) );
			await expect( observeRuntimeRegions( page, source, [] ) ).rejects.toThrow( 'route drift' );
		} );
	} );

	it( 'bounds child document enumeration and byte counts for multibyte content', async () => {
		await fixture( `<div id="frames">${ '<iframe src="https://child.test/frame"></iframe>'.repeat( 17 ) }</div><div id="unicode">${ '界'.repeat( 100000 ) }</div>`, async page => {
			const report = await observeRuntimeRegions( page, source, [ { selector: '#frames', reason: 'Many frames' }, { selector: '#unicode', reason: 'Multibyte content' } ] );
			expect( report.regions[ 0 ]!.status ).toBe( 'partial' );
			expect( report.regions[ 0 ]!.nodes[ 0 ]!.frames ).toHaveLength( 16 );
			expect( report.regions[ 1 ]!.status ).toBe( 'partial' );
			expect( report.regions[ 1 ]!.nodes[ 0 ]!.html ).toBeUndefined();
		} );
	} );
} );
