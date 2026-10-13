import type { CaptureFinding, CaptureFindings } from './capture-findings.js';

/**
 * Capture findings in Static Site Importer's producer-neutral input contract
 * (#787, part of #761): `website/source-findings.json`, schema
 * `static-site-importer/source-findings/v1`.
 *
 * Every row describes itself: what was lost (`unit`), how (`loss_class`),
 * where (`location`) and which layer owns it (`owning_layer`). The importer
 * classifies rows generically and carries no registry of this producer's
 * codes, so this producer owns its code -> loss class mapping
 * (`SOURCE_FINDING_LOSS_CLASSES`).
 *
 * Rollout step 1 writes this file beside `capture-findings.json`; both are built
 * from the same rows. See docs/contracts/loss-ledger.md.
 */
export const SOURCE_FINDINGS_SCHEMA = 'static-site-importer/source-findings/v1';

/** File name at the website root (`website/source-findings.json`). */
export const SOURCE_FINDINGS_FILE = 'source-findings.json';

export const SOURCE_FINDINGS_OWNING_LAYER = 'data-liberation-agent';

export type SourceFindingLossClass = 'omitted_unit' | 'degraded_unit';

export type SourceFindingUnit = 'route' | 'page' | 'block' | 'asset' | 'stylesheet' | 'profile' | 'item' | 'file';

/**
 * Capture code -> loss class and default unit.
 *
 * `omitted_unit`: the unit is absent from the artifact. `degraded_unit`: the
 * unit is present with part of its source. Matches the classification Static
 * Site Importer applied to `capture-findings.json` rows before #787.
 */
export const SOURCE_FINDING_LOSS_CLASSES = {
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
} as const satisfies Record< string, { loss_class: SourceFindingLossClass; unit: SourceFindingUnit } >;

/**
 * A capture code without a registry entry is still a loss of one unit: the row
 * kept its unit, so it is reported as degraded (the importer's handling of an
 * unregistered capture code before #787) rather than left unclassified.
 */
export const DEFAULT_SOURCE_FINDING_LOSS_CLASS: SourceFindingLossClass = 'degraded_unit';

export interface SourceFinding {
	code: string;
	severity: 'warning' | 'error' | 'info';
	unit: SourceFindingUnit;
	loss_class: SourceFindingLossClass;
	/** `url` is the source URL; `path` is the exported file, relative to the website root. */
	location: { url?: string; path?: string };
	message: string;
	metrics?: Record< string, number >;
	owning_layer: typeof SOURCE_FINDINGS_OWNING_LAYER;
}

export interface SourceFindings {
	schema: typeof SOURCE_FINDINGS_SCHEMA;
	entrypoint: string;
	complete: boolean;
	usable: boolean;
	summary: CaptureFindings['summary'] & { omitted_findings: number };
	findings: SourceFinding[];
}

/** Loss class and default unit for a capture code. */
export function sourceFindingLossClass( code: string ): { loss_class: SourceFindingLossClass; unit?: SourceFindingUnit } {
	return ( SOURCE_FINDING_LOSS_CLASSES as Record< string, { loss_class: SourceFindingLossClass; unit: SourceFindingUnit } > )[ code ]
		?? { loss_class: DEFAULT_SOURCE_FINDING_LOSS_CLASS };
}

function sourceFinding( finding: Pick< CaptureFinding, 'code' | 'url' | 'reason' > & Partial< CaptureFinding > ): SourceFinding {
	const mapped = sourceFindingLossClass( finding.code );
	return {
		code: finding.code,
		severity: finding.severity ?? 'error',
		// The row's own unit wins; the registry fills it when absent.
		unit: finding.unit ?? mapped.unit ?? 'route',
		loss_class: mapped.loss_class,
		location: { url: finding.url, ...( finding.path ? { path: finding.path } : {} ) },
		message: finding.reason,
		...( finding.metrics ? { metrics: finding.metrics } : {} ),
		owning_layer: SOURCE_FINDINGS_OWNING_LAYER,
	};
}

/**
 * Project a capture findings document into the neutral contract.
 *
 * Rows are the capture findings rows, in their deterministic order and under
 * the same cap, followed by every missing route the cap left out: a missing
 * route is always reported, as an `omitted_unit` route finding.
 */
export function buildSourceFindings( capture: CaptureFindings ): SourceFindings {
	const covered = new Set( capture.findings.map( finding => `${ finding.code } ${ finding.url }` ) );
	const missing = capture.missing_routes
		.filter( route => ! covered.has( `${ route.code } ${ route.url }` ) )
		.map( route => sourceFinding( { code: route.code, url: route.url, reason: route.reason, unit: 'route', severity: 'error' } ) );
	return {
		schema: SOURCE_FINDINGS_SCHEMA,
		entrypoint: capture.entrypoint,
		complete: capture.complete,
		usable: capture.usable,
		summary: { ...capture.summary, omitted_findings: capture.omitted_findings },
		findings: [ ...capture.findings.map( sourceFinding ), ...missing ],
	};
}
