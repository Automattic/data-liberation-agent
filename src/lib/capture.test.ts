import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SectionSpec } from './replicate/section-extract.js';
import { SectionSpecsStore } from './replicate/section-specs-store.js';
import { MediaStubStore } from './resume-state/index.js';

const { captureScreenshotsMock } = vi.hoisted( () => ( {
	captureScreenshotsMock: vi.fn( async ( { urls }: { urls: string[] } ) => ( {
		urls,
		captured: 1,
		skipped: 0,
		failed: 0,
		durationMs: 1,
	} ) ),
} ) );

vi.mock( './media-fetch/safe-fetch.js', () => ( {
	safeFetch: vi.fn( async ( url: string ) => ( { finalUrl: url } ) ),
} ) );

vi.mock( './detect-platform/index.js', () => ( {
	detect: vi.fn( async () => ( { platform: 'generic' } ) ),
} ) );

vi.mock( './screenshot/screenshotter.js', () => ( {
	captureScreenshots: captureScreenshotsMock,
} ) );

vi.mock( './site-preview.js', () => ( {
	captureSitePreview: vi.fn( async () => ( { path: 'website/site-preview.png', width: 1200, height: 900, origin: 'portable_render' } ) ),
} ) );

vi.mock( './capture-export.js', () => ( {
	exportWebsiteCapture: vi.fn( ( { outputDir }: { outputDir: string } ) => {
		mkdirSync( outputDir, { recursive: true } );
		const path = join( outputDir, 'capture-receipt.json' );
		writeFileSync( path, JSON.stringify( { source: { url: 'https://example.com/' }, routes: [] } ) );
		return path;
	} ),
} ) );

vi.mock( './media-fetch/media.js', () => ( {
	downloadMedia: vi.fn( async ( url: string, outputDir: string ) => {
		if ( url.endsWith( 'failed.jpg' ) ) {
			return { localPath: null, error: 'download failed' };
		}
		mkdirSync( outputDir, { recursive: true } );
		const localPath = join( outputDir, `${ url.includes( 'mobile' ) ? 'mobile' : 'desktop' }.jpg` );
		writeFileSync( localPath, url );
		return { localPath, error: null };
	} ),
} ) );

import { captureWebsite, DEFAULT_REFERENCE_SAMPLE, DEFAULT_ROUTE_LIMIT, downloadCaptureSectionMedia, IncompleteCaptureError, isUsableCapture } from './capture.js';
import { exportWebsiteCapture } from './capture-export.js';
import { captureSitePreview } from './site-preview.js';

const root = join( process.cwd(), '.tmp-test', 'capture-section-media' );
const sourceUrl = 'https://example.com/';

function section( images: Array< { url: string } > ): SectionSpec {
	return {
		sectionIndex: 0,
		images,
		cells: [],
	} as unknown as SectionSpec;
}

