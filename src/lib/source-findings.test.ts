import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCaptureFindings, MAX_CAPTURE_FINDINGS, writeCaptureFindings, type CaptureFindingsInput } from './capture-findings.js';
import { MISSING_ROUTE_CODES } from './capture-usability.js';
import {
	buildSourceFindings, DEFAULT_SOURCE_FINDING_LOSS_CLASS, SOURCE_FINDING_LOSS_CLASSES, SOURCE_FINDINGS_SCHEMA, sourceFindingLossClass,
} from './source-findings.js';

const summary = { routesDiscovered: 4, routesCaptured: 2, routesFailed: 2, routesOmitted: 1 };

const input = ( discoveryDiagnostics: CaptureFindingsInput['discoveryDiagnostics'], overrides: Partial< CaptureFindingsInput > = {} ): CaptureFindingsInput => ( {
	complete: false, entrypointCaptured: true, summary, unresolvedAnchors: [], discoveryDiagnostics, ...overrides,
} );

const rows: CaptureFindingsInput['discoveryDiagnostics'] = [
	{ code: 'stylesheet_unparseable', url: 'https://example.test/', reason: 'bad css', unit: 'stylesheet', severity: 'warning', path: 'website/assets/site.css' },
	{ code: 'route_omitted_by_budget', url: 'https://example.test/later/', reason: 'outside the route budget' },
	{ code: 'route_capture_failed', url: 'https://example.test/slow/', reason: 'deadline' },
	{ code: 'route_profile_uncaptured', url: 'https://example.test/', reason: 'no tablet document', unit: 'profile', severity: 'error', profile: 'tablet' },
	{ code: 'route_path_collision', url: 'https://example.test/a.html', reason: 'path claimed', unit: 'route', severity: 'error', path: 'website/a/index.html' },
	{ code: 'asset_exceeds_file_limit', url: 'https://example.test/big.mp4', reason: 'over the limit', unit: 'asset', severity: 'warning', metrics: { bytes: 4096, limit: 2048 } },
	{ code: 'disclosure_unrestored', url: 'https://example.test/', reason: 'baseline not restored', unit: 'block', severity: 'error', profile: 'desktop' },
];

