import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from '../platform/types.js';
import type { CaptureOptions, CaptureProgress, CaptureResult } from './capture.js';
import { budgetOmittedRoutes, missingRoutes } from './capture-usability.js';
import type { RouteDiagnostic } from './capture-export-routes.js';
import { writeCaptureFindings } from './capture-findings.js';
import { acquireHttpDocuments } from './http-acquisition.js';
import { materializeHttpDocuments } from './http-materialization.js';

export interface HttpCaptureOptions {
	/** Observe at most this many routes with declared runtime regions. Default 0; max 50. */
	runtimeRouteLimit?: number;
}

export function validateHttpCaptureOptions( options: CaptureOptions ): void {
	if ( options.resume ) throw new Error( 'HTTP review capture does not support resume yet' );
	if ( options.captureImages ) throw new Error( 'HTTP review capture does not produce source screenshots' );
	const runtimeLimit = options.http?.runtimeRouteLimit;
	if ( runtimeLimit !== undefined && ( ! Number.isSafeInteger( runtimeLimit ) || runtimeLimit < 0 || runtimeLimit > 50 ) ) throw new Error( 'Runtime route limit must be an integer from 0 to 50' );
}

export async function captureHttpWebsite( input: {
	options: CaptureOptions; sourceUrl: string; platform: Platform; startedAt: number;
	routeScope?: import('../platform/types.js').SiteRouteScope;
	progress: ( progress: CaptureProgress ) => void; title?: string;
	/** Routes the shared route budget kept, entrypoint first. */
	urls: string[];
	/** Discovery diagnostics, including one `route_omitted_by_budget` row per omitted route. */
	discoveryDiagnostics: RouteDiagnostic[];
} ): Promise<CaptureResult> {
	const { options, platform, progress } = input;
	const profile = platform.acquisition;
	if ( ! profile ) throw new Error( `Platform ${ platform.id } has no HTTP acquisition profile` );
	const roles = profile.exportVariants ?? ( profile.variants.length === 1 ? { desktop: profile.variants[ 0 ]!.id } : undefined );
	if ( ! roles || ! roles.desktop.trim() || ( roles.mobile !== undefined && ( ! roles.mobile.trim() || roles.mobile === roles.desktop ) ) || new Set( [ roles.desktop, roles.mobile ].filter( Boolean ) ).size !== profile.variants.length || profile.variants.some( variant => variant.id !== roles.desktop && variant.id !== roles.mobile ) ) throw new Error( 'HTTP orchestration requires explicit export roles for all profile variants' );
	const urls = input.urls;
	const acquisition = await acquireHttpDocuments( {
		url: input.sourceUrl, urls, routeScope: input.routeScope, outputDir: options.outputDir, profile, collectAssets: true,
		onProgress: ( current, total, document ) => progress( { phase: 'capturing', current, total, unit: 'documents', url: document.url } ),
	} );
	let runtime: { attachments: number; observations: number; failures: Array<{ url: string; error: string }> } | undefined;
	if ( ( options.http?.runtimeRouteLimit ?? 0 ) > 0 ) {
		try { runtime = await ( await import( './http-runtime-observation.js' ) ).observeHttpCaptureRegions( {
			outputDir: options.outputDir, acquisition, profile, roles, routeLimit: options.http!.runtimeRouteLimit!, progress,
		} ); } catch ( error ) { runtime = { attachments: 0, observations: 0, failures: [ { url: input.sourceUrl, error: `Runtime observation unavailable: ${ String( error ) }` } ] }; }
	}
	progress( { phase: 'finalizing', current: urls.length, total: urls.length, unit: 'routes' } );
	const captureReceiptPath = materializeHttpDocuments( { outputDir: options.outputDir, sourceUrl: input.sourceUrl, platform: platform.id, routeScope: input.routeScope, desktopVariant: roles.desktop, mobileVariant: roles.mobile, embeddedDocuments: ( runtime?.attachments ?? 0 ) > 0, ...( options.maxFileBytes !== undefined ? { limits: { maxFileBytes: options.maxFileBytes } } : {} ) } );
	const receipt = JSON.parse( readFileSync( captureReceiptPath, 'utf8' ) );
	const failures = acquisition.documents.filter( document => document.status !== 'acquired' ).map( document => ( { url: document.url, error: `${ document.variant }: ${ document.error ?? document.status }` } ) );
	if ( runtime ) failures.push( ...runtime.failures );
	const diagnostics: RouteDiagnostic[] = [ ...input.discoveryDiagnostics, ...( receipt.discoveryDiagnostics ?? [] ) ];
	const failedRoutes = new Set( acquisition.documents.filter( document => document.status !== 'acquired' ).map( document => document.url ) );
	const summary = { routesDiscovered: urls.length, routesCaptured: receipt.routes.length, routesSkipped: 0, routesFailed: failedRoutes.size, routesOmitted: budgetOmittedRoutes( diagnostics ).length, durationMs: Date.now() - input.startedAt, complete: false, entrypointCaptured: true };
	receipt.summary = summary;
	receipt.discoveryDiagnostics = diagnostics;
	receipt.failures = failures;
	receipt.orchestration = { mode: 'http', requestedRoutes: urls.length, discoveredRoutes: urls.length + summary.routesOmitted, runtimeRouteLimit: options.http?.runtimeRouteLimit ?? 0, runtime, verification: 'unverified' };
	if ( input.title ) receipt.title = input.title;
	writeFileSync( captureReceiptPath, JSON.stringify( receipt, null, 2 ) + '\n' );
	const diagnosticPath = join( options.outputDir, 'diagnostics.json' );
	const diagnostic = JSON.parse( readFileSync( diagnosticPath, 'utf8' ) );
	diagnostic.discoveryDiagnostics = diagnostics; diagnostic.failures = failures;
	writeFileSync( diagnosticPath, JSON.stringify( diagnostic, null, 2 ) + '\n' );
	const result: CaptureResult = { captureReceiptPath, outputDir: options.outputDir, summary, complete: false, entrypointCaptured: true, missingRoutes: missingRoutes( diagnostics ), failures, discoveryDiagnostics: diagnostics, unresolvedAnchors: diagnostic.unresolvedAnchors ?? [], provenance: { provider: 'data-liberation/http-capture', platform: platform.id } };
	writeCaptureFindings( options.outputDir, result );
	progress( { phase: 'complete', current: urls.length, total: urls.length, unit: 'routes' } );
	return result;
}
