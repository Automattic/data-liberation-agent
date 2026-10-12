import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCaptureFindings, CAPTURE_FINDINGS_SCHEMA, MAX_CAPTURE_FINDINGS, writeCaptureFindings, type CaptureFindingsInput } from './capture-findings.js';

const summary = { routesDiscovered: 4, routesCaptured: 2, routesFailed: 2, routesOmitted: 1 };

const input = ( discoveryDiagnostics: CaptureFindingsInput['discoveryDiagnostics'], overrides: Partial< CaptureFindingsInput > = {} ): CaptureFindingsInput => ( {
	complete: false, entrypointCaptured: true, summary, unresolvedAnchors: [], discoveryDiagnostics, ...overrides,
} );

describe( 'capture findings', () => {
	const directories: string[] = [];
	afterEach( () => {
		for ( const directory of directories.splice( 0 ) ) rmSync( directory, { recursive: true, force: true } );
	} );

	it( 'keeps loss rows, drops discovery evidence and sorts deterministically', () => {
		const rows: CaptureFindingsInput['discoveryDiagnostics'] = [
			{ code: 'stylesheet_unparseable', url: 'https://example.test/', reason: 'bad css', unit: 'stylesheet', severity: 'warning', path: 'website/assets/site.css' },
			{ code: 'route_omitted_by_budget', url: 'https://example.test/later/', reason: 'outside the route budget' },
			{ code: 'sitemap_unreadable', url: 'https://example.test/sitemap.xml', reason: 'HTTP 500' },
			{ code: 'route_capture_failed', url: 'https://example.test/slow/', reason: 'deadline' },
			{ code: 'route_profile_uncaptured', url: 'https://example.test/', reason: 'no tablet document', unit: 'profile', severity: 'error', profile: 'tablet' },
			{ code: 'route_path_collision', url: 'https://example.test/a.html', reason: 'path claimed', unit: 'route', severity: 'error', path: 'website/a/index.html' },
			{ code: 'route_path_collision', url: 'https://example.test/a.html', reason: 'path claimed', unit: 'route', severity: 'error', path: 'website/a/index.html' },
		];
		const findings = buildCaptureFindings( input( rows, { unresolvedAnchors: [ {}, {} ] } ) );
		expect( findings ).toEqual( {
			schema: CAPTURE_FINDINGS_SCHEMA,
			entrypoint: 'index.html',
			complete: false,
			usable: false,
			summary: { routes_discovered: 4, routes_captured: 2, routes_failed: 2, routes_omitted: 1, unresolved_anchors: 2 },
			findings: [
				{ code: 'route_profile_uncaptured', severity: 'error', unit: 'profile', url: 'https://example.test/', profile: 'tablet', reason: 'no tablet document' },
				{ code: 'stylesheet_unparseable', severity: 'warning', unit: 'stylesheet', url: 'https://example.test/', path: 'assets/site.css', reason: 'bad css' },
				{ code: 'route_path_collision', severity: 'error', unit: 'route', url: 'https://example.test/a.html', path: 'a/index.html', reason: 'path claimed' },
				{ code: 'route_capture_failed', severity: 'error', unit: 'route', url: 'https://example.test/slow/', reason: 'deadline' },
			],
			omitted_findings: 0,
			missing_routes: [
				{ url: 'https://example.test/a.html', code: 'route_path_collision', reason: 'path claimed' },
				{ url: 'https://example.test/slow/', code: 'route_capture_failed', reason: 'deadline' },
			],
		} );
		expect( buildCaptureFindings( input( [ ...rows ].reverse(), { unresolvedAnchors: [ {}, {} ] } ) ) ).toEqual( findings );
	} );

	it( 'bounds the finding rows and counts the rest', () => {
		const rows = Array.from( { length: MAX_CAPTURE_FINDINGS + 3 }, ( _, index ) => ( {
			code: 'route_off_origin', url: `https://other.test/${ String( index ).padStart( 4, '0' ) }`, reason: 'off origin', unit: 'route' as const, severity: 'warning' as const,
		} ) );
		const findings = buildCaptureFindings( input( rows, { complete: true } ) );
		expect( findings.findings ).toHaveLength( MAX_CAPTURE_FINDINGS );
		expect( findings.omitted_findings ).toBe( 3 );
		expect( findings.usable ).toBe( true );
	} );

	it( 'writes the file at the website root', () => {
		const outputDir = mkdtempSync( join( tmpdir(), 'capture-findings-' ) );
		directories.push( outputDir );
		const path = writeCaptureFindings( outputDir, input( [], { complete: true } ) );
		expect( path ).toBe( join( outputDir, 'website', 'capture-findings.json' ) );
		expect( JSON.parse( readFileSync( path, 'utf8' ) ) ).toMatchObject( { schema: CAPTURE_FINDINGS_SCHEMA, complete: true, usable: true, findings: [], missing_routes: [] } );
	} );
} );