describe( 'downloadCaptureSectionMedia', () => {
	afterEach( () => rmSync( root, { recursive: true, force: true } ) );

	it( 'downloads deduplicated desktop and mobile section media and records failures', async () => {
		SectionSpecsStore.load( root ).set(
			sourceUrl,
			[
				section( [
					{ url: 'https://cdn.example.com/desktop.jpg' },
					{ url: 'https://cdn.example.com/failed.jpg' },
				] ),
			],
			[]
		);
		SectionSpecsStore.loadMobile( root ).set(
			sourceUrl,
			[
				section( [
					{ url: 'https://cdn.example.com/desktop.jpg' },
					{ url: 'https://cdn.example.com/mobile.jpg' },
				] ),
			],
			[],
			{ width: 402, height: 681 }
		);

		expect( await downloadCaptureSectionMedia( root, [ sourceUrl ] ) ).toBe( 2 );
		expect( Object.fromEntries( MediaStubStore.load( root ).list() ) ).toMatchObject( {
			'https://cdn.example.com/desktop.jpg': { status: 'success' },
			'https://cdn.example.com/mobile.jpg': { status: 'success' },
			'https://cdn.example.com/failed.jpg': { status: 'error', error: 'download failed' },
		} );
	} );

	it( 'does not download empty or self-referential page URLs as section media', async () => {
		SectionSpecsStore.load( root ).set(
			sourceUrl,
			[
				section( [
					{ url: sourceUrl },
					{ url: 'https://example.com' },
					{ url: '   ' },
					{ url: 'https://cdn.example.com/desktop.jpg' },
				] ),
			],
			[]
		);
		SectionSpecsStore.loadMobile( root ).set(
			sourceUrl,
			[ section( [ { url: 'https://example.com/about' } ] ) ],
			[],
			{ width: 402, height: 681 }
		);

		expect(
			await downloadCaptureSectionMedia( root, [ sourceUrl, 'https://example.com/about' ] )
		).toBe( 1 );
		expect( Object.fromEntries( MediaStubStore.load( root ).list() ) ).toEqual( {
			'https://cdn.example.com/desktop.jpg': expect.objectContaining( { status: 'success' } ),
		} );
	} );

	it( 'downloads media referenced only by captured gallery frame HTML', async () => {
		const manifestDir = join( root, 'screenshots' );
		mkdirSync( manifestDir, { recursive: true } );
		writeFileSync( join( manifestDir, 'manifest.json' ), JSON.stringify( {
			entries: { [ sourceUrl ]: { interactions: { states: [ { kind: 'gallery', gallery: { inline: { frames: [ { html: '<figure><img src="https://cdn.example.com/frame-only.jpg" srcset="https://cdn.example.com/frame,one.jpg 1x, https://cdn.example.com/frame-two.jpg 2x"></figure>' } ] } } } ] } } },
		} ) );

		expect( await downloadCaptureSectionMedia( root, [ sourceUrl ] ) ).toBe( 3 );
		expect( MediaStubStore.load( root ).get( 'https://cdn.example.com/frame-only.jpg' )?.status ).toBe( 'success' );
		expect( MediaStubStore.load( root ).get( 'https://cdn.example.com/frame,one.jpg' )?.status ).toBe( 'success' );
		expect( MediaStubStore.load( root ).get( 'https://cdn.example.com/frame-two.jpg' )?.status ).toBe( 'success' );
	} );
} );

describe( 'captureWebsite fluid learning', () => {
	afterEach( () => {
		captureScreenshotsMock.mockClear();
		rmSync( root, { recursive: true, force: true } );
	} );
	it( 'carries adapter document ownership into seeds, capture and export without inferring a generic subpath scope', async () => {
		const scopedSource = 'https://example.com/tenant';
		const routeScope = { origin: 'https://example.com', pathPrefixes: ['/tenant'] };
		await captureWebsite( { url: scopedSource, outputDir: root }, {
			findAdapter: () => ( { id: 'neutral', routeScope: () => routeScope,
				discover: async () => ( { urls: [ {url: `${scopedSource}/about?view=one`}, {url: 'https://example.com/'}, {url: 'https://example.com/tenant-two'} ] } ),
			} ),
		} );
		expect( captureScreenshotsMock ).toHaveBeenLastCalledWith( expect.objectContaining( { routeScope, urls: [ scopedSource, `${scopedSource}/about?view=one` ] } ) );
		expect( exportWebsiteCapture ).toHaveBeenLastCalledWith( expect.objectContaining( { routeScope } ) );
	} );

	it.each( [
		{ option: undefined, expected: true, label: 'defaults to enabled' },
		{ option: false, expected: false, label: 'supports explicit opt-out' },
	] )( '$label', async ( { option, expected } ) => {
		await captureWebsite(
			{
				url: sourceUrl,
				outputDir: root,
				...( option === undefined ? {} : { learnFluid: option } ),
			},
			{
				findAdapter: () => ( {
					id: 'generic',
					platform: 'generic',
					discover: async () => ( { urls: [] } ),
					extract: async () => ( { title: '', content: '' } ),
				} ),
			}
		);

		expect( captureScreenshotsMock ).toHaveBeenCalledWith(
			expect.objectContaining( { learnFluid: expected } )
		);
	} );

	it.each( [
		{ option: undefined, expected: DEFAULT_REFERENCE_SAMPLE, label: 'bounds reference evidence to the default sample' },
		{ option: 3, expected: 3, label: 'honors an explicit reference sample' },
		{ option: 'all' as const, expected: undefined, label: "freezes every route with referenceSample 'all'" },
	] )( '$label', async ( { option, expected } ) => {
		await captureWebsite(
			{ url: sourceUrl, outputDir: root, ...( option === undefined ? {} : { referenceSample: option } ) },
			{
				findAdapter: () => ( {
					id: 'generic',
					platform: 'generic',
					discover: async () => ( { urls: Array.from( { length: 9 }, ( _, i ) => ( { url: `${ sourceUrl }page-${ i }` } ) ) } ),
					extract: async () => ( { title: '', content: '' } ),
				} ),
			}
		);
		const call = captureScreenshotsMock.mock.calls.at( -1 )![ 0 ] as { referenceSampleUrls?: readonly string[] };
		if ( expected === undefined ) expect( call.referenceSampleUrls ).toBeUndefined();
		else {
			expect( call.referenceSampleUrls ).toHaveLength( expected );
			expect( call.referenceSampleUrls ).toContain( sourceUrl );
		}
	} );

	it.each( [ 0, -1, 1.5 ] )( 'rejects referenceSample %s before any browser starts', async ( referenceSample ) => {
		await expect(
			captureWebsite(
				{ url: sourceUrl, outputDir: root, referenceSample },
				{
					findAdapter: () => ( {
						id: 'generic',
						platform: 'generic',
						discover: async () => ( { urls: [] } ),
						extract: async () => ( { title: '', content: '' } ),
					} ),
				}
			)
		).rejects.toThrow( 'referenceSample must be a positive integer' );
		expect( captureScreenshotsMock ).not.toHaveBeenCalled();
	} );
} );

