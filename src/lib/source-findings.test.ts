import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MISSING_ROUTE_CODES } from './capture-usability.js';
import {
	buildSourceFindings, DEFAULT_SOURCE_FINDING_LOSS_CLASS, MAX_SOURCE_FINDINGS, SOURCE_FINDING_LOSS_CLASSES, SOURCE_FINDINGS_SCHEMA,
	sourceFindingLossClass, writeSourceFindings, type SourceFindingsInput,
} from './source-findings.js';

const summary = { routesDiscovered: 4, routesCaptured: 2, routesFailed: 2, routesOmitted: 1 };

const input = ( discoveryDiagnostics: SourceFindingsInput['discoveryDiagnostics'], overrides: Partial< SourceFindingsInput > = {} ): SourceFindingsInput => ( {
	complete: false, entrypointCaptured: true, summary, unresolvedAnchors: [], discoveryDiagnostics, ...overrides,
} );

const owning_layer = 'data-liberation-agent';

const rows: SourceFindingsInput['discoveryDiagnostics'] = [
	{ code: 'stylesheet_unparseable', url: 'https://example.test/', reason: 'bad css', unit: 'stylesheet', severity: 'warning', path: 'website/assets/site.css' },
	{ code: 'route_omitted_by_budget', url: 'https://example.test/later/', reason: 'outside the route budget' },
	{ code: 'sitemap_unreadable', url: 'https://example.test/sitemap.xml', reason: 'HTTP 500' },
	{ code: 'route_capture_failed', url: 'https://example.test/slow/', reason: 'deadline' },
	{ code: 'route_profile_uncaptured', url: 'https://example.test/', reason: 'no tablet document', unit: 'profile', severity: 'error', profile: 'tablet' },
	{ code: 'route_path_collision', url: 'https://example.test/a.html', reason: 'path claimed', unit: 'route', severity: 'error', path: 'website/a/index.html' },
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
		// static-site-importer includes/class-static-site-importer-diagnostic-loss-classes.php, REPORTED_LOSS_CODES, before #787.
		expect( SOURCE_FINDING_LOSS_CLASSES ).toEqual( {
			route_capture_failed: { loss_class: 'omitted_unit', unit: 'route' },
			route_export_failed: { loss_class: 'omitted_unit', unit: 'route' },
			route_path_collision: { loss_class: 'omitted_unit', unit: 'route' },
			route_off_origin: { loss_class: 'omitted_unit', unit: 'route' },
			route_profile_uncaptured: { loss_class: 'omitted_unit', unit: 'profile' },
			route_capture_skipped_budget: { loss_class: 'omitted_unit', unit: 'route' },
			route_capture_timeout: { loss_class: 'omitted_unit', unit: 'route' },
			asset_exceeds_file_limit: { loss_class: 'omitted_unit', unit: 'asset' },
			asset_exceeds_total_budget: { loss_class: 'omitted_unit', unit: 'asset' },
			route_exceeds_total_budget: { loss_class: 'omitted_unit', unit: 'route' },
			route_capture_degraded: { loss_class: 'degraded_unit', unit: 'route' },
			route_template_derived: { loss_class: 'degraded_unit', unit: 'route' },
			template_slot_runtime_unobserved: { loss_class: 'degraded_unit', unit: 'block' },
			stylesheet_unparseable: { loss_class: 'degraded_unit', unit: 'stylesheet' },
			native_timeline_unproven: { loss_class: 'degraded_unit', unit: 'block' },
			disclosure_unrestored: { loss_class: 'degraded_unit', unit: 'block' },
		} );
		for ( const code of MISSING_ROUTE_CODES ) expect( SOURCE_FINDING_LOSS_CLASSES[ code ] ).toEqual( { loss_class: 'omitted_unit', unit: 'route' } );
		expect( DEFAULT_SOURCE_FINDING_LOSS_CLASS ).toBe( 'degraded_unit' );
		expect( sourceFindingLossClass( 'some_new_capture_code' ) ).toEqual( { loss_class: 'degraded_unit' } );
	} );

	it( 'keeps loss rows as self-describing rows, drops discovery evidence and sorts deterministically', () => {
		const findings = buildSourceFindings( input( rows, { unresolvedAnchors: [ {} ] } ) );
		expect( findings ).toEqual( {
			schema: SOURCE_FINDINGS_SCHEMA,
			entrypoint: 'index.html',
			complete: false,
			usable: false,
			summary: { routes_discovered: 4, routes_captured: 2, routes_failed: 2, routes_omitted: 1, unresolved_anchors: 1, omitted_findings: 0 },
			findings: [
				{ code: 'disclosure_unrestored', severity: 'error', unit: 'block', loss_class: 'degraded_unit', location: { url: 'https://example.test/', profile: 'desktop' }, message: 'baseline not restored', owning_layer },
				{ code: 'route_profile_uncaptured', severity: 'error', unit: 'profile', loss_class: 'omitted_unit', location: { url: 'https://example.test/', profile: 'tablet' }, message: 'no tablet document', owning_layer },
				{ code: 'stylesheet_unparseable', severity: 'warning', unit: 'stylesheet', loss_class: 'degraded_unit', location: { url: 'https://example.test/', path: 'assets/site.css' }, message: 'bad css', owning_layer },
				{ code: 'route_path_collision', severity: 'error', unit: 'route', loss_class: 'omitted_unit', location: { url: 'https://example.test/a.html', path: 'a/index.html' }, message: 'path claimed', owning_layer },
				{ code: 'asset_exceeds_file_limit', severity: 'warning', unit: 'asset', loss_class: 'omitted_unit', location: { url: 'https://example.test/big.mp4' }, message: 'over the limit', metrics: { bytes: 4096, limit: 2048 }, owning_layer },
				{ code: 'route_capture_failed', severity: 'error', unit: 'route', loss_class: 'omitted_unit', location: { url: 'https://example.test/slow/' }, message: 'deadline', owning_layer },
			],
		} );
		expect( buildSourceFindings( input( [ ...rows ].reverse(), { unresolvedAnchors: [ {} ] } ) ) ).toEqual( findings );
	} );

	it( 'bounds the loss rows and still reports every missing route', () => {
		const offOrigin = Array.from( { length: MAX_SOURCE_FINDINGS + 2 }, ( _, index ) => ( {
			code: 'route_off_origin', url: `https://a.test/${ String( index ).padStart( 4, '0' ) }`, reason: 'off origin', unit: 'route' as const, severity: 'warning' as const,
		} ) );
		// Sorted after every off-origin row, so the cap leaves it out of the bounded rows.
		const missing = { code: 'route_capture_skipped_budget', url: 'https://z.test/late/', reason: 'time budget spent', unit: 'route' as const, severity: 'error' as const, metrics: { timeBudgetMs: 1000 } };
		const findings = buildSourceFindings( input( [ ...offOrigin, missing ], { complete: true } ) );
		expect( findings.summary.omitted_findings ).toBe( 3 );
		expect( findings.findings ).toHaveLength( MAX_SOURCE_FINDINGS + 1 );
		expect( findings.findings.at( -1 ) ).toEqual( {
			code: 'route_capture_skipped_budget', severity: 'error', unit: 'route', loss_class: 'omitted_unit',
			location: { url: 'https://z.test/late/' }, message: 'time budget spent', owning_layer,
		} );
	} );

	it( 'writes only source-findings.json at the website root', () => {
		const outputDir = mkdtempSync( join( tmpdir(), 'source-findings-' ) );
		directories.push( outputDir );
		const path = writeSourceFindings( outputDir, input( rows ) );
		expect( path ).toBe( join( outputDir, 'website', 'source-findings.json' ) );
		const written = JSON.parse( readFileSync( path, 'utf8' ) );
		expect( written ).toEqual( buildSourceFindings( input( rows ) ) );
		for ( const row of written.findings ) {
			expect( [ 'warning', 'error', 'info' ] ).toContain( row.severity );
			expect( [ 'route', 'page', 'block', 'asset', 'stylesheet', 'profile', 'item', 'file' ] ).toContain( row.unit );
			expect( [ 'omitted_unit', 'degraded_unit' ] ).toContain( row.loss_class );
			expect( row.owning_layer ).toBe( owning_layer );
		}
	} );
} );
