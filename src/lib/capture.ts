import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { catalogImageSources } from './product-row.js';
import { dirname, join, resolve } from 'node:path';
import { pathWithin } from './portable-assets.js';
import { findAdapter } from '../adapters/index.js';
import { resolveEntryUrl } from '../platform/registry.js';
import type { PlatformAdapter } from '../types.js';
import { detect } from './detect-platform/index.js';
import { fetchTemplateDocument } from './template-cluster-fetch.js';
import { normalizeTrustedOrigins, runWithTrustedOrigins, safeFetch } from './media-fetch/safe-fetch.js';
import { downloadMedia, existingMediaNames } from './media-fetch/media.js';
import { establishSourceSession, sourceSessionCookieHeader } from './browser-kit/browser-kit.js';
import { captureAssets } from './image-assets.js';
import { downloadSectionMedia } from './replicate/download-section-media.js';
import { SectionSpecsStore } from './replicate/section-specs-store.js';
import { MediaStubStore } from './resume-state/index.js';
import { documentRequestUrl, normalizedUrl } from './url/route-key.js';
import { extractNavigationLandmarkLinks } from './html-extract/index.js';
import { decodeHtml } from './decode-html.js';
import { normalizeDiscoveredRoutes } from './extraction/sitemap.js';
import { routeInScope, scopedRouteKey, validateRouteScope } from './url/route-scope.js';
import { githubPagesRouteScope } from '../hosts/github-pages.js';
import { actionUrlExclusion, platformRuntimeExclusion, ROUTE_EXCLUDED_ACTION_URL } from './url/action-url.js';
import { NON_DOCUMENT_URL } from './screenshot/linked-frontier.js';
import { galleryFrameMediaUrls } from './screenshot/gallery-capture.js';
import type { ManifestEntry } from './screenshot/manifest-queue.js';
import { budgetOmittedRoutes, hasUncapturedProfiles, missingRoutes, withExportDroppedRoutes, type MissingRoute } from './capture-usability.js';
import { DEFAULT_CAPTURE_TIME_BUDGET_MS, ROUTE_OMITTED_BY_BUDGET, routeBudgetReason, templateVerificationMember, dedupeRouteInventory, rankTemplateClusterRoutes, selectRouteBudget, validateRouteLimit, validateRouteSelection, type RouteLimit } from './route-budget.js';
import type { RouteDiagnostic } from './capture-export-routes.js';
import { ROUTE_ALIAS_CANONICAL, probeCanonicalRouteAliases } from './route-aliases.js';
import { writeSourceFindings } from './source-findings.js';
import { sourceRequestContext, SourceRequestGovernors, THROTTLE_STATUSES } from './source-request-governor.js';
import { completeSourceTlsChain } from './tls-aia.js';
import { AssetAcquisitionQueue } from './asset-acquisition-queue.js';
import { captureTimeBudgetWindow, validateTimeBudgetMs, validateRouteReserveMs, validateRouteDeadlineMs } from './capture-time-budget.js';
import { validateMaxFileBytes } from './export-file-limit.js';
import { captureExportLimits, recordFinalWebsiteSize, validateMaxFiles, validateMaxTotalBytes } from './export-total-budget.js';
import { assertEntrypointHasContent } from './source-content.js';
import { structuredTermArchiveUrls } from './content-index.js';

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
	/**
	 * The routes selected for capture, in capture order. Sent once, on the first
	 * `capturing` event (`current: 0`). Linked pages admitted while capturing can
	 * raise `total` and arrive later as `url` without being listed here.
	 */
	urls?: string[];
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
	/**
	 * Origins the caller vouches for — typically its own machine: a local
	 * development site (WordPress Studio, wp-env, Local) served at e.g.
	 * `http://localhost:8884/`. Each entry is an absolute http(s) URL; its
	 * exact `URL.origin` (scheme, host, port) bypasses the SSRF guard's
	 * loopback/private-host rejection for the entry URL, discovered routes,
	 * subresources, media and every redirect hop. A trusted origin that
	 * redirects to another internal host stays blocked, and with no entry
	 * named the guard behaves exactly as before. Default: nothing vouched.
	 */
	trustedOrigins?: string[];
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
	/** Export now; freeze capture-declared reference cells with the reference command later. */
	deferReference?: boolean;
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
	/** Save resumable state without exporting when the time budget leaves missing routes. */
	checkpoint?: boolean;
	/**
	 * Milliseconds of the capture time budget reserved per started route for
	 * downstream work (browser acquisition only). Every route that starts —
	 * the entrypoint included — holds this much of the budget unspent, and
	 * admission closes once the remaining window can no longer cover all
	 * reserves plus the candidate's; routes left out this way are
	 * `route_capture_skipped_budget` findings whose reason names the reserve.
	 * Use it when what follows capture costs a fixed amount per captured route
	 * (e.g. a site build): pass the measured per-route downstream cost and
	 * capture admits only as many routes as the reserved budget covers.
	 * `abandonAt` is unchanged: routes already running finish or are abandoned
	 * as before. Has no effect when no time budget governs the capture.
	 * Default: 0 (no per-route reserve).
	 */
	routeReserveMs?: number;
	/**
	 * Per-route capture deadline in milliseconds (browser acquisition only). A
	 * route that exceeds it is abandoned: its context closes, its slot frees
	 * for the next route, and nothing from its in-flight profile is recorded.
	 * With no completed profile it records a `route_capture_timeout` missing
	 * route naming the phase it entered last; otherwise it keeps its completed
	 * profiles and each lost profile is a `route_profile_capture_timeout` (and,
	 * at export, `route_profile_uncaptured`) row. Default: derived from
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
	 * Defaults on when the adapter declares structuredContent; false opts out.
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
	reference?: { status: 'pending' | 'complete' };
	/** True only when export was deferred; resume into the same output directory. */
	checkpoint?: boolean;
	resumable?: boolean;
	/** Captured pages still need a run with enough remaining export reserve. */
	exportPending?: boolean;
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

export { SourceHasNoContentError } from './source-content.js';

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
	urls?: Array< { url: string } >;
	diagnostics?: Array< { code: string; url: string; reason: string } >;
}