describe( 'captureWebsite completeness', () => {
	afterEach( () => {
		vi.mocked( exportWebsiteCapture ).mockClear();
		rmSync( root, { recursive: true, force: true } );
	} );

	it( 'records preview failure without failing an otherwise complete capture', async () => {
		vi.mocked( captureSitePreview ).mockRejectedValueOnce( new Error( 'Preview browser failed' ) );
		const result = await captureWebsite( { url: sourceUrl, outputDir: root }, {
			findAdapter: () => ( { id: 'generic', platform: 'generic', discover: async () => ( { urls: [] } ), extract: async () => ( { title: '', content: '' } ) } ),
		} );
		expect( result.complete ).toBe( true );
		expect( JSON.parse( readFileSync( result.captureReceiptPath, 'utf8' ) ).preview ).toEqual( { status: 'failed', reason: 'Preview browser failed' } );
	} );

	it( 'says the capture is incomplete when exported output links to uncaptured routes', async () => {
		vi.mocked( exportWebsiteCapture ).mockImplementationOnce( ( { outputDir } ) => {
			mkdirSync( outputDir, { recursive: true } );
			writeFileSync( join( outputDir, 'capture-receipt.json' ), JSON.stringify( { source: { url: sourceUrl }, routes: [] } ) );
			writeFileSync(
				join( outputDir, 'diagnostics.json' ),
				JSON.stringify( {
					unresolvedAnchors: [
						{
							sourceUrl,
							url: 'https://example.com/hyundai-i30n',
							reason: 'target route was not captured',
						},
					],
				} )
			);
			return join( outputDir, 'capture-receipt.json' );
		} );

		const result = await captureWebsite(
			{ url: sourceUrl, outputDir: root },
			{
				findAdapter: () => ( {
					id: 'generic',
					platform: 'generic',
					discover: async () => ( { urls: [] } ),
					extract: async () => ( { title: '', content: '' } ),
				} ),
			}
		);

		expect( result.complete ).toBe( false );
		expect( result.summary.complete ).toBe( false );
		expect( result.unresolvedAnchors ).toEqual( [
			{
				sourceUrl,
				url: 'https://example.com/hyundai-i30n',
				reason: 'target route was not captured',
			},
		] );
	} );

	it( 'preserves source-absent link diagnostics in a complete strict capture', async () => {
		const realExport = await vi.importActual< typeof import('./capture-export.js') >( './capture-export.js' );
		vi.mocked( exportWebsiteCapture ).mockImplementationOnce( realExport.exportWebsiteCapture );
		captureScreenshotsMock.mockResolvedValueOnce( { urls: [ sourceUrl ], captured: 1, skipped: 1, failed: 0, durationMs: 1 } );
		mkdirSync( join( root, 'html' ), { recursive: true } );
		mkdirSync( join( root, 'screenshots' ), { recursive: true } );
		writeFileSync( join( root, 'html', 'home.html' ), '<h1>Home</h1><a href="/gone">Gone</a>' );
		writeFileSync( join( root, 'screenshots', 'manifest.json' ), JSON.stringify( {
			version: 1, entries: { [ sourceUrl ]: { html: 'html/home.html' }, 'https://example.com/gone': {} },
		} ) );
		writeFileSync( join( root, 'screenshots', 'failures.json' ), JSON.stringify( [ { url: 'https://example.com/gone', error: 'HTTP 404' } ] ) );
		const result = await captureWebsite( { url: sourceUrl, outputDir: root, strict: true }, {
			findAdapter: () => ( {
				id: 'generic', platform: 'generic',
				discover: async () => ( { urls: [ { url: 'https://example.com/gone', type: 'page' } ] } ),
				extract: async () => ( { title: '', content: '' } ),
			} ),
		} );
		expect( result.complete ).toBe( true );
		expect( result.summary.complete ).toBe( true );
		expect( result.unresolvedAnchors ).toEqual( [ { sourceUrl, url: 'https://example.com/gone', reason: 'target route is absent at source' } ] );
	} );

	it( 'reports a captured entrypoint and a structured missing route when one of twelve routes fails', async () => {
		const realExport = await vi.importActual< typeof import('./capture-export.js') >( './capture-export.js' );
		vi.mocked( exportWebsiteCapture ).mockImplementationOnce( realExport.exportWebsiteCapture );
		const others = Array.from( { length: 11 }, ( _, index ) => `https://example.com/p${ index }` );
		const failed = others[ 3 ]!;
		captureScreenshotsMock.mockResolvedValueOnce( { urls: [ sourceUrl, ...others ], captured: 11, skipped: 0, failed: 1, durationMs: 1 } );
		mkdirSync( join( root, 'html' ), { recursive: true } );
		mkdirSync( join( root, 'screenshots' ), { recursive: true } );
		const entries: Record< string, { html?: string } > = {};
		for ( const [ index, url ] of [ sourceUrl, ...others ].entries() ) {
			if ( url === failed ) { entries[ url ] = {}; continue; }
			writeFileSync( join( root, 'html', `page-${ index }.html` ), `<h1>Page ${ index }</h1>` );
			entries[ url ] = { html: `html/page-${ index }.html` };
		}
		writeFileSync( join( root, 'screenshots', 'manifest.json' ), JSON.stringify( { version: 1, entries } ) );
		writeFileSync( join( root, 'screenshots', 'failures.json' ), JSON.stringify( [
			{ url: failed, viewport: 'desktop', stage: 'goto', error: 'Navigation timeout of 30000 ms exceeded', attempt: 4 },
		] ) );
		const result = await captureWebsite( { url: sourceUrl, outputDir: root }, {
			findAdapter: () => ( { id: 'generic', platform: 'generic', discover: async () => ( { urls: others.map( url => ( { url, type: 'page' } ) ) } ), extract: async () => ( { title: '', content: '' } ) } ),
		} );
		expect( result.complete ).toBe( false );
		expect( result.entrypointCaptured ).toBe( true );
		expect( result.summary.entrypointCaptured ).toBe( true );
		expect( result.missingRoutes ).toEqual( [ { url: failed, code: 'route_capture_failed', reason: 'desktop/goto: Navigation timeout of 30000 ms exceeded' } ] );
		expect( isUsableCapture( result ) ).toBe( true );
	} );

	it( 'counts a route saved with a failed stage as captured and a route export dropped as failed', async () => {
		const realExport = await vi.importActual< typeof import('./capture-export.js') >( './capture-export.js' );
		vi.mocked( exportWebsiteCapture ).mockImplementationOnce( realExport.exportWebsiteCapture );
		const degraded = 'https://example.com/degraded';
		const dropped = 'https://example.com/dropped';
		captureScreenshotsMock.mockResolvedValueOnce( { urls: [ sourceUrl, degraded, dropped ], captured: 3, skipped: 0, failed: 0, durationMs: 1 } );
		for ( const directory of [ 'html', 'html-mobile', 'screenshots' ] ) mkdirSync( join( root, directory ), { recursive: true } );
		const entries: Record< string, { html: string } > = {};
		for ( const [ index, url ] of [ sourceUrl, degraded, dropped ].entries() ) {
			writeFileSync( join( root, 'html', `page-${ index }.html` ), `<h1>${ url === dropped ? 'Dropped' : 'Page' } ${ index }</h1>` );
			// Every declared profile produced its document; only a later stage failed.
			writeFileSync( join( root, 'html-mobile', `page-${ index }.html` ), `<h1>Phone ${ index }</h1>` );
			entries[ url ] = { html: `html/page-${ index }.html` };
		}
		writeFileSync( join( root, 'screenshots', 'manifest.json' ), JSON.stringify( { version: 1, entries } ) );
		writeFileSync( join( root, 'screenshots', 'failures.json' ), JSON.stringify( [
			{ url: degraded, viewport: 'mobile', stage: 'screenshot-scrolled', error: 'screenshot timeout', attempt: 1 },
		] ) );
		const documentSelection = ( documents: Record< string, string > ) => {
			if ( documents.desktop?.includes( 'Dropped' ) ) throw new Error( 'cannot export page' );
			return undefined;
		};
		const result = await captureWebsite( { url: sourceUrl, outputDir: root }, {
			findAdapter: () => ( {
				id: 'generic', platform: 'generic', liberation: { documentSelection },
				discover: async () => ( { urls: [ degraded, dropped ].map( url => ( { url, type: 'page' } ) ) } ), extract: async () => ( { title: '', content: '' } ),
			} ),
		} );
		const { routesDiscovered, routesCaptured, routesSkipped, routesFailed } = result.summary;
		expect( { routesDiscovered, routesCaptured, routesSkipped, routesFailed } ).toEqual( { routesDiscovered: 3, routesCaptured: 2, routesSkipped: 0, routesFailed: 1 } );
		expect( routesCaptured + routesSkipped + routesFailed ).toBeLessThanOrEqual( routesDiscovered );
		expect( result.missingRoutes ).toEqual( [ { url: dropped, code: 'route_export_failed', reason: 'cannot export page' } ] );
		expect( result.complete ).toBe( false );
		expect( isUsableCapture( result ) ).toBe( true );
		const receipt = JSON.parse( readFileSync( result.captureReceiptPath, 'utf8' ) );
		expect( receipt.discoveryDiagnostics.map( ( row: { code: string; url: string } ) => [ row.code, row.url ] ) ).toEqual( [
			[ 'route_capture_degraded', degraded ], [ 'route_export_failed', dropped ],
		] );
	} );

	it( 'records off-origin inventory URLs the browser capture dropped without counting them as missing', async () => {
		const offOrigin = 'https://cdn.other.test/landing';
		captureScreenshotsMock.mockImplementationOnce( async ( { urls } ) => ( {
			urls: urls.filter( url => url !== offOrigin ), captured: 1, skipped: 0, failed: 0, durationMs: 1,
			routeDiagnostics: [ { code: 'route_off_origin', url: offOrigin, reason: 'discovered URL is outside the entry origin https://example.com', unit: 'route', severity: 'warning' } ],
		} ) );
		const result = await captureWebsite( { url: sourceUrl, outputDir: root }, {
			findAdapter: () => ( {
				id: 'generic', platform: 'generic',
				discover: async () => ( { urls: [ { url: offOrigin, type: 'page' } ] } ), extract: async () => ( { title: '', content: '' } ),
			} ),
		} );
		const offOriginRow = { code: 'route_off_origin', url: offOrigin, reason: 'discovered URL is outside the entry origin https://example.com', unit: 'route', severity: 'warning' };
		expect( result.discoveryDiagnostics ).toEqual( [ offOriginRow ] );
		expect( vi.mocked( exportWebsiteCapture ).mock.calls.at( -1 )?.[ 0 ].discoveryDiagnostics ).toEqual( [ offOriginRow ] );
		expect( result.summary ).toMatchObject( { routesDiscovered: 1, routesCaptured: 1, routesFailed: 0 } );
		expect( result.missingRoutes ).toEqual( [] );
		expect( result.complete ).toBe( true );
	} );

	it( 'rejects a capture whose entrypoint failed, whatever happened to other routes', async () => {
		const realExport = await vi.importActual< typeof import('./capture-export.js') >( './capture-export.js' );
		vi.mocked( exportWebsiteCapture ).mockImplementationOnce( realExport.exportWebsiteCapture );
		const other = 'https://example.com/other';
		captureScreenshotsMock.mockResolvedValueOnce( { urls: [ sourceUrl, other ], captured: 1, skipped: 0, failed: 1, durationMs: 1 } );
		mkdirSync( join( root, 'html' ), { recursive: true } );
		mkdirSync( join( root, 'screenshots' ), { recursive: true } );
		writeFileSync( join( root, 'html', 'other.html' ), '<h1>Other</h1>' );
		writeFileSync( join( root, 'screenshots', 'manifest.json' ), JSON.stringify( {
			version: 1, entries: { [ sourceUrl ]: {}, [ other ]: { html: 'html/other.html' } },
		} ) );
		writeFileSync( join( root, 'screenshots', 'failures.json' ), JSON.stringify( [ { url: sourceUrl, viewport: 'desktop', stage: 'goto', error: 'HTTP 403', attempt: 1 } ] ) );
		await expect( captureWebsite( { url: sourceUrl, outputDir: root }, {
			findAdapter: () => ( { id: 'generic', platform: 'generic', discover: async () => ( { urls: [ { url: other, type: 'page' } ] } ), extract: async () => ( { title: '', content: '' } ) } ),
		} ) ).rejects.toThrow( `Source homepage ${ sourceUrl } was not captured: desktop/goto: HTTP 403` );
	} );

	it( 'counts discovered routes over the same route set as captured, skipped and failed', async () => {
		const other = 'https://example.com/other';
		const unscheduled = [ 'https://example.com/a', 'https://example.com/b', 'https://example.com/c' ];
		captureScreenshotsMock.mockResolvedValueOnce( {
			urls: [ sourceUrl, other ], captured: 1, skipped: 0, failed: 1, durationMs: 1,
			linkedPageCoverage: {
				limits: { maxPages: 2, maxDepth: 8, timeoutMs: 1_800_000 },
				requiredUrls: [ sourceUrl, other, ...unscheduled ],
				scheduled: 2,
				diagnostics: unscheduled.map( url => ( { code: 'linked_page_budget_exhausted', url, reason: 'maxPages=2 exhausted; 2 addresses scheduled' } ) ),
			},
		} as Awaited< ReturnType< typeof captureScreenshotsMock > > );
		const result = await captureWebsite( { url: sourceUrl, outputDir: root }, {
			findAdapter: () => ( { id: 'generic', platform: 'generic', discover: async () => ( { urls: [] } ), extract: async () => ( { title: '', content: '' } ) } ),
		} );
		const { routesDiscovered, routesCaptured, routesSkipped, routesFailed } = result.summary;
		expect( { routesDiscovered, routesCaptured, routesSkipped, routesFailed } ).toEqual( { routesDiscovered: 2, routesCaptured: 1, routesSkipped: 0, routesFailed: 1 } );
		expect( routesCaptured + routesSkipped + routesFailed ).toBeLessThanOrEqual( routesDiscovered );
		// Unscheduled routes stay visible as diagnostics and keep the capture incomplete.
		expect( result.discoveryDiagnostics.map( row => row.url ) ).toEqual( unscheduled );
		expect( result.complete ).toBe( false );
	} );

	it( 'rejects in strict mode so programmatic callers fail closed', async () => {
		vi.mocked( exportWebsiteCapture ).mockImplementationOnce( ( { outputDir } ) => {
			mkdirSync( outputDir, { recursive: true } );
			writeFileSync( join( outputDir, 'capture-receipt.json' ), JSON.stringify( { source: { url: sourceUrl }, routes: [] } ) );
			writeFileSync(
				join( outputDir, 'diagnostics.json' ),
				JSON.stringify( {
					unresolvedAnchors: [
						{
							sourceUrl,
							url: 'https://example.com/missing',
							reason: 'target route was not captured',
						},
					],
				} )
			);
			return join( outputDir, 'capture-receipt.json' );
		} );

		await expect(
			captureWebsite(
				{ url: sourceUrl, outputDir: root, strict: true },
				{
					findAdapter: () => ( {
						id: 'generic',
						platform: 'generic',
						discover: async () => ( { urls: [] } ),
						extract: async () => ( { title: '', content: '' } ),
					} ),
				}
			)
		).rejects.toBeInstanceOf( IncompleteCaptureError );
	} );
} );

