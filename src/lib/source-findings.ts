import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteDiagnostic } from './capture-export-routes.js';
import { isUsableCapture, MISSING_ROUTE_CODES, missingRoutes } from './capture-usability.js';

/**
 * Capture findings that travel inside the exported website artifact, in
 * Static Site Importer's producer-neutral input contract (#787, part of #761):
 * `website/source-findings.json`, schema `static-site-importer/source-findings/v1`.
 *
 * The capture receipt and `diagnostics.json` sit next to `website/`, so an
 * importer that only receives the website artifact would never see which
 * routes were dropped or degraded. Every row describes itself: what was lost
 * (`unit`), how (`loss_class`), where (`location`) and which layer owns it
 * (`owning_layer`). The importer classifies rows generically and carries no
 * registry of this producer's codes, so this producer owns its code -> loss
 * class mapping (`SOURCE_FINDING_LOSS_CLASSES`). See docs/contracts/loss-ledger.md.
 */
export const SOURCE_FINDINGS_SCHEMA = 'static-site-importer/source-findings/v1';

/** File name at the website root (`website/source-findings.json`). */
export const SOURCE_FINDINGS_FILE = 'source-findings.json';

export const SOURCE_FINDINGS_OWNING_LAYER = 'data-liberation-agent';

/** Most loss rows the file carries; the rest are counted in `summary.omitted_findings`. Missing routes are always written. */
export const MAX_SOURCE_FINDINGS = 500;

export type SourceFindingLossClass = 'omitted_unit' | 'degraded_unit';

export type SourceFindingUnit = 'route' | 'page' | 'block' | 'asset' | 'stylesheet' | 'profile' | 'item' | 'file';

/**
 * Capture code -> loss class and default unit.
 *
 * `omitted_unit`: the unit is absent from the artifact. `degraded_unit`: the
 * unit is present with part of its source. Equal to the classification Static
 * Site Importer applied to these codes before #787.
 */
export const SOURCE_FINDING_LOSS_CLASSES = {
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
} as const satisfies Record< string, { loss_class: SourceFindingLossClass; unit: SourceFindingUnit } >;

/**
 * A capture code without a registry entry is still a loss of one unit: the row
 * keeps its unit and is reported as degraded rather than left unclassified.
 */
export const DEFAULT_SOURCE_FINDING_LOSS_CLASS: SourceFindingLossClass = 'degraded_unit';

export interface SourceFinding {
	code: string;
	severity: 'warning' | 'error' | 'info';
	unit: SourceFindingUnit;
	loss_class: SourceFindingLossClass;
	/** `url`: the source URL. `path`: the exported file, relative to the website root. `profile`: the capture profile. */
	location: { url?: string; path?: string; profile?: string };
	message: string;
	metrics?: Record< string, number >;
	owning_layer: typeof SOURCE_FINDINGS_OWNING_LAYER;
}

export interface SourceFindings {
	schema: typeof SOURCE_FINDINGS_SCHEMA;
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
		/** Opt-in template-clustered capture: routes exported from a verified template. */
		routes_derived?: number;
		unresolved_anchors: number;
		omitted_findings: number;
	};
	findings: SourceFinding[];
}

export interface SourceFindingsInput {
	complete: boolean;
	entrypointCaptured: boolean;
	summary: { routesDiscovered: number; routesCaptured: number; routesFailed: number; routesOmitted: number; routesDerived?: number };
	unresolvedAnchors: ReadonlyArray< unknown >;
	/** The full list, including rows export added (the receipt's `discoveryDiagnostics`). */
	discoveryDiagnostics: ReadonlyArray< RouteDiagnostic >;
}

/** Loss class and default unit for a capture code. */
export function sourceFindingLossClass( code: string ): { loss_class: SourceFindingLossClass; unit?: SourceFindingUnit } {
	return ( SOURCE_FINDING_LOSS_CLASSES as Record< string, { loss_class: SourceFindingLossClass; unit: SourceFindingUnit } > )[ code ]
		?? { loss_class: DEFAULT_SOURCE_FINDING_LOSS_CLASS };
}

const missingRouteCodes = new Set< string >( MISSING_ROUTE_CODES );

