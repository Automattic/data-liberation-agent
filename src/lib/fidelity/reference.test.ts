import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices, type BrowserContext, type Page } from 'playwright';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { captureScreenshots } from '../screenshot/screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { applySourceCleanup, cleanupPolicy } from '../source-cleanup.js';
import { checkFidelity, observePage } from './check.js';
import { createReferenceCollector, readFrozenObservation, readReferenceArtifact, type FidelityReference } from './reference.js';
import { matchRenderedImages } from './score.js';
import { waitForFonts } from '../screenshot/page-helpers.js';
import { squareFont } from './font-fixture.js';

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'capture-session reference replay', () => {
	let sharedBrowser: Awaited< ReturnType< typeof chromium.launch > >;
	beforeAll( async () => { sharedBrowser = await chromium.launch(); } );
	afterAll( async () => { await sharedBrowser?.close(); }, 30_000 );
	it.each( [ 'profile', 'sibling', 'borrowed', 'persistent' ] as const )( 'releases only owned %s resources on success and navigation failure', async mode => {
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const directory = mkdtempSync( join( parent, `reference-lifetime-${ mode }-` ) );
		const html = '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:20px monospace}</style><h1>Neutral reference lifetime</h1>';
		let activeRequests = 0; let peakRequests = 0;
		const source = createServer( ( request, response ) => {
			activeRequests++; peakRequests = Math.max( peakRequests, activeRequests );
			setTimeout( () => {
				response.writeHead( request.url === '/failed' ? 500 : 200, { 'content-type': 'text/html' } );
				response.end( html ); activeRequests--;
			}, 100 );
		} );
		await new Promise<void>( resolve => source.listen( 0, '127.0.0.1', resolve ) );
		const url = `http://127.0.0.1:${ ( source.address() as { port: number } ).port }/`;
		const browser = await chromium.launch();
		const identity = { screen: { width: 1920, height: 1080 }, userAgent: 'NeutralReference/1', deviceScaleFactor: 1 };
		const persistent = mode === 'persistent' ? await chromium.launchPersistentContext( join( directory, 'browser' ), { headless: true } ) : undefined;
		const context = persistent ?? ( mode === 'borrowed' ? ( await browser.newPage() ).context() : await browser.newContext( identity ) );
		const page = context.pages()[ 0 ] ?? await context.newPage();
		const siblingAcquisitions = vi.spyOn( context, 'newPage' );
		const ownedContexts: BrowserContext[] = []; const ownedPages: Page[] = [];
		const newContext = browser.newContext.bind( browser );
		const contextAcquisitions = vi.spyOn( browser, 'newContext' ).mockImplementation( async options => {
			const cellContext = await newContext( options ); ownedContexts.push( cellContext );
			const newPage = cellContext.newPage.bind( cellContext );
			vi.spyOn( cellContext, 'newPage' ).mockImplementation( async () => {
				const cellPage = await newPage(); ownedPages.push( cellPage ); vi.spyOn( cellPage, 'close' ); return cellPage;
			} );
			vi.spyOn( cellContext, 'close' ); return cellContext;
		} );
		const collect = process.env.DLA_REFERENCE_BASELINE ? ( await import( process.env.DLA_REFERENCE_BASELINE ) ).createReferenceCollector as typeof createReferenceCollector : createReferenceCollector;
		const started = Date.now();
		try {
			await page.goto( url ); await page.evaluate( () => localStorage.setItem( 'visitor', 'source-session' ) );
			const observed: { width: number; screen: number; visitor: string | null }[] = [];
			const collector = collect( directory, url, [ url ], { prepareCapture: async cellPage => {
				observed.push( await cellPage.evaluate( () => ( { width: innerWidth, screen: screen.width, visitor: localStorage.getItem( 'visitor' ) } ) ) );
				if ( mode === 'profile' ) await cellPage.evaluate( () => localStorage.setItem( 'visitor', 'reference-cell' ) );
			} } );
			const profile = mode === 'profile' ? { id: 'desktop', width: 1440, height: 900, context: identity } : undefined;
			const addedListeners = vi.spyOn( page, 'on' ); const removedListeners = vi.spyOn( page, 'off' );
			await collector.observe( page, url, 'desktop', [], { isMobile: false, hasTouch: false }, profile );
			await collector.observe( page, `${ url }failed`, 'desktop', [], { isMobile: false, hasTouch: false }, profile );
			const receipt = join( directory, 'receipt.json' ); writeFileSync( receipt, JSON.stringify( { routes: [] } ) );
			const manifest = JSON.parse( readFileSync( collector.finalize( receipt ), 'utf8' ) ) as FidelityReference;
			const successes = manifest.entries.filter( entry => entry.sourceUrl === url );
			const failures = manifest.entries.filter( entry => entry.sourceUrl !== url );
			expect( manifest.scope.cells ).toHaveLength( 4 );
			expect( successes.map( entry => entry.viewport ) ).toEqual( [ 768, 1440 ] );
			for ( const entry of successes ) {
				expect( readFrozenObservation( directory, entry ).observation.textChars ).toBe( 'Neutral reference lifetime'.length );
				expect( readReferenceArtifact( directory, entry.document! ).toString() ).toContain( 'Neutral reference lifetime' );
			}
			for ( const entry of failures ) {
				expect( entry.readiness ).toMatchObject( { ready: false, reasons: [ 'Error: Reference navigation HTTP 500' ] } );
				expect( entry.document ).toBeUndefined();
				expect( () => readFrozenObservation( directory, entry ) ).toThrow( 'Source evidence unready' );
			}
			expect( observed.map( item => item.width ).sort( ( a, b ) => a - b ) ).toEqual( [ 768, 1440 ] );
			expect( observed.every( item => item.visitor === 'source-session' ) ).toBe( true );
			if ( mode === 'profile' ) {
				expect( observed.every( item => item.screen === identity.screen.width ) ).toBe( true );
				expect( successes.every( entry => entry.userAgent === identity.userAgent ) ).toBe( true );
				expect( new Set( ownedContexts ).size ).toBe( 4 );
				expect( await page.evaluate( () => localStorage.getItem( 'visitor' ) ) ).toBe( 'source-session' );
			}
			expect( page.isClosed() ).toBe( false );
			expect( context.pages() ).toEqual( [ page ] );
			for ( const event of [ 'pageerror', 'crash' ] ) expect( removedListeners.mock.calls.filter( call => call[ 0 ] === event ) ).toEqual( addedListeners.mock.calls.filter( call => call[ 0 ] === event ) );
			expect( browser.contexts() ).toEqual( persistent ? [] : [ context ] );
			expect( ownedPages.every( cellPage => cellPage.isClosed() ) ).toBe( true );
			if ( mode === 'borrowed' ) expect( peakRequests ).toBe( 1 );
			const counts = { siblingAcquisitions: siblingAcquisitions.mock.calls.length, contextAcquisitions: contextAcquisitions.mock.calls.length,
				pageCloses: ownedPages.reduce( ( count, cellPage ) => count + vi.mocked( cellPage.close ).mock.calls.length, 0 ),
				contextCloses: ownedContexts.reduce( ( count, cellContext ) => count + vi.mocked( cellContext.close ).mock.calls.length, 0 ) };
			if ( process.env.DLA_REFERENCE_EVIDENCE ) {
				const evidence = process.env.DLA_REFERENCE_EVIDENCE; mkdirSync( evidence, { recursive: true } );
				writeFileSync( join( evidence, `${ mode }.json` ), JSON.stringify( { mode, durationMs: Date.now() - started, counts, observed,
					entries: manifest.entries.map( entry => ( { viewport: entry.viewport, readiness: entry.readiness, context: entry.context,
						observation: entry.observation?.sha256, document: entry.document?.sha256, screenshot: entry.screenshot?.sha256 } ) ) }, null, 2 ) );
			}
			expect( counts ).toEqual( { siblingAcquisitions: mode === 'borrowed' || mode === 'profile' ? 2 : 6,
				contextAcquisitions: mode === 'profile' ? 4 : 0, pageCloses: 0, contextCloses: mode === 'profile' ? 4 : 0 } );
		} finally {
			vi.restoreAllMocks(); await persistent?.close(); await browser.close();
			source.closeAllConnections(); await new Promise<void>( resolve => source.close( () => resolve() ) );
			rmSync( directory, { recursive: true, force: true } );
		}
	}, 60_000 );
	it( 'accepts candidate-local canonical redirects using frozen evidence with the source stopped', async () => {
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const directory = mkdtempSync( join( parent, 'frozen-canonical-redirects-' ) );
		const html = '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Canonical navigation</title><h1>Canonical navigation</h1><a href="/category">Category</a>';
		let sourceRequests = 0;
		const source = createServer( ( _request, response ) => { sourceRequests++; response.setHeader( 'content-type', 'text/html' ); response.end( html ); } );
		await new Promise<void>( resolve => source.listen( 0, '127.0.0.1', resolve ) );
		const url = `http://127.0.0.1:${ ( source.address() as { port: number } ).port }/`;
		let terminalStatus = 200;
		let terminalLocation: string | undefined;
		const candidate = createServer( ( request, response ) => {
			if ( request.url === '/category' ) { response.writeHead( 301, { location: '/category/' } ); response.end(); return; }
			if ( request.url === '/category/' && terminalLocation ) { response.writeHead( 302, { location: terminalLocation } ); response.end(); return; }
			response.writeHead( request.url === '/category/' ? terminalStatus : 200, { 'content-type': 'text/html' } ); response.end( html );
		} );
		await new Promise<void>( resolve => candidate.listen( 0, '127.0.0.1', resolve ) );
		const candidateUrl = `http://127.0.0.1:${ ( candidate.address() as { port: number } ).port }`;
		const browser = sharedBrowser;
		try {
			mkdirSync( join( directory, 'website', 'category' ), { recursive: true } );
			writeFileSync( join( directory, 'website', 'index.html' ), html );
			writeFileSync( join( directory, 'website', 'category', 'index.html' ), html );
			const page = await browser.newPage();
			const collector = createReferenceCollector( directory, url, [ url ] );
			await collector.observe( page, url, 'desktop', [], { isMobile: false, hasTouch: false } );
			await collector.observe( page, url, 'mobile', [], { isMobile: false, hasTouch: false } );
			const receipt = join( directory, 'capture-receipt.json' );
			writeFileSync( receipt, JSON.stringify( { source: { url }, websiteRoot: 'website', routes: [ { url, path: 'website/index.html' } ] } ) );
			collector.finalize( receipt );
			source.closeAllConnections(); await new Promise<void>( resolve => source.close( () => resolve() ) );
			const report = await checkFidelity( { directory, candidateUrl, settleMs: 0 } );
			expect( report.pending ).toEqual( [] );
			expect( report.scores ).toHaveLength( 3 );
			expect( report.scores.flatMap( score => score.failures.filter( failure => failure.startsWith( 'nav ' ) ) ) ).toEqual( [] );
			expect( report.pass ).toBe( true );
			for ( const score of report.scores ) expect( score.liberated.internalRoutes ).toEqual( [ { path: '/category', status: 200, redirects: 1, outcome: 'reachable' } ] );
			// Resume the original origin with changed content. A local hop back to
			// it must fail without a single API request bypassing the browser guard.
			source.removeAllListeners( 'request' );
			source.on( 'request', ( _request, response ) => { sourceRequests++; response.end( '<h1>Changed source</h1>' ); } );
			await new Promise<void>( resolve => source.listen( Number( new URL( url ).port ), '127.0.0.1', resolve ) );
			const before = sourceRequests;
			terminalLocation = url;
			const blocked = await checkFidelity( { directory, candidateUrl, settleMs: 0, widths: [ 390 ] } );
			expect( blocked.pending ).toEqual( [] );
			expect( blocked.pass ).toBe( false );
			expect( blocked.scores[ 0 ]!.liberated.internalRoutes ).toEqual( [ { path: '/category', status: 302, redirects: 1, outcome: 'blocked-redirect' } ] );
			expect( sourceRequests ).toBe( before );
			terminalLocation = undefined;
			terminalStatus = 404;
			const missing = await checkFidelity( { directory, candidateUrl, settleMs: 0, widths: [ 390 ] } );
			expect( missing.scores[ 0 ]!.liberated.internalRoutes ).toEqual( [ { path: '/category', status: 404, redirects: 1, outcome: 'http-error' } ] );
			expect( missing.scores[ 0 ]!.failures.join( ' ' ) ).toContain( 'HTTP 404' );
			terminalStatus = 500;
			const failed = await checkFidelity( { directory, candidateUrl, settleMs: 0, widths: [ 390 ] } );
			expect( failed.pass ).toBe( false );
			for ( const score of failed.scores ) {
				expect( score.failures.filter( failure => failure.startsWith( 'nav ' ) ).join( ' ' ) ).toContain( 'HTTP 500' );
				expect( score.failures.join( ' ' ) ).not.toContain( '404' );
			}
		} finally {
			source.closeAllConnections(); source.close(); candidate.closeAllConnections();
			await new Promise<void>( resolve => candidate.close( () => resolve() ) ); rmSync( directory, { recursive: true, force: true } );
		}
	}, 90_000 );
	it( 'counts painted text through boxless wrappers while honoring real ancestor clipping', async () => {
		const browser = sharedBrowser;
		try {
			const page = await browser.newPage( { viewport: { width: 390, height: 900 } } );
			const text = 'Painted editorial text survives a boxless wrapper.';
			await page.setContent( `<div style="display:contents;overflow:hidden"><h1>${ text }</h1></div>` );
			const painted = await observePage( page, 'about:blank', 390, 0, null, undefined, undefined, true, true );
			expect( painted.textChars ).toBe( text.length );
			await page.setContent( `<div style="position:relative;width:100px;height:100px;overflow:hidden"><div style="display:contents;overflow:hidden"><p style="position:absolute;left:200px;width:200px">${ text }</p></div></div>` );
			const clipped = await observePage( page, 'about:blank', 390, 0, null, undefined, undefined, true, true );
			expect( clipped.textChars ).toBe( 0 );
		} finally { /* shared browser is closed after the suite */ }
	}, 30_000 );
	it( 'replays fixed-width mobile emulation and complete compositor frames', async () => {
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const directory = mkdtempSync( join( parent, 'reference-mobile-profile-' ) );
		const html = '<meta name="viewport" content="width=320,user-scalable=yes"><style>body{margin:0}h1{font:20px Arial}@media(pointer:coarse){h1{font-size:30px}}</style><h1>Mobile viewport heading</h1><div style="height:2000px"></div><img loading="lazy" src="/media.png" width="120" height="120">';
		mkdirSync( join( directory, 'website' ) );
		writeFileSync( join( directory, 'website', 'index.html' ), html );
		const media = PNG.sync.write( new PNG( { width: 120, height: 120 } ) );
		writeFileSync( join( directory, 'website', 'media.png' ), media );
		const browser = sharedBrowser;
		try {
			const { defaultBrowserType: _browserType, ...iphone } = devices[ 'iPhone 17' ];
			const context = await browser.newContext( iphone );
			const page = await context.newPage();
			const url = 'http://fixture.invalid/';
			await context.route( url, route => route.fulfill( { contentType: 'text/html', body: html } ) );
			await context.route( `${ url }media.png`, route => route.fulfill( { contentType: 'image/png', body: media } ) );
			const collector = createReferenceCollector( directory, url, [ url ] );
			await collector.observe( page, url, 'mobile', [], { isMobile: true, hasTouch: true } );
			const receipt = join( directory, 'capture-receipt.json' );
			writeFileSync( receipt, JSON.stringify( { source: { url }, websiteRoot: 'website', routes: [ { url, path: 'website/index.html' } ] } ) );
			const manifest = JSON.parse( readFileSync( collector.finalize( receipt ), 'utf8' ) ) as FidelityReference;
			expect( manifest.entries[ 0 ]!.readiness.ready, manifest.entries[ 0 ]!.readiness.reasons.join( ', ' ) ).toBe( true );
			const report = await checkFidelity( { directory, stage: 'capture', widths: [ 390 ], screenshots: true } );
			expect( report.pending ).toEqual( [] );
			expect( report.scores[ 0 ]!.failures ).toEqual( [] );
			expect( report.pass ).toBe( true );
			delete manifest.entries[ 0 ]!.browserProfile;
			writeFileSync( join( directory, 'fidelity-reference.json' ), JSON.stringify( manifest ) );
			const legacy = await checkFidelity( { directory, stage: 'capture', widths: [ 390 ] } );
			expect( legacy.pass ).toBe( false );
			expect( legacy.pending?.[ 0 ]!.reason ).toMatch( /browser profile unproven/ );
		} finally { rmSync( directory, { recursive: true, force: true } ); }
	}, 30_000 );
	it( 'replays source pixel density when measuring resolution-dependent content', async () => {
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const directory = mkdtempSync( join( parent, 'reference-pixel-density-' ) );
		const html = '<meta name="viewport" content="width=device-width,initial-scale=1"><style>h1{font-size:20px}@media(min-resolution:2dppx){h1{font-size:30px}}</style><h1>Density-dependent heading</h1>';
		mkdirSync( join( directory, 'website' ) );
		writeFileSync( join( directory, 'website', 'index.html' ), html );
		const browser = sharedBrowser;
		const page = await browser.newPage( { viewport: { width: 390, height: 900 }, deviceScaleFactor: 3 } );
		const url = 'http://fixture.invalid/';
		try {
			await page.route( url, route => route.fulfill( { contentType: 'text/html', body: html } ) );
			await page.goto( url ); await applySourceCleanup( page, cleanupPolicy() );
			const collector = createReferenceCollector( directory, url, [ url ] );
			await collector.observe( page, url, 'mobile', [], { isMobile: false, hasTouch: false } );
			const receipt = join( directory, 'capture-receipt.json' );
			writeFileSync( receipt, JSON.stringify( { source: { url }, websiteRoot: 'website', routes: [ { url, path: 'website/index.html' } ] } ) );
			collector.finalize( receipt );
			const report = await checkFidelity( { directory, stage: 'capture', widths: [ 390 ] } );
			expect( report.pending ).toEqual( [] );
			expect( report.scores[ 0 ]!.failures ).toEqual( [] );
			expect( report.pass ).toBe( true );
		} finally { rmSync( directory, { recursive: true, force: true } ); }
	}, 30_000 );
	it( 'uses capture route identity for query/hash renditions while refusing path drift', async () => {
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const directory = mkdtempSync( join( parent, 'reference-route-identity-' ) );
		const browser = sharedBrowser;
		const page = await browser.newPage();
		const url = 'http://fixture.invalid/article/';
		try {
			for ( const [ destination, drift ] of [ [ '/article/?view=phone#content', false ], [ '/different/', true ] ] as const ) {
				await page.route( 'http://fixture.invalid/**', route => route.fulfill( { contentType: 'text/html', body:
					`<main id="content"><h1>Article</h1></main><script>history.replaceState(null,'',${ JSON.stringify( destination ) });</script>` } ) );
				await page.goto( url );
				await applySourceCleanup( page, cleanupPolicy() );
				const collector = createReferenceCollector( directory, url, [ url ] );
				await collector.observe( page, url, 'mobile', [], { isMobile: false, hasTouch: false } );
				const receipt = join( directory, 'receipt.json' ); writeFileSync( receipt, JSON.stringify( { routes: [] } ) );
				const manifest = JSON.parse( readFileSync( collector.finalize( receipt ), 'utf8' ) ) as FidelityReference;
				expect( manifest.entries[ 0 ]!.readiness.reasons.includes( 'source route drift' ) ).toBe( drift );
				if ( ! drift ) expect( manifest.entries[ 0 ]!.readiness.ready, manifest.entries[ 0 ]!.readiness.reasons.join( ', ' ) ).toBe( true );
				await page.unroute( 'http://fixture.invalid/**' );
			}
		} finally { rmSync( directory, { recursive: true, force: true } ); }
	}, 30_000 );
	it( 'freezes a protocol-changing server redirect while rejecting subsequent client drift', async () => {
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const directory = mkdtempSync( join( parent, 'reference-protocol-redirect-' ) );
		const browser = sharedBrowser;
		const context = await browser.newContext();
		const page = await context.newPage();
		let drift = false;
		const server = createServer( ( _request, response ) => {
			response.writeHead( 200, { 'Content-Type': 'text/html' } );
			response.end( `<main><h1>Article</h1></main>${ drift ? '<script>history.replaceState(null,"","/different/")</script>' : '' }` );
		} );
		await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
		const host = `127.0.0.1:${ ( server.address() as { port: number } ).port }`;
		const url = `https://${ host }/article`;
		const destination = `http://${ host }/article/`;
		try {
			await context.route( url, route => route.fulfill( { status: 308, headers: { location: destination } } ) );
			for ( const shouldDrift of [ false, true ] ) {
				drift = shouldDrift;
				const collector = createReferenceCollector( directory, url, [ url ] );
				await collector.observe( page, url, 'desktop', [], { isMobile: false, hasTouch: false } );
				await collector.observe( page, url, 'mobile', [], { isMobile: false, hasTouch: false } );
				const receipt = join( directory, 'receipt.json' ); writeFileSync( receipt, JSON.stringify( { routes: [] } ) );
				const manifest = JSON.parse( readFileSync( collector.finalize( receipt ), 'utf8' ) ) as FidelityReference;
				expect( manifest.entries.map( entry => entry.viewport ) ).toEqual( [ 768, 1440, 390 ] );
				for ( const entry of manifest.entries ) {
					expect( entry.readiness.reasons.includes( 'source route drift' ) ).toBe( drift );
					if ( ! drift ) expect( entry.readiness.ready, entry.readiness.reasons.join( ', ' ) ).toBe( true );
				}
			}
		} finally { await new Promise<void>( resolve => server.close( () => resolve() ) ); rmSync( directory, { recursive: true, force: true } ); }
	}, 30_000 );
	it( 'settles unused local fallback stacks at each frozen viewport', async () => {
		const parent = join(process.cwd(), '.tmp-test'); mkdirSync(parent, { recursive: true });
		const directory = mkdtempSync(join(parent, 'reference-fonts-'));
		const browser = sharedBrowser; const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
			await collector.observe(page, url, 'desktop', [], { isMobile: false, hasTouch: false });
			await collector.observe(page, url, 'mobile', [], { isMobile: false, hasTouch: false });
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
		} finally { rmSync(directory, { recursive: true, force: true }); }
	}, 60_000);

	it( 'waits for a delayed declared stack before baseline screenshot and measurement', async () => {
		const browser = sharedBrowser; const page = await browser.newPage();
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
		} finally { /* shared browser is closed after the suite */ }
	}, 30_000);

	it( 'settles a stack introduced by scroll restoration before baseline screenshot', async () => {
		const browser = sharedBrowser; const page = await browser.newPage();
		try {
			await page.setContent(`<style>@font-face{font-family:Restored;src:local("Arial"),local("Liberation Sans"),local("DejaVu Sans")}p{font:20px sans-serif}</style>
				<p>Restored painted text</p><script>addEventListener('scroll',()=>{document.querySelector('p').style.fontFamily='sans-serif,Restored';},{once:true});</script>`);
			const observation = await observePage(page, 'about:blank', 1280, 0, null, undefined, async () => {
				expect(await page.evaluate(() => document.fonts.check('20px sans-serif,Restored'))).toBe(true);
				await page.screenshot();
			}, true);
			expect(observation.typography![0]).toMatchObject({ fontFamily: 'sans-serif, Restored', loaded: true });
		} finally { /* shared browser is closed after the suite */ }
	}, 30_000);
	it( 'keeps frozen baseline pose untouched while retaining the explicit scroll probe for drift', async () => {
		const browser = sharedBrowser; const page = await browser.newPage( { viewport: { width: 768, height: 700 } } );
		try {
			await page.setContent( `<style>header{height:100px}header.compact{height:60px}</style><header>Header</header><main style="height:2400px">Baseline content</main>
				<script>addEventListener('scroll',()=>document.querySelector('header').classList.add('compact'),{once:true})</script>` );
			await observePage( page, 'about:blank', 768, 0, 'http://fixture.invalid', undefined, undefined, true, true );
			expect( await page.locator( 'header' ).evaluate( element => getComputedStyle( element ).height ) ).toBe( '100px' );
			await observePage( page, 'about:blank', 768, 0, 'http://fixture.invalid', undefined, undefined, true );
			expect( await page.evaluate( () => scrollY ) ).toBe( 0 );
			expect( await page.locator( 'header' ).evaluate( element => getComputedStyle( element ).height ) ).toBe( '60px' );
		} finally { /* shared browser is closed after the suite */ }
	}, 30_000 );

	it( 'keeps failed and unavailable fonts unready and bounds a pending font', async () => {
		const parent = join(process.cwd(), '.tmp-test'); mkdirSync(parent, { recursive: true });
		const directory = mkdtempSync(join(parent, 'reference-failed-fonts-'));
		const browser = sharedBrowser; const page = await browser.newPage();
		try {
			await page.route('http://fixture.invalid/failed.ttf', route => route.fulfill({ status: 404, body: '' }));
			await page.setContent('<style>@font-face{font-family:Failed;src:url("http://fixture.invalid/failed.ttf")}@font-face{font-family:Unavailable;src:local("No Such Neutral Font 505")}p{font:20px Failed,Unavailable,sans-serif}</style><p>Still painted with fallback</p>');
			const observation = await observePage(page, 'about:blank', 1280, 0, null, undefined, undefined, true);
			expect(observation.typography![0]!.loaded).toBe(false);
			expect(await page.evaluate(() => [...document.fonts].map(font => font.status))).toEqual(['error', 'error']);
			await applySourceCleanup(page, cleanupPolicy());
			const collector = createReferenceCollector(directory, 'about:blank', ['about:blank']);
			await collector.observe(page, 'about:blank', 'desktop', [], { isMobile: false, hasTouch: false });
			const receipt = join(directory, 'receipt.json'); writeFileSync(receipt, JSON.stringify({ routes: [] }));
			const manifest = JSON.parse(readFileSync(collector.finalize(receipt), 'utf8')) as FidelityReference;
			expect(manifest.entries.every(entry => !entry.readiness.ready && entry.readiness.fontsReady === false && entry.readiness.reasons.includes('source fonts pending or failed'))).toBe(true);
			await page.route('http://fixture.invalid/pending.ttf', () => {});
			await page.setContent('<style>@font-face{font-family:Pending;src:url("http://fixture.invalid/pending.ttf");font-display:swap}p{font:20px sans-serif,Pending}</style><p>Pending fallback</p>');
			const started = Date.now(); await waitForFonts(page, 100);
			expect(Date.now() - started).toBeLessThan(2_000);
			expect(await page.evaluate(() => [...document.fonts].map(font => font.status))).toEqual(['loading']);
			expect(await page.evaluate(() => document.fonts.check('20px sans-serif,Pending'))).toBe(false);
		} finally { rmSync(directory, { recursive: true, force: true }); }
	}, 30_000);
	it( 'measures the declared resting disclosure state without expanding it during frozen observation', async () => {
		const browser = sharedBrowser;
		const page = await browser.newPage();
		try {
			await page.setContent('<button aria-expanded="false" aria-controls="answer">Neutral baseline question</button><div id="answer" hidden>Only visible after activation</div><script>const button=document.querySelector("button");button.onclick=()=>{const open=button.getAttribute("aria-expanded")==="false";button.setAttribute("aria-expanded",String(open));document.getElementById("answer").hidden=!open;};</script>');
			const observation = await observePage(page, 'http://fixture.invalid/', 390, 0, null, undefined, undefined, true);
			expect(await page.locator('button').getAttribute('aria-expanded')).toBe('false');
			expect(observation.textChars).toBe('Neutral baseline question'.length);
		} finally { /* shared browser is closed after the suite */ }
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
		const sourcePolicy = cleanupPolicy( [ { id: 'fixture-credit', category: 'source-attribution', selector: '.credit' } ] );
		const collector = createReferenceCollector( directory, url, [ url ], { cleanupPolicy: sourcePolicy } );
		let candidate: ReturnType<typeof createServer> | undefined;
		try {
			const captured = await captureScreenshots( { urls: [ url ], primaryUrl: url, outputDir: directory, concurrency: 1, settleMs: 100, learnFluid: false,
				cleanupPolicy: sourcePolicy, observeSource: collector.observe } );
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
		const browser = sharedBrowser;
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
		} finally { /* shared browser is closed after the suite */ }
	}, 30_000 );
	it( 'excludes overflow-clipped offstage copy while retaining repeated and below-fold text', async () => {
		const browser = sharedBrowser; const page = await browser.newPage( { viewport: { width: 390, height: 700 } } );
		try {
			const quote = 'The migration from Google Workspace to Microsoft 365 and Exchange Online went very well. Shaun did a wonderful job making it happen. We also moved from an on-prem phone system to Teams Phone and it is working out quite well.';
			const attribution = 'Luke Ervin - IT Director';
			const shared = '<p>Shared visible label</p><p>Shared visible label</p><div style="margin-top:1200px">Lower-page editorial content</div>';
			await page.setContent( `<style>body{margin:0}.track{width:240px;height:80px;overflow:hidden}.offstage{transform:translateX(300px)}</style>
				${ shared }<div class="track"><div class="offstage"><p>${ quote }</p><p>${ attribution }</p></div></div>` );
			const source = await observePage( page, 'about:blank', 390, 0, null, undefined, undefined, true, true );
			expect( await page.locator( '.offstage' ).textContent() ).toContain( attribution );
			await page.setContent( `<style>.track{width:240px;height:80px}.inactive{visibility:hidden}</style>${ shared }
				<div class="track"><div class="inactive"><p>${ quote }</p><p>${ attribution }</p></div></div>` );
			const candidate = await observePage( page, 'about:blank', 390, 0, null, undefined, undefined, true, true );
			expect( source.textChars ).toBe( candidate.textChars );
			expect( source.textChars ).toBe( 'Shared visible label Shared visible label Lower-page editorial content'.length );
			expect( quote.length + 1 + attribution.length ).toBe( 249 );
			expect( await page.locator( '.inactive' ).textContent() ).toContain( quote );
			await page.setContent( `<style>.track{width:240px;height:80px;overflow:hidden}.partial{transform:translateX(150px)}</style>${ shared }
				<div class="track"><div class="partial"><p>${ quote }</p><p>${ attribution }</p></div></div>` );
			const partial = await observePage( page, 'about:blank', 390, 0, null, undefined, undefined, true, true );
			expect( partial.textChars ).toBe( 'Shared visible label Shared visible label Lower-page editorial content'.length + quote.length + 1 );
			const repeated = 'Repeated article sentence';
			await page.setContent( `<style>.clip{width:200px;height:60px;overflow:hidden}.offstage{transform:translateX(300px)}article{width:200px;height:50px;overflow:auto}</style>
				<p>${ repeated }</p><div class="clip"><p class="offstage">${ repeated }</p></div>` );
			const repeatedText = await observePage( page, 'about:blank', 390, 0, null, undefined, undefined, true, true );
			expect( repeatedText.textChars ).toBe( repeated.length );
			const scrollCopy = 'Scrollable editorial text remains part of the article below its visible scrollport.';
			await page.setContent( `<style>article{width:220px;height:40px;overflow-x:hidden;overflow-y:auto}p{margin:0}</style><article><p>Article introduction.</p><p style="margin-top:90px">${ scrollCopy }</p></article>` );
			const scrollText = await observePage( page, 'about:blank', 390, 0, null, undefined, undefined, true, true );
			expect( scrollText.textChars ).toBe( 'Article introduction.'.length + 1 + scrollCopy.length );
		} finally { /* shared browser is closed after the suite */ }
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
	it( 'freezes each width from a fresh navigation instead of resize-history state', async () => {
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const directory = mkdtempSync( join( parent, 'reference-fresh-viewport-' ) );
		const server = createServer( ( _request, response ) => {
			response.setHeader( 'content-type', 'text/html' );
			response.end( `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>h1{font-size:33px}</style><h1>Neutral viewport pose</h1><script>
				if ( innerWidth === 768 ) document.documentElement.dataset.pose = 'fresh';
				addEventListener('resize', () => { if ( innerWidth === 768 ) { document.documentElement.dataset.pose = 'resized'; document.querySelector('h1').style.fontSize = '29px'; } });
			</script>` );
		} );
		await new Promise<void>( resolve => server.listen( 0, '127.0.0.1', resolve ) );
		const url = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }/`;
		const browser = sharedBrowser; const context = await browser.newContext( { viewport: { width: 1440, height: 900 } } );
		try {
			const page = await context.newPage(); await page.goto( url ); await page.setViewportSize( { width: 768, height: 900 } );
			await page.waitForFunction( () => document.documentElement.dataset.pose === 'resized' );
			expect( await page.locator( 'h1' ).evaluate( element => getComputedStyle( element ).fontSize ) ).toBe( '29px' );
			const collector = createReferenceCollector( directory, url, [ url ], { cleanupPolicy: cleanupPolicy() } );
			await collector.observe( page, url, 'desktop', [], { isMobile: false, hasTouch: false } );
			const receipt = join( directory, 'receipt.json' ); writeFileSync( receipt, JSON.stringify( { routes: [] } ) );
			const manifest = JSON.parse( readFileSync( collector.finalize( receipt ), 'utf8' ) ) as FidelityReference;
			const entry = manifest.entries.find( candidate => candidate.viewport === 768 )!;
			const observation = JSON.parse( readFileSync( join( directory, entry.observation!.path ), 'utf8' ) );
			expect( entry.readiness.ready, entry.readiness.reasons.join( ', ' ) ).toBe( true );
			expect( observation.typography ).toContainEqual( expect.objectContaining( { key: 'Neutral viewport pose', fontSize: 33 } ) );
			// The original capture page is not resized or otherwise changed by reference collection.
			expect( await page.locator( 'h1' ).evaluate( element => getComputedStyle( element ).fontSize ) ).toBe( '29px' );
		} finally { server.closeAllConnections(); await new Promise<void>( resolve => server.close( () => resolve() ) ); rmSync( directory, { recursive: true, force: true } ); }
	}, 60_000 );
	it( 'observes declared reference widths concurrently and preserves ordered artifacts', async () => {
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const directory = mkdtempSync( join( parent, 'reference-concurrent-widths-' ) );
		let arrivals = 0;
		const arrivalTimes: number[] = [];
		const source = createServer( ( request, response ) => {
			if ( request.url !== '/' ) { response.writeHead( 404 ); response.end(); return; }
			arrivals++;
			arrivalTimes.push( Date.now() );
			const respond = () => { response.setHeader( 'content-type', 'text/html' ); response.end( '<meta name="viewport" content="width=device-width,initial-scale=1"><h1>Concurrent reference</h1>' ); };
			if ( arrivals >= 2 ) respond();
			else setTimeout( respond, 2_000 );
		} );
		await new Promise<void>( resolve => source.listen( 0, '127.0.0.1', resolve ) );
		const url = `http://127.0.0.1:${ ( source.address() as { port: number } ).port }/`;
		const browser = await chromium.launch();
		try {
			const context = await browser.newContext();
			const page = await context.newPage();
			const collector = createReferenceCollector( directory, url, [ url ] );
			await collector.observe( page, url, 'desktop', [], { isMobile: false, hasTouch: false }, { id: 'desktop', width: 1440, height: 900, referenceWidths: [ 768, 1440 ] } );
			const receipt = join( directory, 'receipt.json' ); writeFileSync( receipt, JSON.stringify( { routes: [] } ) );
			const manifest = JSON.parse( readFileSync( collector.finalize( receipt ), 'utf8' ) ) as FidelityReference;
			expect( arrivals ).toBe( 2 );
			expect( arrivalTimes[ 1 ]! - arrivalTimes[ 0 ]! ).toBeLessThan( 1_500 );
			expect( manifest.entries.map( entry => entry.viewport ) ).toEqual( [ 768, 1440 ] );
			for ( const entry of manifest.entries ) {
				expect( entry.readiness.ready, entry.readiness.reasons.join( ', ' ) ).toBe( true );
				expect( entry.observation?.path ).toMatch( new RegExp( `-${ entry.viewport }\\.json$` ) );
				expect( entry.document?.path ).toMatch( new RegExp( `-${ entry.viewport }\\.html$` ) );
				expect( PNG.sync.read( readFileSync( join( directory, entry.screenshot!.path ) ) ).width ).toBe( entry.viewport );
			}
		} finally { await browser.close(); source.closeAllConnections(); await new Promise<void>( resolve => source.close( () => resolve() ) ); rmSync( directory, { recursive: true, force: true } ); }
	}, 30_000 );
} );

it( 'never silently pairs normal/zoom duplicate media by geometry or index', () => {
	const normal = { key: 'product', contentHash: 'same', role: 'img:product/main:', x: 0, y: 0, width: 200, height: 200 };
	const zoom = { ...normal, role: 'img:product/dialog:zoom', width: 500, height: 500 };
	const candidate = [ { ...zoom, width: 200 }, { ...normal, width: 500 } ];
	expect( matchRenderedImages( [ normal, zoom ], candidate ).map( pair => pair.candidate.role ) ).toEqual( [ normal.role, zoom.role ] );
	expect( matchRenderedImages( [ { ...normal, role: undefined }, { ...zoom, role: undefined } ], candidate ) ).toEqual( [] );
} );