describe( 'captureWebsite route budget', () => {
	const store = Array.from( { length: 3_000 }, ( _, index ) => `https://example.com/product/item-${ index }/` );
	const storeAdapter = () => ( {
		findAdapter: () => ( {
			id: 'generic', platform: 'generic',
			discover: async () => ( { urls: store.map( url => ( { url, type: 'product' } ) ) } ),
			extract: async () => ( { title: '', content: '' } ),
		} ),
	} );
	const capturedUrls = () => ( captureScreenshotsMock.mock.calls.at( -1 )![ 0 ] as { urls: string[] } ).urls;
	afterEach( () => {
		captureScreenshotsMock.mockClear();
		vi.mocked( exportWebsiteCapture ).mockClear();
		rmSync( root, { recursive: true, force: true } );
	} );

	it( 'bounds a store-sized inventory to the default budget and reports every omitted route', async () => {
		const result = await captureWebsite( { url: sourceUrl, outputDir: root }, storeAdapter() );
		const call = captureScreenshotsMock.mock.calls.at( -1 )![ 0 ] as { urls: string[]; limit?: number };
		expect( DEFAULT_ROUTE_LIMIT ).toBe( 50 );
		expect( call.urls ).toHaveLength( DEFAULT_ROUTE_LIMIT );
		expect( call.urls[ 0 ] ).toBe( sourceUrl );
		// Linked-page admissions share the same budget.
		expect( call.limit ).toBe( DEFAULT_ROUTE_LIMIT );
		// An even spread reaches the end of the inventory, not just its head.
		expect( call.urls ).toContain( store.at( -1 ) );
		const omitted = result.discoveryDiagnostics.filter( row => row.code === 'route_omitted_by_budget' );
		expect( omitted ).toHaveLength( store.length + 1 - DEFAULT_ROUTE_LIMIT );
		expect( new Set( [ ...omitted.map( row => row.url ), ...call.urls ] ).size ).toBe( store.length + 1 );
		expect( omitted[ 0 ] ).toEqual( { code: 'route_omitted_by_budget', url: expect.any( String ), reason: 'Outside the route budget of 50 routes' } );
		expect( result.summary ).toMatchObject( { routesDiscovered: DEFAULT_ROUTE_LIMIT, routesOmitted: store.length + 1 - DEFAULT_ROUTE_LIMIT, routesFailed: 0 } );
		expect( result.missingRoutes ).toEqual( [] );
		expect( result.complete ).toBe( true );
		expect( isUsableCapture( result ) ).toBe( true );
		expect( vi.mocked( exportWebsiteCapture ).mock.calls.at( -1 )![ 0 ] ).toMatchObject( {
			summary: { routesOmitted: store.length + 1 - DEFAULT_ROUTE_LIMIT },
			discoveryDiagnostics: expect.arrayContaining( [ omitted[ 0 ] ] ),
		} );
	} );

	it( 'selects the same routes, entrypoint first, for the same inventory', async () => {
		await captureWebsite( { url: sourceUrl, outputDir: root, routeLimit: 7 }, storeAdapter() );
		const first = capturedUrls();
		await captureWebsite( { url: sourceUrl, outputDir: root, routeLimit: 7 }, storeAdapter() );
		expect( capturedUrls() ).toEqual( first );
		expect( first ).toHaveLength( 7 );
		expect( first[ 0 ] ).toBe( sourceUrl );
		await captureWebsite( { url: sourceUrl, outputDir: root, routeLimit: 1 }, storeAdapter() );
		expect( capturedUrls() ).toEqual( [ sourceUrl ] );
	} );

	it( "captures the whole inventory with routeLimit 'all'", async () => {
		const result = await captureWebsite( { url: sourceUrl, outputDir: root, routeLimit: 'all' }, storeAdapter() );
		const call = captureScreenshotsMock.mock.calls.at( -1 )![ 0 ] as { urls: string[]; limit?: number };
		expect( call.urls ).toHaveLength( store.length + 1 );
		expect( call.limit ).toBeUndefined();
		expect( result.summary.routesOmitted ).toBe( 0 );
		expect( result.discoveryDiagnostics.filter( row => row.code === 'route_omitted_by_budget' ) ).toEqual( [] );
	} );

	it.each( [ 0, -1, 1.5, 'some' ] )( 'rejects routeLimit %s before any fetch or browser', async ( routeLimit ) => {
		await expect( captureWebsite( { url: sourceUrl, outputDir: root, routeLimit: routeLimit as number }, storeAdapter() ) )
			.rejects.toThrow( "routeLimit must be a positive integer or 'all'" );
		expect( captureScreenshotsMock ).not.toHaveBeenCalled();
	} );

	it( 'counts frontier budget omissions once and keeps them out of failure and completeness', async () => {
		const linked = 'https://example.com/linked-only/';
		captureScreenshotsMock.mockImplementationOnce( async ( { urls }: { urls: string[] } ) => ( {
			urls, captured: urls.length, skipped: 0, failed: 0, durationMs: 1,
			linkedPageCoverage: {
				limits: { maxPages: 256, maxDepth: 8, timeoutMs: 1_800_000 },
				requiredUrls: [ ...urls, linked, store[ 1 ]! ],
				scheduled: urls.length,
				// One linked route is new; the other is an inventory route the
				// initial selection already omitted.
				diagnostics: [ linked, store[ 1 ]! ].map( url => ( { code: 'route_omitted_by_budget', url, reason: 'Outside the route budget of 3 routes' } ) ),
			},
		} ) as Awaited< ReturnType< typeof captureScreenshotsMock > > );
		const result = await captureWebsite( { url: sourceUrl, outputDir: root, routeLimit: 3 }, storeAdapter() );
		expect( capturedUrls() ).toHaveLength( 3 );
		expect( result.summary ).toMatchObject( { routesDiscovered: 3, routesCaptured: 3, routesFailed: 0, routesOmitted: store.length + 1 - 3 + 1 } );
		expect( result.discoveryDiagnostics.filter( row => row.url === store[ 1 ] ) ).toHaveLength( 1 );
		expect( result.discoveryDiagnostics.filter( row => row.url === linked ) ).toHaveLength( 1 );
		expect( result.complete ).toBe( true );
	} );

	it( 'reports links to omitted routes with their own reason and stays complete under strict', async () => {
		const realExport = await vi.importActual< typeof import('./capture-export.js') >( './capture-export.js' );
		vi.mocked( exportWebsiteCapture ).mockImplementationOnce( realExport.exportWebsiteCapture );
		const kept = 'https://example.com/kept';
		const omitted = 'https://example.com/omitted';
		captureScreenshotsMock.mockResolvedValueOnce( { urls: [ sourceUrl, kept ], captured: 2, skipped: 0, failed: 0, durationMs: 1 } );
		for ( const directory of [ 'html', 'screenshots' ] ) mkdirSync( join( root, directory ), { recursive: true } );
		writeFileSync( join( root, 'html', 'home.html' ), '<h1>Home</h1><a href="/omitted">Omitted</a><a href="/kept">Kept</a>' );
		writeFileSync( join( root, 'html', 'kept.html' ), '<h1>Kept</h1>' );
		writeFileSync( join( root, 'screenshots', 'manifest.json' ), JSON.stringify( {
			version: 1, entries: { [ sourceUrl ]: { html: 'html/home.html' }, [ kept ]: { html: 'html/kept.html' } },
		} ) );
		const result = await captureWebsite( { url: sourceUrl, outputDir: root, routeLimit: 2, strict: true }, {
			findAdapter: () => ( {
				id: 'generic', platform: 'generic',
				discover: async () => ( { urls: [ omitted, kept ].map( url => ( { url, type: 'page' } ) ) } ),
				extract: async () => ( { title: '', content: '' } ),
			} ),
		} );
		expect( capturedUrls() ).toEqual( [ sourceUrl, kept ] );
		expect( result.unresolvedAnchors ).toEqual( [ { sourceUrl, url: omitted, reason: 'target route was omitted by the route budget' } ] );
		expect( result.summary ).toMatchObject( { routesOmitted: 1, routesFailed: 0, complete: true } );
		const receipt = JSON.parse( readFileSync( result.captureReceiptPath, 'utf8' ) );
		expect( receipt.summary ).toMatchObject( { routesOmitted: 1, complete: true } );
		expect( receipt.discoveryDiagnostics ).toEqual( [ { code: 'route_omitted_by_budget', url: omitted, reason: 'Outside the route budget of 2 routes' } ] );
	} );
} );