const websiteRelative = ( path: string ): string => path.replace( /\\/g, '/' ).replace( /^website\//, '' );

const compare = ( a: string, b: string ): number => ( a < b ? -1 : a > b ? 1 : 0 );

/**
 * Loss rows: every diagnostic that names a `unit`, plus missing-route rows,
 * which describe the route implicitly. Discovery evidence (`sitemap_*`,
 * `http_*`, budget omission, absent or redirected routes) is not a loss.
 */
function toFinding( row: RouteDiagnostic ): SourceFinding | undefined {
	const missing = missingRouteCodes.has( row.code );
	if ( ! row.unit && ! missing ) return undefined;
	const mapped = sourceFindingLossClass( row.code );
	return {
		code: row.code,
		severity: row.severity ?? ( missing ? 'error' : 'warning' ),
		// The row's own unit wins; the registry fills it when absent.
		unit: row.unit ?? mapped.unit ?? 'route',
		loss_class: mapped.loss_class,
		location: { url: row.url, ...( row.path ? { path: websiteRelative( row.path ) } : {} ), ...( row.profile ? { profile: row.profile } : {} ) },
		message: row.reason,
		...( row.metrics ? { metrics: row.metrics } : {} ),
		owning_layer: SOURCE_FINDINGS_OWNING_LAYER,
	};
}

/**
 * Build the findings document. Deterministic: rows are de-duplicated and
 * sorted. At most `MAX_SOURCE_FINDINGS` rows are written, then every missing
 * route the cap left out, so a missing route is always reported.
 */
export function buildSourceFindings( input: SourceFindingsInput ): SourceFindings {
	const unique = new Map< string, SourceFinding >();
	for ( const row of input.discoveryDiagnostics ) {
		const finding = toFinding( row );
		if ( ! finding ) continue;
		const { url = '', path = '', profile = '' } = finding.location;
		const key = JSON.stringify( [ finding.code, finding.unit, url, path, profile, finding.message ] );
		if ( ! unique.has( key ) ) unique.set( key, finding );
	}
	const sorted = [ ...unique.values() ].sort( ( a, b ) =>
		compare( a.location.url ?? '', b.location.url ?? '' ) || compare( a.code, b.code ) || compare( a.unit, b.unit ) ||
		compare( a.location.path ?? '', b.location.path ?? '' ) || compare( a.location.profile ?? '', b.location.profile ?? '' ) ||
		compare( a.message, b.message ) );
	const kept = sorted.slice( 0, MAX_SOURCE_FINDINGS );
	const covered = new Set( kept.map( finding => `${ finding.code } ${ finding.location.url }` ) );
	const missing = missingRoutes( input.discoveryDiagnostics ).sort( ( a, b ) => compare( a.url, b.url ) );
	const uncovered = missing
		.filter( route => ! covered.has( `${ route.code } ${ route.url }` ) )
		.map( route => toFinding( { code: route.code, url: route.url, reason: route.reason, unit: 'route', severity: 'error' } )! );
	return {
		schema: SOURCE_FINDINGS_SCHEMA,
		entrypoint: 'index.html',
		complete: input.complete,
		usable: isUsableCapture( { complete: input.complete, entrypointCaptured: input.entrypointCaptured, missingRoutes: missing, summary: input.summary } ),
		summary: {
			routes_discovered: input.summary.routesDiscovered,
			routes_captured: input.summary.routesCaptured,
			routes_failed: input.summary.routesFailed,
			routes_omitted: input.summary.routesOmitted,
			...( input.summary.routesDerived !== undefined ? { routes_derived: input.summary.routesDerived } : {} ),
			unresolved_anchors: input.unresolvedAnchors.length,
			omitted_findings: sorted.length - kept.length,
		},
		findings: [ ...kept, ...uncovered ],
	};
}

/** Write `website/source-findings.json` under a capture output directory. */
export function writeSourceFindings( outputDir: string, input: SourceFindingsInput ): string {
	const websiteDir = join( outputDir, 'website' );
	mkdirSync( websiteDir, { recursive: true } );
	const path = join( websiteDir, SOURCE_FINDINGS_FILE );
	writeFileSync( path, `${ JSON.stringify( buildSourceFindings( input ), null, 2 ) }\n` );
	return path;
}
