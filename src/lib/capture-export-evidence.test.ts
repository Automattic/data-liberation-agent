import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MediaStubStore } from './resume-state/index.js';
import { collectAssetEvidenceReferences, writeCaptureEvidence, UNCAPTURED_ROUTE_REASON, type CaptureEvidenceInput } from './capture-export-evidence.js';

it.each( [ 'http', 'missing-route' ] )( 'keeps receipt and sidecar completeness/profile decisions coherent for %s', ( mode ) => {
	const root = mkdtempSync( join( tmpdir(), 'capture-evidence-' ) );
	try {
		const captureRoot = join( root, 'capture' );
		const stageRoot = join( root, 'stage' );
		mkdirSync( captureRoot );
		mkdirSync( join( stageRoot, 'website' ), { recursive: true } );
		writeFileSync( join( stageRoot, 'website', 'index.html' ), '<main>Evidence</main>' );
		const identityHtmlPath = join( stageRoot, 'identity.html' );
		writeFileSync( identityHtmlPath, '<main>Evidence</main>' );
		const resourceManifest = { version: 1 as const, resources: {}, failures: [] };
		const references = collectAssetEvidenceReferences( [], () => 'index.html', resourceManifest, captureRoot );
		const input: CaptureEvidenceInput = {
			locations: { captureRoot, stageRoot },
			source: { sourceUrl: 'https://example.test/', platform: 'generic', summary: { routesFailed: 0 }, failures: [] },
			capture: {
				entries: { 'https://example.test/': { nativeViewTimelines: { desktop: {
					path: 'native-view-timelines/home.desktop.json', preserved: 0,
					losses: [ { target: 'n1', reason: 'range is unproven' } ], status: 'unproven', failures: [],
				} } } }, absentRoutes: new Set(), interactivity: [],
				...( mode === 'http' ? { http: { acquisition: { method: 'http' }, diagnostics: [] } } : {} ),
			},
			pages: [ { slug: 'home', url: 'https://example.test/', routePath: 'index.html', identityHtmlPath, hasMobileDocument: true } ],
			routes: { retained: [ { url: 'https://example.test/', path: 'website/index.html' } ], excluded: [], duplicates: [] },
			states: { interactions: [], scroll: [] },
			layout: { switchWidths: [ 751, 768 ], fluidReports: [ { applied: 5, unmodelled: 1, breakpoints: [ 751, 390, 751 ], byKind: {} } ] },
			assets: {
				references, stubs: MediaStubStore.load( captureRoot ), manifest: resourceManifest, portablePaths: new Map(), files: [],
				media: { selected_count: 0, selected_bytes: 0, retained_external_count: 0, max_bytes: 1000, reserved_bytes: 0 },
			},
			diagnostics: {
				capture: [], dependencies: [], media: [], rejectedKeys: new Set( [ '/' ] ),
				anchors: mode === 'missing-route' ? [ { sourceUrl: 'https://example.test/', reason: UNCAPTURED_ROUTE_REASON } ] : [],
				styles: { hoistedStylesheets: 0, diagnostics: [], diagnosticCounts: {}, diagnosticsTruncated: false },
			},
		};
		const receiptPath = writeCaptureEvidence( input );
		const receipt = JSON.parse( readFileSync( receiptPath, 'utf8' ) );
		const diagnostics = JSON.parse( readFileSync( join( stageRoot, 'diagnostics.json' ), 'utf8' ) );
		const profile = JSON.parse( readFileSync( join( stageRoot, 'source-profile.json' ), 'utf8' ) );
		expect( receipt.summary.complete ).toBe( false );
		expect( diagnostics.complete ).toBe( receipt.summary.complete );
		expect( receipt.sourceProfile ).toEqual( profile );
		expect( profile.geometry ).toBe( mode === 'http' ? 'unverified' : 'mixed' );
		expect( profile.breakpoints ).toEqual( [ 390, 751 ] );
		expect( profile.switchWidth ).toBe( 768 );
		expect( profile.documentsPerRoute ).toBe( 2 );
		expect( diagnostics.interactions ).toEqual( receipt.interactions );
		expect( diagnostics.scrollStates ).toEqual( receipt.scrollStates );
		expect( diagnostics.portableMedia ).toEqual( receipt.portableMedia );
		expect( diagnostics.nativeViewTimelines ).toEqual( receipt.nativeViewTimelines );
		expect( receipt.nativeViewTimelines.pages ).toEqual( [ { url: 'https://example.test/', profiles: input.capture.entries[ 'https://example.test/' ].nativeViewTimelines } ] );
		expect( diagnostics.unresolvedMedia ).toEqual( [ { url: '/', error: 'skipped degenerate replacement key' } ] );
		expect( receipt.layoutGeometry ).toEqual( JSON.parse( readFileSync( join( stageRoot, 'layout-geometry-report.json' ), 'utf8' ) ) );
		expect( existsSync( join( stageRoot, 'interaction-states.json' ) ) ).toBe( false );
		expect( existsSync( join( captureRoot, 'capture-receipt.json' ) ) ).toBe( false );
	} finally { rmSync( root, { recursive: true, force: true } ); }
} );
