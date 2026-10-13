import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findAdapter } from '../adapters/index.js';
import type { PlatformAdapter } from '../types.js';
import { detect } from './detect-platform/index.js';
import { downloadMedia } from './media-fetch/media.js';
import { safeFetch } from './media-fetch/safe-fetch.js';
import { downloadSectionMedia } from './replicate/download-section-media.js';
import { SectionSpecsStore } from './replicate/section-specs-store.js';
import { MediaStubStore } from './resume-state/index.js';
import { documentRequestUrl, normalizedUrl } from './url/route-key.js';
import { routeInScope, validateRouteScope } from './url/route-scope.js';
import { actionUrlExclusion, ROUTE_EXCLUDED_ACTION_URL } from './url/action-url.js';
import { galleryFrameMediaUrls } from './screenshot/gallery-capture.js';
import type { ManifestEntry } from './screenshot/manifest-queue.js';
import { budgetOmittedRoutes, hasUncapturedProfiles, missingRoutes, withExportDroppedRoutes, type MissingRoute } from './capture-usability.js';
import { DEFAULT_ROUTE_LIMIT, dedupeRouteInventory, ROUTE_OMITTED_BY_BUDGET, routeBudgetReason, selectRouteBudget, validateRouteLimit, validateRouteSelection, type RouteLimit } from './route-budget.js';
import type { RouteDiagnostic } from './capture-export-routes.js';
import { writeCaptureFindings } from './capture-findings.js';
import { captureTimeBudgetWindow, validateTimeBudgetMs } from './capture-time-budget.js';
import { validateMaxFileBytes } from './export-file-limit.js';

export { isUsableCapture, USABLE_PARTIAL_CAPTURE_POLICY, type MissingRoute } from './capture-usability.js';
export { DEFAULT_ROUTE_LIMIT, DEFAULT_ROUTE_SELECTION, ROUTE_SELECTIONS, type RouteLimit, type RouteSelection } from './route-budget.js';
export { DEFAULT_MAX_FILE_BYTES } from './export-file-limit.js';

export interface CaptureProgress {
	unit?: 'routes' | 'documents';
	phase: 'discovering' | 'capturing' | 'media' | 'finalizing' | 'complete';
	current?: number;
	total?: number;
	url?: string;
	elapsedMs?: number;
	phaseElapsedMs?: number;
}

/**
 * Routes that receive frozen baseline reference evidence by default: the
 * entrypoint. Reference navigations are the largest per-route capture cost
 * (#634), and callers that compare bounded samples or drift against the live
 * source never consume the rest. Full-route parity opts in with 'all'.
 */
export const DEFAULT_REFERENCE_SAMPLE = 1;