/** `deadline` (epoch ms) stops new downloads; media not started stays unlocalized. */
export async function downloadCaptureSectionMedia(
	outputDir: string,
	urls: string[],
	deadline?: number,
	resolveImageOriginal?: import('../platform/types.js').Platform['resolveImageOriginal'],
	catalogImages: string[] = [],
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
	const sectionUrls: string[] = [...catalogImages];
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
			sectionUrls.push( ...galleryFrameMediaUrls( entry.interactions?.states ?? [], pageUrl, entry.interactions?.components ) );
		}
	}

	// Serialized documents retain every srcset candidate, not just currentSrc.
	const documents: Array<{ path: string; url: string; css?: boolean }> = [];
	if ( existsSync( manifestPath ) ) {
		const manifest = JSON.parse( readFileSync( manifestPath, 'utf8' ) ) as { entries?: Record<string, ManifestEntry> };
		for ( const [ url, entry ] of Object.entries( manifest.entries ?? {} ) ) {
			for ( const path of new Set( [ entry.html, entry.mobileHtml, ...Object.values( entry.profiles ?? {} ).map( profile => profile.html ) ] ) ) {
				if ( path && existsSync( join( outputDir, path ) ) ) documents.push( { path: join( outputDir, path ), url } );
			}
		}
	}
	const resourceManifestPath = join( outputDir, 'resources', 'manifest.json' );
	if ( existsSync( resourceManifestPath ) ) {
		const resources = JSON.parse( readFileSync( resourceManifestPath, 'utf8' ) ).resources ?? {};
		for ( const [ url, resource ] of Object.entries( resources ) as Array<[string, { path: string; contentType: string }]> ) {
			if ( /^text\/css/.test( resource.contentType ) && pathWithin( outputDir, resolve( outputDir, resource.path ) ) && existsSync( join( outputDir, resource.path ) ) ) {
				documents.push( { url, path: join( outputDir, resource.path ), css: true } );
			}
		}
	}
	function* imageDocuments() {
		// Catalog references share asset verification, reuse and source governance with page images.
		if (catalogImages.length) yield { url: urls[0]!, html: catalogImages.map(src => `<img src="${src.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`).join('') };
		for ( const document of documents ) {
			const text = readFileSync( document.path, 'utf8' );
			yield { url: document.url, html: document.css ? `<style>${ text }</style>` : text };
		}
	}
	// Most of this phase is verifying every captured asset, not section downloads.
	const verificationStartedAt = Date.now();
	const imageAssets = await captureAssets( outputDir, imageDocuments(), deadline, resolveImageOriginal );
	process.stderr.write(
		`[timing] asset-verification ${ Date.now() - verificationStartedAt }ms (${ imageAssets.filter( record => record.original ).length } of ${ imageAssets.length } verified)\n`
	);
	const recordedImageUrls = new Set( imageAssets.flatMap( record => record.source_urls ) );
	const stubs = MediaStubStore.load( outputDir );
	const mediaDir = join( outputDir, 'media' );
	const seenNames = existingMediaNames( mediaDir );
	const { downloaded } = await downloadSectionMedia( {
		srcUrls: sectionUrls,
		isAlreadyDone: ( url ) => recordedImageUrls.has( url ) || ! stubs.shouldAttempt( url ),
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
	// One vouching decision for the whole run: the caller names the origins it
	// owns (a local dev site on its own machine), and every guard check on
	// this path — discovery, browser request routing, media, sitemap, HTTP
	// acquisition and each redirect hop — sees exactly that set through the
	// capture context. Malformed entries reject here, before any work starts.
	normalizeTrustedOrigins( options.trustedOrigins );
	const governors = new SourceRequestGovernors();
	return sourceRequestContext.run(governors, async () => {
		try { return await runWithTrustedOrigins( options.trustedOrigins, () => runCaptureWebsite( options, dependencies, governors ) ); }
		finally {
			const attribution = governors.attribution();
			process.stderr.write(`[source-requests] ${JSON.stringify(governors.stats())} attribution=${JSON.stringify(attribution.origins.map(({ origin, totals }) => ({ origin, totals })))}\n`);
			// Diagnostics must never turn an otherwise successful capture into a failure.
			try {
				mkdirSync(options.outputDir, { recursive: true });
				writeFileSync(join(options.outputDir, 'source-request-attribution.json'), `${JSON.stringify(attribution, null, 2)}\n`);
			} catch { /* Output may be unavailable after a failed capture. */ }
		}
	});
}

async function runCaptureWebsite(
	options: CaptureOptions,
	dependencies: CaptureDependencies,
	sourceGovernors: SourceRequestGovernors
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
	validateRouteReserveMs( options.routeReserveMs );
	validateRouteDeadlineMs( options.routeDeadlineMs );
	if ( options.timeBudgetMs !== undefined && options.acquisition === 'http' ) throw new RangeError( 'timeBudgetMs applies to browser acquisition only' );
	if ( options.routeReserveMs !== undefined && options.acquisition === 'http' ) throw new RangeError( 'routeReserveMs applies to browser acquisition only' );
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
	const timeBudget = timeBudgetMs === undefined ? undefined : { ...captureTimeBudgetWindow( startedAt, timeBudgetMs, options.routeReserveMs ), projectAdmission: options.routeLimit === undefined, checkpoint: options.checkpoint };
	// One governor per source origin for every HTTP pass of this capture (#907).
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

	if ( options.acquisition !== 'http' ) await ( await import( './browser-kit/ensure-capture-browser.js' ) ).ensureCaptureBrowser();
	const response = await fetchEntryDocument( await resolveEntryUrl( options.url ), sourceGovernors, { session: options.acquisition !== 'http' } );
	// The governor already waited out Retry-After; a still-throttled entry would
	// detect from a throttle page. Other statuses keep their browser capture.
	if ( THROTTLE_STATUSES.has( response.status ) ) {
		throw new Error( `entry_document_throttled: Entry document ${ response.finalUrl } is still throttled (HTTP ${ response.status }) after Retry-After` ); // failure-class: operational
	}
	let sourceUrl = response.finalUrl;
	const entryHtml = response.body && response.headers
		? decodeHtml( new Uint8Array( response.body ), response.headers.get( 'content-type' ) ?? '', { fatal: false } )
		: '';
	const outputDir = options.outputDir;
	const detection = await detect( sourceUrl, { headers: response.headers, html: entryHtml } );
	process.stderr.write( `[capture] platform detection ${ JSON.stringify( { status: response.status, ...detection } ) }\n` );
	const adapter = dependencies.findAdapter( detection.platform );
	if ( ! adapter )
		throw new UnsupportedCapturePlatformError(
			`No adapter available for platform: ${ detection.platform }`
		);
	const templateClusters = options.templateClusters ?? options.acquisition !== 'http';
	const templateClustersDecision = { enabled: templateClusters, source: options.templateClusters !== undefined ? 'explicit' : 'default' };
	if ( options.templateClusters === true && options.acquisition === 'http' ) throw new Error( 'templateClusters applies to browser acquisition only' ); // failure-class: programmer
	const scopeDiagnostics: NonNullable<CaptureInventory['diagnostics']> = [];
	const routeScope = await githubPagesRouteScope( sourceUrl, scopeDiagnostics ) ?? adapter.routeScope?.( sourceUrl );
	if ( routeScope ) {
		validateRouteScope( routeScope );
		if ( !routeInScope( sourceUrl, routeScope ) ) throw new Error( 'Source URL is outside its adapter route scope' );
		sourceUrl = scopedRouteKey( sourceUrl, routeScope );
	}
	if ( options.acquisition === 'http' && ! adapter.acquisition ) throw new UnsupportedCapturePlatformError( `Platform ${ adapter.id } has no HTTP acquisition profile` );

	progress( { phase: 'discovering', url: sourceUrl } );
	const inventory = ( await adapter.discover( sourceUrl, {
		outputDir,
		entryHtml,
		resume: options.resume === true,
	} ) ) as CaptureInventory;
	process.stderr.write( `[timing] discovery ${ Date.now() - phaseStartedAt }ms\n` );
	// Structured content (#1701) only feeds template-cluster derivation.
	const contentSource = templateClusters ? adapter.structuredContent : undefined;
	const structuredContent = contentSource ? await contentSource.enumerate( sourceUrl, { governors: sourceGovernors, inventory } ) : undefined;
	const contentEntries = structuredContent?.entries ?? [];
	if ( structuredContent ) process.stderr.write( `[timing] structured content ${ adapter.id }: ${ contentEntries.length } entries, ${ structuredContent.diagnostics.length } diagnostics, ${ Date.now() - phaseStartedAt }ms\n` );
	inventory.diagnostics = [ ...scopeDiagnostics, ...( inventory.diagnostics ?? [] ), ...( structuredContent?.diagnostics ?? [] ) ];
	const sourceRoute = documentRequestUrl( sourceUrl );
	// Action URLs and declared runtime paths leave before the budget sees them, so they never
	// spend, and never appear as omitted, failed or missing routes.
	const excludedActions = new Map< string, { code: string; url: string; reason: string } >();
	const inventoryUrls = await normalizeDiscoveredRoutes( [
		sourceUrl,
		...contentEntries.map( entry => entry.permalink ),
		...( contentSource ? structuredTermArchiveUrls( contentEntries, contentSource ) : [] ),
		...( inventory.urls ?? [] )
			.map( ( entry ) => entry.url )
			.filter( ( url ) => {
				if ( ! routeInScope( url, routeScope ) ) {
					excludedActions.set( url, { code: 'route_outside_adapter_scope', url, reason: 'Route is outside the adapter-owned site route scope' } );
					return false;
				}
				if ( documentRequestUrl( url ) === sourceRoute ) return false;
				const action = platformRuntimeExclusion( url, sourceUrl, adapter.runtimePaths ) ?? actionUrlExclusion( url );
				if ( action ) excludedActions.set( action.url, action );
				return ! action;
			} ),
	].map( url => scopedRouteKey( url, routeScope ) ) );
	// Structured content already declares each entry's canonical permalink. Do
	// not fetch every entry merely to rediscover that identity before derivation.
	const feedPermalinks = new Set( contentEntries.map( entry => entry.permalink ) );
	const aliasProbe = await probeCanonicalRouteAliases( { sourceUrl, urls: inventoryUrls.filter( url => ! feedPermalinks.has( url ) ), routeScope } );
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
	const routeSelection = options.routeSelection ?? ( templateClusters || adapter.templateIdentity ? 'template-coverage' : undefined );
	const templateGrouping = routeSelection === 'template-coverage'
		? await groupInventoryTemplates( { contentEntries, sourceUrl, urls: prunedInventoryUrls, routeScope, styleNormalization: adapter.templateStyleNormalization, templateIdentity: adapter.templateIdentity, runtimeStateClasses: adapter.runtimeStateClasses, outputDir, timeBudgetMs, wholeInventory: options.routeLimit === 'all' || templateClusters, governors: sourceGovernors } )
		: undefined;
	const navigationTargets = new Set( extractNavigationLandmarkLinks( entryHtml, sourceUrl ).map( link => normalizedUrl( link.href ) ) );
	// Shape sub-clusters (#1805) seed their own representative and verifier.
	let clusterRankingGroups = templateGrouping?.report
		? ( await import( './template-groups.js' ) ).templateClusterRankingGroups( templateGrouping.report.groups, structuredMemberShape( contentSource, contentEntries ) )
		: [];
	// Explicit count budgets select before capture observes the entry DOM. Only
	// pay for an early render when server chrome cannot supply that priority.
	if ( routeLimit !== undefined && prunedInventoryUrls.length > routeLimit && navigationTargets.size === 0 && options.acquisition !== 'http' ) {
		const { renderedEntryNavigation } = await import( './entry-navigation.js' );
		for ( const href of await renderedEntryNavigation( sourceUrl, sourceGovernors, adapter.sourceTelemetry ) ) navigationTargets.add( normalizedUrl( href ) );
	}
	const entryNavigationRoutes = prunedInventoryUrls.filter( url => navigationTargets.has( normalizedUrl( url ) ) );
	// Navigation targets come first, then cluster seeds that unlock whole
	// collections. Without clusters, navigation then representatives and spread.
	const preferred = templateClusters
		? rankTemplateClusterRoutes( prunedInventoryUrls, sourceUrl, clusterRankingGroups, navigationTargets, contentSource?.termName.bind( contentSource ) )
		: [ ...entryNavigationRoutes, ...( templateGrouping?.representatives ?? [] ) ];
	const { selected: urls, omitted } = selectRouteBudget( prunedInventoryUrls, routeLimit, preferred, timeBudget?.projectAdmission && ! options.checkpoint );
	let templateGroups = templateGrouping?.report ? await recordTemplateSelection( outputDir, templateGrouping.report, urls, routeLimit ) : undefined;
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
	progress( { phase: 'capturing', current: 0, total: urls.length, urls: [ ...urls ] } );
	if ( options.acquisition === 'http' ) {
		const result = await ( await import( './capture-http.js' ) ).captureHttpWebsite( { options, sourceUrl, platform: adapter, detection, routeScope, urls, startedAt, progress, title: inventory.siteMeta?.title, discoveryDiagnostics, templateGroups, templateClustersDecision, canonicalAliases: aliasProbe.aliases, governors: sourceGovernors } );
		assertEntrypointHasContent( outputDir, options.url, sourceUrl );
		if ( options.strict && ! result.complete ) throw new IncompleteCaptureError( result );
		return result;
	}

	const { captureScreenshots } = await import( './screenshot/screenshotter.js' );
	const { createReferenceCollector } = await import( './fidelity/reference.js' );
	const telemetryRequest = adapter.liberation?.telemetryRequest?.bind( adapter.liberation );
	const initializePage = adapter.liberation?.loadDocument || adapter.liberation?.initScript ? async (page: import('playwright').Page): Promise<void> => {
		if (adapter.liberation?.loadDocument) {
			const { installSourceDocumentLoader } = await import('./source-navigation.js');
			installSourceDocumentLoader(page, async (url, timeout) => {
				const document = await adapter.liberation!.loadDocument!(page, url, timeout);
				return document && { url, status: 200, headers: document.headers, body: Buffer.from(document.html) };
			});
		}
		await adapter.liberation?.initScript?.(page);
	} : undefined;
	const reference = createReferenceCollector( outputDir, sourceUrl, urls, {
		defer: options.deferReference,
		adapterId: adapter.id,
		trustedOrigins: options.trustedOrigins,
		routeScope,
		publicUrlsOnly: true,
		cleanupPolicy: ( await import( './source-cleanup.js' ) ).cleanupPolicy( adapter.liberation?.cleanupRules ),
		telemetryRequest,
		removeSelectors: adapter.liberation?.removeSelectors,
		prepareCapture: adapter.liberation?.prepare,
		initializePage,
		clientErrorShellSelectors: adapter.liberation?.clientErrorShellSelectors,
		referenceSample,
	} );
	// Frontier grouping shares the bounded HTTP fingerprint implementation and
	// source governors with inventory grouping. Never use whole-inventory limits.
	const frontierGroupingLimits = templateClusters ? {
		...( await import( './template-groups.js' ) ).TEMPLATE_GROUPING_LIMITS,
		...await templateGroupingLimits( { timeBudgetMs, wholeInventory: false } ),
	} : undefined;
	const frontierOffered = new Set< string >();
	let frontierRounds = 0;
	let frontierRemaining = frontierGroupingLimits?.maxRoutes === 'all' ? 1000 : frontierGroupingLimits?.maxRoutes ?? 0;
	let frontierDeadline: number | undefined;
	const assetQueue = new AssetAcquisitionQueue( outputDir, timeBudget?.abandonAt, adapter.resolveImageOriginal?.bind( adapter ), undefined, timeBudget?.admitUntil );
	// Deferral and post-capture derivation derive members under one contract:
	// a member the deferral check accepts must derive after capture too.
	const derivationContract = {
		templateIdentity: adapter.templateIdentity,
		styleNormalization: adapter.templateStyleNormalization,
		rewriteDerivedMedia: adapter.liberation?.rewriteDerivedMedia?.bind( adapter.liberation ),
		runtimeWidgetSelectors: adapter.liberation?.runtimeWidgetSelectors,
		canonicalizeHtml: adapter.liberation?.canonicalizeHtml?.bind( adapter.liberation ),
		runtimeStateClasses: adapter.runtimeStateClasses,
	};
	// Verified clusters' members leave the browser pass for derivation (#784).
	const deferral = templateClusters && templateGrouping?.report
		? new ( await import( './template-cluster-deferral.js' ) ).TemplateClusterDeferral( {
				sourceUrl, outputDir, routeScope, governors: sourceGovernors,
				...derivationContract,
				// Light renders stop with the capture window, or the default one without a time budget.
				deadline: timeBudget?.abandonAt ?? startedAt + DEFAULT_CAPTURE_TIME_BUDGET_MS,
			}, () => clusterRankingGroups )
		: undefined;
	const aliasInventory = new Set( inventoryUrls );
	const aliasOffered = new Set< string >();
	const screenshotResult = await captureScreenshots( {
		governors: sourceGovernors,
		maxTotalBytes: options.maxTotalBytes,
		urls,
		routeScope,
		runtimePaths: adapter.runtimePaths,
		sourceTelemetry: adapter.sourceTelemetry,
		outputDir,
		linkedPages: options.linkedPages ?? {},
		probeLinkedRouteAliases: async ( candidates: string[] ) => {
			for ( const url of candidates ) aliasInventory.add( url );
			const candidateUrls = candidates.filter( url => ! aliasOffered.has( url ) && ! actionUrlExclusion( url ) && ! platformRuntimeExclusion( url, sourceUrl, adapter.runtimePaths ) );
			for ( const url of candidateUrls ) aliasOffered.add( url );
			const { aliases } = await probeCanonicalRouteAliases( {
				sourceUrl, urls: [ ...aliasInventory ], candidateUrls, routeScope,
			}, { fetch: ( url, opts ) => safeFetch( url, { ...opts, governors: sourceGovernors } ) } );
			aliasProbe.aliases.push( ...aliases );
			for ( const { url, canonicalUrl } of aliases ) discoveryDiagnostics.push( {
				code: ROUTE_ALIAS_CANONICAL, url: documentRequestUrl( url ),
				reason: `Route skipped before capture: its server-HTML rel=canonical resolves to ${ documentRequestUrl( canonicalUrl ) }, another inventory route`,
			} );
			return aliases;
		},
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
		initScript: initializePage,
		clientErrorShellSelectors: adapter.liberation?.clientErrorShellSelectors,
		probeExclusions: adapter.liberation?.probeExclusions,
		cleanupPolicy: (await import('./source-cleanup.js')).cleanupPolicy(adapter.liberation?.cleanupRules),
		prepareCapture: adapter.liberation?.prepare,
		telemetryRequest,
		resolveClientRedirect: adapter.liberation?.resolveClientRedirect,
		beforeFluid: adapter.liberation?.beforeFluid,
		beforeSerialize: adapter.liberation?.beforeSerialize,
		observeSource: async ( ...args ) => {
			const [ page, url ] = args;
			if ( normalizedUrl( url ) === normalizedUrl( sourceUrl ) ) {
				for ( const link of extractNavigationLandmarkLinks( await page.content(), url ) ) navigationTargets.add( normalizedUrl( link.href ) );
			}
			await reference.observe( ...args );
		},
		// Source evidence already renders the entrypoint. Promote its client-only
		// menu before subsequent admissions, without opening another browser page.
		...( templateClusters && templateGrouping?.report && frontierGroupingLimits ? {
			groupLinkedRoutes: async ( candidates: string[] ) => {
				const report = templateGrouping.report!;
				const grouped = new Set( report.groups.flatMap( group => group.members ) );
				const urls = candidates.filter( url => ! aliasProbe.aliases.some( alias => alias.url === url ) && ! grouped.has( url ) && ! frontierOffered.has( url ) && ! actionUrlExclusion( url ) && ! platformRuntimeExclusion( url, sourceUrl, adapter.runtimePaths ) ).slice( 0, frontierRemaining );
				frontierDeadline ??= Date.now() + frontierGroupingLimits.timeBudgetMs;
				if ( ! urls.length || frontierRounds >= 3 || Date.now() >= frontierDeadline ) return;
				frontierRounds++;
				frontierRemaining -= urls.length;
				for ( const url of urls ) frontierOffered.add( url );
				try {
					const { extendTemplateGroups, templateClusterRankingGroups } = await import( './template-groups.js' );
					await extendTemplateGroups( report, {
						sourceUrl, urls, routeScope, governors: sourceGovernors,
						styleNormalization: adapter.templateStyleNormalization, templateIdentity: adapter.templateIdentity, runtimeStateClasses: adapter.runtimeStateClasses,
						limits: { ...frontierGroupingLimits, maxRoutes: urls.length, maxTotalBytes: Math.floor( frontierGroupingLimits.maxTotalBytes / 3 ), timeBudgetMs: Math.max( 1, frontierDeadline - Date.now() ) },
					}, true );
					const aliases = report.frontier?.canonicalAliases ?? [];
					aliasProbe.aliases.push( ...aliases );
					for ( const { url, canonicalUrl } of aliases ) discoveryDiagnostics.push( {
						code: ROUTE_ALIAS_CANONICAL, url: documentRequestUrl( url ),
						reason: `Route skipped before capture: its server-HTML rel=canonical resolves to ${ documentRequestUrl( canonicalUrl ) }, another inventory route`,
					} );
					// Rank pending work against the groups this frontier pass admitted.
					clusterRankingGroups = templateClusterRankingGroups( report.groups, structuredMemberShape( contentSource, contentEntries ) );
					return aliases;
				} catch ( error ) {
					process.stderr.write( `[template-groups] frontier grouping unavailable: ${ error instanceof Error ? error.message : String( error ) }\n` );
				}
			},
		} : {} ),
		...( timeBudget?.projectAdmission || templateClusters ? {
			prioritizePendingRoutes: ( pending: string[] ) => {
				if ( templateClusters ) return rankTemplateClusterRoutes( pending, sourceUrl, clusterRankingGroups, navigationTargets, contentSource?.termName.bind( contentSource ) );
				const pendingRoutes = new Set( pending );
				const promoted = [ ...prunedInventoryUrls.filter( url => navigationTargets.has( normalizedUrl( url ) ) ), ...( templateGrouping?.representatives ?? [] ) ].filter( url => pendingRoutes.has( url ) );
				const promotedRoutes = new Set( promoted );
				return [ ...promotedRoutes, ...pending.filter( url => ! promotedRoutes.has( url ) ) ];
			},
		} : {} ),
		// Memory admission reserves for what a route opens: bounded samples
		// leave most routes without fresh reference pages.
		...( options.deferReference ? { referenceSampleUrls: [] } : reference.sampledSourceUrls ? { referenceSampleUrls: reference.sampledSourceUrls } : {} ),
		onRouteAlias: reference.alias,
		withdrawSourceProfile: reference.withdraw,
		...( adapter.liberation?.canonicalizeHtml
			? { canonicalizeHtml: adapter.liberation.canonicalizeHtml.bind( adapter.liberation ) }
			: {} ),
		...( adapter.liberation?.responsiveImages
			? { collectResponsiveImages: adapter.liberation.responsiveImages.bind( adapter.liberation ) }
			: {} ),
		publicUrlsOnly: true,
		...( timeBudget ? { timeBudget: { ...timeBudget, assetBacklog: () => assetQueue.backlog() } } : {} ),
		...( options.routeDeadlineMs !== undefined ? { routeDeadlineMs: options.routeDeadlineMs } : {} ),
		onProgress: ( current, total, url ) => progress( { phase: 'capturing', current, total, url } ),
		onRouteCaptured: ( url, documents, stored, interactions, profiles ) => {
			assetQueue.enqueueRoute( url, documents, stored );
			deferral?.routeCaptured( url, documents[ 0 ], interactions, profiles );
		},
		...( deferral ? {
			deferRoute: ( url: string ) => deferral.defers( url ),
			pendingRoute: ( url: string ) => deferral.pending( url ),
			waitForPendingRoute: () => deferral.waitForCheck(),
		} : {} ),
	} );
	await assetQueue.drain();
	process.stderr.write(
		`[timing] browser-capture ${ screenshotResult.durationMs }ms (${ screenshotResult.captured } captured, ${ screenshotResult.failed } failed)\n`
	);
	progress( { phase: 'media', current: screenshotResult.captured, total: screenshotResult.urls.length } );
	const mediaStartedAt = Date.now();
	const downloadedSectionMedia = sourceGovernors.forOrigin( sourceUrl ).blockedClient ? 0 : await downloadCaptureSectionMedia( outputDir, screenshotResult.urls, timeBudget?.abandonAt, adapter.resolveImageOriginal?.bind( adapter ), catalogImageSources( contentEntries.map( entry => entry.product ) ).sources );
	process.stderr.write(
		`[timing] section-media ${ Date.now() - mediaStartedAt }ms (${ downloadedSectionMedia } downloaded)\n`
	);

	// Phase 1 of #784: derive every ungated member of a verified multi-member
	// cluster from its representative's captured document. Enabled by
	// (`templateClusters`), bounded by TEMPLATE_CLUSTER_LIMITS, and recorded in
	// `template-clusters.json` next to `website/`. Derived entries become
	// ordinary manifest entries before export, so export needs no second input
	// kind. Any failure degrades to the pre-derivation state: the member keeps
	// its `route_omitted_by_budget` diagnostic.
	const budgetHttp = { acquired: [] as string[], diagnostics: [] as RouteDiagnostic[] };
	const acquireRemaining = async ( escalations: readonly import('./template-cluster-fallback.js').EscalatedMember[] ) => {
		const { ManifestQueue } = await import( './screenshot/manifest-queue.js' );
		const { acquireEscalatedMembers, runtimeRenderBudgetMs } = await import( './template-cluster-fallback.js' );
		const queue = new ManifestQueue( join( outputDir, 'screenshots', 'manifest.json' ) );
		await queue.init();
		const escalationIdentities = new Set( escalations.map( member => normalizedUrl( member.url ) ) );
		const omissions = timeBudget ? dedupeRouteInventory( [
			...( screenshotResult.routeDiagnostics ?? [] ),
			...( screenshotResult.linkedPageCoverage?.diagnostics ?? [] ),
		].filter( row => row.code === ROUTE_OMITTED_BY_BUDGET || row.code === 'linked_page_budget_exhausted' ).map( row => row.url ) )
			.filter( url => ! escalationIdentities.has( normalizedUrl( url ) ) && ! queue.getEntry( url )?.html ) : [];
		try {
			const fallback = await acquireEscalatedMembers( {
				outputDir, sourceUrl, routeScope, profile: adapter.acquisition!, governors: sourceGovernors, queue,
				members: [ ...escalations, ...omissions.map( url => ( { url, gate: ROUTE_OMITTED_BY_BUDGET, reason: 'browser admission closed' } ) ) ],
				navigationTargets,
				clusterMemberUrls: new Set( clusterRankingGroups.filter( group => group.size > 2 ).flatMap( group => group.members.map( normalizedUrl ) ) ),
				maxTotalBytes: options.maxTotalBytes,
				runtimeRenderBudgetMs: runtimeRenderBudgetMs( options.timeBudgetMs ),
			} );
			budgetHttp.acquired.push( ...fallback.acquired.filter( url => ! escalationIdentities.has( normalizedUrl( url ) ) ) );
			budgetHttp.diagnostics.push( ...budgetHttp.acquired.map( url => ( {
				code: ROUTE_TEMPLATE_ESCALATED, url, reason: `browser admission closed; captured through governed HTTP acquisition (${ adapter.acquisition!.id })`,
				unit: 'route' as const, severity: 'warning' as const,
			} ) ) );
			budgetHttp.diagnostics.push( ...fallback.diagnostics );
			// Cluster receipts count only escalations, not unrelated budget omissions.
			return { ...fallback, diagnostics: [], acquired: fallback.acquired.filter( url => escalationIdentities.has( normalizedUrl( url ) ) ) };
		} finally {
			await queue.flush();
		}
	};
	const derivedTemplateClusters = ! sourceGovernors.forOrigin( sourceUrl ).blockedClient && templateClusters && templateGrouping?.report
		? await deriveTemplateClusterMembers( {
				contentEntries,
				contentSource,
				sourceUrl,
				outputDir,
				report: templateGrouping.report,
				...derivationContract,
				routeScope,
				timeBudgetMs: options.timeBudgetMs,
				deadline: timeBudget?.abandonAt,
				frontierUrls: screenshotResult.linkedPageCoverage?.requiredUrls ?? [],
				aliasUrls: new Set( aliasProbe.aliases.map( alias => normalizedUrl( alias.url ) ) ),
				governors: sourceGovernors,
				maxTotalBytes: options.maxTotalBytes,
				resolveImageOriginal: adapter.resolveImageOriginal?.bind( adapter ),
				acquisition: adapter.acquisition,
				deferral,
				acquireRemaining,
			} )
		: undefined;
	await deferral?.close();
	if ( templateGrouping?.report?.frontier ) {
		templateGroups = await recordTemplateSelection( outputDir, templateGrouping.report, urls, routeLimit );
	}
	if ( derivedTemplateClusters ) {
		process.stderr.write(
			`[template-clusters] ${ derivedTemplateClusters.summary.derived } derived, ${ derivedTemplateClusters.summary.escalated } escalated (${ derivedTemplateClusters.summary.httpAcquired } HTTP-acquired), ${ derivedTemplateClusters.summary.unavailable } unavailable, ${ Date.now() - mediaStartedAt }ms\n`
		);
	}

	// Without template grouping there are still browser-budget omissions to acquire.
	if ( ! derivedTemplateClusters && timeBudget && adapter.acquisition && ! sourceGovernors.forOrigin( sourceUrl ).blockedClient ) {
		const fallback = await acquireRemaining( [] );
		budgetHttp.diagnostics.push( ...fallback.diagnostics );
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
	const derivedUrls = new Set( [ ...derivedTemplateClusters?.summary.derivedUrls ?? [], ...derivedTemplateClusters?.summary.httpAcquiredUrls ?? [], ...budgetHttp.acquired ] );
	const derivedIdentities = new Set( [ ...derivedUrls ].map( normalizedUrl ) );
	// A confirmed canonical alias is held by its canonical route, never omitted.
	const aliasIdentities = new Set( aliasProbe.aliases.map( alias => normalizedUrl( alias.url ) ) );
	const blockedClient = sourceGovernors.forOrigin( sourceUrl ).blockedClient;
	// Frontier timeouts and late-pass refusals are capture-budget omissions too.
	// Keep the first explanation per document, regardless of which stage found
	// it or which slash spelling it used; derived documents keep no omission.
	const budgetRows = new Set< string >();
	// A deferred route derivation did not produce stays a missing route.
	const underived = ( screenshotResult.deferredUrls ?? [] ).filter( url => ! derivedIdentities.has( normalizedUrl( url ) ) ).map( url => ( {
		code: ROUTE_OMITTED_BY_BUDGET, url: documentRequestUrl( url ),
		reason: 'deferred from browser capture to template-cluster derivation, which did not produce it (see template-clusters.json)',
	} ) );
	const captureDiagnostics = [
		...discoveryDiagnostics, ...( screenshotResult.routeDiagnostics ?? [] ), ...linkedDiagnostics,
		...( derivedTemplateClusters?.diagnostics ?? [] ), ...underived, ...budgetHttp.diagnostics,
	].map( row => row.code === 'linked_page_budget_exhausted' ? { ...row, code: ROUTE_OMITTED_BY_BUDGET } : row )
		.filter( row => {
			if ( row.code !== ROUTE_OMITTED_BY_BUDGET ) return true;
			const identity = normalizedUrl( row.url );
			if ( derivedIdentities.has( identity ) || aliasIdentities.has( identity ) || budgetRows.has( identity ) ) return false;
			budgetRows.add( identity );
			return true;
		} );
	const summary = {
		// Same route set `captured`, `skipped` and `failed` are counted over.
		routesDiscovered: screenshotResult.urls.length - ( screenshotResult.routeDiagnostics ?? [] ).filter( row => row.code === ROUTE_OMITTED_BY_BUDGET ).length,
		routesCaptured: screenshotResult.captured + ( derivedTemplateClusters?.summary.derived ?? 0 ) + ( derivedTemplateClusters?.summary.httpAcquired ?? 0 ) + budgetHttp.acquired.length,
		routesSkipped: screenshotResult.skipped,
		routesPending: captureDiagnostics.filter(row => row.code === 'route_capture_pending').length,
		sourceRequests: sourceGovernors.stats(),
		...(blockedClient ? { resumable: true, stopReason: blockedClient.code } : {}),
		routesFailed: screenshotResult.failed,
		routesOmitted: budgetOmittedRoutes( captureDiagnostics ).length,
		...( derivedTemplateClusters ? { routesDerived: derivedTemplateClusters.summary.derived } : {} ),
		durationMs: screenshotResult.durationMs,
		...( screenshotResult.deviceMode ? { deviceMode: screenshotResult.deviceMode.mode } : {} ),
		...( screenshotResult.deviceMode?.routes ? { dualRoutes: screenshotResult.deviceMode.routes.dual.length } : {} ),
	};
	// Export writes reused pages too. Decide only after capture so even the last
	// new route can progress without holding reserve for earlier runs' pages.
	let exportPending = false;
	if ( options.checkpoint && timeBudget && ( timeBudget.routeReserveMs ?? 0 ) > 0 ) {
		// Read the export's manifest, including retained entries from earlier runs.
		const manifest = JSON.parse( readFileSync( screenshotResult.manifestPath, 'utf8' ) ) as { entries: Record< string, ManifestEntry > };
		const exportRoutes = Object.entries( manifest.entries ).filter( ( [ url, entry ] ) => {
			if ( new URL( url ).origin !== new URL( sourceUrl ).origin || ! routeInScope( url, routeScope ) ||
				! entry.html || entry.redirectedTo || entry.externalRedirect || entry.sourceAbsentStatus ) return false;
			const htmlPath = resolve( outputDir, entry.html );
			return pathWithin( outputDir, htmlPath ) && existsSync( htmlPath );
		} ).length;
		exportPending = exportRoutes * timeBudget.routeReserveMs! > timeBudget.abandonAt - Date.now();
	}
	if ( options.checkpoint && ( exportPending || captureDiagnostics.some( row => row.code === 'route_capture_skipped_budget' ) ) ) {
		const entrypointCaptured = screenshotResult.captured + screenshotResult.skipped > 0 &&
			! missingRoutes( captureDiagnostics ).some( row => normalizedUrl( row.url ) === normalizedUrl( sourceUrl ) );
		const captureReceiptPath = join( outputDir, 'capture-checkpoint.json' );
		const result: CaptureResult = {
			captureReceiptPath, outputDir, checkpoint: true, resumable: true, exportPending,
			summary: { ...summary, complete: false, entrypointCaptured },
			complete: false, entrypointCaptured,
			missingRoutes: missingRoutes( captureDiagnostics ), failures,
			discoveryDiagnostics: captureDiagnostics, unresolvedAnchors: [],
			provenance: { provider: 'data-liberation/browser-capture', platform: detection.platform },
			...( screenshotResult.deviceMode ? { deviceMode: screenshotResult.deviceMode } : {} ),
			...( screenshotResult.sharedChrome ? { sharedChrome: screenshotResult.sharedChrome } : {} ),
		};
		writeFileSync( captureReceiptPath, `${ JSON.stringify( result, null, 2 ) }\n` );
		progress( { phase: 'complete', current: screenshotResult.captured + screenshotResult.skipped, total: screenshotResult.urls.length } );
		// A refusal after the entrypoint truncates the capture like a spent
		// budget: the receipt carries the evidence and the partial site ships.
		if ( blockedClient && ! entrypointCaptured ) throw blockedClient; // failure-class: operational
		return result;
	}
	const { exportWebsiteCapture } = await import( './capture-export.js' );
	const { precollectCapturedRoutes } = await import( './capture-export-parallel.js' );
	const exportOptions: import( './capture-export.js' ).ExportCaptureOptions = {
		...( contentSource && contentEntries.length ? { structuredContent: { source: contentSource, entries: contentEntries } } : {} ),
		outputDir,
		sourceUrl,
		platform: detection.platform,
		nonContentAttributes: adapter.nonContentAttributes,
		canonicalizeHtml: adapter.liberation?.canonicalizeHtml?.bind( adapter.liberation ),
		routeScope,
		resolveDocumentSelection: adapter.liberation?.documentSelection,
		...( screenshotResult.deviceMode ? { deviceMode: screenshotResult.deviceMode.mode } : {} ),
		title: inventory.siteMeta?.title,
		summary,
		canonicalAliases: aliasProbe.aliases,
		failures,
		discoveryDiagnostics: captureDiagnostics,
		limits: captureExportLimits( options ),
	};
	const precollected = await precollectCapturedRoutes( exportOptions );
	let captureReceiptPath: string;
	try {
		captureReceiptPath = exportWebsiteCapture( { ...exportOptions, ...( precollected ? { precollectedRoutes: precollected.routes } : {} ) } );
	} finally {
		precollected?.release();
	}
	process.stderr.write( `[timing] export ${ Date.now() - exportStartedAt }ms\n` );
	assertEntrypointHasContent( outputDir, options.url, sourceUrl );
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
	receipt.source.detection = detection;
	receipt.preview = preview;
	receipt.reference = { status: options.deferReference ? 'pending' : 'complete' };
	receipt.templateClustersDecision = templateClustersDecision;
	if ( templateGroups ) receipt.templateGroups = templateGroups;
	if ( derivedTemplateClusters ) {
		receipt.templateClusters = derivedTemplateClusters.receiptSummary;
		// Next to `website/`, like template-groups.json: evidence of what was
		// derived and on what cluster verdict, hashed into the fidelity reference.
		( await import( './template-clusters.js' ) ).writeTemplateClusters( outputDir, derivedTemplateClusters.receipt );
	}
	if ( screenshotResult.deviceMode ) receipt.deviceMode = screenshotResult.deviceMode;
	if ( screenshotResult.sharedChrome ) receipt.sharedChrome = screenshotResult.sharedChrome;
	if ( adapter.engagementStats && ! blockedClient ) {
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
		! blockedClient &&
		finalSummary.routesFailed === 0 &&
		! hasUncapturedProfiles( receipt.discoveryDiagnostics ) &&
		! ( receipt.sourceProfile?.documentSelection?.routes ?? [] ).some( ( route: { missing?: string[] } ) => ( route.missing?.length ?? 0 ) > 0 ) &&
		// Budget omission is the caller's scope choice, and neither an action URL
		// nor a non-document resource is a page (see `budgetOmittedRoutes`,
		// `actionUrlExclusion`, `NON_DOCUMENT_URL`); links to them carry their own reason.
		! linkedDiagnostics.some( row => row.code !== ROUTE_OMITTED_BY_BUDGET && row.code !== ROUTE_EXCLUDED_ACTION_URL && row.code !== NON_DOCUMENT_URL ) &&
		unresolvedAnchors.every( ( anchor ) => anchor.reason !== 'target route was not captured' );
	const result: CaptureResult = {
		captureReceiptPath,
		reference: { status: options.deferReference ? 'pending' : 'complete' },
		outputDir,
		...(blockedClient ? { resumable: true } : {}),
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
/** Feed posts sampled across the archive to choose the provisional post cohort (#1701). */
const FEED_COHORT_SAMPLES = 6;

/**
 * Fetch the entry document. With `session`, the entry URL's own session is
 * harvested first: a tokenized link may set it on a redirect that drops the
 * token, and every later step continues from the redirected URL.
 */
export async function fetchEntryDocument( url: string, governors: SourceRequestGovernors, options: { session: boolean } ): ReturnType< typeof safeFetch > {
	if ( options.session ) await establishSourceSession( url, { publicUrlsOnly: true, governors } );
	const entryFetchOptions = {
		timeoutMs: 10_000,
		governors,
		headersForOrigin: async ( origin: string ) => {
			const cookie = await sourceSessionCookieHeader( origin );
			return cookie ? { Cookie: cookie } : undefined;
		},
	};
	const fetchEntry = ( entryUrl: string ) => safeFetch( entryUrl, entryFetchOptions ).catch( async error => {
		if ( await completeSourceTlsChain( entryUrl, error ) ) return safeFetch( entryUrl, entryFetchOptions );
		throw error; // failure-class: operational
	} );
	return fetchEntry( url ).catch( async error => {
		const insecure = httpFallbackUrl( url, error );
		if ( ! insecure ) throw error; // failure-class: operational
		// Capture continues from the HTTP address, as if it had been entered.
		// HTTP that redirects back to the broken HTTPS reports the original failure.
		return fetchEntry( insecure ).catch( () => { throw error; } ); // failure-class: operational
	} );
}

/**
 * Node error codes for an HTTPS certificate that fails verification. A bare
 * domain is entered as HTTPS, and many shared hosts serve the host's own
 * certificate for a customer domain whose site works over HTTP.
 */
const CERTIFICATE_FAILURES = new Set( [
	'ERR_TLS_CERT_ALTNAME_INVALID',
	'CERT_HAS_EXPIRED',
	'CERT_NOT_YET_VALID',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
] );

/** The `http:` form of an HTTPS entry URL whose certificate failed verification. */
function httpFallbackUrl( url: string, failure: unknown ): string | undefined {
	const parsed = new URL( url );
	if ( parsed.protocol !== 'https:' ) return undefined;
	let cause = failure;
	for ( let i = 0; i < 5 && cause && typeof cause === 'object'; i++ ) {
		if ( CERTIFICATE_FAILURES.has( String( ( cause as NodeJS.ErrnoException ).code ) ) ) {
			parsed.protocol = 'http:';
			return parsed.href;
		}
		cause = ( cause as Error ).cause;
	}
	return undefined;
}

export async function groupInventoryTemplates( input: { contentEntries?: import('../platform/types.js').StructuredContentEntry[]; sourceUrl: string; urls: string[]; routeScope?: import('../platform/types.js').SiteRouteScope; styleNormalization?: import('./template-groups.js').TemplateStyleNormalization; templateIdentity?: import('./template-groups.js').TemplateIdentity; runtimeStateClasses?: readonly RegExp[]; outputDir: string; timeBudgetMs?: number; wholeInventory: boolean; governors: SourceRequestGovernors } ): Promise< {
	report?: import('./template-groups.js').TemplateGroupsReport;
	representatives?: string[];
	diagnostic?: { code: string; url: string; reason: string };
} > {
	const startedAt = Date.now();
	try {
		const { buildTemplateGroups, templateRepresentatives } = await import( './template-groups.js' );
		// Feed cohorts are provisional until the ordinary cluster verification
		// compares their transplanted documents with real browser captures.
		// Sample entries spread across the archive, so one recent variant cannot
		// decide the cohort; the cohort is the group holding most samples.
		const feedPosts = new Set( ( input.contentEntries ?? [] ).filter( entry => entry.kind === 'post' ).map( entry => entry.permalink ) );
		const feedUrls = input.urls.filter( url => feedPosts.has( url ) );
		const sampleCount = Math.min( FEED_COHORT_SAMPLES, feedUrls.length );
		const postSamples = [ ...new Set( Array.from( { length: sampleCount }, ( _, i ) => feedUrls[ Math.floor( i * ( feedUrls.length - 1 ) / Math.max( 1, sampleCount - 1 ) ) ]! ) ) ];
		const groupingUrls = input.urls.filter( url => ! feedPosts.has( url ) || postSamples.includes( url ) );
		let report = await buildTemplateGroups( { sourceUrl: input.sourceUrl, urls: groupingUrls, routeScope: input.routeScope, limits: await templateGroupingLimits( input ), governors: input.governors, templateIdentity: input.templateIdentity, runtimeStateClasses: input.runtimeStateClasses, ...( input.styleNormalization ? { styleNormalization: input.styleNormalization } : {} ) } );
		const sampled = ( group: { members: string[] } ) => postSamples.filter( url => group.members.includes( url ) ).length;
		const cohort = postSamples.length >= 2
			? report.groups.filter( group => sampled( group ) >= 2 ).sort( ( a, b ) => sampled( b ) - sampled( a ) )[ 0 ]
			: undefined;
		if ( feedPosts.size ) process.stderr.write( `[template-groups] structured content: ${ feedUrls.length } of ${ feedPosts.size } entries in inventory, ${ postSamples.length } samples, cohort ${ cohort ? `${ cohort.id } (${ sampled( cohort ) } samples)` : 'not found; grouping every route' }\n` );
		if ( ! cohort && groupingUrls.length !== input.urls.length ) {
			report = await buildTemplateGroups( { sourceUrl: input.sourceUrl, urls: input.urls, routeScope: input.routeScope, limits: await templateGroupingLimits( input ), governors: input.governors, templateIdentity: input.templateIdentity, runtimeStateClasses: input.runtimeStateClasses, styleNormalization: input.styleNormalization } );
		}
		if ( cohort ) {
			cohort.representative = postSamples.find( url => cohort.members.includes( url ) )!;
			for ( const url of input.urls ) {
				if ( feedPosts.has( url ) && ! cohort.members.includes( url ) ) {
					cohort.members.push( url );
					cohort.size++;
					report.coverage.routes++;
					report.coverage.fingerprinted++;
				}
			}
		}
		const { coverage } = report;
		process.stderr.write( `[template-groups] ${ coverage.routes } routes: ${ coverage.fingerprinted } fingerprinted into ${ coverage.groups } groups (${ coverage.singletons } singletons), ${ coverage.unfingerprinted } unfingerprinted, ${ report.throttle.events } throttle events, ${ Date.now() - startedAt }ms\n` );
		const source = input.governors.forOrigin( input.sourceUrl ).stats();
		process.stderr.write( `[timing] template-groups source ${ source.origin }: ${ source.requests } requests (${ JSON.stringify(source.requestCounts) }), ${ source.throttleEvents } throttled, sustained ${ source.sustainedRate.toFixed( 2 ) } req/s, ${ source.concurrency } in flight\n` );
		return { report, representatives: templateRepresentatives( report ) };
	} catch ( error ) {
		const reason = `Template grouping unavailable; routes were selected in discovery order: ${ error instanceof Error ? error.message : String( error ) }`;
		process.stderr.write( `[template-groups] ${ reason }\n` );
		return { diagnostic: { code: 'template_grouping_unavailable', url: documentRequestUrl( input.sourceUrl ), reason } };
	}
}

/** An adapter's member shape keyed by route, when it declares one (#1805). */
function structuredMemberShape( contentSource: import('../platform/types.js').StructuredContentSource | undefined, entries: readonly import('../platform/types.js').StructuredContentEntry[] | undefined ): ( ( url: string ) => string | undefined ) | undefined {
	if ( ! contentSource?.memberShape || ! entries?.length ) return undefined;
	const byUrl = new Map( entries.map( entry => [ normalizedUrl( entry.permalink ), entry ] ) );
	return url => {
		const entry = byUrl.get( normalizedUrl( url ) );
		return entry ? contentSource.memberShape!( entry ) : undefined;
	};
}

/**
 * Grouping bounds for a capture. Whole-inventory capture (`routeLimit: 'all'`,
 * or `templateClusters`, which can derive only fingerprinted members) makes
 * every inventory route a candidate and, with a capture time budget,
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
	summary: { derived: number; derivedUrls: string[]; escalated: number; unavailable: number; httpAcquired: number; httpAcquiredUrls: string[] };
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
 * A member derives every document the representative ships: desktop, phone
 * and any middle width range, each from its representative counterpart, so
 * export assembles members exactly as it assembles the representative. A
 * failed derivation of any of them escalates the member. Where the source
 * serves a profile's identity (phone, tablet) a different server document, that
 * profile's document derives from its own server pair, with runtime media from
 * a light render as that profile; the desktop pair decides cluster identity.
 */
export async function deriveTemplateClusterMembers( input: {
	contentEntries?: import('../platform/types.js').StructuredContentEntry[];
	contentSource?: import('../platform/types.js').StructuredContentSource;
	sourceUrl: string;
	outputDir: string;
	report: import('./template-groups.js').TemplateGroupsReport;
	routeScope?: import('../platform/types.js').SiteRouteScope;
	timeBudgetMs?: number;
	runtimeWidgetSelectors?: readonly string[];
	canonicalizeHtml?: ( html: string ) => string;
	/** Absolute capture deadline, including source throttle waits. */
	deadline?: number;
	/** Runtime-render stage budget; defaults to `runtimeRenderBudgetMs( timeBudgetMs )`. */
	runtimeRenderBudgetMs?: number;
	frontierUrls: string[];
	/** Normalized identities of confirmed canonical aliases; their canonical route holds the document. */
	aliasUrls?: ReadonlySet< string >;
	governors: SourceRequestGovernors;
	styleNormalization?: import('./template-groups.js').TemplateStyleNormalization;
	templateIdentity?: import('./template-groups.js').TemplateIdentity;
	runtimeStateClasses?: readonly RegExp[];
	/** The run byte budget (`--max-total-bytes`); each cluster's resource store spends it like the capture's. */
	maxTotalBytes?: number;
	/** Platform original-rendition resolver for queued member media (#1701). */
	resolveImageOriginal?: import('../platform/types.js').Platform['resolveImageOriginal'];
	/** Capture supplies one shared pass for escalations and browser-budget omissions. */
	acquireRemaining?: ( members: readonly import('./template-cluster-fallback.js').EscalatedMember[] ) => Promise< import('./template-cluster-fallback.js').EscalationFallback >;
	/** The adapter's HTTP acquisition profile: escalated members fall back to it instead of being omitted. */
	acquisition?: import('../platform/acquisition.js').HttpAcquisitionProfile;
	rewriteDerivedMedia?: import('../adapters/page-actions.js').LiberationHooks['rewriteDerivedMedia'];
	/** The browser pass's deferral: its light renders verify and supply clusters whose runtime rewrites server content. */
	deferral?: import('./template-cluster-deferral.js').TemplateClusterDeferral;
} ): Promise< TemplateClusterDerivation > {
	const { deriveMemberDocument: derive, compareDerivedWithCapture, TEMPLATE_CLUSTER_LIMITS, writeTemplateClusters, TEMPLATE_CLUSTERS_FILE } =
		await import( './template-clusters.js' );
	const deriveMemberDocument: typeof derive = options => derive( { ...options, runtimeWidgetSelectors: input.runtimeWidgetSelectors, canonicalizeHtml: input.canonicalizeHtml } );
	const { templateClusterUnits } = await import( './template-groups.js' );
	const { chromeInteractionStates } = await import( './static-dialogs.js' );
	const { interactionReportMismatch, projectInteractionReport } = await import( './interaction-projection.js' );
	const { compareServerHtml } = await import( './screenshot/device-mode.js' );
	const { TEMPLATE_DEFERRAL_LIMITS } = await import( './template-cluster-deferral.js' );
	const memberShape = structuredMemberShape( input.contentSource, input.contentEntries );
	// Derivation documents go through the run's source governors, as grouping
	// does: throttles wait out Retry-After and retry (#1685). A failed or non-2xx
	// answer is the source's unavailability, never template evidence.
	const sourceDocument = async ( url: string, userAgent?: string ): Promise< { html: string } | { unavailable: string } > => {
		try {
			const response = await fetchTemplateDocument( url, { governors: input.governors, deadline: input.deadline, timeoutMs: TEMPLATE_CLUSTER_LIMITS.requestTimeoutMs, userAgent } );
			if ( response.status < 200 || response.status >= 300 ) return { unavailable: `HTTP ${ response.status }` };
			return { html: response.body.toString( 'utf8' ) };
		} catch ( error ) {
			return { unavailable: error instanceof Error ? error.message : String( error ) };
		}
	};
	const { CapturedResourceStore } = await import( './screenshot/resource-capture.js' );
	const { ManifestQueue } = await import( './screenshot/manifest-queue.js' );
	const { slugify } = await import( './url/index.js' );

	const contentSource = input.contentSource;
	const feedEntries = new Map( ( contentSource ? input.contentEntries ?? [] : [] ).map( entry => [ normalizedUrl( entry.permalink ), entry ] ) );
	const feedBodyEquivalent = ( html: string, entry: import('../platform/types.js').StructuredContentEntry ) => contentSource!.bodyEquivalent( html, entry );
	const contentSlotSelector = contentSource?.contentSlotSelector;
	const feedMemberDocument = ( html: string, representative: import('../platform/types.js').StructuredContentEntry, member: import('../platform/types.js').StructuredContentEntry ) => contentSource!.memberDocument( html, representative, member, { governors: input.governors } );
	const { enqueueMedia } = await import( './media-queue.js' );
	const deferredMedia = new Set< string >();
	const deferMedia = ( url: string ) => { deferredMedia.add( url ); };
	const diagnostics: RouteDiagnostic[] = [];
	const clusters: import('./template-clusters.js').TemplateClusterRecord[] = [];
	const derivedUrls: string[] = [];
	let escalated = 0;
	let unavailableCount = 0;
	const escalations: Array< { url: string; gate: string; reason: string; runtimeAnchor?: import('./template-clusters.js').SlotAnchor; slug?: string; clusterSize: number; record: import('./template-clusters.js').TemplateClusterRecord } > = [];

	// The capture released the manifest queue, so this stage is its single
	// writer; a fresh queue loads the flushed file.
	const manifestPath = join( input.outputDir, 'screenshots', 'manifest.json' );
	const queue = new ManifestQueue( manifestPath );
	await queue.init();
	// The admitted URL inventory includes budget omissions; only a manifest
	// entry with HTML proves that capture produced a document.
	const documentUrls = new Set< string >( queue.urls() );
	const documentIdentities = new Map( [ ...documentUrls ].map( url => [ normalizedUrl( url ), url ] ) );
	const capturedEntry = ( url: string ) => queue.getEntry( documentIdentities.get( normalizedUrl( url ) ) ?? documentRequestUrl( url ) );
	const isCaptured = ( url: string ) => Boolean( capturedEntry( url )?.html );
	const { sameOriginPageAnchors } = await import( './screenshot/unscheduled-anchors.js' );
	const { stateChangingAction } = await import( './url/action-url.js' );
	const { isNonDocumentUrl } = await import( './extraction/sitemap.js' );
	const { resolveDocumentReferences, authoredBaseUrl } = await import( './document-resource-base.js' );
	const offered = new Set< string >();
	const diagnosed = new Set< string >();
	const { TEMPLATE_GROUPING_LIMITS } = await import( './template-groups.js' );
	const lateLimits = { ...TEMPLATE_GROUPING_LIMITS, ...await templateGroupingLimits( { timeBudgetMs: input.timeBudgetMs, wholeInventory: false } ) };
	const lateDeadline = Date.now() + lateLimits.timeBudgetMs;
	const maxRounds = 3;
	let remainingRoutes = lateLimits.maxRoutes === 'all' ? 1000 : lateLimits.maxRoutes;
	const perRoundBytes = Math.floor( lateLimits.maxTotalBytes / maxRounds );
	// The final scan only explains links from the last derived wave; it
	// cannot start another grouping or derivation round.
	for ( let round = 0; round <= maxRounds; round++ ) {
	const derivedBefore = derivedUrls.length;
	// The crawl can discover routes absent from initial grouping. Fingerprint
	// only uncaptured, ungrouped routes, using the same bounded HTTP pass and
	// governors. A failed advisory pass must not prevent ordinary derivation.
	try {
		const { extendTemplateGroups } = await import( './template-groups.js' );
		const grouped = new Set( input.report.groups.flatMap( group => group.members ) );
		const targets = new Set( input.frontierUrls );
		for ( const url of documentUrls ) {
			const entry = capturedEntry( url );
			if ( ! entry?.html ) continue;
			for ( const path of [ entry.html, entry.mobileHtml ].filter( ( path ): path is string => Boolean( path ) ) ) {
				const file = resolve( input.outputDir, path );
				if ( ! pathWithin( input.outputDir, file ) || ! existsSync( file ) ) continue;
				const document = path === entry.html ? entry.documents?.desktop : entry.documents?.mobile;
				const html = resolveDocumentReferences( readFileSync( file, 'utf8' ), document?.url ?? url, document?.baseUrl );
				for ( const anchor of sameOriginPageAnchors( html, url ) ) {
					if ( routeInScope( anchor, input.routeScope ) && ! stateChangingAction( anchor ) && ! isNonDocumentUrl( anchor ) ) targets.add( scopedRouteKey( anchor, input.routeScope ) );
				}
			}
		}
		const candidates = [ ...targets ].filter( url => ! isCaptured( url ) && ! input.aliasUrls?.has( normalizedUrl( url ) ) && ! grouped.has( url ) && ! offered.has( url ) ).slice( 0, remainingRoutes );
		for ( const url of targets ) {
			const identity = normalizedUrl( url );
			if ( ! isCaptured( url ) && ! input.aliasUrls?.has( identity ) && ! diagnosed.has( identity ) ) {
				diagnostics.push( { code: ROUTE_OMITTED_BY_BUDGET, url: documentRequestUrl( url ), reason: 'post-capture linked route exceeds the browser capture budget' } );
				diagnosed.add( identity );
			}
		}
		for ( const url of candidates ) offered.add( url );
		remainingRoutes -= candidates.length;
		if ( round < maxRounds && candidates.length && Date.now() < lateDeadline && input.report.groups.some( group => group.size >= 2 ) ) {
			await extendTemplateGroups( input.report, {
				sourceUrl: input.sourceUrl, urls: candidates, routeScope: input.routeScope,
				templateIdentity: input.templateIdentity, runtimeStateClasses: input.runtimeStateClasses, styleNormalization: input.styleNormalization, governors: input.governors,
				// Never use the whole-inventory override for extra frontier work:
				// retain the default route/byte caps and the capture-budget fraction.
				limits: { ...lateLimits, maxRoutes: candidates.length, maxTotalBytes: perRoundBytes, timeBudgetMs: Math.max( 1, lateDeadline - Date.now() ) },
			} );
		}
	} catch ( error ) {
		process.stderr.write( `[template-groups] frontier grouping unavailable: ${ error instanceof Error ? error.message : String( error ) }\n` );
	}
	if ( round === maxRounds ) break;
	try {
		// A group whose members span several adapter-declared shapes derives
		// one sub-cluster per shape (#1805): an outlier representative must not
		// fail members its synthesized documents can never match.
		const units = input.report.groups.flatMap( group => {
			if ( group.size < 2 ) return [];
			const { units, unclustered } = templateClusterUnits( group, memberShape );
			if ( units.length === 1 && units[ 0 ]!.id === group.id ) return units;
			let record = clusters.find( cluster => cluster.id === group.id );
			if ( ! record ) {
				record = { id: group.id, key: group.key, representative: group.representative, subClusters: units.map( unit => ( { id: unit.id, shape: unit.shape!, representative: unit.representative, size: unit.size } ) ), derived: [], escalated: [], unavailable: [] };
				clusters.push( record );
			}
			// No sub-cluster can derive a singleton-shape or unshaped member: it
			// takes ordinary acquisition (browser capture, else the HTTP fallback).
			const attempted = new Set( record.escalated.map( member => member.url ) );
			for ( const url of unclustered ) {
				if ( isCaptured( url ) || attempted.has( url ) ) continue;
				const gate = 'member_shape_unclustered';
				const reason = 'member shape has no other member to derive it from';
				record.escalated.push( { url, gate, reason } );
				escalations.push( { url, gate, reason, slug: feedEntries.get( normalizedUrl( url ) )?.slug, clusterSize: group.size, record } );
				escalated++;
			}
			return units;
		} );
		for ( const unit of units ) {
			// A representative that failed capture (a timeout under throttling, a
			// redirect) must not drop its cluster: a captured member stands in.
			const usable = ( url: string ) => { const entry = capturedEntry( url ); return Boolean( entry?.html && ! entry.redirectedTo ) && ! derivedUrls.includes( url ); };
			const representative = usable( unit.representative ) ? unit.representative
				: unit.members.filter( url => url !== unit.representative && usable( url ) ).sort( ( a, b ) => a.localeCompare( b ) )[ 0 ];
			if ( ! representative ) continue;
			const group = { ...unit, representative };
			const repEntry = capturedEntry( representative )!;
			const repHtmlPath = resolve( input.outputDir, repEntry.html! );
			if ( ! pathWithin( input.outputDir, repHtmlPath ) || ! existsSync( repHtmlPath ) ) continue;
			let record = clusters.find( cluster => cluster.id === group.id );
			if ( record?.verification && ! record.verification.equal ) continue;
			if ( ! record ) {
				record = { id: group.id, key: group.key, representative: group.representative, ...( group.parent ? { parent: group.parent, shape: group.shape } : {} ), derived: [], escalated: [], unavailable: [] };
				clusters.push( record );
			}
			const startedAt = Date.now();
			try {
				const attempted = new Set( [ ...record.escalated, ...record.unavailable ].map( member => member.url ) );
				const members = group.members
					.filter( url => ! isCaptured( url ) && ! attempted.has( url ) )
					.sort( ( a, b ) => a.localeCompare( b ) );
				const sourceUnavailable = ( url: string, reason: string ) => {
					const why = `source unavailable: ${ reason }`;
					for ( const member of members ) record.unavailable.push( { url: member, reason: why } );
					unavailableCount += members.length;
					diagnostics.push( { code: ROUTE_TEMPLATE_ESCALATED, url, reason: `cluster ${ group.id } derivation ${ why }`, metrics: { clusterSize: group.size } } );
				};
				const repFetch = await sourceDocument( group.representative );
				if ( 'unavailable' in repFetch ) {
					sourceUnavailable( group.representative, `representative ${ repFetch.unavailable }` );
					continue;
				}
				let repServerHtml = repFetch.html;
				// Where members' documents come from: server HTML, or light renders
				// once the cluster verified only from rendered documents.
				let rendered = false;
				const repProcessedHtml = readFileSync( repHtmlPath, 'utf8' );
				const repFeed = feedEntries.get( normalizedUrl( group.representative ) );
				let feedVerified = Boolean( repFeed && feedBodyEquivalent( repProcessedHtml, repFeed ) );
				// A dual-device representative has a phone document too; export merges
				// the two, so each member is derived from both.
				const repMobilePath = repEntry.mobileHtml ? resolve( input.outputDir, repEntry.mobileHtml ) : undefined;
				const repProcessedMobileHtml = repMobilePath && pathWithin( input.outputDir, repMobilePath ) && existsSync( repMobilePath ) ? readFileSync( repMobilePath, 'utf8' ) : undefined;
				// Further width-range documents (a middle layout, #1379) assemble
				// with the other two at export; members derive them the same way, or
				// the member's chrome assembles differently from the representative's.
				const repWidthDocuments = repProcessedMobileHtml === undefined ? [] : Object.entries( repEntry.profiles ?? {} ).flatMap( ( [ key, profile ] ) => {
					if ( key === 'desktop' || key === 'mobile' || ! profile.html ) return [];
					const path = resolve( input.outputDir, profile.html );
					return pathWithin( input.outputDir, path ) && existsSync( path ) ? [ { key, profile, html: readFileSync( path, 'utf8' ) } ] : [];
				} );
				// A source that serves a profile's identity its own server document
				// (Wix's mobile and tablet sites) builds that capture from it, so
				// anchors of the desktop pair do not exist there. Such a profile
				// derives from its own server pair, fetched with the capture's user
				// agent; the desktop pair still decides cluster identity.
				const profileServers = new Map< string, { userAgent: string; html: string; render: import('./template-cluster-deferral.js').RenderProfile } >();
				const byUserAgent = new Map< string, string | undefined >();
				for ( const key of repProcessedMobileHtml === undefined ? [] : [ 'mobile', ...repWidthDocuments.map( document => document.key ) ] ) {
					const userAgent = repEntry.profiles?.[ key ]?.userAgent;
					if ( ! userAgent ) continue;
					if ( ! byUserAgent.has( userAgent ) ) {
						const fetched = await sourceDocument( group.representative, userAgent );
						byUserAgent.set( userAgent, 'html' in fetched && compareServerHtml( repServerHtml, fetched.html ) === 'different' ? fetched.html : undefined );
					}
					const html = byUserAgent.get( userAgent );
					const profile = repEntry.profiles![ key ]!;
					// Runtime media of such a document come from a light render as that profile.
					if ( html !== undefined ) profileServers.set( key, { userAgent, html, render: { id: key, identity: profile.identity, viewport: profile.viewport } } );
				}
				const profileRenders = ( url: string ) => input.rewriteDerivedMedia && ! rendered ? [ ...profileServers.values() ].map( server => server.render ) : [];
				const store = new CapturedResourceStore( input.outputDir, input.sourceUrl, undefined, input.maxTotalBytes );
				let derivedInCluster = record.derived.length;
				let clusterFailure = { code: 'cluster_verification_missing', reason: 'cluster has no captured verification member' };

				// Verification first (#784 §4.2): one member derived, then compared
				// with its real capture, offline, on the six acceptance checks. A
				// mismatch (or a missing verification capture) fails the cluster: no
				// member of it is ever derived (§3.5).
				// A captured member is the stronger verification: its real capture
				// exists on disk, so the derived-vs-real comparison is actually
				// scored. Preferred verification members are already in the budget.
				const verificationUrl = templateVerificationMember( group.members, group.representative, url => isCaptured( url ) && ! derivedUrls.includes( url ) );
				const verificationCaptured = verificationUrl !== undefined &&
					isCaptured( verificationUrl );
				let verified = false;
				// Whether the representative's interaction report, projected onto the
				// verification member's derived document, reproduces its capture.
				let interactionsVerified = false;
				let failureReason: string | undefined;
				let verificationRecord: import('./template-clusters.js').TemplateClusterRecord['verification'] =
					{ url: verificationUrl ?? group.representative, captured: verificationCaptured };

				if ( verificationCaptured ) {
					const realEntry = capturedEntry( verificationUrl )!;
					let verifiedHtml = '';
					const realHtml = readFileSync( resolve( input.outputDir, realEntry.html! ), 'utf8' );
					const verificationFeed = feedEntries.get( normalizedUrl( verificationUrl ) );
					feedVerified = feedVerified && Boolean( verificationFeed && feedBodyEquivalent( realHtml, verificationFeed ) );
					const feedHtml = feedVerified && repFeed && verificationFeed ? await feedMemberDocument( repServerHtml, repFeed, verificationFeed ) : undefined;
					const verificationFetch = feedHtml === undefined ? await sourceDocument( verificationUrl ) : { html: feedHtml };
					if ( 'unavailable' in verificationFetch ) {
						sourceUnavailable( verificationUrl, `verification member ${ verificationFetch.unavailable }` );
						continue;
					}
					const media = input.rewriteDerivedMedia ? await input.deferral?.document( verificationUrl, 'rendered' ) : undefined;
					const mediaContext = { rewriteDerivedMedia: input.rewriteDerivedMedia, memberRenderedHtml: media && 'html' in media ? media.html : undefined };
					let memberHtml = verificationFetch.html;
					let derivation = deriveMemberDocument( { ...mediaContext, repServerHtml, repProcessedHtml, memberServerHtml: memberHtml, baseUrl: group.representative, templateIdentity: input.templateIdentity, styleNormalization: input.styleNormalization, featuredImages: { representative: repFeed?.image, member: verificationFeed?.image }, ...( feedHtml ? { contentSlotSelector, memberHeadSlotSelector: contentSource?.memberHeadSlotSelector } : {} ) } );
					if ( feedHtml && ( ! derivation.ok || ! compareDerivedWithCapture( { derivedHtml: derivation.html, realHtml, repServerHtml, memberServerHtml: memberHtml, styleNormalization: input.styleNormalization, runtimeStateClasses: input.runtimeStateClasses, baseUrl: group.representative } ).equal ) ) {
						feedVerified = false;
						diagnostics.push( { code: ROUTE_TEMPLATE_ESCALATED, url: verificationUrl, reason: 'feed template verification mismatch; using governed page acquisition for this cluster' } );
						const fallback = await sourceDocument( verificationUrl );
						if ( 'unavailable' in fallback ) {
							sourceUnavailable( verificationUrl, `verification member ${ fallback.unavailable }` );
							continue;
						}
						memberHtml = fallback.html;
						derivation = deriveMemberDocument( { ...mediaContext, repServerHtml, repProcessedHtml, memberServerHtml: memberHtml, baseUrl: group.representative, templateIdentity: input.templateIdentity, styleNormalization: input.styleNormalization, featuredImages: { representative: repFeed?.image, member: verificationFeed?.image } } );
					}
					if ( derivation.ok ) {
						const comparison = compareDerivedWithCapture( { derivedHtml: derivation.html, realHtml, repServerHtml, memberServerHtml: memberHtml, styleNormalization: input.styleNormalization, runtimeStateClasses: input.runtimeStateClasses, baseUrl: group.representative } );
						verificationRecord = { url: verificationUrl, captured: true, checks: { ...comparison.checks, ...( repFeed ? { feedBody: feedVerified } : {} ) }, equal: comparison.equal };
						verified = comparison.equal;
						verifiedHtml = derivation.html;
						if ( ! comparison.equal ) {
							const failing = Object.entries( comparison.checks ).filter( ( [ , ok ] ) => ! ok ).map( ( [ name ] ) => name ).join( ', ' );
							clusterFailure = { code: 'cluster_verification_mismatch', reason: `derived-vs-real comparison failed (${ failing })` };
							failureReason = `cluster verification failed its derived-vs-real comparison (${ failing })`;
						}
					} else {
						verificationRecord = { url: verificationUrl, captured: true };
						clusterFailure = derivation.gate;
						failureReason = `cluster verification member failed the ${ derivation.gate.code } gate`;
					}
					// A runtime that rewrites server content per member fails the
					// server-document check. Light renders of the representative and
					// the verification member are then the slot pair: when the member
					// derived from them equals its real capture, every member derives
					// from its own light render.
					if ( ! verified ) {
						const [ repRender, memberRender ] = input.deferral ? await Promise.all( [ input.deferral.document( group.representative, 'rendered' ), input.deferral.document( verificationUrl, 'rendered' ) ] ) : [];
						if ( repRender && memberRender && 'html' in repRender && 'html' in memberRender ) {
							const renderedDerivation = deriveMemberDocument( { ...mediaContext, repServerHtml: repRender.html, repProcessedHtml, memberServerHtml: memberRender.html, baseUrl: group.representative, templateIdentity: input.templateIdentity, styleNormalization: input.styleNormalization } );
							const comparison = renderedDerivation.ok ? compareDerivedWithCapture( { derivedHtml: renderedDerivation.html, realHtml, repServerHtml: repRender.html, memberServerHtml: memberRender.html, styleNormalization: input.styleNormalization, baseUrl: group.representative } ) : undefined;
							if ( comparison?.equal && renderedDerivation.ok ) {
								verified = rendered = true;
								verifiedHtml = renderedDerivation.html;
								repServerHtml = repRender.html;
								verificationRecord = { url: verificationUrl, captured: true, documents: 'rendered', checks: comparison.checks, equal: true };
							}
						}
					}
					if ( ! verified && failureReason ) diagnostics.push( { code: ROUTE_TEMPLATE_ESCALATED, url: verificationUrl, reason: failureReason, metrics: { clusterSize: group.size } } );
					if ( verified ) {
						const mismatch = interactionReportMismatch( projectInteractionReport( repProcessedHtml, verifiedHtml, repEntry.interactions ), realEntry.interactions );
						interactionsVerified = mismatch === undefined;
						if ( mismatch ) process.stderr.write( `[template-clusters] ${ group.representative } interaction states did not verify (${ mismatch }); derived members keep site-chrome states only\n` );
					}
				}
				// The verdict is final here: record it so a failed cluster is visible
				// in the receipt, not only in the diagnostics.
				record.verification = verificationRecord;
				if ( ! verified ) {
					for ( const url of members ) {
						const { code: gate, reason } = clusterFailure;
						record.escalated.push( { url, gate, reason } );
						escalations.push( { url, gate, reason, runtimeAnchor: 'runtimeAnchor' in clusterFailure ? clusterFailure.runtimeAnchor as import('./template-clusters.js').SlotAnchor : undefined, slug: feedEntries.get( normalizedUrl( url ) )?.slug, clusterSize: group.size, record } );
						escalated++;
					}
					continue;
				}

				// Member documents are governed HTTP work; keep the governor's
				// concurrency busy ahead of the CPU-bound derivation.
				const phases: Record< string, number > = {};
				let phaseStart = 0;
				const lap = ( name: string ) => { phases[ name ] = ( phases[ name ] ?? 0 ) + Date.now() - phaseStart; phaseStart = Date.now(); };
				const memberDocuments = new Map< string, Promise< string | undefined > >();
				const memberDocument = ( index: number ): Promise< string | undefined > | undefined => {
					for ( let ahead = index; ahead < Math.min( members.length, index + input.governors.forOrigin( input.sourceUrl ).concurrency ); ahead++ ) {
						const next = members[ ahead ]!;
						const nextFeed = feedEntries.get( normalizedUrl( next ) );
						const synthesized = feedVerified && repFeed && nextFeed;
						if ( rendered ) void input.deferral!.document( next, 'rendered' );
						else if ( ! memberDocuments.has( next ) ) memberDocuments.set( next, synthesized ? Promise.resolve( feedMemberDocument( repServerHtml, repFeed, nextFeed ) ).catch( () => undefined ) : Promise.resolve( undefined ) );
						// Profile light renders are browser work: a narrower, memoized window.
						if ( ! synthesized && ahead < index + TEMPLATE_DEFERRAL_LIMITS.renderConcurrency ) for ( const render of profileRenders( next ) ) void input.deferral?.document( next, 'rendered', render );
					}
					return memberDocuments.get( members[ index ]! );
				};
				for ( const [ index, url ] of members.entries() ) {
					if ( derivedInCluster >= Math.max( TEMPLATE_CLUSTER_LIMITS.maxDerivedRoutes, feedEntries.size ) ) break;
					const memberFeed = feedEntries.get( normalizedUrl( url ) );
					phaseStart = Date.now();
					// A prefetched governed request can time out while derivation holds
					// the event loop; retry it once inline before the raw-page fallback.
					const feedHtml = await memberDocument( index ) ?? ( feedVerified && repFeed && memberFeed ? await Promise.resolve( feedMemberDocument( repServerHtml, repFeed, memberFeed ) ).catch( () => undefined ) : undefined );
					memberDocuments.delete( url );
					lap( 'memberDocument' );
					// The browser pass's deferral check already holds most member documents.
					const memberSource = rendered ? 'rendered' : 'server';
					const response = feedHtml ? { html: feedHtml } : input.deferral ? await input.deferral.document( url, memberSource ) : await sourceDocument( url );
					const media = input.rewriteDerivedMedia ? await input.deferral?.document( url, 'rendered' ) : undefined;
					const mediaContext = { rewriteDerivedMedia: input.rewriteDerivedMedia, memberRenderedHtml: media && 'html' in media ? media.html : undefined };
					input.deferral?.release( url, memberSource );
					input.deferral?.release( url, 'rendered' );
					if ( 'unavailable' in response ) {
						record.unavailable.push( { url, reason: response.unavailable } );
						unavailableCount++;
						continue;
					}
					const memberServerHtml = response.html;
					// A synthesized member is the representative's template by
					// construction: its key is compared outside the content slot.
					const slotSelector = feedHtml ? { contentSlotSelector, memberHeadSlotSelector: contentSource?.memberHeadSlotSelector } : {};
					const desktopDerivation = deriveMemberDocument( { ...mediaContext, repServerHtml, repProcessedHtml, memberServerHtml, baseUrl: group.representative, templateIdentity: input.templateIdentity, styleNormalization: input.styleNormalization, featuredImages: { representative: repFeed?.image, member: memberFeed?.image }, ...slotSelector } );
					// Profile server pairs apply to server-sourced members only:
					// synthesized and light-rendered documents are desktop documents.
					const memberProfileServers = new Map< string, { repServerHtml: string; memberServerHtml: string; clusterKeyDocuments: { repServerHtml: string; memberServerHtml: string } } >();
					let profileUnavailable: string | undefined;
					const profileMedia = new Map< string, string | undefined >();
					if ( desktopDerivation.ok && ! feedHtml && ! rendered ) {
						const fetched = new Map< string, Promise< { html: string } | { unavailable: string } > >();
						for ( const [ key, server ] of profileServers ) {
							if ( ! fetched.has( server.userAgent ) ) fetched.set( server.userAgent, sourceDocument( url, server.userAgent ) );
							const document = await fetched.get( server.userAgent )!;
							if ( 'unavailable' in document ) { profileUnavailable = `${ key } server document ${ document.unavailable }`; break; }
							memberProfileServers.set( key, { repServerHtml: server.html, memberServerHtml: document.html, clusterKeyDocuments: { repServerHtml, memberServerHtml } } );
							if ( input.rewriteDerivedMedia ) {
								const media = await input.deferral?.document( url, 'rendered', server.render );
								profileMedia.set( key, media && 'html' in media ? media.html : undefined );
							}
						}
					}
					for ( const render of profileRenders( url ) ) input.deferral?.release( url, 'rendered', render );
					if ( profileUnavailable ) {
						record.unavailable.push( { url, reason: profileUnavailable } );
						unavailableCount++;
						continue;
					}
					const serverPair = ( key: string ) => {
						const pair = memberProfileServers.get( key );
						return pair ? { ...pair, ...( profileMedia.has( key ) ? { memberRenderedHtml: profileMedia.get( key ) } : {} ) } : { repServerHtml, memberServerHtml };
					};
					const mobileDerivation = desktopDerivation.ok && repProcessedMobileHtml !== undefined
						? deriveMemberDocument( { ...mediaContext, ...serverPair( 'mobile' ), repProcessedHtml: repProcessedMobileHtml, baseUrl: group.representative, templateIdentity: input.templateIdentity, styleNormalization: input.styleNormalization, featuredImages: { representative: repFeed?.image, member: memberFeed?.image }, ...slotSelector } )
						: undefined;
					const widthDerivations = mobileDerivation?.ok
						? repWidthDocuments.map( document => ( { ...document, derivation: deriveMemberDocument( { ...mediaContext, ...serverPair( document.key ), repProcessedHtml: document.html, baseUrl: group.representative, templateIdentity: input.templateIdentity, styleNormalization: input.styleNormalization, featuredImages: { representative: repFeed?.image, member: memberFeed?.image }, ...slotSelector } ) } ) )
						: [];
					const derivation = [ mobileDerivation, ...widthDerivations.map( width => width.derivation ) ].find( candidate => candidate && ! candidate.ok ) ?? desktopDerivation;
					lap( 'derive' );
					if ( ! derivation.ok ) {
						// A gate failure is an escalation, not a loss: the member falls
						// back to HTTP acquisition after derivation, or keeps its
						// budget-omission row with the gate named for the next run.
						record.escalated.push( { url, gate: derivation.gate.code, reason: derivation.gate.reason } );
						escalations.push( { url, gate: derivation.gate.code, reason: derivation.gate.reason, runtimeAnchor: derivation.gate.runtimeAnchor, slug: memberFeed?.slug, clusterSize: group.size, record } );
						escalated++;
						continue;
					}
					// Template dependencies take the captured-resource stage over the
					// same store (§3.1 step 3). Slot media is queued for the media
					// stage instead of downloaded inline (#1701).
					// The derived document keeps the source's `<base href>`; its slot
					// media resolves against that base, as the browser's baseURI does.
					const dependencyBase = authoredBaseUrl( derivation.html, url );
					await store.captureDomDependencies( derivation.html, dependencyBase, { deferMedia } );
					const memberPath = `screenshots/derived/${ slugify( url ) }.html`;
					const memberFile = resolve( input.outputDir, memberPath );
					mkdirSync( dirname( memberFile ), { recursive: true } );
					writeFileSync( memberFile, derivation.html );
					let memberMobilePath: string | undefined;
					if ( mobileDerivation?.ok ) {
						await store.captureDomDependencies( mobileDerivation.html, dependencyBase, { deferMedia } );
						memberMobilePath = `screenshots/derived/${ slugify( url ) }.mobile.html`;
						writeFileSync( resolve( input.outputDir, memberMobilePath ), mobileDerivation.html );
					}
					const widthProfiles: NonNullable< import('./screenshot/manifest-queue.js').ManifestEntry[ 'profiles' ] > = {};
					for ( const { key, profile, derivation: widthDerivation } of widthDerivations ) {
						if ( ! widthDerivation.ok ) continue;
						await store.captureDomDependencies( widthDerivation.html, dependencyBase, { deferMedia } );
						const widthPath = `screenshots/derived/${ slugify( url ) }.${ key }.html`;
						writeFileSync( resolve( input.outputDir, widthPath ), widthDerivation.html );
						widthProfiles[ key ] = { ...profile, html: widthPath };
					}
					lap( 'dependencies' );
					const slug = await queue.claimSlug( memberFeed?.slug ?? slugify( url ) );
					const capturedAtNow = new Date().toISOString();
					const repProfile = repEntry.profiles?.desktop;
					// A verified projection carries every observed menu and dialog
					// over to the member; otherwise only site chrome identical to the
					// representative's keeps its dropdowns and menus.
					const memberInteractions = interactionsVerified
						? projectInteractionReport( repProcessedHtml, derivation.html, repEntry.interactions )
						: chromeInteractionStates( repProcessedHtml, derivation.html, repEntry.interactions );
					const repMobileProfile = memberMobilePath ? repEntry.profiles?.mobile : undefined;
					await queue.updateEntry( url, {
						slug,
						html: memberPath,
						...( memberMobilePath ? { mobileHtml: memberMobilePath } : {} ),
						capturedAt: capturedAtNow,
						...( repProfile ? { profiles: { desktop: { ...repProfile, html: memberPath }, ...( repMobileProfile ? { mobile: { ...repMobileProfile, html: memberMobilePath } } : {} ), ...widthProfiles } } : {} ),
						...( memberMobilePath && repEntry.deviceMode ? { deviceMode: repEntry.deviceMode } : {} ),
						...( memberMobilePath && repEntry.fluidMobile ? { fluidMobile: repEntry.fluidMobile } : {} ),
						...( repEntry.fluid ? { fluid: repEntry.fluid } : {} ),
						...( memberInteractions ? { interactions: memberInteractions } : {} ),
					} as import('./screenshot/manifest-queue.js').ManifestEntry );
					lap( 'manifest' );
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
					documentUrls.add( url );
					documentIdentities.set( normalizedUrl( url ), url );
					derivedInCluster++;
				}
				await store.flush();
				const queued = enqueueMedia( input.outputDir, deferredMedia, input.resolveImageOriginal );
				if ( Object.keys( phases ).length ) process.stderr.write( `[timing] template-cluster ${ group.id } members ${ JSON.stringify( phases ) }\n` );
				deferredMedia.clear();
				process.stderr.write( `[template-clusters] cluster ${ group.id }: ${ queued } media queued, derived ${ record.derived.length }, escalated ${ record.escalated.length }, ${ Date.now() - startedAt }ms\n` );
			} catch ( error ) {
				// One cluster's derivation failure degrades only that cluster: the
				// members keep their budget-omission rows (#761).
				diagnostics.push( { code: ROUTE_TEMPLATE_ESCALATED, url: group.representative, reason: `cluster derivation unavailable: ${ error instanceof Error ? error.message : String( error ) }` } );
			}
		}
	} finally {
		await queue.flush().catch( () => {} );
	}

	if ( derivedUrls.length === derivedBefore ) break;
	}
	enqueueMedia( input.outputDir, deferredMedia, input.resolveImageOriginal );

	// Escalated members fall back to the adapter's governed HTTP acquisition
	// and ship as HTTP-captured routes; only a failed fallback stays omitted.
	const httpAcquiredUrls: string[] = [];
	const fallbackFailures = new Map< string, string >();
	const runtimeResults = new Map< string, { observed: boolean; reason?: string } >();
	if ( ( escalations.length || input.acquireRemaining ) && input.acquisition && ! input.governors.forOrigin( input.sourceUrl ).blockedClient ) {
		const { acquireEscalatedMembers, runtimeRenderBudgetMs } = await import( './template-cluster-fallback.js' );
		const fallbackQueue = new ManifestQueue( manifestPath );
		await fallbackQueue.init();
		try {
			const fallback = input.acquireRemaining ? await input.acquireRemaining( escalations ) : await acquireEscalatedMembers( {
				outputDir: input.outputDir, sourceUrl: input.sourceUrl, routeScope: input.routeScope, profile: input.acquisition,
				governors: input.governors, members: escalations, queue: fallbackQueue, maxTotalBytes: input.maxTotalBytes,
				runtimeRenderBudgetMs: input.runtimeRenderBudgetMs ?? runtimeRenderBudgetMs( input.timeBudgetMs ),
			} );
			httpAcquiredUrls.push( ...fallback.acquired );
			for ( const [ url, result ] of fallback.runtime ) runtimeResults.set( url, result );
			for ( const [ url, reason ] of fallback.failed ) fallbackFailures.set( url, reason );
			diagnostics.push( ...fallback.diagnostics );
		} catch ( error ) {
			for ( const member of escalations ) fallbackFailures.set( member.url, error instanceof Error ? error.message : String( error ) );
		} finally {
			if ( ! input.acquireRemaining ) await fallbackQueue.flush().catch( () => {} );
		}
	}
	const acquiredSet = new Set( httpAcquiredUrls );
	for ( const member of escalations ) {
		const isRuntimeGate = member.gate === 'runtime_mount_member_keyed';
		const runtime = runtimeResults.get( member.url ) ?? ( isRuntimeGate ? { observed: false, reason: `unobserved runtime mount: ${ member.reason }; runtime render unavailable` } : undefined );
		const gate = `failed the ${ member.gate } gate: ${ member.reason }${ runtime && ! runtime.observed ? `; ${ runtime.reason }` : '' }`;
		const entry = member.record.escalated.find( row => row.url === member.url );
		if ( acquiredSet.has( member.url ) ) {
			if ( entry ) entry.fallback = { acquired: true, ...( runtime ? { reason: runtime.observed ? 'runtime mount observed through bounded browser render' : runtime.reason } : {} ) };
			diagnostics.push( { code: ROUTE_TEMPLATE_ESCALATED, url: member.url, reason: `${ gate }; ${ runtime ? runtime.observed ? 'runtime mount observed through bounded browser render' : runtime.reason : `captured through governed HTTP acquisition (${ input.acquisition!.id })` }`, unit: 'route', severity: 'warning', metrics: { clusterSize: member.clusterSize } } );
			continue;
		}
		const failure = input.acquisition ? fallbackFailures.get( member.url ) ?? 'source client blocked' : undefined;
		if ( entry && ( failure || runtime ) ) entry.fallback = { acquired: false, reason: [ failure, runtime?.reason ].filter( Boolean ).join( '; ' ) };
		diagnostics.push( { code: ROUTE_TEMPLATE_ESCALATED, url: member.url, reason: failure ? `${ gate }; HTTP fallback failed: ${ failure }` : gate, metrics: { clusterSize: member.clusterSize } } );
	}

	const receipt: import('./template-clusters.js').TemplateClustersReceipt = {
		schema: 'data-liberation-agent/template-clusters/v1',
		fingerprint: { version: ( await import( './template-groups.js' ) ).TEMPLATE_FINGERPRINT_VERSION },
		sourceUrl: input.sourceUrl,
		derivedCount: derivedUrls.length,
		escalatedCount: escalated,
		...( input.acquisition ? { httpAcquiredCount: httpAcquiredUrls.length } : {} ),
		unavailableCount,
		clusters,
	};
	writeTemplateClusters( input.outputDir, receipt );
	return {
		summary: { derived: derivedUrls.length, derivedUrls, escalated, unavailable: unavailableCount, httpAcquired: httpAcquiredUrls.length, httpAcquiredUrls },
		diagnostics,
		receipt,
		receiptSummary: { report: TEMPLATE_CLUSTERS_FILE, derived: derivedUrls.length, escalated, httpAcquired: httpAcquiredUrls.length, unavailable: unavailableCount, clusters: clusters.length },
	};
}
