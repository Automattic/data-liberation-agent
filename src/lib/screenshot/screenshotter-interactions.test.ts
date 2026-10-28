import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectBrowser } from '../browser-kit/index.js';
import { __resetSourceSessionsForTests } from '../browser-kit/browser-kit.js';
import { wireCapturedDialogs } from '../static-dialogs.js';
import { captureTriggeredDialogs } from './interaction-capture.js';
import { captureScreenshots } from './screenshotter.js';

vi.mock( '../url/index.js', async ( importOriginal ) => {
	const actual = ( await importOriginal() ) as Record< string, unknown >;
	return {
		...actual,
		slugify: ( url: string ) => new URL( url ).pathname.replace( /^\//, '' ) || 'homepage',
	};
} );

// Mock contexts carry no wire identity; source-identity.test.ts owns that contract.
vi.mock( '../browser-kit/source-identity.js', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import( '../browser-kit/source-identity.js' ) >() ),
	createSourceContext: ( browser: { newContext: ( options: unknown ) => unknown }, options: unknown ) => browser.newContext( options ),
} ) );
vi.mock( '../browser-kit/index.js', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import( '../browser-kit/index.js' ) >() ),
	connectBrowser: vi.fn(),
} ) );

vi.mock( './interaction-capture.js', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import( './interaction-capture.js' ) >() ),
	captureTriggeredDialogs: vi.fn(),
	captureRouteNavigation: vi.fn(),
} ) );

const LOCAL_TMP = join( process.cwd(), '.tmp-test' );
mkdirSync( LOCAL_TMP, { recursive: true } );

/** Stands in for the page the one-time session harvest navigates. */
function makeHarvestPage() {
	return { goto: vi.fn().mockResolvedValue( { status: () => 200 } ) };
}

function makePage() {
	let currentUrl = '';
	return {
		route: vi.fn().mockResolvedValue(undefined),
		unroute: vi.fn().mockResolvedValue(undefined),
		exposeBinding: vi.fn().mockResolvedValue(undefined),
		once: vi.fn(),
		goto: vi.fn().mockImplementation( async ( url: string ) => {
			currentUrl = url;
			return { status: () => 200 };
		} ),
		url: () => currentUrl,
		viewportSize: () => null,
		content: vi.fn().mockResolvedValue( '<html><body>Tianna Wolfson</body></html>' ),
		screenshot: vi.fn().mockResolvedValue( Buffer.from( 'fakepng' ) ),
		waitForLoadState: vi.fn().mockResolvedValue( undefined ),
		evaluate: vi.fn().mockImplementation( async ( fn: unknown ) => {
			const source = String( fn );
			if ( source.includes( 'ViewTimeline' ) ) return [];
			if ( source.includes( '__dlaCleanup' ) ) return { url: currentUrl, viewport: 1440, removed: 0, records: [], truncated: false, failures: [], residual: 0 };
			if ( source.includes( 'DOCTYPE' ) ) return '<html><body>Tianna Wolfson</body></html>';
			if ( source.includes( 'motionAnimatedElements' ) ) return { rows: [], landmarks: [] };
			if ( source.includes( 'scrollHeight' ) ) return 3000;
			if ( source.includes( 'scrollTo' ) ) return undefined;
			return {
				palette: [ { hex: currentUrl ? '#111111' : '#222222', count: 10 } ],
				typography: {},
				metadata: { title: '', metaDescription: '', openGraph: {}, jsonLdTypes: [], htmlBytes: 0 },
				breakpoints: { minWidth: [], maxWidth: [] },
			};
		} ),
	};
}