export interface CaptureOptions {
	/** Opt-in source-only review capture; browser rendering remains the default. */
	acquisition?: 'browser' | 'http';
	http?: import('./capture-http.js').HttpCaptureOptions;
	/**
	 * Route budget shared by browser and HTTP acquisition: capture at most this
	 * many routes, counting the entrypoint and linked-page admissions. The
	 * entrypoint is always kept; the rest is an even, deterministic spread over
	 * the discovered inventory. Each omitted route is a `route_omitted_by_budget`
	 * discovery diagnostic and counts in `summary.routesOmitted`, never in
	 * `routesFailed`. Browser default: `DEFAULT_ROUTE_LIMIT`; HTTP default:
	 * `'all'`. Pass `'all'` to capture the whole inventory.
	 */
	routeLimit?: RouteLimit;
	/**
	 * How the route budget picks routes when it truncates the inventory.
	 * `'discovery-order'` (default): the entrypoint plus an even spread.
	 * `'template-coverage'`: fetch each discovered route's server HTML (bounded
	 * by `TEMPLATE_GROUPING_LIMITS`), group routes by template fingerprint, keep
	 * one representative per group after the entrypoint, then fill the rest with
	 * the even spread. It writes `template-groups.json` next to `website/` and
	 * adds `templateGroups` counts to the receipt. Grouping problems never fail
	 * the capture: the selection falls back to `'discovery-order'` with one
	 * `template_grouping_unavailable` discovery diagnostic.
	 */
	routeSelection?: import('./route-budget.js').RouteSelection;
	url: string;
	outputDir: string;
	resume?: boolean;
	captureImages?: boolean;
	/** Learn responsive sizing by sweeping widths instead of freezing one. */
	learnFluid?: boolean;
	/** Bounded rendered-link coverage, layered on adapter discovery. */
	linkedPages?: import('./screenshot/linked-frontier.js').LinkedPageLimits;
	/**
	 * Fail closed when the capture is incomplete. Default is false: a partial
	 * site is still written and returned with `complete: false`. Programmatic
	 * callers that used to guard on `routesFailed > 0` should check `complete`
	 * instead, or pass `strict: true` to reject.
	 */
	strict?: boolean;
	/**
	 * Freeze baseline reference evidence for at most this many routes
	 * (browser capture only): the entrypoint plus an even spread of the
	 * remaining initial routes. Unsampled routes skip reference navigations
	 * entirely and are reported as uncompared scope by frozen comparison
	 * instead of failing it. Default: `DEFAULT_REFERENCE_SAMPLE` (the entrypoint
	 * only). Pass `'all'` to freeze reference evidence for every route
	 * (full-route parity).
	 */
	referenceSample?: number | 'all';
	/**
	 * Capture time budget in milliseconds, measured from the start of this call
	 * until export must begin (browser acquisition only). Route admission
	 * closes at the budget minus a grace window (25% of the budget, at most
	 * 60s); routes still running at the budget are abandoned, and section media
	 * stops downloading. Export then runs on what was captured. The entrypoint
	 * is always captured first and never skipped. Each uncaptured route is a
	 * `route_capture_skipped_budget` finding: a missing route, counted in
	 * `routesFailed`, so `complete` is false and `usable` follows
	 * `isUsableCapture`. Default: no budget. Recommended: the caller's deadline
	 * minus the post-capture headroom (README, "Capture time budget").
	 */
	timeBudgetMs?: number;
	/**
	 * Largest file export writes into `website/`, in bytes. A captured asset over
	 * it is not written; its references resolve like any missing asset and it is
	 * reported as `asset_exceeds_file_limit`. A page document over it fails that
	 * route (`route_export_failed`). Default: `DEFAULT_MAX_FILE_BYTES` (50 MiB),
	 * matching Static Site Importer's per-file intake limit.
	 */
	maxFileBytes?: number;
	/**
	 * Whether routes are also captured in the phone profile (browser
	 * acquisition only). `'auto'` (default) gates the site on the entrypoint:
	 * `'reflow-only'` when the adapter declares no per-device documents and the
	 * desktop and phone identities receive the same server HTML (per-request
	 * nonces, CSRF tokens and timestamps ignored); `'dual'` otherwise. Under a
	 * reflow-only site each route first gets a cheap phone check (images, media
	 * and fonts blocked, bounded settle). A route whose server HTML, element
	 * structure or body classes differ between the identities is captured in
	 * both profiles; every other route in the desktop profile alone, and the
	 * copied CSS produces its phone layout. Pass `'dual'` or `'reflow-only'` to
	 * force a mode for every route. The decisions are `summary.deviceMode`,
	 * `summary.dualRoutes` and the receipt's `deviceMode` record.
	 */
	deviceMode?: import('./screenshot/device-mode.js').DeviceModeRequest;
	onProgress?: ( progress: CaptureProgress ) => void;
}

export interface UnresolvedAnchor {
	sourceUrl: string;
	reason: string;
	fragment?: string;
	targetCount?: number;
	url?: string;
}