describe( 'source findings (static-site-importer/source-findings/v1)', () => {
	const directories: string[] = [];
	afterEach( () => {
		for ( const directory of directories.splice( 0 ) ) rmSync( directory, { recursive: true, force: true } );
	} );

	it( 'owns the capture code -> loss class mapping Static Site Importer applied before #787', () => {
		// static-site-importer includes/class-static-site-importer-diagnostic-loss-classes.php, REPORTED_LOSS_CODES.
		expect( SOURCE_FINDING_LOSS_CLASSES ).toEqual( {
			route_capture_failed: { loss_class: 'omitted_unit', unit: 'route' },
			route_export_failed: { loss_class: 'omitted_unit', unit: 'route' },
			route_path_collision: { loss_class: 'omitted_unit', unit: 'route' },
			route_off_origin: { loss_class: 'omitted_unit', unit: 'route' },
			route_profile_uncaptured: { loss_class: 'omitted_unit', unit: 'profile' },
			route_capture_skipped_budget: { loss_class: 'omitted_unit', unit: 'route' },
			asset_exceeds_file_limit: { loss_class: 'omitted_unit', unit: 'asset' },
			route_capture_degraded: { loss_class: 'degraded_unit', unit: 'route' },
			stylesheet_unparseable: { loss_class: 'degraded_unit', unit: 'stylesheet' },
			native_timeline_unproven: { loss_class: 'degraded_unit', unit: 'block' },
			disclosure_unrestored: { loss_class: 'degraded_unit', unit: 'block' },
		} );
		// Every missing route is an omitted route.
		for ( const code of MISSING_ROUTE_CODES ) expect( SOURCE_FINDING_LOSS_CLASSES[ code ] ).toEqual( { loss_class: 'omitted_unit', unit: 'route' } );
		// A capture code without an entry is still a unit loss.
		expect( DEFAULT_SOURCE_FINDING_LOSS_CLASS ).toBe( 'degraded_unit' );
		expect( sourceFindingLossClass( 'some_new_capture_code' ) ).toEqual( { loss_class: 'degraded_unit' } );
	} );

	it( 'projects every capture finding into a self-describing row', () => {
		const capture = buildCaptureFindings( input( rows, { unresolvedAnchors: [ {} ] } ) );
		const source = buildSourceFindings( capture );
		expect( source ).toEqual( {
			schema: SOURCE_FINDINGS_SCHEMA,
			entrypoint: 'index.html',
			complete: false,
			usable: false,
			summary: { routes_discovered: 4, routes_captured: 2, routes_failed: 2, routes_omitted: 1, unresolved_anchors: 1, omitted_findings: 0 },
			findings: [
				{ code: 'disclosure_unrestored', severity: 'error', unit: 'block', loss_class: 'degraded_unit', location: { url: 'https://example.test/' }, message: 'baseline not restored', owning_layer: 'data-liberation-agent' },
				{ code: 'route_profile_uncaptured', severity: 'error', unit: 'profile', loss_class: 'omitted_unit', location: { url: 'https://example.test/' }, message: 'no tablet document', owning_layer: 'data-liberation-agent' },
				{ code: 'stylesheet_unparseable', severity: 'warning', unit: 'stylesheet', loss_class: 'degraded_unit', location: { url: 'https://example.test/', path: 'assets/site.css' }, message: 'bad css', owning_layer: 'data-liberation-agent' },
				{ code: 'route_path_collision', severity: 'error', unit: 'route', loss_class: 'omitted_unit', location: { url: 'https://example.test/a.html', path: 'a/index.html' }, message: 'path claimed', owning_layer: 'data-liberation-agent' },
				{ code: 'asset_exceeds_file_limit', severity: 'warning', unit: 'asset', loss_class: 'omitted_unit', location: { url: 'https://example.test/big.mp4' }, message: 'over the limit', metrics: { bytes: 4096, limit: 2048 }, owning_layer: 'data-liberation-agent' },
				{ code: 'route_capture_failed', severity: 'error', unit: 'route', loss_class: 'omitted_unit', location: { url: 'https://example.test/slow/' }, message: 'deadline', owning_layer: 'data-liberation-agent' },
			],
		} );
		// Deterministic: the order of the input rows does not matter.
		expect( buildSourceFindings( buildCaptureFindings( input( [ ...rows ].reverse(), { unresolvedAnchors: [ {} ] } ) ) ) ).toEqual( source );
	} );

	it( 'keeps the capture cap and still reports every missing route', () => {
		const offOrigin = Array.from( { length: MAX_CAPTURE_FINDINGS }, ( _, index ) => ( {
			code: 'route_off_origin', url: `https://a.test/${ String( index ).padStart( 4, '0' ) }`, reason: 'off origin', unit: 'route' as const, severity: 'warning' as const,
		} ) );
		// Sorted after every off-origin row, so the capture cap leaves it out.
		const missing = { code: 'route_capture_skipped_budget', url: 'https://z.test/late/', reason: 'time budget spent', unit: 'route' as const, severity: 'error' as const, metrics: { timeBudgetMs: 1000 } };
		const capture = buildCaptureFindings( input( [ ...offOrigin, missing ] ) );
		expect( capture.findings ).toHaveLength( MAX_CAPTURE_FINDINGS );
		expect( capture.omitted_findings ).toBe( 1 );
		const source = buildSourceFindings( capture );
		expect( source.summary.omitted_findings ).toBe( 1 );
		expect( source.findings ).toHaveLength( MAX_CAPTURE_FINDINGS + 1 );
		expect( source.findings.at( -1 ) ).toEqual( {
			code: 'route_capture_skipped_budget', severity: 'error', unit: 'route', loss_class: 'omitted_unit',
			location: { url: 'https://z.test/late/' }, message: 'time budget spent', owning_layer: 'data-liberation-agent',
		} );
	} );

	it( 'writes both findings files at the website root from the same rows', () => {
		const outputDir = mkdtempSync( join( tmpdir(), 'source-findings-' ) );
		directories.push( outputDir );
		writeCaptureFindings( outputDir, input( rows ) );
		const capture = JSON.parse( readFileSync( join( outputDir, 'website', 'capture-findings.json' ), 'utf8' ) );
		const source = JSON.parse( readFileSync( join( outputDir, 'website', 'source-findings.json' ), 'utf8' ) );
		expect( source ).toEqual( buildSourceFindings( capture ) );
		expect( source.schema ).toBe( SOURCE_FINDINGS_SCHEMA );
		for ( const key of [ 'entrypoint', 'complete', 'usable' ] as const ) expect( source[ key ] ).toBe( capture[ key ] );
		expect( source.findings.map( ( row: { code: string; location: { url: string; path?: string }; severity: string } ) => [ row.code, row.location.url, row.location.path, row.severity ] ) )
			.toEqual( capture.findings.map( ( row: { code: string; url: string; path?: string; severity: string } ) => [ row.code, row.url, row.path, row.severity ] ) );
		for ( const route of capture.missing_routes ) {
			expect( source.findings ).toContainEqual( expect.objectContaining( { code: route.code, location: expect.objectContaining( { url: route.url } ), loss_class: 'omitted_unit', unit: 'route' } ) );
		}
		for ( const row of source.findings ) {
			expect( [ 'warning', 'error', 'info' ] ).toContain( row.severity );
			expect( [ 'route', 'page', 'block', 'asset', 'stylesheet', 'profile', 'item', 'file' ] ).toContain( row.unit );
			expect( [ 'omitted_unit', 'degraded_unit' ] ).toContain( row.loss_class );
			expect( row.owning_layer ).toBe( 'data-liberation-agent' );
		}
	} );
} );
