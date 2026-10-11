/**
 * A route that was attempted (or advertised as a redirect target) and did not
 * produce a page. Routes the source itself lacks (`route_not_found`) or sends
 * elsewhere (`route_external_redirect`) are not missing: the source has nothing
 * to copy there.
 */
export interface MissingRoute {
	url: string;
	code: 'route_capture_failed';
	/** The cause as recorded by capture: deadline, engine error, uncaptured redirect target. */
	reason: string;
}

/**
 * Recommended default policy for callers deciding whether an incomplete
 * capture is still worth importing: the entrypoint was captured and missing
 * routes are at most max(1, 10%) of discovered routes. Callers may adopt a
 * stricter or looser rule; capture itself never applies it.
 */
export const USABLE_PARTIAL_CAPTURE_POLICY = {
	version: 1,
	minFailedRoutes: 1,
	maxFailedFraction: 0.1,
} as const;

/** The receipt's `route_capture_failed` diagnostics, one per URL. */
export function missingRoutes( discoveryDiagnostics: ReadonlyArray< { code?: unknown; url?: unknown; reason?: unknown } > = [] ): MissingRoute[] {
	const missing = new Map< string, MissingRoute >();
	for ( const diagnostic of discoveryDiagnostics ) {
		if ( diagnostic.code !== 'route_capture_failed' || typeof diagnostic.url !== 'string' || missing.has( diagnostic.url ) ) continue;
		missing.set( diagnostic.url, { url: diagnostic.url, code: 'route_capture_failed', reason: String( diagnostic.reason ?? '' ) } );
	}
	return [ ...missing.values() ];
}

/** Apply `USABLE_PARTIAL_CAPTURE_POLICY`. A capture without its entrypoint is never usable. */
export function isUsableCapture( result: {
	complete: boolean;
	entrypointCaptured: boolean;
	missingRoutes: ReadonlyArray< unknown >;
	summary: { routesDiscovered: number };
} ): boolean {
	if ( ! result.entrypointCaptured ) return false;
	if ( result.complete ) return true;
	const { minFailedRoutes, maxFailedFraction } = USABLE_PARTIAL_CAPTURE_POLICY;
	return result.missingRoutes.length <= Math.max( minFailedRoutes, maxFailedFraction * result.summary.routesDiscovered );
}