export interface CaptureResult {
	captureReceiptPath: string;
	outputDir: string;
	summary: {
		routesDiscovered: number;
		routesCaptured: number;
		routesSkipped: number;
		routesFailed: number;
		/** Discovered routes the route budget left out; not attempted, not failed. */
		routesOmitted: number;
		durationMs: number;
		complete: boolean;
		entrypointCaptured: boolean;
		/** Browser capture: the site-level device mode. */
		deviceMode?: import('./screenshot/device-mode.js').DeviceMode;
		/** Reflow-only site: routes whose phone check kept them in both profiles. */
		dualRoutes?: number;
	};
	complete: boolean;
	/**
	 * The entrypoint route is in the capture. Always true on a resolved result:
	 * export rejects with the recorded cause when the entrypoint was not rendered.
	 */
	entrypointCaptured: boolean;
	/** Routes that failed to capture, by URL with cause. Excludes source-absent and external-redirect routes. */
	missingRoutes: MissingRoute[];
	failures: Array< { url: unknown; error: unknown } >;
	/** Discovery and capture findings; loss rows carry `unit`, `severity`, `path`, `profile` and `metrics`. */
	discoveryDiagnostics: RouteDiagnostic[];
	unresolvedAnchors: UnresolvedAnchor[];
	provenance: { provider: string; platform: string };
	/** Browser capture: the device-mode decision and the evidence behind it. */
	deviceMode?: import('./screenshot/device-mode.js').DeviceModeDecision;
}

export interface CaptureDependencies {
	findAdapter( platform: string ): PlatformAdapter | null;
}

export class UnsupportedCapturePlatformError extends Error {}

export class IncompleteCaptureError extends Error {
	readonly result: CaptureResult;

	constructor( result: CaptureResult ) {
		super( 'Capture is incomplete' );
		this.name = 'IncompleteCaptureError';
		this.result = result;
	}
}

const defaultDependencies: CaptureDependencies = { findAdapter };

interface CaptureInventory {
	siteMeta?: { title?: string };
	urls?: Array< { url: string; type: string } >;
	diagnostics?: Array< { code: string; url: string; reason: string } >;
}

/** `deadline` (epoch ms) stops new downloads; media not started stays unlocalized. */
export async function downloadCaptureSectionMedia(
	outputDir: string,
	urls: string[],
	deadline?: number
): Promise< number > {
	const pageRoutes = new Set(
		urls.flatMap( ( url ) => {
			try {
				return [ normalizedUrl( url ) ];
			} catch {
				return [];
			}
		} )
	);
	const sectionUrls: string[] = [];
	for ( const store of [
		SectionSpecsStore.load( outputDir ),
		SectionSpecsStore.loadMobile( outputDir ),
	] ) {
		for ( const url of urls ) {
			for ( const section of store.get( url ) ?? [] ) {
				for ( const image of [
					...( section.images ?? [] ),
					...( section.cells ?? [] ).flatMap( ( cell ) => ( cell.image ? [ cell.image ] : [] ) ),
				] ) {
					const mediaUrl = ( image.sourceUrl || image.url || '' ).trim();
					if ( ! mediaUrl ) continue;
					try {
						if ( pageRoutes.has( normalizedUrl( mediaUrl ) ) ) continue;
					} catch {
						// Invalid media URLs are dropped by downloadSectionMedia.
					}
					sectionUrls.push( mediaUrl );
				}
			}
		}
	}
	const manifestPath = join( outputDir, 'screenshots', 'manifest.json' );
	if ( existsSync( manifestPath ) ) {
		const manifest = JSON.parse( readFileSync( manifestPath, 'utf8' ) ) as { entries?: Record< string, ManifestEntry > };
		for ( const [ pageUrl, entry ] of Object.entries( manifest.entries ?? {} ) ) {
			sectionUrls.push( ...galleryFrameMediaUrls( entry.interactions?.states ?? [], pageUrl ) );
		}
	}

	const stubs = MediaStubStore.load( outputDir );
	const mediaDir = join( outputDir, 'media' );
	const seenNames = new Map< string, number >();
	const { downloaded } = await downloadSectionMedia( {
		srcUrls: sectionUrls,
		isAlreadyDone: ( url ) => ! stubs.shouldAttempt( url ),
		download: async ( url ) => {
			if ( deadline !== undefined && Date.now() >= deadline ) return null;
			const result = await downloadMedia( url, mediaDir, seenNames );
			if ( result.error ) stubs.markFailure( url, result.error );
			return result.localPath;
		},
		onSuccess: ( url, localPath ) => stubs.markSuccess( url, localPath ),
	} );
	stubs.flush();
	return downloaded;
}