describe( 'captureScreenshots interactions', () => {
	// The session harvest (sourceContextOptions) caches per origin, and every
	// case here shares https://example.com — without a reset, only the first
	// case in the file would pay for (and consume a mocked page on) it.
	beforeEach( () => {
		__resetSourceSessionsForTests();
	} );

	it.each( [
		{ name: 'mobile first', viewportIds: [ 'mobile', 'desktop' ] as const, expectedCalls: 2 },
		{
			name: 'desktop false candidate first',
			viewportIds: [ 'desktop', 'mobile' ] as const,
			expectedCalls: 2,
		},
	] )(
		'captures a mobile-only Tianna dialog once with $name',
		async ( { viewportIds, expectedCalls } ) => {
			const outputDir = mkdtempSync( join( LOCAL_TMP, 'ss-' ) );
			const mobilePage = makePage();
			const desktopPage = makePage();
			// A leading entry for the one-time session-harvest page (see
			// sourceContextOptions in screenshotter.ts) — it navigates before
			// either real viewport capture, so it claims pages[0].
			const pages = [ makeHarvestPage(), ...viewportIds.map( ( id ) => ( id === 'mobile' ? mobilePage : desktopPage ) ) ];
			const captureDialogs = vi.mocked( captureTriggeredDialogs );
			captureDialogs.mockReset();
			let triggerClicks = 0;

			captureDialogs.mockImplementation( async ( page, sourceUrl ) => {
				if ( ( page as unknown ) === mobilePage ) {
					triggerClicks++;
					return {
						schema: 'blocks-engine-capture/interaction-states/v1',
						sourceUrl,
						viewport: { width: 402, height: 681 },
						capturedAt: '2026-08-25T00:00:00.000Z',
						states: [
							{
								status: 'captured',
								trigger: {
									selector: '#tianna-mobile-menu',
									tag: 'button',
									ariaHaspopup: 'dialog',
									dataBindings: {},
								},
								dialog: {
									selector: '#site-navigation',
									tag: 'dialog',
									id: 'site-navigation',
									ariaModal: true,
									html: '<dialog id="site-navigation">Tianna Wolfson</dialog>',
									htmlBytes: 60,
									htmlTruncated: false,
								},
							},
						],
					};
				}
				return {
					schema: 'blocks-engine-capture/interaction-states/v1',
					sourceUrl,
					viewport: { width: 1440, height: 900 },
					capturedAt: '2026-08-25T00:00:00.000Z',
					states: [
						{
							status: 'no-dialog',
							trigger: {
								selector: '#tianna-mobile-menu',
								tag: 'button',
								ariaHaspopup: 'dialog',
								dataBindings: {},
							},
						},
					],
				};
			} );

			const connect = connectBrowser as ReturnType< typeof vi.fn >;
			connect.mockReset();
			connect.mockResolvedValue( {
				newContext: vi.fn().mockImplementation( () =>
					Promise.resolve( {
						newPage: vi.fn().mockResolvedValue( pages.shift()! ),
						addInitScript: vi.fn().mockResolvedValue( undefined ),
						close: vi.fn().mockResolvedValue( undefined ),
						storageState: vi.fn().mockResolvedValue( { cookies: [], origins: [] } ),
					} )
				),
				close: vi.fn().mockResolvedValue( undefined ),
				isConnected: () => true,
			} );

			try {
				const result = await captureScreenshots( {
					urls: [ 'https://example.com/tianna' ],
					outputDir,
					concurrency: 1,
					settleMs: 0,
					captureImages: true,
					viewports: viewportIds.map( ( id ) =>
						id === 'mobile' ? { id, width: 402, height: 681 } : { id, width: 1440, height: 900 }
					),
				} );
				expect( result.failed ).toBe( 0 );
				expect( captureDialogs ).toHaveBeenCalledTimes( expectedCalls );
				expect( captureDialogs ).toHaveBeenCalledWith( mobilePage, 'https://example.com/tianna' );
				expect( triggerClicks ).toBe( 1 );
				expect( mobilePage.screenshot.mock.invocationCallOrder.at( -1 ) ).toBeLessThan(
					captureDialogs.mock.invocationCallOrder.at( -1 )!
				);
				const serializationOrder = mobilePage.evaluate.mock.invocationCallOrder.find(
					( _: number, index: number ) =>
						String( mobilePage.evaluate.mock.calls[ index ][ 0 ] ).includes( 'DOCTYPE' )
				);
				expect( serializationOrder! ).toBeLessThan(
					captureDialogs.mock.invocationCallOrder.at( -1 )!
				);

				const manifest = JSON.parse(
					readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' )
				);
				expect( manifest.entries[ 'https://example.com/tianna' ].interactions ).toMatchObject( {
					viewport: { width: 402, height: 681 },
					states: [
						{
							status: 'captured',
							trigger: { tag: 'button', ariaHaspopup: 'dialog' },
						},
					],
					} );
					expect( manifest.entries[ 'https://example.com/tianna' ].interactions.states ).toHaveLength( 1 );
			} finally {
				rmSync( outputDir, { recursive: true, force: true } );
			}
		}
	);

	it.each( [
		{ name: 'desktop first', viewportIds: [ 'desktop', 'mobile' ] as const },
		{ name: 'mobile first', viewportIds: [ 'mobile', 'desktop' ] as const },
	] )( 'retains distinct desktop and mobile dialogs with $name', async ( { viewportIds } ) => {
		const outputDir = mkdtempSync( join( LOCAL_TMP, 'ss-' ) );
		const desktopPage = makePage();
		const mobilePage = makePage();
		const pages = [ makeHarvestPage(), ...viewportIds.map( ( id ) => ( id === 'mobile' ? mobilePage : desktopPage ) ) ];
		const captureDialogs = vi.mocked( captureTriggeredDialogs );
		captureDialogs.mockReset();
		captureDialogs.mockImplementation( async ( page, sourceUrl ) => ( {
			schema: 'blocks-engine-capture/interaction-states/v1',
			sourceUrl,
			viewport:
				( page as unknown ) === mobilePage ? { width: 390, height: 844 } : { width: 1440, height: 900 },
			capturedAt: '2026-09-08T00:00:00.000Z',
			states: [ {
				status: 'captured',
				trigger: {
					selector: ( page as unknown ) === mobilePage ? '#mobile-menu' : '#desktop-dialog',
					id: ( page as unknown ) === mobilePage ? 'mobile-menu' : 'desktop-dialog',
					tag: 'button',
					ariaHaspopup: 'dialog',
					dataBindings: {},
				},
				dialog: {
					selector: '#dialog', tag: 'nav', ariaModal: true,
					html: '<nav><a href="/about">About</a></nav>', htmlBytes: 37, htmlTruncated: false,
				},
			} ],
		} ) );

		const connect = connectBrowser as ReturnType< typeof vi.fn >;
		connect.mockReset();
		connect.mockResolvedValue( {
			newContext: vi.fn().mockImplementation( () => Promise.resolve( {
				newPage: vi.fn().mockResolvedValue( pages.shift()! ),
				addInitScript: vi.fn().mockResolvedValue( undefined ), close: vi.fn().mockResolvedValue( undefined ),
				storageState: vi.fn().mockResolvedValue( { cookies: [], origins: [] } ),
			} ) ),
			close: vi.fn().mockResolvedValue( undefined ),
			isConnected: () => true,
		} );

		try {
			const result = await captureScreenshots( {
				urls: [ 'https://example.com/mobile-menu' ], outputDir, concurrency: 1, settleMs: 0, captureImages: true,
				viewports: viewportIds.map( ( id ) => id === 'mobile' ? { id, width: 390, height: 844 } : { id, width: 1440, height: 900 } ),
			} );
			expect( result.failed ).toBe( 0 );
			expect( captureDialogs ).toHaveBeenCalledTimes( 2 );
			const manifest = JSON.parse( readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' ) );
			const states = manifest.entries[ 'https://example.com/mobile-menu' ].interactions.states;
			expect( states ).toHaveLength( 2 );
			expect( states.map( ( state: { trigger: { selector: string } } ) => state.trigger.selector ) ).toEqual(
				expect.arrayContaining( [ '#desktop-dialog', '#mobile-menu' ] )
			);
			expect( wireCapturedDialogs(
				'<html><head></head><body><button id="desktop-dialog">Desktop</button><button id="mobile-menu">Mobile</button></body></html>', states
			).match( /data-blocks-engine-capture-dialog-trigger=/g ) ).toHaveLength( 2 );
		} finally {
			rmSync( outputDir, { recursive: true, force: true } );
		}
	} );

	// Interaction evidence is consumed per route, not per profile: mergeProfile
	// accepts desktop and mobile reports alone, and every downstream reader
	// (interaction-states.json, export media localization, fidelity) reads that
	// route-level report. An additional profile (an adapter's third document) is
	// still captured — its own HTML, screenshots and fluid geometry — but probing
	// it again produced evidence no stage read, so probing is per-device only.
	it( 'probes interactions for the per-device documents, never for an additional profile', async () => {
		const outputDir = mkdtempSync( join( LOCAL_TMP, 'ss-' ) );
		const desktopPage = makePage();
		const mobilePage = makePage();
		const tabletPage = makePage();
		const pages = [ makeHarvestPage(), desktopPage, mobilePage, tabletPage ];
		const captureDialogs = vi.mocked( captureTriggeredDialogs );
		captureDialogs.mockReset();
		captureDialogs.mockImplementation( async ( page, sourceUrl ) => ( {
			schema: 'blocks-engine-capture/interaction-states/v1',
			sourceUrl,
			viewport: ( page as unknown ) === mobilePage ? { width: 402, height: 681 } : { width: 1440, height: 900 },
			capturedAt: '2026-10-13T00:00:00.000Z',
			states: [ {
				status: 'captured',
				trigger: {
					selector: ( page as unknown ) === mobilePage ? '#mobile-menu' : '#desktop-dialog',
					id: ( page as unknown ) === mobilePage ? 'mobile-menu' : 'desktop-dialog',
					tag: 'button',
					ariaHaspopup: 'dialog',
					dataBindings: {},
				},
				dialog: {
					selector: '#dialog', tag: 'nav', ariaModal: true,
					html: '<nav><a href="/about">About</a></nav>', htmlBytes: 37, htmlTruncated: false,
				},
			} ],
		} ) );

		const connect = connectBrowser as ReturnType< typeof vi.fn >;
		connect.mockReset();
		connect.mockResolvedValue( {
			newContext: vi.fn().mockImplementation( () =>
				Promise.resolve( {
					newPage: vi.fn().mockResolvedValue( pages.shift()! ),
					addInitScript: vi.fn().mockResolvedValue( undefined ),
					close: vi.fn().mockResolvedValue( undefined ),
					storageState: vi.fn().mockResolvedValue( { cookies: [], origins: [] } ),
				} )
			),
			close: vi.fn().mockResolvedValue( undefined ),
			isConnected: () => true,
		} );

		try {
			const result = await captureScreenshots( {
				urls: [ 'https://example.com/third-document' ], outputDir, concurrency: 1, settleMs: 0, captureImages: true,
				viewports: [ { id: 'desktop', width: 1440, height: 900 }, { id: 'mobile', width: 402, height: 681 }, { id: 'tablet', width: 768, height: 900 } ],
			} );
			expect( result.failed ).toBe( 0 );
			expect( captureDialogs ).toHaveBeenCalledTimes( 2 );
			expect( captureDialogs ).toHaveBeenCalledWith( desktopPage, 'https://example.com/third-document' );
			expect( captureDialogs ).toHaveBeenCalledWith( mobilePage, 'https://example.com/third-document' );
			const manifest = JSON.parse(
				readFileSync( join( outputDir, 'screenshots', 'manifest.json' ), 'utf8' )
			) as { entries: Record<string, { interactions?: unknown; profiles: Record<string, { interactions?: unknown; html?: string }> }> };
			const route = manifest.entries[ 'https://example.com/third-document' ];
			// The additional profile keeps its own captured document but records no
			// probed evidence, and the route report still carries the device probes.
			expect( route.profiles.tablet?.html ).toMatch( /^html-tablet\// );
			expect( route.profiles.tablet?.interactions ).toBeUndefined();
			expect( route.interactions ).toBeDefined();
		} finally {
			rmSync( outputDir, { recursive: true, force: true } );
		}
	} );
} );
