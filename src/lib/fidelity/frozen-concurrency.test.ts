import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import * as staticServer from '../replicate/local-site/static-server.js';
import { checkFidelity, type FidelityReport } from './check.js';
import { createReferenceCollector, digest, type FidelityReference } from './reference.js';

// Compare full semantic reports, normalizing only ephemeral preview ports.
const semantics = ( report: FidelityReport ) => JSON.parse( JSON.stringify( report ).replace( /http:\/\/127\.0\.0\.1:\d+/g, 'http://replay.local' ) );
function files( root: string ): Record<string, string> {
	return Object.fromEntries( readdirSync( root, { recursive: true, withFileTypes: true } )
		.filter( entry => entry.isFile() ).map( entry => {
			const path = join( entry.parentPath, entry.name );
			return [ path.slice( root.length + 1 ), digest( readFileSync( path ) ) ];
		} ) );
}

it.each( [ 0, -1, 1.5, 5, Infinity, NaN ] )( 'rejects a non-finite or out-of-range frozen bound (%s) before startup', async concurrency => {
	await expect( checkFidelity( { directory: 'unused', concurrency } ) ).rejects.toThrow( 'Frozen comparison concurrency must be an integer from 1 to 4' );
} );

describe.skipIf( Boolean( process.env.SKIP_BROWSER_TESTS ) || ! existsSync( chromium.executablePath() ) )( 'bounded frozen cells', () => {
	it.each( [ 'capture', 'materialization' ] as const )( '%s drains isolated cells in stable order, including unready and HTTP-failing cells', async stage => {
		const parent = join( process.cwd(), '.tmp-test' ); mkdirSync( parent, { recursive: true } );
		const directory = mkdtempSync( join( parent, 'frozen-pool-' ) );
		const routes = [ '/', '/fast/', '/broken/' ];
		const html = '<meta name="viewport" content="width=device-width,initial-scale=1"><style>h1{font:20px Arial}@media(pointer:coarse){h1{font-size:24px}}</style><h1>Independent page</h1>';
		let sourceRequests = 0;
		const source = createServer( ( _req, res ) => { sourceRequests++; res.setHeader( 'content-type', 'text/html' ); res.end( html ); } );
		await new Promise<void>( resolve => source.listen( 0, '127.0.0.1', resolve ) );
		const sourceUrl = `http://127.0.0.1:${ ( source.address() as { port: number } ).port }/`;
		const candidate = createServer( ( _req, res ) => { res.setHeader( 'content-type', 'text/html' ); res.end( html ); } );
		await new Promise<void>( resolve => candidate.listen( 0, '127.0.0.1', resolve ) );
		const candidateUrl = `http://127.0.0.1:${ ( candidate.address() as { port: number } ).port }`;
		const captureBrowser = await chromium.launch();
		try {
			const urls = routes.map( route => new URL( route, sourceUrl ).href );
			const collector = createReferenceCollector( directory, sourceUrl, urls );
			for ( const url of urls ) {
				for ( const device of [ 'mobile', 'desktop' ] ) {
					const mobile = device === 'mobile';
					const page = await captureBrowser.newPage( { isMobile: mobile, hasTouch: mobile } );
					await collector.observe( page, url, device, [], { isMobile: mobile, hasTouch: mobile } );
					await page.context().close();
				}
				const path = join( directory, 'website', new URL( url ).pathname, 'index.html' );
				mkdirSync( dirname( path ), { recursive: true } );
				writeFileSync( path, html );
			}
			await captureBrowser.close();
			// A real preview HTTP 500 and one unready frozen cell are distinct pending outcomes.
			writeFileSync( join( directory, 'website/broken/index.html' ), '<!--#include virtual="/parts/missing.html" -->' );
			const receipt = join( directory, 'capture-receipt.json' );
			writeFileSync( receipt, JSON.stringify( { source: { url: sourceUrl }, websiteRoot: 'website', routes: urls.map( url => ( { url, path: `website${ new URL( url ).pathname }index.html` } ) ) } ) );
			const manifestPath = collector.finalize( receipt );
			const manifest = JSON.parse( readFileSync( manifestPath, 'utf8' ) ) as FidelityReference;
			const unready = manifest.entries.find( entry => entry.route === '/fast/' && entry.viewport === 768 )!;
			unready.readiness = { ready: false, reasons: [ 'fixture unready' ] };
			writeFileSync( manifestPath, JSON.stringify( manifest ) );
			const input = { receipt: digest( readFileSync( receipt ) ), manifest: digest( readFileSync( manifestPath ) ), reference: files( join( directory, 'reference' ) ), website: files( join( directory, 'website' ) ) };
			const beforeRequests = sourceRequests;
			const launch = chromium.launch.bind( chromium );
			const start = staticServer.startStaticServer;
			let active = 0, peak = 0, launches = 0, serverStarts = 0;
			let contexts: BrowserContext[] = [], closed: number[] = [], serverUrls: string[] = [];
			let holdFirst = false;
			let cleanupFailure = false;
			let releaseFirst: () => void = () => {};
			vi.spyOn( staticServer, 'startStaticServer' ).mockImplementation( async root => {
				serverStarts++;
				const server = await start( root ); serverUrls.push( server.url ); return server;
			} );
			vi.spyOn( chromium, 'launch' ).mockImplementation( async options => {
				launches++;
				const browser = await launch( options );
				const newPage = browser.newPage.bind( browser );
				vi.spyOn( browser, 'newPage' ).mockImplementation( async options => {
					const page = await newPage( options );
					const index = contexts.length;
					contexts.push( page.context() ); active++; peak = Math.max( peak, active );
					page.context().on( 'close', () => { active--; closed.push( index ); if ( index !== 0 ) releaseFirst(); } );
					const close = page.context().close.bind( page.context() );
					vi.spyOn( page.context(), 'close' ).mockImplementation( async options => {
						const fail = cleanupFailure && page.viewportSize()?.width === 390 && new URL( page.url() ).pathname === '/';
						await close( options );
						if ( fail ) throw new Error( 'fixture cleanup failure after close' );
					} );
					// Storage poisoning would change actual measured text if a context were reused.
					await page.addInitScript( () => {
						const cookie = `prior-cell-${ location.port }`;
						const poisoned = localStorage.getItem( 'prior-cell' ) || document.cookie.includes( `${ cookie }=` );
						localStorage.setItem( 'prior-cell', 'yes' ); document.cookie = `${ cookie }=yes`;
						if ( poisoned ) document.addEventListener( 'DOMContentLoaded', () => { document.querySelector( 'h1' )!.textContent = 'LEAKED CELL'; } );
					} );
					if ( holdFirst && index === 0 ) {
						// Force out-of-order real-cell completion; bounded fallback makes this
						// test fail meaningfully (rather than hang) on the serial baseline.
						await new Promise<void>( resolve => {
							const timer = setTimeout( resolve, 5000 );
							releaseFirst = () => { clearTimeout( timer ); resolve(); };
						} );
					}
					return page;
				} );
				return browser;
			} );
			const run = async ( concurrency: number | undefined, failCleanup = false ) => {
				active = 0; peak = 0; launches = 0; serverStarts = 0; contexts = []; closed = []; serverUrls = []; holdFirst = concurrency !== 1;
				cleanupFailure = failCleanup;
				rmSync( join( directory, 'compare' ), { recursive: true, force: true } );
				const report = await checkFidelity( { directory, stage, candidateUrl: stage === 'materialization' ? candidateUrl : undefined, concurrency, settleMs: 0, screenshots: true } );
				expect( active ).toBe( 0 ); expect( closed ).toHaveLength( contexts.length );
				expect( new Set( contexts ).size ).toBe( 8 );
				expect( launches ).toBe( 1 ); expect( serverStarts ).toBe( 1 );
				for ( const context of contexts ) expect( context.browser()?.isConnected() ?? false ).toBe( false );
				for ( const url of serverUrls ) await expect( fetch( url ) ).rejects.toThrow();
				expect( sourceRequests ).toBe( beforeRequests );
				expect( report.coverage ).toMatchObject( { required: 9, measured: 5 } );
				expect( report.pending ).toHaveLength( failCleanup ? 5 : 4 );
				if ( failCleanup ) expect( report.pending?.[ 0 ]?.reason ).toContain( 'fixture cleanup failure after close' );
				expect( report.pending?.[ failCleanup ? 1 : 0 ]?.reason ).toContain( 'fixture unready' );
				for ( const pending of report.pending!.slice( failCleanup ? 2 : 1 ) ) expect( pending.reason ).toContain( 'Observation HTTP 500' );
				expect( report.scores.flatMap( score => score.failures ) ).toEqual( [] );
				expect( report.selfConsistency.pass ).toBe( false );
				const evidence = files( join( directory, 'compare', stage ) );
				delete evidence[ 'report.json' ];
				return { report, peak, closed: [ ...closed ], evidence };
			};
			const serial = await run( 1 ); expect( serial.peak ).toBe( 1 );
			for ( const bound of [ undefined, 2 ] ) {
				const parallel = await run( bound );
				expect( parallel.peak ).toBeGreaterThan( 1 ); expect( parallel.peak ).toBeLessThanOrEqual( bound ?? 3 );
				expect( parallel.closed[ 0 ] ).not.toBe( 0 );
				expect( semantics( parallel.report ) ).toEqual( semantics( serial.report ) );
				expect( parallel.evidence ).toEqual( serial.evidence );
			}
			if ( stage === 'capture' ) {
				// A cleanup exception retains the already-measured score and its diagnostic,
				// exactly as serial main does, while the other real contexts still drain.
				const serialFailure = await run( 1, true );
				const parallelFailure = await run( 2, true );
				expect( semantics( parallelFailure.report ) ).toEqual( semantics( serialFailure.report ) );
				cleanupFailure = false;
				active = 0; peak = 0; contexts = []; closed = []; holdFirst = false;
				const duplicates = await checkFidelity( { directory, routes: [ '/', '/' ], concurrency: 2, settleMs: 0 } );
				expect( peak ).toBe( 1 ); expect( active ).toBe( 0 ); expect( closed ).toHaveLength( 6 );
				expect( duplicates.scores.map( score => score.viewport ) ).toEqual( [ 390, 768, 1440, 390, 768, 1440 ] );
				expect( duplicates.coverage ).toMatchObject( { required: 6, measured: 6 } );
				expect( duplicates.pending ).toEqual( [] );
			}
			expect( { receipt: digest( readFileSync( receipt ) ), manifest: digest( readFileSync( manifestPath ) ), reference: files( join( directory, 'reference' ) ), website: files( join( directory, 'website' ) ) } ).toEqual( input );
		} finally {
			vi.restoreAllMocks(); await captureBrowser.close(); source.closeAllConnections(); candidate.closeAllConnections();
			await Promise.all( [ new Promise<void>( resolve => source.close( () => resolve() ) ), new Promise<void>( resolve => candidate.close( () => resolve() ) ) ] );
			rmSync( directory, { recursive: true, force: true } );
		}
	}, 120_000 );
} );