export async function captureWebsite(
	options: CaptureOptions,
	dependencies: CaptureDependencies = defaultDependencies
): Promise< CaptureResult > {
	if ( options.acquisition !== undefined && ! [ 'browser', 'http' ].includes( options.acquisition ) ) throw new Error( 'Unknown capture acquisition mode' );
	if ( options.acquisition === 'http' ) ( await import( './capture-http.js' ) ).validateHttpCaptureOptions( options );
	else if ( options.http !== undefined ) throw new Error( 'HTTP capture options require HTTP acquisition' );
	// Reject before discovery or any browser starts.
	if ( options.referenceSample !== undefined && options.referenceSample !== 'all' && ( ! Number.isInteger( options.referenceSample ) || options.referenceSample < 1 ) ) throw new Error( "referenceSample must be a positive integer or 'all'" );
	const referenceSample = options.referenceSample === 'all' ? undefined : options.referenceSample ?? DEFAULT_REFERENCE_SAMPLE;
	validateRouteLimit( options.routeLimit );
	validateRouteSelection( options.routeSelection );
	validateTimeBudgetMs( options.timeBudgetMs );
	if ( options.timeBudgetMs !== undefined && options.acquisition === 'http' ) throw new RangeError( 'timeBudgetMs applies to browser acquisition only' );
	validateMaxFileBytes( options.maxFileBytes );
	if ( options.deviceMode !== undefined ) {
		const { DEVICE_MODE_REQUESTS } = await import( './screenshot/device-mode.js' );
		if ( ! DEVICE_MODE_REQUESTS.includes( options.deviceMode ) ) throw new RangeError( `deviceMode must be one of ${ DEVICE_MODE_REQUESTS.join( ', ' ) }` );
		if ( options.acquisition === 'http' ) throw new RangeError( 'deviceMode applies to browser acquisition only' );
	}
	const routeLimit = options.routeLimit === 'all' ? undefined : options.routeLimit ?? ( options.acquisition === 'http' ? undefined : DEFAULT_ROUTE_LIMIT );
	const { onProgress } = options;
	const startedAt = Date.now();
	const timeBudget = options.timeBudgetMs === undefined ? undefined : captureTimeBudgetWindow( startedAt, options.timeBudgetMs );
	let phase = '';
	let phaseStartedAt = startedAt;
	const progress = ( event: CaptureProgress ): void => {
		const now = Date.now();
		if ( event.phase !== phase ) {
			phase = event.phase;
			phaseStartedAt = now;
		}
		const timedEvent = {
			...event,
			elapsedMs: now - startedAt,
			phaseElapsedMs: now - phaseStartedAt,
		};
		onProgress?.( timedEvent );
	};

	const response = await safeFetch( options.url, { timeoutMs: 10_000 } );
	const sourceUrl = response.finalUrl;
	const outputDir = options.outputDir;
	const detection = await detect( sourceUrl );
	const adapter = dependencies.findAdapter( detection.platform );
	if ( ! adapter )
		throw new UnsupportedCapturePlatformError(
			`No adapter available for platform: ${ detection.platform }`
		);
	const routeScope = adapter.routeScope?.( sourceUrl );
	if ( routeScope ) {
		validateRouteScope( routeScope );
		if ( !routeInScope( sourceUrl, routeScope ) ) throw new Error( 'Source URL is outside its adapter route scope' );
	}
	if ( options.acquisition === 'http' && ! adapter.acquisition ) throw new UnsupportedCapturePlatformError( `Platform ${ adapter.id } has no HTTP acquisition profile` );

	progress( { phase: 'discovering', url: sourceUrl } );
	const inventory = ( await adapter.discover( sourceUrl, {
		outputDir,
		resume: options.resume === true,
	} ) ) as CaptureInventory;
	process.stderr.write( `[timing] discovery ${ Date.now() - phaseStartedAt }ms\n` );
	const sourceRoute = documentRequestUrl( sourceUrl );
	// Action URLs leave the inventory before the budget sees it, so they never
	// spend, and never appear as omitted, failed or missing routes.
	const excludedActions = new Map< string, { code: string; url: string; reason: string } >();
	const inventoryUrls = dedupeRouteInventory( [
		sourceUrl,
		...( inventory.urls ?? [] )
			.map( ( entry ) => entry.url )
			.filter( ( url ) => {
				if ( ! routeInScope( url, routeScope ) || documentRequestUrl( url ) === sourceRoute ) return false;
				const action = actionUrlExclusion( url );
				if ( action ) excludedActions.set( action.url, action );
				return ! action;
			} ),
	] );
	const templateGrouping = options.routeSelection === 'template-coverage'
		? await groupInventoryTemplates( { sourceUrl, urls: inventoryUrls, routeScope, outputDir, timeBudgetMs: options.timeBudgetMs } )
		: undefined;
	const { selected: urls, omitted } = selectRouteBudget( inventoryUrls, routeLimit, templateGrouping?.representatives );
	const templateGroups = templateGrouping?.report ? await recordTemplateSelection( outputDir, templateGrouping.report, urls, routeLimit ) : undefined;
	const discoveryDiagnostics = [
		...( inventory.diagnostics ?? [] ),
		...excludedActions.values(),
		...( templateGrouping?.diagnostic ? [ templateGrouping.diagnostic ] : [] ),
		// Request identity, as the linked frontier records it, so a link to an
		// omitted route is the same diagnostic rather than a second one.
		...omitted.map( url => ( { code: ROUTE_OMITTED_BY_BUDGET, url: documentRequestUrl( url ), reason: routeBudgetReason( routeLimit! ) } ) ),
	];
	if ( omitted.length ) process.stderr.write( `[capture] route budget ${ routeLimit }: capturing ${ urls.length } of ${ urls.length + omitted.length } routes\n` );
	progress( { phase: 'capturing', current: 0, total: urls.length } );
	if ( options.acquisition === 'http' ) {
		const result = await ( await import( './capture-http.js' ) ).captureHttpWebsite( { options, sourceUrl, platform: adapter, routeScope, urls, startedAt, progress, title: inventory.siteMeta?.title, discoveryDiagnostics, templateGroups } );
		if ( options.strict && ! result.complete ) throw new IncompleteCaptureError( result );
		return result;
	}

	const { captureScreenshots } = await import( './screenshot/screenshotter.js' );
	const { createReferenceCollector } = await import( './fidelity/reference.js' );
	const reference = createReferenceCollector( outputDir, sourceUrl, urls, {
		routeScope,
		publicUrlsOnly: true,
		cleanupPolicy: ( await import( './source-cleanup.js' ) ).cleanupPolicy( adapter.liberation?.cleanupRules ),
		removeSelectors: adapter.liberation?.removeSelectors,
		prepareCapture: adapter.liberation?.prepare,
		referenceSample,
	} );
	const screenshotResult = await captureScreenshots( {
		urls,
		routeScope,
		outputDir,
		linkedPages: options.linkedPages ?? {},
		// The same budget bounds linked-page admissions, so the frontier cannot
		// push the total past it.
		...( routeLimit !== undefined ? { limit: routeLimit } : {} ),
		primaryUrl: sourceUrl,
		additionalProfiles: adapter.liberation?.additionalProfiles,
		deviceMode: options.deviceMode ?? 'auto',
		deviceDocumentSelection: Boolean( adapter.liberation?.documentSelection ),
		referenceWidths: adapter.liberation?.referenceWidths,
		declareSourceProfile: reference.declare,
		captureImages: options.captureImages === true,
		learnFluid: options.learnFluid !== false,
		force: options.resume !== true,
		removeSelectors: adapter.liberation?.removeSelectors,
		cleanupPolicy: (await import('./source-cleanup.js')).cleanupPolicy(adapter.liberation?.cleanupRules),
		prepareCapture: adapter.liberation?.prepare,
		resolveClientRedirect: adapter.liberation?.resolveClientRedirect,
		beforeSerialize: adapter.liberation?.beforeSerialize,
		observeSource: reference.observe,
		// Memory admission must calibrate on a route that actually produced fresh
		// reference pages; bounded samples leave most routes without them.
		...( reference.sampledSourceUrls ? { referenceSampleUrls: reference.sampledSourceUrls } : {} ),
		...( adapter.liberation?.canonicalizeHtml
			? { canonicalizeHtml: adapter.liberation.canonicalizeHtml.bind( adapter.liberation ) }
			: {} ),
		...( adapter.liberation?.responsiveImages
			? { collectResponsiveImages: adapter.liberation.responsiveImages.bind( adapter.liberation ) }
			: {} ),
		publicUrlsOnly: true,
		...( timeBudget ? { timeBudget } : {} ),
		onProgress: ( current, total, url ) => progress( { phase: 'capturing', current, total, url } ),
	} );
	process.stderr.write(
		`[timing] browser-capture ${ screenshotResult.durationMs }ms (${ screenshotResult.captured } captured, ${ screenshotResult.failed } failed)\n`
	);
	progress( { phase: 'media', current: screenshotResult.captured, total: screenshotResult.urls.length } );
	const mediaStartedAt = Date.now();
	const downloadedSectionMedia = await downloadCaptureSectionMedia( outputDir, screenshotResult.urls, timeBudget?.abandonAt );
	process.stderr.write(
		`[timing] section-media ${ Date.now() - mediaStartedAt }ms (${ downloadedSectionMedia } downloaded)\n`
	);

	const exportStartedAt = Date.now();
	progress( { phase: 'finalizing', current: screenshotResult.captured, total: screenshotResult.urls.length } );
	const failuresPath = join( outputDir, 'screenshots', 'failures.json' );
	const failures = existsSync( failuresPath )
		? ( JSON.parse( readFileSync( failuresPath, 'utf8' ) ) as Array< {
				url: unknown;
				error: unknown;
		  } > )
		: [];
	// One diagnostic per budget-omitted or action-excluded route: initial
	// inventory selection refused it, or the linked frontier did.
	const initialRefusals = new Set( discoveryDiagnostics
		.filter( row => row.code === ROUTE_OMITTED_BY_BUDGET || row.code === ROUTE_EXCLUDED_ACTION_URL )
		.map( row => `${ row.code } ${ row.url }` ) );
	const linkedDiagnostics = ( screenshotResult.linkedPageCoverage?.diagnostics ?? [] ).filter( row =>
		! initialRefusals.has( `${ row.code } ${ row.url }` ) );
	const captureDiagnostics = [ ...discoveryDiagnostics, ...( screenshotResult.routeDiagnostics ?? [] ), ...linkedDiagnostics ];
	const summary = {
		// Same route set `captured`, `skipped` and `failed` are counted over.
		routesDiscovered: screenshotResult.urls.length,
		routesCaptured: screenshotResult.captured,
		routesSkipped: screenshotResult.skipped,
		routesFailed: screenshotResult.failed,
		routesOmitted: budgetOmittedRoutes( captureDiagnostics ).length,
		durationMs: screenshotResult.durationMs,
		...( screenshotResult.deviceMode ? { deviceMode: screenshotResult.deviceMode.mode } : {} ),
		...( screenshotResult.deviceMode?.routes ? { dualRoutes: screenshotResult.deviceMode.routes.dual.length } : {} ),
	};
	const { exportWebsiteCapture } = await import( './capture-export.js' );
	const captureReceiptPath = exportWebsiteCapture( {
		outputDir,
		sourceUrl,
		platform: detection.platform,
		routeScope,
		resolveDocumentSelection: adapter.liberation?.documentSelection,
		...( screenshotResult.deviceMode ? { deviceMode: screenshotResult.deviceMode.mode } : {} ),
		title: inventory.siteMeta?.title,
		summary,
		failures,
		discoveryDiagnostics: captureDiagnostics,
		...( options.maxFileBytes !== undefined ? { limits: { maxFileBytes: options.maxFileBytes } } : {} ),
	} );
	process.stderr.write( `[timing] export ${ Date.now() - exportStartedAt }ms\n` );
	const previewStartedAt = Date.now();
	// A portable homepage preview is a deliverable, not optional capture evidence.
	// Its failure must not turn an otherwise usable website into a failed capture.
	const { captureSitePreview } = await import( './site-preview.js' );
	let preview;
	try {
		preview = { status: 'captured', ...await captureSitePreview( join( outputDir, 'website' ) ) };
	} catch ( error ) {
		preview = { status: 'failed', reason: error instanceof Error ? error.message : String( error ) };
	}
	const receipt = JSON.parse( readFileSync( captureReceiptPath, 'utf8' ) );
	receipt.preview = preview;
	if ( templateGroups ) receipt.templateGroups = templateGroups;
	if ( screenshotResult.deviceMode ) receipt.deviceMode = screenshotResult.deviceMode;
	writeFileSync( captureReceiptPath, `${ JSON.stringify( receipt, null, 2 ) }\n` );
	process.stderr.write( `[timing] homepage-preview ${ Date.now() - previewStartedAt }ms\n` );
	const unresolvedAnchors = readUnresolvedAnchors( outputDir );
	// Diagnosed dynamic pages need causal evidence, not an author-authored site
	// recipe. Discovery remains explicit untranslated evidence until a portable
	// implementation passes the independent source fidelity gate.
	// It revisits the live source, so once the time budget is spent it is skipped:
	// the caller's remaining headroom belongs to finishing the artifact.
	const behaviorStartedAt = Date.now();
	if ( timeBudget && behaviorStartedAt >= timeBudget.abandonAt ) process.stderr.write( '[budget] behavior discovery skipped: capture time budget spent\n' );
	else await ( await import( './behavior-discovery.js' ) ).discoverCapturedBehavior( outputDir );
	process.stderr.write( `[timing] behavior-discovery ${ Date.now() - behaviorStartedAt }ms\n` );
	const finalSummary = withExportDroppedRoutes( summary, receipt.discoveryDiagnostics );
	const complete =
		finalSummary.routesFailed === 0 &&
		! hasUncapturedProfiles( receipt.discoveryDiagnostics ) &&
		! ( receipt.sourceProfile?.documentSelection?.routes ?? [] ).some( ( route: { missing?: string[] } ) => ( route.missing?.length ?? 0 ) > 0 ) &&
		// Budget omission is the caller's scope choice and an action URL is not a
		// page (see `budgetOmittedRoutes`, `actionUrlExclusion`); links to either
		// carry their own reason.
		! linkedDiagnostics.some( row => row.code !== ROUTE_OMITTED_BY_BUDGET && row.code !== ROUTE_EXCLUDED_ACTION_URL ) &&
		unresolvedAnchors.every( ( anchor ) => anchor.reason !== 'target route was not captured' );
	const result: CaptureResult = {
		captureReceiptPath,
		outputDir,
		summary: { ...finalSummary, complete, entrypointCaptured: true },
		complete,
		entrypointCaptured: true,
		missingRoutes: missingRoutes( receipt.discoveryDiagnostics ),
		failures,
		discoveryDiagnostics: captureDiagnostics,
		unresolvedAnchors,
		provenance: { provider: 'data-liberation/browser-capture', platform: detection.platform },
		...( screenshotResult.deviceMode ? { deviceMode: screenshotResult.deviceMode } : {} ),
	};
	// Inside website/, so the findings travel with the artifact and the
	// fidelity reference hashes them with the rest of the capture.
	writeCaptureFindings( outputDir, { ...result, discoveryDiagnostics: receipt.discoveryDiagnostics ?? [] } );
	const referenceStartedAt = Date.now();
	reference.requireUrls(screenshotResult.linkedPageCoverage?.requiredUrls ?? screenshotResult.urls);
	reference.finalize( captureReceiptPath );
	process.stderr.write( `[timing] reference-finalize ${ Date.now() - referenceStartedAt }ms\n` );
	progress( { phase: 'complete', current: urls.length, total: urls.length } );
	if ( options.strict && ! complete ) throw new IncompleteCaptureError( result );
	return result;
}

