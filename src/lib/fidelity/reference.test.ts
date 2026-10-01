import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { captureScreenshots } from '../screenshot/screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { applySourceCleanup, cleanupPolicy } from '../source-cleanup.js';
import { checkFidelity, observePage } from './check.js';
import { createReferenceCollector, type FidelityReference } from './reference.js';
import { matchRenderedImages } from './score.js';
import { waitForFonts } from '../screenshot/page-helpers.js';
import { squareFont } from './font-fixture.js';

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'capture-session reference replay', () => {
	it( 'replays source pixel density when measuring resolution-dependent content', async () => {
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const directory = mkdtempSync( join( parent, 'reference-pixel-density-' ) );
		const html = '<meta name="viewport" content="width=device-width,initial-scale=1"><style>h1{font-size:20px}@media(min-resolution:2dppx){h1{font-size:30px}}</style><h1>Density-dependent heading</h1>';
		mkdirSync( join( directory, 'website' ) );
		writeFileSync( join( directory, 'website', 'index.html' ), html );
		const browser = await chromium.launch();
		const page = await browser.newPage( { viewport: { width: 390, height: 900 }, deviceScaleFactor: 3 } );
		const url = 'http://fixture.invalid/';
		try {
			await page.route( url, route => route.fulfill( { contentType: 'text/html', body: html } ) );
			await page.goto( url ); await applySourceCleanup( page, cleanupPolicy() );
			const collector = createReferenceCollector( directory, url, [ url ] );
			await collector.observe( page, url, 'mobile' );
			const receipt = join( directory, 'capture-receipt.json' );
			writeFileSync( receipt, JSON.stringify( { source: { url }, websiteRoot: 'website', routes: [ { url, path: 'website/index.html' } ] } ) );
			collector.finalize( receipt );
			const report = await checkFidelity( { directory, stage: 'capture', widths: [ 390 ] } );
			expect( report.pending ).toEqual( [] );
			expect( report.scores[ 0 ]!.failures ).toEqual( [] );
			expect( report.pass ).toBe( true );
		} finally { await browser.close(); rmSync( directory, { recursive: true, force: true } ); }
	}, 30_000 );
	it( 'uses capture route identity for query/hash renditions while refusing path drift', async () => {
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const directory = mkdtempSync( join( parent, 'reference-route-identity-' ) );
		const browser = await chromium.launch();
		const page = await browser.newPage();
		const url = 'http://fixture.invalid/article/';
		try {
			for ( const [ destination, drift ] of [ [ '/article/?view=phone#content', false ], [ '/different/', true ] ] as const ) {
				await page.route( 'http://fixture.invalid/**', route => route.fulfill( { contentType: 'text/html', body:
					`<main id="content"><h1>Article</h1></main><script>history.replaceState(null,'',${ JSON.stringify( destination ) });</script>` } ) );
				await page.goto( url );
				await applySourceCleanup( page, cleanupPolicy() );
				const collector = createReferenceCollector( directory, url, [ url ] );
				await collector.observe( page, url, 'mobile' );
				const receipt = join( directory, 'receipt.json' ); writeFileSync( receipt, JSON.stringify( { routes: [] } ) );
				const manifest = JSON.parse( readFileSync( collector.finalize( receipt ), 'utf8' ) ) as FidelityReference;
				expect( manifest.entries[ 0 ]!.readiness.reasons.includes( 'source route drift' ) ).toBe( drift );
				if ( ! drift ) expect( manifest.entries[ 0 ]!.readiness.ready, manifest.entries[ 0 ]!.readiness.reasons.join( ', ' ) ).toBe( true );
				await page.unroute( 'http://fixture.invalid/**' );
			}
		} finally { await browser.close(); rmSync( directory, { recursive: true, force: true } ); }
	}, 30_000 );
	it( 'settles unused local fallback stacks at each frozen viewport', async () => {
		const parent = join(process.cwd(), '.tmp-test'); mkdirSync(parent, { recursive: true });
		const directory = mkdtempSync(join(parent, 'reference-fonts-'));
		const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		const url = 'http://fixture.invalid/';
		try {
			await page.route(url, route => route.fulfill({ contentType: 'text/html', body: `<style>
				@font-face{font-family:Primary;src:local("Arial"),local("Liberation Sans"),local("DejaVu Sans")}
				@font-face{font-family:"Local Fallback";src:local("Arial"),local("Liberation Sans"),local("DejaVu Sans")}
				@font-face{font-family:"Wide Fallback";src:local("Arial"),local("Liberation Sans"),local("DejaVu Sans")}
				@font-face{font-family:Unused;src:local("No Such Unpainted Font 505")}
				h1{font:normal 500 36px Primary,"Local Fallback",sans-serif}
				@media(min-width:1000px){h1{font-family:Primary,"Wide Fallback",sans-serif}}
				</style><h1>Neutral painted heading</h1><p hidden style="font-family:Unused">Hidden text</p>` }));
			await page.goto(url); await page.evaluate(() => document.fonts.ready);
			await applySourceCleanup(page, cleanupPolicy());
			expect(await page.evaluate(() => document.fonts.check('500 36px Primary'))).toBe(true);
			expect(await page.evaluate(() => document.fonts.check('500 36px Primary,"Wide Fallback",sans-serif'))).toBe(false);
			const collector = createReferenceCollector(directory, url, [url]);
			await collector.observe(page, url, 'desktop');
			await collector.observe(page, url, 'mobile');
			const receipt = join(directory, 'receipt.json'); writeFileSync(receipt, JSON.stringify({ routes: [] }));
			const manifest = JSON.parse(readFileSync(collector.finalize(receipt), 'utf8')) as FidelityReference;
			expect(manifest.entries.map(entry => entry.viewport)).toEqual([768, 1440, 390]);
			for (const entry of manifest.entries) {
				expect(entry.readiness.fontsReady, entry.readiness.reasons.join(', ')).toBe(true);
				expect(entry.readiness.ready, entry.readiness.reasons.join(', ')).toBe(true);
				const observation = JSON.parse(readFileSync(join(directory, entry.observation!.path), 'utf8'));
				expect(observation.typography).toEqual([expect.objectContaining({ key: 'Neutral painted heading', loaded: true })]);
				expect(PNG.sync.read(readFileSync(join(directory, entry.screenshot!.path))).width).toBe(entry.viewport);
			}
			expect(await page.evaluate(() => [...document.fonts].find(font => font.family === 'Unused')?.status)).toBe('unloaded');
		} finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
	}, 60_000);

	it( 'waits for a delayed declared stack before baseline screenshot and measurement', async () => {
		const browser = await chromium.launch(); const page = await browser.newPage();
		let requests = 0;
		try {
			await page.route('http://fixture.invalid/delayed.ttf', async route => {
				requests++; await new Promise(resolve => setTimeout(resolve, 200));
				await route.fulfill({ contentType: 'font/ttf', body: squareFont });
			});
			await page.setContent('<style>@font-face{font-family:Delayed;src:url("http://fixture.invalid/delayed.ttf");font-display:swap}h1{font:40px sans-serif,Delayed}</style><h1>MMMM</h1>');
			await page.evaluate(() => document.fonts.ready);
			expect(requests).toBe(0); // Layout uses the generic family; the stack check still needs Delayed.
			const observation = await observePage(page, 'about:blank', 1280, 0, null, undefined, async () => {
				expect(await page.evaluate(() => [...document.fonts].map(font => font.status))).toEqual(['loaded']);
				await page.screenshot();
			}, true);
			expect(requests).toBe(1);
			expect(observation.typography![0]!.loaded).toBe(true);
			// The same loaded face becomes primary after resize: measure actual glyph advances.
			await page.addStyleTag({ content: '@media(max-width:600px){h1{font-family:Delayed,sans-serif}}' });
			await page.setViewportSize({ width: 390, height: 900 });
			const mobile = await observePage(page, 'about:blank', 390, 0, null, undefined, undefined, true);
			expect(mobile.typography![0]).toMatchObject({ loaded: true, advance: 160 });
		} finally { await browser.close(); }
	}, 30_000);

	it( 'settles a stack introduced by scroll restoration before baseline screenshot', async () => {
		const browser = await chromium.launch(); const page = await browser.newPage();
		try {
			await page.setContent(`<style>@font-face{font-family:Restored;src:local("Arial"),local("Liberation Sans"),local("DejaVu Sans")}p{font:20px sans-serif}</style>
				<p>Restored painted text</p><script>addEventListener('scroll',()=>{document.querySelector('p').style.fontFamily='sans-serif,Restored';},{once:true});</script>`);
			const observation = await observePage(page, 'about:blank', 1280, 0, null, undefined, async () => {
				expect(await page.evaluate(() => document.fonts.check('20px sans-serif,Restored'))).toBe(true);
				await page.screenshot();
			}, true);
			expect(observation.typography![0]).toMatchObject({ fontFamily: 'sans-serif, Restored', loaded: true });
		} finally { await browser.close(); }
	}, 30_000);

	it( 'keeps failed and unavailable fonts unready and bounds a pending font', async () => {
		const parent = join(process.cwd(), '.tmp-test'); mkdirSync(parent, { recursive: true });
		const directory = mkdtempSync(join(parent, 'reference-failed-fonts-'));
		const browser = await chromium.launch(); const page = await browser.newPage();
		try {
			await page.route('http://fixture.invalid/failed.ttf', route => route.fulfill({ status: 404, body: '' }));
			await page.setContent('<style>@font-face{font-family:Failed;src:url("http://fixture.invalid/failed.ttf")}@font-face{font-family:Unavailable;src:local("No Such Neutral Font 505")}p{font:20px Failed,Unavailable,sans-serif}</style><p>Still painted with fallback</p>');
			const observation = await observePage(page, 'about:blank', 1280, 0, null, undefined, undefined, true);
			expect(observation.typography![0]!.loaded).toBe(false);
			expect(await page.evaluate(() => [...document.fonts].map(font => font.status))).toEqual(['error', 'error']);
			await applySourceCleanup(page, cleanupPolicy());
			const collector = createReferenceCollector(directory, 'about:blank', ['about:blank']);
			await collector.observe(page, 'about:blank', 'desktop');
			const receipt = join(directory, 'receipt.json'); writeFileSync(receipt, JSON.stringify({ routes: [] }));
			const manifest = JSON.parse(readFileSync(collector.finalize(receipt), 'utf8')) as FidelityReference;
			expect(manifest.entries.every(entry => !entry.readiness.ready && entry.readiness.fontsReady === false && entry.readiness.reasons.includes('source fonts pending or failed'))).toBe(true);
			await page.route('http://fixture.invalid/pending.ttf', () => {});
			await page.setContent('<style>@font-face{font-family:Pending;src:url("http://fixture.invalid/pending.ttf");font-display:swap}p{font:20px sans-serif,Pending}</style><p>Pending fallback</p>');
			const started = Date.now(); await waitForFonts(page, 100);
			expect(Date.now() - started).toBeLessThan(2_000);
			expect(await page.evaluate(() => [...document.fonts].map(font => font.status))).toEqual(['loading']);
			expect(await page.evaluate(() => document.fonts.check('20px sans-serif,Pending'))).toBe(false);
		} finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
	}, 30_000);
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
	it( 'counts painted labels without a zero-font decorative glyph, retaining visible plus signs', async () => {
		const browser = await chromium.launch(); const page = await browser.newPage();
		try {
			await page.setContent('<p>Visible + sum</p><button>Neutral + question<span aria-hidden="true" style="font-size:0;display:inline-block;width:18px;height:18px;background:blue">+</span></button>');
			const observation = await observePage(page, 'http://fixture.invalid/', 390, 0, null, undefined, undefined, true);
			expect(observation.textChars).toBe('Visible + sum Neutral + question'.length);
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
