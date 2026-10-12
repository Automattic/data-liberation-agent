import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteDiagnostic } from './capture-export-routes.js';
import { isUsableCapture, missingRoutes, type MissingRoute } from './capture-usability.js';

/**
 * Capture findings that travel inside the exported website artifact.
 *
 * The capture receipt and `diagnostics.json` sit next to `website/`, so an
 * importer that only receives the website artifact never sees which routes were
 * dropped or degraded. This small, static JSON file at the website root carries
 * the loss rows with the artifact. See docs/contracts/loss-ledger.md.
 */
export const CAPTURE_FINDINGS_SCHEMA = 'data-liberation-agent/capture-findings/v1';

/** File name at the website root (`website/capture-findings.json`). */
export const CAPTURE_FINDINGS_FILE = 'capture-findings.json';

/** Most finding rows the file carries; the rest are counted in `omitted_findings`. */
export const MAX_CAPTURE_FINDINGS = 500;

export interface CaptureFinding {
	code: string;
	severity: 'warning' | 'error';
	unit: NonNullable< RouteDiagnostic['unit'] >;
	url: string;
	/** Exported file, relative to the website root. */
	path?: string;
	profile?: string;
	reason: string;
	metrics?: Record< string, number >;
}

export interface CaptureFindings {
	schema: typeof CAPTURE_FINDINGS_SCHEMA;
	/** Entry document, relative to the website root. */
	entrypoint: string;
	complete: boolean;
	/** `isUsableCapture()` under `USABLE_PARTIAL_CAPTURE_POLICY`. */
	usable: boolean;
	summary: {
		routes_discovered: number;
		routes_captured: number;
		routes_failed: number;
		routes_omitted: number;
		unresolved_anchors: number;
	};
	findings: CaptureFinding[];
	omitted_findings: number;
	missing_routes: MissingRoute[];
}

export interface CaptureFindingsInput {
	complete: boolean;
	entrypointCaptured: boolean;
	summary: { routesDiscovered: number; routesCaptured: number; routesFailed: number; routesOmitted: number };
	unresolvedAnchors: ReadonlyArray< unknown >;
	/** The full list, including rows export added (the receipt's `discoveryDiagnostics`). */
	discoveryDiagnostics: ReadonlyArray< RouteDiagnostic >;
}

const missingRouteCodes = new Set< string >( [ 'route_capture_failed', 'route_export_failed', 'route_path_collision' ] );

const websiteRelative = ( path: string ): string => path.replace( /\\/g, '/' ).replace( /^website\//, '' );

const compare = ( a: string, b: string ): number => ( a < b ? -1 : a > b ? 1 : 0 );

/**
 * Loss rows: every diagnostic that names a `unit`, plus missing-route rows,
 * which describe the route implicitly. Discovery evidence (`sitemap_*`,
 * `http_*`, budget omission, absent or redirected routes) is not a loss.
 */
function toFinding( row: RouteDiagnostic ): CaptureFinding | undefined {
	const missing = missingRouteCodes.has( row.code );
	if ( ! row.unit && ! missing ) return undefined;
	return {
		code: row.code,
		severity: row.severity ?? ( missing ? 'error' : 'warning' ),
		unit: row.unit ?? 'route',
		url: row.url,
		...( row.path ? { path: websiteRelative( row.path ) } : {} ),
		...( row.profile ? { profile: row.profile } : {} ),
		reason: row.reason,
		...( row.metrics ? { metrics: row.metrics } : {} ),
	};
}

/** Build the findings document. Deterministic: rows are de-duplicated and sorted. */
export function buildCaptureFindings( input: CaptureFindingsInput ): CaptureFindings {
	const unique = new Map< string, CaptureFinding >();
	for ( const row of input.discoveryDiagnostics ) {
		const finding = toFinding( row );
		if ( ! finding ) continue;
		const key = JSON.stringify( [ finding.code, finding.unit, finding.url, finding.path ?? '', finding.profile ?? '', finding.reason ] );
		if ( ! unique.has( key ) ) unique.set( key, finding );
	}
	const findings = [ ...unique.values() ].sort( ( a, b ) =>
		compare( a.url, b.url ) || compare( a.code, b.code ) || compare( a.unit, b.unit ) ||
		compare( a.path ?? '', b.path ?? '' ) || compare( a.profile ?? '', b.profile ?? '' ) || compare( a.reason, b.reason ) );
	const missing = missingRoutes( input.discoveryDiagnostics ).sort( ( a, b ) => compare( a.url, b.url ) );
	return {
		schema: CAPTURE_FINDINGS_SCHEMA,
		entrypoint: 'index.html',
		complete: input.complete,
		usable: isUsableCapture( { complete: input.complete, entrypointCaptured: input.entrypointCaptured, missingRoutes: missing, summary: input.summary } ),
		summary: {
			routes_discovered: input.summary.routesDiscovered,
			routes_captured: input.summary.routesCaptured,
			routes_failed: input.summary.routesFailed,
			routes_omitted: input.summary.routesOmitted,
			unresolved_anchors: input.unresolvedAnchors.length,
		},
		findings: findings.slice( 0, MAX_CAPTURE_FINDINGS ),
		omitted_findings: Math.max( 0, findings.length - MAX_CAPTURE_FINDINGS ),
		missing_routes: missing,
	};
}

/** Write `website/capture-findings.json` under a capture output directory. */
export function writeCaptureFindings( outputDir: string, input: CaptureFindingsInput ): string {
	const websiteDir = join( outputDir, 'website' );
	mkdirSync( websiteDir, { recursive: true } );
	const path = join( websiteDir, CAPTURE_FINDINGS_FILE );
	writeFileSync( path, `${ JSON.stringify( buildCaptureFindings( input ), null, 2 ) }\n` );
	return path;
}
