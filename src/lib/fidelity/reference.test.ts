import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { captureScreenshots } from '../screenshot/screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { cleanupPolicy } from '../source-cleanup.js';
import { checkFidelity, observePage } from './check.js';
import { createReferenceCollector, type FidelityReference } from './reference.js';
import { matchRenderedImages } from './score.js';

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'capture-session reference replay', () => {
	it( 'measures the declared resting disclosure state without expanding it during frozen observation', async () => {
		const browser = await chromium.launch();
		const page = await browser.newPage();
		try {
			await page.setContent('<button aria-expanded="false" aria-controls="answer">Neutral baseline question</button><div id="answer" hidden>Only visible after activation</div><script>const button=document.querySelector("button");button.onclick=()=>{const open=button.getAttribute("aria-expanded")==="false";button.setAttribute("aria-expanded",String(open));document.getElementById("answer").hidden=!open;};</script>');
			const observation = await observePage(page, 'http://fixture.invalid/', 390, 0, null, undefined, undefined, true);
			expect(await page.locator('button').getAttribute('aria-expanded')).toBe('false');
			expect(observation.textChars).toBe('Neutral baseline question'.length);
		} finally { await browser.close(); }
	}, 30_000);
	it( 'freezes a mutating neutral source, attributes geometry to each stage, and refuses incomplete evidence', async () => {
		const parent = join( process.cwd(), '.tmp-test' );
		mkdirSync( parent, { recursive: true } );
		const directory = mkdtempSync( join( parent, 'frozen-reference-' ) );
		let mutated = false;
		let requests = 0;
		const png = new PNG( { width: 80, height: 80 } );
		for ( let i = 0; i < png.data.length; i += 4 ) { png.data[i] = ( i / 4 ) % 80 * 3; png.data[i+1] = 70; png.data[i+2] = 180; png.data[i+3] = 255; }
		const image = PNG.sync.write( png );
		const source = createServer( ( request, response ) => {
			requests++;
			if ( request.url?.endsWith( '.png' ) ) { response.setHeader( 'content-type', 'image/png' ); response.end( image ); return; }
			response.setHeader( 'content-type', 'text/html' );
			response.end( `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Observed recommendations</title><style>body{margin:0;font:16px Arial}img{display:block;width:60vw;max-width:400px;height:auto}</style></head><body><main><h1>Recommendations</h1><p>${ mutated ? 'Beta then Alpha' : 'Alpha then Beta' }</p><img alt="normal product" src="/product.png"><nav><a href="#details">Details</a></nav><section id="details">Product details</section></main><footer class="credit">Powered by fixture</footer></body></html>` );
		} );
		await new Promise<void>( resolve => source.listen( 0, '127.0.0.1', resolve ) );
		const origin = `http://127.0.0.1:${ ( source.address() as { port: number } ).port }`;
		const url = `${ origin }/shop/product/`;
		const collector = createReferenceCollector( directory, url, [ url ] );
		let candidate: ReturnType<typeof createServer> | undefined;
		try {
			const captured = await captureScreenshots( { urls: [ url ], primaryUrl: url, outputDir: directory, concurrency: 1, settleMs: 100, learnFluid: false,
				cleanupPolicy: cleanupPolicy( [ { id: 'fixture-credit', category: 'source-attribution', selector: '.credit' } ] ), observeSource: collector.observe } );
			expect( captured.failed ).toBe( 0 );
			const receiptPath = exportWebsiteCapture( { outputDir: directory, sourceUrl: url, platform: 'default', summary: { routesDiscovered: 1, routesCaptured: 1, routesSkipped: 0, routesFailed: 0, durationMs: captured.durationMs }, failures: [], discoveryDiagnostics: [] } );
			const manifestPath = collector.finalize( receiptPath );
			const manifestBytes = readFileSync( manifestPath, 'utf8' );
			const manifest = JSON.parse( manifestBytes ) as FidelityReference;
			expect( manifest.entries.map( entry => entry.viewport ).sort( ( a, b ) => a - b ) ).toEqual( [ 390, 768, 1440 ] );
			expect( manifest.entries.every( entry => entry.readiness.ready && entry.screenshot && entry.document ) ).toBe( true );
			for ( const entry of manifest.entries ) {
				expect( entry.route ).toBe( '/' );
				expect( PNG.sync.read( readFileSync( join( directory, entry.screenshot!.path ) ) ).width ).toBe( entry.viewport );
			}
			mutated = true;
			const before = requests;
			const options = { directory, settleMs: 100 };
			const first = await checkFidelity( options );
			expect( first.pass, JSON.stringify( first ) ).toBe( true );
			const second = await checkFidelity( options );
			expect( second.scores ).toEqual( first.scores );
			expect( first.scores.every( score => score.stage === 'capture' && score.state === 'baseline' && score.source.images.length === 1 ) ).toBe( true );
			expect( first.scores.every( score => score.source.typography!.some( text => text.key === 'Alpha then Beta' ) ) ).toBe( true );
			expect( requests ).toBe( before );
			const artifactPath = join( directory, 'website', 'index.html' );
			const artifact = readFileSync( artifactPath, 'utf8' );
			writeFileSync( artifactPath, artifact.replace( '</head>', '<style>img{width:120px!important}</style></head>' ) );
			const brokenCapture = await checkFidelity( options );
			expect( brokenCapture.status ).toBe( 'failed' );
			expect( brokenCapture.scores.some( score => score.stage === 'capture' && score.failures.some( failure => /image/.test( failure ) ) ) ).toBe( true );
			const staleBaseline = await checkFidelity( { ...options, candidateUrl: origin } );
			expect( staleBaseline.status ).toBe( 'unproven' );
			expect( staleBaseline.pending!.every( item => item.stage === 'materialization' && /digest mismatch/.test( item.reason ) ) ).toBe( true );
			writeFileSync( artifactPath, artifact );
			candidate = createServer( ( request, response ) => {
				response.setHeader( 'content-type', request.url?.endsWith( '.png' ) ? 'image/png' : 'text/html' );
				response.end( request.url?.endsWith( '.png' ) ? image : artifact.replace( '</head>', '<style>img{width:120px!important}</style></head>' ) );
			} );
			await new Promise<void>( resolve => candidate!.listen( 0, '127.0.0.1', resolve ) );
			const materialization = await checkFidelity( { ...options, candidateUrl: `http://127.0.0.1:${ ( candidate.address() as { port: number } ).port }` } );
			expect( materialization.status ).toBe( 'failed' );
			expect( materialization.scores.some( score => score.stage === 'materialization' && ! score.pass ) ).toBe( true );
			expect( requests ).toBe( before );
			for ( const change of [
				( value: FidelityReference ) => { value.entries = value.entries.filter( entry => entry.viewport !== 768 ); },
				( value: FidelityReference ) => { value.entries.push( structuredClone( value.entries[0]! ) ); },
				( value: FidelityReference ) => { value.receipt.sha256 = 'stale'; },
				( value: FidelityReference ) => { value.entries[0]!.observation!.sha256 = 'changed'; },
				( value: FidelityReference ) => { value.scope.sourceUrls.push( `${ origin }/missing/` ); },
				( value: FidelityReference ) => { value.entries[0]!.readiness.ready = false; },
			] ) {
				const value = JSON.parse( manifestBytes ) as FidelityReference;
				change( value ); writeFileSync( manifestPath, JSON.stringify( value ) );
				const report = await checkFidelity( options );
				expect( report.status ).toBe( 'unproven' ); expect( report.pass ).toBe( false ); expect( report.pending!.length ).toBeGreaterThan( 0 );
			}
			writeFileSync( manifestPath, manifestBytes );
			const sourceDocument = join( directory, manifest.entries[0]!.document!.path );
			const documentBytes = readFileSync( sourceDocument );
			writeFileSync( sourceDocument, '<p>Changed source observation</p>' );
			expect( ( await checkFidelity( options ) ).status ).toBe( 'unproven' );
			writeFileSync( sourceDocument, documentBytes );
			const unsupported = await checkFidelity( { ...options, states: [ 'baseline', 'dialog', 'zoom', 'motion' ] } );
			expect( unsupported.status ).toBe( 'unproven' );
			expect( unsupported.pass ).toBe( false );
			for ( const state of [ 'dialog', 'zoom', 'motion' ] ) expect( unsupported.pending!.some( item => item.state === state ) ).toBe( true );
			unlinkSync( join( directory, manifest.entries[0]!.screenshot!.path ) );
			expect( ( await checkFidelity( options ) ).status ).toBe( 'unproven' );
			unlinkSync( manifestPath );
			expect( ( await checkFidelity( options ) ).status ).toBe( 'unproven' );
			expect( requests ).toBe( before );
		} finally {
			candidate?.closeAllConnections();
			if ( candidate ) await new Promise<void>( resolve => candidate!.close( () => resolve() ) );
			source.closeAllConnections(); await new Promise<void>( resolve => source.close( () => resolve() ) );
			rmSync( directory, { recursive: true, force: true } );
		}
	}, 300_000 );

	it( 'observes real normal/zoom occurrences and refuses correspondence after semantic roles are lost', async () => {
		const browser = await chromium.launch();
		const page = await browser.newPage();
		try {
			const src = 'data:image/svg+xml,' + encodeURIComponent( '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="blue"/></svg>' );
			const normal = `<figure aria-label="normal"><img alt="product" src="${ src }" width="200" height="200"></figure>`;
			const zoom = `<section role="region" aria-label="zoom"><img alt="product" src="${ src }" width="400" height="400"></section>`;
			await page.setContent( normal + zoom );
			const source = await observePage( page, 'about:blank', 1280, 0, null, undefined, undefined, true );
			await page.setContent( zoom.replaceAll( '="400"', '="200"' ) + normal.replaceAll( '="200"', '="400"' ) );
			const rewritten = await observePage( page, 'about:blank', 1280, 0, null, undefined, undefined, true );
			const pairs = matchRenderedImages( source.images, rewritten.images );
			expect( pairs ).toHaveLength( 2 );
			expect( pairs.every( pair => pair.source.role === pair.candidate.role && pair.source.width !== pair.candidate.width ) ).toBe( true );
			await page.setContent( `<div><img alt="product" src="${ src }" width="200" height="200"></div><div><img alt="product" src="${ src }" width="400" height="400"></div>` );
			const ambiguous = await observePage( page, 'about:blank', 1280, 0, null, undefined, undefined, true );
			expect( matchRenderedImages( source.images, ambiguous.images ) ).toEqual( [] );
		} finally { await browser.close(); }
	}, 30_000 );

	it( 'leaves source runtime failures unready even when the page can serialize', async () => {
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const directory = mkdtempSync( join( parent, 'reference-error-' ) );
		const server = createServer( ( _request, response ) => { response.setHeader( 'content-type', 'text/html' ); response.end( '<h1>Partially ready</h1><script>throw new Error("source application fatal")</script>' ); } );
		await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
		const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
		try {
			const collector = createReferenceCollector( directory, url, [ url ] );
			const captured = await captureScreenshots( { urls: [ url ], outputDir: directory, concurrency: 1, settleMs: 0, observeSource: collector.observe } );
			const receiptPath = exportWebsiteCapture( { outputDir: directory, sourceUrl: url, platform: 'default', summary: { routesDiscovered: 1, routesCaptured: 1, routesSkipped: 0, routesFailed: 0, durationMs: captured.durationMs }, failures: [], discoveryDiagnostics: [] } );
			const manifest = JSON.parse( readFileSync( collector.finalize( receiptPath ), 'utf8' ) ) as FidelityReference;
			expect( manifest.entries.every( entry => ! entry.readiness.ready && entry.readiness.reasons.some( reason => reason.includes( 'source application fatal' ) ) ) ).toBe( true );
			expect( ( await checkFidelity( { directory } ) ).status ).toBe( 'unproven' );
		} finally { server.closeAllConnections(); await new Promise<void>( resolve => server.close( () => resolve() ) ); rmSync( directory, { recursive: true, force: true } ); }
	}, 90_000 );
} );

it( 'never silently pairs normal/zoom duplicate media by geometry or index', () => {
	const normal = { key: 'product', contentHash: 'same', role: 'img:product/main:', x: 0, y: 0, width: 200, height: 200 };
	const zoom = { ...normal, role: 'img:product/dialog:zoom', width: 500, height: 500 };
	const candidate = [ { ...zoom, width: 200 }, { ...normal, width: 500 } ];
	expect( matchRenderedImages( [ normal, zoom ], candidate ).map( pair => pair.candidate.role ) ).toEqual( [ normal.role, zoom.role ] );
	expect( matchRenderedImages( [ { ...normal, role: undefined }, { ...zoom, role: undefined } ], candidate ) ).toEqual( [] );
} );
