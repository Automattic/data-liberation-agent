import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { captureScreenshots } from './screenshot/screenshotter.js';
import { probeCanonicalRouteAliases, ROUTE_ALIAS_CANONICAL } from './route-aliases.js';
import { exportWebsiteCapture } from './capture-export.js';

const dirs: string[] = [];
afterEach( () => {
	if (!process.env.KEEP_ALIAS_EVIDENCE) for ( const dir of dirs.splice( 0 ) ) rmSync( dir, { recursive: true, force: true } );
} );

/**
 * A query-only alias served with a `rel=canonical` pointing at the base route,
 * exactly the shape #835 documents (sitemap URL plus in-page `?programId`
 * link). The alias keeps its capture out of the browser pipeline while every
 * exported link to it still resolves to the canonical challenge page.
 */
describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'canonical route-alias dedupe (real Chromium)', () => {
	it( 'skips a query-only alias before capture, exports it as a duplicate, and satisfies a link to it', async () => {
		const browserRequests: string[] = [];
		const probeRequests: string[] = [];
		const page = ( canonical?: string, body = '' ) => `<html><head><title>Fixture</title><meta name="viewport" content="width=device-width,initial-scale=1">${ canonical ? `<link rel="canonical" href="${ canonical }">` : '' }<link rel="stylesheet" href="/site.css"></head><body id="challenge-body"><main><h1>Challenge 12</h1><p>Same document either way.</p></main>${ body }</body></html>`;
		const server = createServer( ( request, response ) => {
			const target = request.url!;
			if ( target === '/site.css' ) {
				response.writeHead( 200, { 'content-type': 'text/css' } );
				response.end( 'main{color:#222}' );
				return;
			}
			browserRequests.push( target );
			const document =
				target === '/' ? page( undefined, '<a href="/challenge-page/12/">Challenge</a><a href="/challenge-page/12/?programId=12">Challenge (linked)</a>' ) :
				target.startsWith( '/challenge-page/12/' ) ? page( '/challenge-page/12/' ) :
				'';
			response.writeHead( document ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' } );
			response.end( document || '<h1>Absent</h1>' );
		} );
		await new Promise< void >( resolve => server.listen( 0, '127.0.0.1', resolve ) );
		const origin = `http://127.0.0.1:${ ( server.address() as { port: number } ).port }`;
		mkdirSync( '.tmp-test', { recursive: true } );
		const outputDir = mkdtempSync( join( process.cwd(), '.tmp-test', 'route-alias-dedupe-' ) );
		dirs.push( outputDir );
		try {
			const baseUrl = `${ origin }/challenge-page/12/`;
			const aliasUrl = `${ baseUrl }?programId=12`;
			const inventory = [ `${ origin }/`, baseUrl, aliasUrl ];

			// Before capture: only the query-only candidates are fetched, and the
			// alias drops out of the capture set.
			const loopbackFetch = ( async ( url: string ) => {
				probeRequests.push( url );
				const response = await fetch( url, { signal: AbortSignal.timeout( 10_000 ) } );
				return { finalUrl: response.url || url, status: response.status, headers: response.headers, body: Buffer.from( await response.arrayBuffer() ) };
			} ) as unknown as typeof import('./media-fetch/safe-fetch.js').safeFetch;
			const probe = await probeCanonicalRouteAliases( { sourceUrl: `${ origin }/`, urls: inventory }, { fetch: loopbackFetch } );
			expect( probeRequests ).toEqual( [ aliasUrl ] );
			expect( probe.aliases ).toEqual( [ { url: aliasUrl, canonicalUrl: baseUrl } ] );
			const captureUrls = inventory.filter( url => ! probe.aliases.some( alias => alias.url === url ) );
			expect( captureUrls ).toEqual( [ `${ origin }/`, baseUrl ] );
			// The probe's own bounded fetch shares the fixture origin; only
			// capture-phase traffic is asserted below.
			browserRequests.length = 0;

			// Capture: the browser never loads the alias, and the rendered
			// homepage's link to it counts as satisfied by its canonical route.
			const capture = await captureScreenshots( {
				urls: captureUrls, primaryUrl: `${ origin }/`, outputDir,
				linkedPages: { maxPages: 20, timeoutMs: 120_000 },
				linkedCanonicalAliases: probe.aliases,
				concurrency: 2, settleMs: 0, learnFluid: false,
				viewports: [ { id: 'desktop', width: 1440, height: 900 } ],
			} );
			expect( capture.failed ).toBe( 0 );
			expect( capture.captured ).toBe( 2 );
			expect( browserRequests.filter( url => url.includes( 'programId=' ) ) ).toEqual( [] );
			expect( browserRequests.filter( url => url.startsWith( '/challenge-page/12/' ) ).length ).toBeGreaterThan( 0 );
			expect( capture.linkedPageCoverage!.aliasedTo ).toEqual( [ { url: aliasUrl, canonicalUrl: baseUrl } ] );
			expect( capture.linkedPageCoverage!.requiredUrls ).not.toContain( aliasUrl );
			expect( capture.linkedPageCoverage!.requiredUrls ).toContain( baseUrl );

			// Export: the alias is reported exactly like a captured-then-collapsed
			// duplicate, and the homepage's `?programId` link resolves to the
			// canonical challenge page without any unresolved anchor.
			const receiptPath = exportWebsiteCapture( {
				outputDir, sourceUrl: `${ origin }/`, platform: 'default',
				summary: { routesFailed: capture.failed }, failures: [],
				discoveryDiagnostics: [ {
					code: ROUTE_ALIAS_CANONICAL, url: aliasUrl,
					reason: `Route skipped before capture: its server-HTML rel=canonical resolves to ${ baseUrl }, another inventory route`,
				} ],
				canonicalAliases: probe.aliases,
			} );
			const receipt = JSON.parse( readFileSync( receiptPath, 'utf8' ) );
			expect( receipt.routes.map( ( route: { url: string } ) => route.url ).sort() ).toEqual( [ `${ origin }/`, baseUrl ].sort() );
			const baseRoute = receipt.routes.find( ( route: { url: string } ) => route.url === baseUrl );
			expect( receipt.duplicateRoutes ).toEqual( [ { url: aliasUrl, canonicalUrl: baseUrl, path: baseRoute.path } ] );
			expect( receipt.summary.complete ).toBe( true );
			const homePath = receipt.routes.find( ( route: { url: string } ) => route.url === `${ origin }/` ).path.replace( 'website/', '' );
			const home = readFileSync( join( outputDir, 'website', homePath ), 'utf8' );
			expect( home ).not.toContain( 'programId' );
			expect( home ).toContain( 'challenge-page/12/' );
			const anchors = JSON.parse( readFileSync( join( outputDir, 'diagnostics.json' ), 'utf8' ) ).unresolvedAnchors as Array< { url?: string; reason: string } >;
			expect( anchors.filter( anchor => anchor.url?.includes( 'programId' ) ) ).toEqual( [] );
		} finally {
			server.closeAllConnections();
			await new Promise< void >( resolve => server.close( () => resolve() ) );
		}
	}, 180_000 );
} );