/**
 * Template grouping for `routeSelection: 'template-coverage'`. Advisory: any
 * failure yields one `template_grouping_unavailable` discovery diagnostic and
 * no representatives, so the budget falls back to discovery order.
 */
async function groupInventoryTemplates( input: { sourceUrl: string; urls: string[]; routeScope?: import('../platform/types.js').SiteRouteScope; outputDir: string; timeBudgetMs?: number } ): Promise< {
	report?: import('./template-groups.js').TemplateGroupsReport;
	representatives?: string[];
	diagnostic?: { code: string; url: string; reason: string };
} > {
	const startedAt = Date.now();
	try {
		const { buildTemplateGroups, templateRepresentatives, TEMPLATE_GROUPING_LIMITS } = await import( './template-groups.js' );
		// Grouping spends at most a tenth of a capture time budget.
		const timeBudgetMs = input.timeBudgetMs === undefined ? TEMPLATE_GROUPING_LIMITS.timeBudgetMs : Math.min( TEMPLATE_GROUPING_LIMITS.timeBudgetMs, Math.max( 1, Math.floor( input.timeBudgetMs / 10 ) ) );
		const report = await buildTemplateGroups( { sourceUrl: input.sourceUrl, urls: input.urls, routeScope: input.routeScope, limits: { timeBudgetMs } } );
		const { coverage } = report;
		process.stderr.write( `[template-groups] ${ coverage.routes } routes: ${ coverage.fingerprinted } fingerprinted into ${ coverage.groups } groups (${ coverage.singletons } singletons), ${ coverage.unfingerprinted } unfingerprinted, ${ Date.now() - startedAt }ms\n` );
		return { report, representatives: templateRepresentatives( report ) };
	} catch ( error ) {
		const reason = `Template grouping unavailable; routes were selected in discovery order: ${ error instanceof Error ? error.message : String( error ) }`;
		process.stderr.write( `[template-groups] ${ reason }\n` );
		return { diagnostic: { code: 'template_grouping_unavailable', url: documentRequestUrl( input.sourceUrl ), reason } };
	}
}

