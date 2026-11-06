import { ROUTE_OMITTED_BY_BUDGET } from './route-budget.js';
import { ROUTE_EXCEEDS_TOTAL_BUDGET } from './export-total-budget.js';

/**
 * Routes export dropped after capture saved their page: they count as failed,
 * not captured. `route_exceeds_total_budget` is a route the total export budget
 * (`maxTotalBytes`, `maxFiles`) left out.
 */
const EXPORT_DROPPED_ROUTE_CODES = [ 'route_export_failed', 'route_path_collision', ROUTE_EXCEEDS_TOTAL_BUDGET ] as const;

/**
 * A route the capture time budget (`timeBudgetMs`) left uncaptured: not started
 * before admission closed, or abandoned in flight at the deadline. Unlike the
 * route budget (`route_omitted_by_budget`), the route was in the requested
 * scope, so it counts as failed and missing.
 */
export const ROUTE_CAPTURE_SKIPPED_BUDGET = 'route_capture_skipped_budget';

/**
 * A route the per-route capture deadline left unfinished: it was started but
 * exceeded its bounded duration, so it counts as failed and missing.
 */
export const ROUTE_CAPTURE_TIMEOUT = 'route_capture_timeout';

/** Codes of routes that were in scope and produced no page. */
export const MISSING_ROUTE_CODES = [ 'route_capture_failed', ROUTE_CAPTURE_SKIPPED_BUDGET, ROUTE_CAPTURE_TIMEOUT, ...EXPORT_DROPPED_ROUTE_CODES ] as const;

/**
 * A route that was attempted (or advertised as a redirect target) and did not
 * produce a page. Routes the source itself lacks (`route_not_found`) or sends
 * elsewhere (`route_external_redirect`) are not missing: the source has nothing
 * to copy there. Routes the caller's route budget left out
 * (`route_omitted_by_budget`) were never attempted and are not missing either,
 * nor are discovered URLs outside the entry origin (`route_off_origin`).
 */
export interface MissingRoute {
	url: string;
	code: typeof MISSING_ROUTE_CODES[ number ];
	/** The * cause as recorded by capture or export: deadline, engine error, time budget, uncaptured redirect target, export error, path collision, total export budget. */
	reason: string;
}

/**
 * Recommended default policy for callers deciding whether an incomplete
 * capture is still worth importing: the entrypoint was captured, regardless
 * of how many other routes failed. Import the capture and report missingRoutes
 * instead of failing. Capture itself never applies this policy.
 */
export const USABLE_PARTIAL_CAPTURE_POLICY = {
	version: 3,
} as const;

const isMissingRouteCode = ( code: unknown ): code is MissingRoute['code'] =>
	( MISSING_ROUTE_CODES as readonly unknown[] ).includes( code );

/** The receipt's missing-route diagnostics (`MISSING_ROUTE_CODES`), one per URL. */
export function missingRoutes( discoveryDiagnostics: ReadonlyArray< { code?: unknown; url?: unknown; reason?: unknown } > = [] ): MissingRoute[] {
	const missing = new Map< string, MissingRoute >();
	for ( const diagnostic of discoveryDiagnostics ) {
		if ( ! isMissingRouteCode( diagnostic.code ) || typeof diagnostic.url !== 'string' || missing.has( diagnostic.url ) ) continue;
		missing.set( diagnostic.url, { url: diagnostic.url, code: diagnostic.code, reason: String( diagnostic.reason ?? '' ) } );
	}
	return [ ...missing.values() ];
}

/**
 * Routes the route budget left out (`route_omitted_by_budget`), one per URL.
 *
 * Budget omission is the caller's explicit scope choice, not a capture defect:
 * omitted routes never count as failed or missing, links to them are reported
 * as unresolved anchors with their own reason, and they do not make a capture
 * incomplete. `complete` therefore means "everything inside the requested
 * budget was captured"; callers that need the whole source check
 * `summary.routesOmitted === 0` or capture with `routeLimit: 'all'`.
 */
export function budgetOmittedRoutes( discoveryDiagnostics: ReadonlyArray< { code?: unknown; url?: unknown } > = [] ): string[] {
	return [ ...new Set( discoveryDiagnostics.flatMap( diagnostic =>
		diagnostic.code === ROUTE_OMITTED_BY_BUDGET && typeof diagnostic.url === 'string' ? [ diagnostic.url ] : [] ) ) ];
}

/**
 * Whether some exported route lacks the document of a declared capture profile
 * (`route_profile_uncaptured`). The route still counts as captured; the capture
 * is not complete.
 */
export function hasUncapturedProfiles( discoveryDiagnostics: ReadonlyArray< { code?: unknown } > = [] ): boolean {
	return discoveryDiagnostics.some( diagnostic => diagnostic.code === 'route_profile_uncaptured' );
}

/**
 * Route counts once export has run. A route export dropped (`route_export_failed`,
 * `route_path_collision`, `route_exceeds_total_budget`) produced no page: it moves from captured to failed,
 * keeping captured + skipped + failed <= discovered.
 */
export function withExportDroppedRoutes< S extends Record< string, unknown > >(
	summary: S, discoveryDiagnostics: ReadonlyArray< { code?: unknown; url?: unknown; reason?: unknown } > = []
): S {
	const dropped = missingRoutes( discoveryDiagnostics ).filter( route => ( EXPORT_DROPPED_ROUTE_CODES as readonly string[] ).includes( route.code ) ).length;
	if ( dropped === 0 ) return summary;
	return {
		...summary,
		routesCaptured: Math.max( 0, Number( summary.routesCaptured ?? 0 ) - dropped ),
		routesFailed: Number( summary.routesFailed ?? 0 ) + dropped,
	};
}

/**
 * Apply `USABLE_PARTIAL_CAPTURE_POLICY`: a resolved capture with its entrypoint
 * is usable. Missing routes stay reported in `missingRoutes` and keep
 * `complete` false, but never make the capture unusable.
 */
export function isUsableCapture( result: {
	complete: boolean;
	entrypointCaptured: boolean;
	missingRoutes: ReadonlyArray< { code?: unknown } >;
	summary: { routesDiscovered: number };
} ): boolean {
	return result.entrypointCaptured;
}
