import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { createReferenceCollector } from '../fidelity/reference.js';
import { checkFidelity } from '../fidelity/check.js';

describe.skipIf( !!process.env.SKIP_BROWSER_TESTS || !existsSync( chromium.executablePath() ) )( 'adapter-owned route scope in real browser capture', () => {
	it( 'confines seeds, rendered footer expansion and redirects while keeping platform links and cross-namespace resources', async () => {
		const requests: string[] = [];
		const source = createServer( ( request, response ) => {
			requests.push( request.url! );
			if ( request.url === '/tenant/' ) { response.writeHead( 301, { location: '/tenant' } ); response.end(); return; }
			if ( request.url === '/tenant/leave' ) { response.writeHead( 302, { location: '/other/private?ref=tenant' } ); response.end(); return; }
			if ( request.url === '/shared/theme.css' ) { response.writeHead( 200, { 'content-type': 'text/css' } ); response.end( 'body{font:16px Arial}' ); return; }
			response.setHeader( 'content-type', 'text/html' );
			response.end( '<meta name="viewport" content="width=device-width,initial-scale=1">' + ( request.url === '/tenant' ?
				'<link rel="stylesheet" href="/shared/theme.css"><link rel="canonical" href="/tenant"><h1>Customer gallery</h1><nav><a href="/tenant/">Home alias</a><a href="/">Platform</a></nav><a href="/tenant/leave">Other destination via redirect</a><footer><a href="/?utm_content=badge">Builder badge</a></footer><script>document.body.insertAdjacentHTML("beforeend",\'<footer><a href="/other/">Rendered other tenant</a></footer>\')</script>' : '<h1>Unrelated platform content</h1>' ) );
		} );
		await new Promise<void>( resolve => source.listen( 0, '127.0.0.1', resolve ) );
		const origin = `http://127.0.0.1:${ ( source.address() as { port: number } ).port }`;
		const url = `${ origin }/tenant`;
		const routeScope = { origin, pathPrefixes: [ '/tenant' ] };
		mkdirSync( join( process.cwd(), '.tmp-test' ), { recursive: true } );
		const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'tenant-scope-' ) );
		try {
			const collector = createReferenceCollector( outputDir, url, [ url ] );
			const capture = await captureScreenshots( { urls: [ url, `${url}/`, `${origin}/`, `${origin}/other/` ], primaryUrl: url, outputDir, ...{ routeScope }, linkedPages: { maxPages: 8 }, concurrency: 1, settleMs: 0, learnFluid: false, observeSource: collector.observe } );
			expect( capture.failed ).toBe( 0 );
			expect( capture.captured ).toBe( 1 );
			expect( capture.linkedPageCoverage?.requiredUrls ).toEqual( [ url, `${url}/`, `${url}/leave` ] );
			expect( capture.linkedPageCoverage?.diagnostics ).toEqual( [] );
			expect( requests ).toContain( '/shared/theme.css' );
			for ( const external of [ '/', '/?utm_content=badge', '/other/', '/other/private?ref=tenant' ] ) expect( requests ).not.toContain( external );
			const receiptPath = exportWebsiteCapture( { outputDir, sourceUrl: url, platform: 'neutral-tenant', ...{ routeScope }, summary: { routesFailed: capture.failed }, failures: [] } );
			const receipt = JSON.parse( readFileSync( receiptPath, 'utf8' ) );
			expect( receipt.routes ).toHaveLength( 1 );
			expect( receipt.routes[0] ).toMatchObject( { url, path: 'website/index.html' } );
			expect( receipt.summary.complete ).toBe( true );
			expect( receipt.discoveryDiagnostics ).toContainEqual( { code: 'route_external_redirect', url: `${url}/leave`,
				reason: 'source initial-document redirect outside the adapter-owned site route scope (destination not fetched)' } );
			expect( receipt.duplicateRoutes ).toContainEqual( { url: `${url}/`, canonicalUrl: url, path: 'website/index.html' } );
			const portable = readFileSync( join( outputDir, 'website/index.html' ), 'utf8' );
			for ( const external of [ '/', '/?utm_content=badge', '/other/' ] ) expect( portable ).toContain( `href="${origin}${external}"` );
			expect( portable ).not.toContain( 'Unrelated platform content' );
			collector.requireUrls( capture.linkedPageCoverage!.requiredUrls );
			const reference = JSON.parse( readFileSync( collector.finalize( receiptPath ), 'utf8' ) );
			expect( reference.scope.sourceUrls ).toEqual( capture.linkedPageCoverage!.requiredUrls );
			const report = await checkFidelity( { directory: outputDir, widths: [390] } );
			expect( report.pass, JSON.stringify(report) ).toBe( true );
		} finally {
			source.closeAllConnections(); await new Promise<void>( resolve => source.close( () => resolve() ) );
			if ( !process.env.KEEP_ROUTE_SCOPE_EVIDENCE ) rmSync( outputDir, { recursive: true, force: true } );
		}
	}, 180_000 );

	it( 'keeps ordinary subpath entry sites origin-wide and retains distinct meaningful query routes', async () => {
		const docs: Record<string, string> = {
			'/docs/start': '<h1>Start</h1><a href="/">Home</a><a href="/about">About</a><a href="/catalog?view=one">One</a><a href="/catalog?view=two">Two</a>',
			'/': '<h1>Home</h1>', '/about': '<h1>About</h1>',
			'/catalog?view=one': '<h1>First view</h1>', '/catalog?view=two': '<h1>Second view</h1>',
		};
		const source = createServer( ( request, response ) => { response.writeHead( docs[request.url!] ? 200 : 404, { 'content-type': 'text/html' } ); response.end( `<meta name="viewport" content="width=device-width,initial-scale=1">${docs[request.url!] ?? 'Absent'}` ); } );
		await new Promise<void>( resolve => source.listen( 0, '127.0.0.1', resolve ) );
		const origin = `http://127.0.0.1:${ ( source.address() as { port: number } ).port }`;
		mkdirSync( join( process.cwd(), '.tmp-test' ), { recursive: true } );
		const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'subpath-scope-control-' ) );
		try {
			const url = `${origin}/docs/start`;
			const capture = await captureScreenshots( { urls: [url], primaryUrl: url, outputDir, linkedPages: { maxPages: 8 }, concurrency: 2, settleMs: 0, learnFluid: false } );
			expect( capture.captured ).toBe( 5 );
			const receipt = JSON.parse( readFileSync( exportWebsiteCapture( { outputDir, sourceUrl: url, platform: 'default', summary: { routesFailed: capture.failed }, failures: [] } ), 'utf8' ) );
			expect( receipt.summary.complete ).toBe( true );
			expect( receipt.routes ).toHaveLength( 5 );
			const queries = receipt.routes.filter( ( route: {url: string} ) => route.url.includes('?view=') );
			expect( new Set( queries.map( ( route: {path: string} ) => route.path ) ).size ).toBe( 2 );
		} finally { source.closeAllConnections(); await new Promise<void>( resolve => source.close( () => resolve() ) ); if ( !process.env.KEEP_ROUTE_SCOPE_EVIDENCE ) rmSync( outputDir, { recursive: true, force: true } ); }
	}, 120_000 );
} );