/** Record the budget's selection in the report, write it, and return the receipt summary. */
async function recordTemplateSelection( outputDir: string, report: import('./template-groups.js').TemplateGroupsReport, selected: string[], limit: number | undefined ) {
	const { templateGroupsSummary, templateSelectionCoverage, writeTemplateGroups } = await import( './template-groups.js' );
	report.selection = templateSelectionCoverage( report, selected, 'template-coverage', limit );
	try {
		mkdirSync( outputDir, { recursive: true } );
		writeTemplateGroups( outputDir, report );
	} catch ( error ) {
		process.stderr.write( `[template-groups] report not written: ${ error instanceof Error ? error.message : String( error ) }\n` );
	}
	process.stderr.write( `[template-groups] route selection template-coverage: ${ report.selection.groupsRepresented } of ${ report.groups.length } groups represented in ${ selected.length } routes\n` );
	return templateGroupsSummary( report );
}

function readUnresolvedAnchors( outputDir: string ): UnresolvedAnchor[] {
	const diagnosticsPath = join( outputDir, 'diagnostics.json' );
	if ( ! existsSync( diagnosticsPath ) ) return [];
	try {
		const diagnostics = JSON.parse( readFileSync( diagnosticsPath, 'utf8' ) ) as {
			unresolvedAnchors?: UnresolvedAnchor[];
		};
		return Array.isArray( diagnostics.unresolvedAnchors ) ? diagnostics.unresolvedAnchors : [];
	} catch {
		return [];
	}
}