describe( 'captureWebsite phase progress', () => {
	afterEach( () => {
		captureScreenshotsMock.mockClear();
		rmSync( root, { recursive: true, force: true } );
	} );

	it( 'reports media acquisition separately from browser capture and export', async () => {
		const phases: string[] = [];
		await captureWebsite(
			{ url: sourceUrl, outputDir: root, onProgress: ( event ) => phases.push( event.phase ) },
			{
				findAdapter: () => ( {
					id: 'generic',
					platform: 'generic',
					discover: async () => ( { urls: [] } ),
					extract: async () => ( { title: '', content: '' } ),
				} ),
			}
		);

		expect( phases ).toEqual( [ 'discovering', 'capturing', 'media', 'finalizing', 'complete' ] );
	} );
} );

describe( 'isUsableCapture policy', () => {
	const capture = ( failed: number, discovered: number, entrypointCaptured = true ) => ( {
		complete: false, entrypointCaptured, missingRoutes: Array.from( { length: failed }, () => ( {} ) ), summary: { routesDiscovered: discovered },
	} );
	it( 'allows max(1, 10%) failed routes', () => {
		expect( isUsableCapture( capture( 1, 12 ) ) ).toBe( true );
		expect( isUsableCapture( capture( 2, 12 ) ) ).toBe( false );
		expect( isUsableCapture( capture( 5, 52 ) ) ).toBe( true );
		expect( isUsableCapture( capture( 6, 52 ) ) ).toBe( false );
	} );
	it( 'is unusable without the entrypoint, whatever happened elsewhere', () => {
		expect( isUsableCapture( capture( 0, 12, false ) ) ).toBe( false );
		expect( isUsableCapture( { ...capture( 0, 12, false ), complete: true } ) ).toBe( false );
	} );
} );
