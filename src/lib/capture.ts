import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathWithin } from './portable-assets.js';
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
import { DEFAULT_CAPTURE_TIME_BUDGET_MS, dedupeRouteInventory, ROUTE_OMITTED_BY_BUDGET, routeBudgetReason, selectRouteBudget, validateRouteLimit, validateRouteSelection, type RouteLimit } from './route-budget.js';
import type { RouteDiagnostic } from './capture-export-routes.js';
import { ROUTE_ALIAS_CANONICAL, probeCanonicalRouteAliases } from './route-aliases.js';
import { writeSourceFindings } from './source-findings.js';
import { SourceRequestGovernors } from './source-request-governor.js';
import { captureTimeBudgetWindow, validateTimeBudgetMs, validateRouteDeadlineMs } from './capture-time-budget.js';
import { validateMaxFileBytes } from './export-file-limit.js';
import { captureExportLimits, recordFinalWebsiteSize, validateMaxFiles, validateMaxTotalBytes } from './export-total-budget.js';

export { isUsableCapture, USABLE_PARTIAL_CAPTURE_POLICY, type MissingRoute } from './capture-usability.js';
export { DEFAULT_CAPTURE_TIME_BUDGET_MS, DEFAULT_ROUTE_SELECTION, ROUTE_SELECTIONS, type RouteLimit, type RouteSelection } from './route-budget.js';
export { DEFAULT_MAX_FILE_BYTES } from './export-file-limit.js';
export { DEFAULT_MAX_FILES, DEFAULT_MAX_TOTAL_BYTES } from './export-total-budget.js';

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
	 * `routesFailed`. Browser default: observed-time admission within
	 * `DEFAULT_CAPTURE_TIME_BUDGET_MS` (17 minutes), with no fixed count. HTTP
	 * default: 'all'. An explicit number or 'all' overrides default time admission;
	 * an explicit `timeBudgetMs` still bounds the capture.
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
	 * is always captured first and never skipped. Default: 17 minutes unless
	 * `routeLimit` is explicit. Without an explicit route limit, admission uses
	 * observed route durations and actual overlap; unadmitted routes are
	 * `route_omitted_by_budget` diagnostics, not failures. Abandoned routes (and
	 * unadmitted routes with an explicit route limit) are missing routes:
	 * `route_capture_skipped_budget`, counted in `routesFailed`, making
	 * `complete` false. Recommended: the caller's deadline
	 * minus the post-capture headroom (README, "Capture time budget").
	 */
	timeBudgetMs?: number;
	/**
	 * Per-route capture deadline in milliseconds (browser acquisition only). A
	 * route that exceeds it is abandoned: its context closes, its slot frees
	 * for the next route, and it records a `route_capture_timeout` missing
	 * route naming the phase it entered last. Default: derived from
	 * `timeBudgetMs` and the admitted concurrency, never below
	 * `ROUTE_DEADLINE_MIN_MS` (10 min); without `timeBudgetMs`, that floor
	 * applies on its own. `0` disables the deadline.
	 */
	routeDeadlineMs?: number;
	/**
	 * Largest file export writes into `website/`, in bytes. A captured asset over
	 * it is not written; its references resolve like any missing asset and it is
	 * reported as `asset_exceeds_file_limit`. A page document over it fails that
	 * route (`route_export_failed`). Default: `DEFAULT_MAX_FILE_BYTES` (50 MiB),
	 * matching Static Site Importer's per-file intake limit.
	 */
	maxFileBytes?: number;
	/**
	 * Most bytes export writes into `website/`, every file counted, including the
	 * homepage preview and `source-findings.json`. When the site would exceed it,
	 * export drops units least-valuable first: assets the entrypoint does not
	 * need (largest first, fonts last), then non-entry routes (last in route
	 * order first). The entrypoint and the files it needs are never dropped.
	 * Dropped assets resolve like any missing asset (`asset_exceeds_total_budget`);
	 * dropped routes are missing routes (`route_exceeds_total_budget`).
	 * Default: `DEFAULT_MAX_TOTAL_BYTES` (250 MiB), Static Site Importer's
	 * staged-archive `max_total_uncompressed_bytes`.
	 */
	maxTotalBytes?: number;
	/**
	 * Most files export writes into `website/`, enforced like `maxTotalBytes`.
	 * Default: `DEFAULT_MAX_FILES` (5000), Static Site Importer's staged-archive
	 * `max_entries`.
	 */
	maxFiles?: number;
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
	/**
	 * Template-clustered capture, phase 1 of #784 (browser acquisition only).
	 * Implies `routeSelection: 'template-coverage'`, adds one verification
	 * member per multi-member cluster to the budget, and derives every other
	 * member of a verified cluster from the representative's captured document
	 * by transplanting its HTTP-acquired content (`template-clusters.ts`).
	 * Members that fail a gate escalate to the browser pipeline or stay omitted
	 * by budget; derived routes count in `summary.routesDerived`, carry
	 * `route_template_derived` loss rows, and frozen comparison reports them as
	 * uncompared scope (they have no reference evidence). No changes to the
	 * screenshotter itself.
	 */
	templateClusters?: boolean;
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
		/** Opt-in template-clustered capture: routes exported from a verified template (`route_template_derived`). */
		routesDerived?: number;
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
	/** Browser capture: the entrypoint's one-time chrome probe and the routes that reused it. */
	sharedChrome?: import('./screenshot/chrome-reuse.js').SharedChromeSummary;
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
	validateRouteDeadlineMs( options.routeDeadlineMs );
	if ( options.timeBudgetMs !== undefined && options.acquisition === 'http' ) throw new RangeError( 'timeBudgetMs applies to browser acquisition only' );
	validateMaxFileBytes( options.maxFileBytes );
	validateMaxTotalBytes( options.maxTotalBytes );
	validateMaxFiles( options.maxFiles );
	if ( options.deviceMode !== undefined ) {
		const { DEVICE_MODE_REQUESTS } = await import( './screenshot/device-mode.js' );
		if ( ! DEVICE_MODE_REQUESTS.includes( options.deviceMode ) ) throw new RangeError( `deviceMode must be one of ${ DEVICE_MODE_REQUESTS.join( ', ' ) }` );
		if ( options.acquisition === 'http' ) throw new RangeError( 'deviceMode applies to browser acquisition only' );
	}
	const routeLimit = options.routeLimit === 'all' ? undefined : options.routeLimit;
	const { onProgress } = options;
	const startedAt = Date.now();
	const timeBudgetMs = options.timeBudgetMs ?? ( options.acquisition !== 'http' && options.routeLimit === undefined ? DEFAULT_CAPTURE_TIME_BUDGET_MS : undefined );
	const timeBudget = timeBudgetMs === undefined ? undefined : { ...captureTimeBudgetWindow( startedAt, timeBudgetMs ), projectAdmission: options.routeLimit === undefined };
	// One governor per source origin for every HTTP pass of this capture (#907).
	const sourceGovernors = new SourceRequestGovernors();
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
	const aliasProbe = await probeCanonicalRouteAliases( { sourceUrl, urls: inventoryUrls, routeScope } );
	const aliasKeys = new Set( aliasProbe.aliases.map( ( { url } ) => documentRequestUrl( url ) ) );
	if ( aliasProbe.aliases.length ) {
		process.stderr.write( `[capture] canonical route aliases: ${ aliasProbe.aliases.length } of ${ inventoryUrls.length } inventory routes skipped before capture; their rel=canonical is another inventory route (${ aliasProbe.probes } server-HTML probes)\n` );
	}
	const prunedInventoryUrls = aliasProbe.aliases.length
		? inventoryUrls.filter( url => ! aliasKeys.has( documentRequestUrl( url ) ) )
		: inventoryUrls;
	const aliasDiagnostics = aliasProbe.aliases.map( ( { url, canonicalUrl } ) => ( {
		code: ROUTE_ALIAS_CANONICAL,
		url: documentRequestUrl( url ),
		reason: `Route skipped before capture: its server-HTML rel=canonical resolves to ${ documentRequestUrl( canonicalUrl ) }, another inventory route`,
		unit: 'route' as const,
	} ) );
	const templateClusters = options.templateClusters === true;
	if ( templateClusters && options.acquisition === 'http' ) throw new Error( 'templateClusters applies to browser acquisition only' ); // failure-class: programmer
	const routeSelection = options.routeSelection ?? ( templateClusters ? 'template-coverage' : undefined );
	const templateGrouping = routeSelection === 'template-coverage'
		? await groupInventoryTemplates( { sourceUrl, urls: prunedInventoryUrls, routeScope, styleNormalization: adapter.templateStyleNormalization, outputDir, timeBudgetMs, wholeInventory: options.routeLimit === 'all', governors: sourceGovernors } )
		: undefined;
	// Verification members (#784 §4.2): one per multi-member cluster, kept right
	// after the representatives so a budget that fits every template also fits
	// its verification. Derived members hang their cluster's verdict on it.
	const verificationMembers = templateGrouping?.report && templateClusters
		? templateGrouping.report.groups
				.filter( group => group.size >= 2 )
				.map( group => ( group.members.filter( url => url !== group.representative ).sort( ( a, b ) => a.localeCompare( b ) )[ 0 ] ?? '' ) )
				.filter( url => url !== '' )
		: [];
	const { selected: urls, omitted } = selectRouteBudget( prunedInventoryUrls, routeLimit, [ ...( templateGrouping?.representatives ?? [] ), ...verificationMembers ], timeBudget?.projectAdmission );
	const templateGroups = templateGrouping?.report ? await recordTemplateSelection( outputDir, templateGrouping.report, urls, routeLimit ) : undefined;
	const discoveryDiagnostics = [
		...( inventory.diagnostics ?? [] ),
		...excludedActions.values(),
		...( templateGrouping?.diagnostic ? [ templateGrouping.diagnostic ] : [] ),
		...aliasDiagnostics,
		// Request identity, as the linked frontier records it, so a link to an
		// omitted route is the same diagnostic rather than a second one.
		...omitted.map( url => ( { code: ROUTE_OMITTED_BY_BUDGET, url: documentRequestUrl( url ), reason: routeBudgetReason( routeLimit! ) } ) ),
	];
	if ( omitted.length ) process.stderr.write( `[capture] route budget ${ routeLimit }: capturing ${ urls.length } of ${ urls.length + omitted.length } routes\n` );
	progress( { phase: 'capturing', current: 0, total: urls.length } );
	if ( options.acquisition === 'http' ) {
		const result = await ( await import( './capture-http.js' ) ).captureHttpWebsite( { options, sourceUrl, platform: adapter, routeScope, urls, startedAt, progress, title: inventory.siteMeta?.title, discoveryDiagnostics, templateGroups, canonicalAliases: aliasProbe.aliases, governors: sourceGovernors } );
		if ( options.strict && ! result.complete ) throw new IncompleteCaptureError( result );
		return result;
	}

	const { captureScreenshots } = await import( './screenshot/screenshotter.js' );
	const { createReferenceCollector } = await import( './fidelity/reference.js' );
	const telemetryRequest = adapter.liberation?.telemetryRequest?.bind( adapter.liberation );
	const reference = createReferenceCollector( outputDir, sourceUrl, urls, {
		routeScope,
		publicUrlsOnly: true,
		cleanupPolicy: ( await import( './source-cleanup.js' ) ).cleanupPolicy( adapter.liberation?.cleanupRules ),
		telemetryRequest,
		removeSelectors: adapter.liberation?.removeSelectors,
		prepareCapture: adapter.liberation?.prepare,
		referenceSample,
	} );
	const screenshotResult = await captureScreenshots( {
		urls,
		routeScope,
		outputDir,
		linkedPages: options.linkedPages ?? {},
		...( aliasProbe.aliases.length ? { linkedCanonicalAliases: aliasProbe.aliases } : {} ),
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
		clientErrorShellSelectors: adapter.liberation?.clientErrorShellSelectors,
		probeExclusions: adapter.liberation?.probeExclusions,
		cleanupPolicy: (await import('./source-cleanup.js')).cleanupPolicy(adapter.liberation?.cleanupRules),
		prepareCapture: adapter.liberation?.prepare,
		telemetryRequest,
		resolveClientRedirect: adapter.liberation?.resolveClientRedirect,
		beforeFluid: adapter.liberation?.beforeFluid,
		beforeSerialize: adapter.liberation?.beforeSerialize,
		observeSource: reference.observe,
		// Memory admission reserves for what a route opens: bounded samples
		// leave most routes without fresh reference pages.
		...( reference.sampledSourceUrls ? { referenceSampleUrls: reference.sampledSourceUrls } : {} ),
		...( adapter.liberation?.canonicalizeHtml
			? { canonicalizeHtml: adapter.liberation.canonicalizeHtml.bind( adapter.liberation ) }
			: {} ),
		...( adapter.liberation?.responsiveImages
			? { collectResponsiveImages: adapter.liberation.responsiveImages.bind( adapter.liberation ) }
			: {} ),
		publicUrlsOnly: true,
		...( timeBudget ? { timeBudget } : {} ),
		...( options.routeDeadlineMs !== undefined ? { routeDeadlineMs: options.routeDeadlineMs } : {} ),
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

	// Phase 1 of #784: derive every ungated member of a verified multi-member
	// cluster from its representative's captured document. Opt-in
	// (`templateClusters`), bounded by TEMPLATE_CLUSTER_LIMITS, and recorded in
	// `template-clusters.json` next to `website/`. Derived entries become
	// ordinary manifest entries before export, so export needs no second input
	// kind. Any failure degrades to the pre-derivation state: the member keeps
	// its `route_omitted_by_budget` diagnostic.
	const derivedTemplateClusters = templateClusters && templateGrouping?.report
		? await deriveTemplateClusterMembers( {
				sourceUrl,
				outputDir,
				report: templateGrouping.report,
				capturedUrls: screenshotResult.urls,
				routeScope,
				timeBudgetMs: options.timeBudgetMs,
			} )
		: undefined;
	if ( derivedTemplateClusters ) {
		process.stderr.write(
			`[template-clusters] ${ derivedTemplateClusters.summary.derived } derived, ${ derivedTemplateClusters.summary.escalated } escalated, ${ derivedTemplateClusters.summary.unavailable } unavailable, ${ Date.now() - mediaStartedAt }ms\n`
		);
	}

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
	// A derived route is no longer omitted by budget: it shipped as a
	// template-cluster derivative, so its omission row is replaced by the
	// derivation's own loss row (`route_template_derived`).
	const derivedUrls = new Set( derivedTemplateClusters?.summary.derivedUrls ?? [] );
	const captureDiagnostics = [
		...discoveryDiagnostics.filter( row => row.code !== ROUTE_OMITTED_BY_BUDGET || ! derivedUrls.has( row.url ) ),
		...( screenshotResult.routeDiagnostics ?? [] ),
		...linkedDiagnostics,
		...( derivedTemplateClusters?.diagnostics ?? [] ),
	];
	const summary = {
		// Same route set `captured`, `skipped` and `failed` are counted over.
		routesDiscovered: screenshotResult.urls.length - ( screenshotResult.routeDiagnostics ?? [] ).filter( row => row.code === ROUTE_OMITTED_BY_BUDGET ).length,
		routesCaptured: screenshotResult.captured + ( derivedTemplateClusters?.summary.derived ?? 0 ),
		routesSkipped: screenshotResult.skipped,
		routesFailed: screenshotResult.failed,
		routesOmitted: budgetOmittedRoutes( captureDiagnostics ).length,
		...( derivedTemplateClusters ? { routesDerived: derivedTemplateClusters.summary.derived } : {} ),
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
		canonicalAliases: aliasProbe.aliases,
		failures,
		discoveryDiagnostics: captureDiagnostics,
		limits: captureExportLimits( options ),
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
	if ( derivedTemplateClusters ) {
		receipt.templateClusters = derivedTemplateClusters.receiptSummary;
		// Next to `website/`, like template-groups.json: evidence of what was
		// derived and on what cluster verdict, hashed into the fidelity reference.
		( await import( './template-clusters.js' ) ).writeTemplateClusters( outputDir, derivedTemplateClusters.receipt );
	}
	if ( screenshotResult.deviceMode ) receipt.deviceMode = screenshotResult.deviceMode;
	if ( screenshotResult.sharedChrome ) receipt.sharedChrome = screenshotResult.sharedChrome;
	if ( adapter.engagementStats ) {
		const engagementStartedAt = Date.now();
		if ( timeBudget && engagementStartedAt >= timeBudget.abandonAt ) process.stderr.write( '[budget] engagement stats skipped: capture time budget spent\n' );
		else {
			const reading = await adapter.engagementStats( [ ...screenshotResult.urls, ...derivedUrls ], { deadline: timeBudget?.abandonAt } ).catch( () => undefined );
			if ( reading && ( reading.pages.length || reading.unavailable.length ) ) {
				receipt.engagementStats = ( await import( './engagement-stats.js' ) ).engagementStatsRecord( reading, new Date( engagementStartedAt ).toISOString() );
			}
			process.stderr.write( `[timing] engagement-stats ${ Date.now() - engagementStartedAt }ms (${ reading?.pages.length ?? 0 } read)\n` );
		}
	}
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
		...( screenshotResult.sharedChrome ? { sharedChrome: screenshotResult.sharedChrome } : {} ),
	};
	// Inside website/, so the findings travel with the artifact and the
	// fidelity reference hashes them with the rest of the capture.
	writeSourceFindings( outputDir, { ...result, discoveryDiagnostics: receipt.discoveryDiagnostics ?? [] } );
	recordFinalWebsiteSize( outputDir, captureReceiptPath );
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
async function groupInventoryTemplates( input: { sourceUrl: string; urls: string[]; routeScope?: import('../platform/types.js').SiteRouteScope; styleNormalization?: import('./template-groups.js').TemplateStyleNormalization; outputDir: string; timeBudgetMs?: number; wholeInventory: boolean; governors: SourceRequestGovernors } ): Promise< {
	report?: import('./template-groups.js').TemplateGroupsReport;
	representatives?: string[];
	diagnostic?: { code: string; url: string; reason: string };
} > {
	const startedAt = Date.now();
	try {
		const { buildTemplateGroups, templateRepresentatives } = await import( './template-groups.js' );
		const report = await buildTemplateGroups( { sourceUrl: input.sourceUrl, urls: input.urls, routeScope: input.routeScope, limits: await templateGroupingLimits( input ), governors: input.governors, ...( input.styleNormalization ? { styleNormalization: input.styleNormalization } : {} ) } );
		const { coverage } = report;
		process.stderr.write( `[template-groups] ${ coverage.routes } routes: ${ coverage.fingerprinted } fingerprinted into ${ coverage.groups } groups (${ coverage.singletons } singletons), ${ coverage.unfingerprinted } unfingerprinted, ${ report.throttle.events } throttle events, ${ Date.now() - startedAt }ms\n` );
		const source = input.governors.forOrigin( input.sourceUrl ).stats();
		process.stderr.write( `[timing] template-groups source ${ source.origin }: ${ source.requests } requests, ${ source.throttleEvents } throttled, sustained ${ source.sustainedRate.toFixed( 2 ) } req/s, ${ source.concurrency } in flight\n` );
		return { report, representatives: templateRepresentatives( report ) };
	} catch ( error ) {
		const reason = `Template grouping unavailable; routes were selected in discovery order: ${ error instanceof Error ? error.message : String( error ) }`;
		process.stderr.write( `[template-groups] ${ reason }\n` );
		return { diagnostic: { code: 'template_grouping_unavailable', url: documentRequestUrl( input.sourceUrl ), reason } };
	}
}

/**
 * Grouping bounds for a capture. Whole-inventory capture (`routeLimit: 'all'`)
 * makes every inventory route a candidate and, with a capture time budget,
 * spends up to a quarter of it. Otherwise: the default spread sample, and at
 * most a tenth of a capture time budget, never over the default pass time.
 */
export async function templateGroupingLimits( input: { timeBudgetMs?: number; wholeInventory: boolean } ): Promise< Partial< import('./template-groups.js').TemplateGroupingLimits > > {
	const { TEMPLATE_GROUPING_LIMITS } = await import( './template-groups.js' );
	if ( input.wholeInventory ) {
		return { maxRoutes: 'all', timeBudgetMs: input.timeBudgetMs === undefined ? TEMPLATE_GROUPING_LIMITS.timeBudgetMs : Math.max( 1, Math.floor( input.timeBudgetMs / 4 ) ) };
	}
	return { timeBudgetMs: input.timeBudgetMs === undefined ? TEMPLATE_GROUPING_LIMITS.timeBudgetMs : Math.min( TEMPLATE_GROUPING_LIMITS.timeBudgetMs, Math.max( 1, Math.floor( input.timeBudgetMs / 10 ) ) ) };
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

/** Loss-ledger codes for template-clustered capture (docs/contracts/loss-ledger.md, #784 §3.4). */
export const ROUTE_TEMPLATE_DERIVED = 'route_template_derived';
export const ROUTE_TEMPLATE_ESCALATED = 'route_template_escalated';
export const TEMPLATE_SLOT_RUNTIME_UNOBSERVED = 'template_slot_runtime_unobserved';

export interface TemplateClusterDerivation {
	summary: { derived: number; derivedUrls: string[]; escalated: number; unavailable: number };
	/** Findings projected into `capture-findings.json` and the receipt. */
	diagnostics: RouteDiagnostic[];
	/** The `template-clusters.json` receipt. */
	receipt: import('./template-clusters.js').TemplateClustersReceipt;
	/** Compact counts for the capture receipt. */
	receiptSummary: Record< string, unknown >;
}

/**
 * Derive members for verified clusters after the browser capture (opt-in
 * `templateClusters`). Each cluster with a captured representative first
 * derives its verification member and compares it, offline, with the real
 * capture on the six acceptance checks; a mismatch fails the cluster and
 * escalates every member. Remaining members pass the per-member gates and
 * become ordinary manifest entries, so export needs no second input kind.
 * One cluster's failure degrades only that cluster (#761); a terminated
 * stage leaves the pre-derivation state (members stay budget-omitted).
 *
 * Derived routes are phase-1 desktop documents: the transplant copies the
 * representative's desktop profile and fluid evidence, and a dual-site
 * member without a derived phone document ships desktop-only. The mobile
 * transplant (§3.1 step 4) is remaining phase-1 work.
 */
async function deriveTemplateClusterMembers( input: {
	sourceUrl: string;
	outputDir: string;
	report: import('./template-groups.js').TemplateGroupsReport;
	capturedUrls: readonly string[];
	routeScope?: import('../platform/types.js').SiteRouteScope;
	timeBudgetMs?: number;
} ): Promise< TemplateClusterDerivation > {
	const { deriveMemberDocument, compareDerivedWithCapture, TEMPLATE_CLUSTER_LIMITS, writeTemplateClusters, TEMPLATE_CLUSTERS_FILE } =
		await import( './template-clusters.js' );
	const { safeFetch } = await import( './media-fetch/safe-fetch.js' );
	const { CapturedResourceStore } = await import( './screenshot/resource-capture.js' );
	const { ManifestQueue } = await import( './screenshot/manifest-queue.js' );
	const { slugify } = await import( './url/index.js' );

	const diagnostics: RouteDiagnostic[] = [];
	const clusters: import('./template-clusters.js').TemplateClusterRecord[] = [];
	const derivedUrls: string[] = [];
	let escalated = 0;
	let unavailableCount = 0;

	// The capture released the manifest queue, so this stage is its single
	// writer; a fresh queue loads the flushed file.
	const manifestPath = join( input.outputDir, 'screenshots', 'manifest.json' );
	const queue = new ManifestQueue( manifestPath );
	await queue.init();
	const capturedUrls = new Set( input.capturedUrls.map( documentRequestUrl ) );
	try {
		for ( const group of input.report.groups ) {
			if ( group.size < 2 ) continue;
			const repEntry = queue.getEntry( documentRequestUrl( group.representative ) ) ?? queue.getEntry( group.representative );
			if ( ! repEntry?.html || repEntry.redirectedTo ) continue;
			const repHtmlPath = resolve( input.outputDir, repEntry.html );
			if ( ! pathWithin( input.outputDir, repHtmlPath ) || ! existsSync( repHtmlPath ) ) continue;
			const record: import('./template-clusters.js').TemplateClusterRecord = {
				id: group.id, key: group.key, representative: group.representative,
				derived: [], escalated: [], unavailable: [],
			};
			clusters.push( record );
			const startedAt = Date.now();
			try {
				const repFetch = await safeFetch( group.representative, { timeoutMs: TEMPLATE_CLUSTER_LIMITS.requestTimeoutMs } );
				const repServerHtml = repFetch.body.toString( 'utf8' );
				const repProcessedHtml = readFileSync( repHtmlPath, 'utf8' );
				const store = new CapturedResourceStore( input.outputDir, input.sourceUrl );
				let derivedInCluster = 0;
				let clusterFailed = false;

				// Verification first (#784 §4.2): one member derived, then compared
				// with its real capture, offline, on the six acceptance checks. A
				// mismatch (or a missing verification capture) fails the cluster: no
				// member of it is ever derived (§3.5).
				const members = group.members
					.filter( url => ! capturedUrls.has( documentRequestUrl( url ) ) )
					.sort( ( a, b ) => a.localeCompare( b ) );
				// A captured member is the stronger verification: its real capture
				// exists on disk, so the derived-vs-real comparison is actually
				// scored. Preferred verification members are already in the budget.
				const capturedMembers = group.members
					.filter( url => url !== group.representative && capturedUrls.has( documentRequestUrl( url ) ) )
					.sort( ( a, b ) => a.localeCompare( b ) );
				const verificationUrl = capturedMembers[ 0 ] ?? members[ 0 ];
				const verificationCaptured = verificationUrl !== undefined &&
					Boolean( queue.getEntry( documentRequestUrl( verificationUrl ) ) ?? queue.getEntry( verificationUrl ) );
				let verified = false;
				let verificationRecord: import('./template-clusters.js').TemplateClusterRecord['verification'] =
					{ url: verificationUrl ?? group.representative, captured: verificationCaptured };
				if ( verificationUrl === undefined ) continue;
				if ( verificationCaptured ) {
					const realEntry = queue.getEntry( documentRequestUrl( verificationUrl ) ) ?? queue.getEntry( verificationUrl )!;
					const realHtml = readFileSync( resolve( input.outputDir, realEntry.html! ), 'utf8' );
					const memberFetch = await safeFetch( verificationUrl, { timeoutMs: TEMPLATE_CLUSTER_LIMITS.requestTimeoutMs } );
					const derivation = deriveMemberDocument( { repServerHtml, repProcessedHtml, memberServerHtml: memberFetch.body.toString( 'utf8' ), baseUrl: group.representative } );
					if ( derivation.ok ) {
						const comparison = compareDerivedWithCapture( { derivedHtml: derivation.html, realHtml, baseUrl: group.representative } );
						verificationRecord = { url: verificationUrl, captured: true, checks: comparison.checks, equal: comparison.equal };
						verified = comparison.equal;
						if ( ! comparison.equal ) {
							const failing = Object.entries( comparison.checks ).filter( ( [ , ok ] ) => ! ok ).map( ( [ name ] ) => name ).join( ', ' );
	diagnostics.push( { code: ROUTE_TEMPLATE_ESCALATED, url: verificationUrl, reason: `cluster verification failed its derived-vs-real comparison (${ failing })`, metrics: { clusterSize: group.size } } );
						}
					} else {
						verificationRecord = { url: verificationUrl, captured: true };
						diagnostics.push( { code: ROUTE_TEMPLATE_ESCALATED, url: verificationUrl, reason: `cluster verification member failed the ${ derivation.gate.code } gate`, metrics: { clusterSize: group.size } } );
					}
				}
				// The verdict is final here: record it so a failed cluster is visible
				// in the receipt, not only in the diagnostics.
				record.verification = verificationRecord;
				if ( ! verified ) clusterFailed = true;

				for ( const url of members ) {
					if ( clusterFailed || derivedInCluster >= TEMPLATE_CLUSTER_LIMITS.maxDerivedRoutes ) break;
					const response = await safeFetch( url, { timeoutMs: TEMPLATE_CLUSTER_LIMITS.requestTimeoutMs } ).catch( ( error: unknown ) => {
						record.unavailable.push( { url, reason: String( ( error as Error ).message ?? error ) } );
						unavailableCount++;
						return undefined;
					} );
					if ( ! response ) continue;
					if ( response.status < 200 || response.status >= 300 ) {
						record.unavailable.push( { url, reason: `HTTP ${ response.status }` } );
						unavailableCount++;
						continue;
					}
					const derivation = deriveMemberDocument( { repServerHtml, repProcessedHtml, memberServerHtml: response.body.toString( 'utf8' ), baseUrl: group.representative } );
					if ( ! derivation.ok ) {
						// A gate failure is an escalation, not a loss: the member keeps
						// its budget-omission row, with the gate named for the next run.
						diagnostics.push( { code: ROUTE_TEMPLATE_ESCALATED, url, reason: `failed the ${ derivation.gate.code } gate: ${ derivation.gate.reason }`, metrics: { clusterSize: group.size } } );
						record.escalated.push( { url, gate: derivation.gate.code, reason: derivation.gate.reason } );
						escalated++;
						continue;
					}
					// Localize the member's slot media exactly as capture does (§3.1
					// step 3): the same captured-resource stage over the same store.
					await store.captureDomDependencies( derivation.html, url );
					const memberPath = `screenshots/derived/${ slugify( url ) }.html`;
					const memberFile = resolve( input.outputDir, memberPath );
					mkdirSync( dirname( memberFile ), { recursive: true } );
					writeFileSync( memberFile, derivation.html );
					const slug = await queue.claimSlug( slugify( url ) );
					const capturedAtNow = new Date().toISOString();
					const repProfile = repEntry.profiles?.desktop;
					await queue.updateEntry( url, {
						slug,
						html: memberPath,
						capturedAt: capturedAtNow,
						...( repProfile ? { profiles: { desktop: { ...repProfile } } } : {} ),
						...( repEntry.fluid ? { fluid: repEntry.fluid } : {} ),
					} as import('./screenshot/manifest-queue.js').ManifestEntry );
					diagnostics.push( {
						code: ROUTE_TEMPLATE_DERIVED, url, reason: `derived from cluster ${ group.id } representative ${ group.representative }`,
						unit: 'route', severity: 'warning',
						metrics: {
							clusterSize: group.size,
							verifiedSamples: verificationCaptured ? 1 : 0,
							slots: derivation.stats.slots,
							subtreeSlots: derivation.stats.subtreeSlots,
							...( derivation.unobservedSlots > 0 ? { unobservedSlots: derivation.unobservedSlots } : {} ),
						},
					} );
					if ( derivation.unobservedSlots > 0 ) diagnostics.push( { code: TEMPLATE_SLOT_RUNTIME_UNOBSERVED, url, reason: `${ derivation.unobservedSlots } slot(s) hold data-* swapped media whose rendered URL capture never observed`, unit: 'block', severity: 'warning' } );
					record.derived.push( { url, slots: derivation.stats.slots, subtreeSlots: derivation.stats.subtreeSlots } );
					derivedUrls.push( url );
					derivedInCluster++;
				}
				await store.flush();
				process.stderr.write( `[template-clusters] cluster ${ group.id }: derived ${ record.derived.length }, escalated ${ record.escalated.length }, ${ Date.now() - startedAt }ms\n` );
			} catch ( error ) {
				// One cluster's derivation failure degrades only that cluster: the
				// members keep their budget-omission rows (#761).
				diagnostics.push( { code: ROUTE_TEMPLATE_ESCALATED, url: group.representative, reason: `cluster derivation unavailable: ${ error instanceof Error ? error.message : String( error ) }` } );
			}
		}
	} finally {
		await queue.flush().catch( () => {} );
	}

	const receipt: import('./template-clusters.js').TemplateClustersReceipt = {
		schema: 'data-liberation-agent/template-clusters/v1',
		fingerprint: { version: ( await import( './template-groups.js' ) ).TEMPLATE_FINGERPRINT_VERSION },
		sourceUrl: input.sourceUrl,
		derivedCount: derivedUrls.length,
		escalatedCount: escalated,
		unavailableCount,
		clusters,
	};
	writeTemplateClusters( input.outputDir, receipt );
	return {
		summary: { derived: derivedUrls.length, derivedUrls, escalated, unavailable: unavailableCount },
		diagnostics,
		receipt,
		receiptSummary: { report: TEMPLATE_CLUSTERS_FILE, derived: derivedUrls.length, escalated, unavailable: unavailableCount, clusters: clusters.length },
	};
}
