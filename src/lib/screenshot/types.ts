import type { UrlType } from '../extraction/sitemap.js';
import type { CaptureProfile } from './capture-profiles.js';

export interface CaptureLogSink {
	sendLoggingMessage( message: { level: 'info'; data: string } ): void | Promise< void >;
}

export interface Viewport extends CaptureProfile {}

// Desktop stays at 1440×900 — the browser renders the real desktop layout
// (responsive media queries kick in based on logical viewport, not output
// pixels). To keep PNG file size small for the agent's vision context, we
// pair this with `SCREENSHOT_DEVICE_SCALE_FACTOR` below: the browser
// outputs the screenshot at fewer real pixels even though the rendered
// layout is the full 1440×900. That's how to get "~2x fewer pixels"
// without changing what the page actually looks like.
export function defaultViewports(mobile: { width: number; height: number }): Viewport[] {
	return [
		{ id: 'desktop', width: 1440, height: 900 },
		{ id: 'mobile', width: mobile.width, height: mobile.height },
	];
}

/**
 * Default deviceScaleFactor for screenshot capture. 0.7 gives ~49% fewer
 * output pixels (0.7² ≈ 0.49) while the browser keeps rendering at the
 * full logical viewport — so the agent sees the real desktop layout in a
 * smaller PNG. Mobile is already small (402×681 = 274 kpx) so we don't
 * scale it.
 */
export const SCREENSHOT_DEVICE_SCALE_FACTOR = 0.7;

export interface ScreenshotOpts {
	urls: string[];
	outputDir: string;
	primaryUrl?: string; // reference for same-origin enforcement
	routeScope?: import('../../platform/types.js').SiteRouteScope;
	viewports?: Viewport[];
	/**
	 * Whether the default phone profile is captured as its own document (see
	 * `device-mode.ts`). `auto` decides once on the entrypoint before route
	 * capture. Ignored when `viewports` is given. Default: `dual`.
	 */
	deviceMode?: import('./device-mode.js').DeviceModeRequest;
	/** The adapter selects among per-device documents at export, so `auto` keeps both profiles. */
	deviceDocumentSelection?: boolean;
	/**
	 * Probe the entrypoint's shared chrome (header, navigation, footer) once per
	 * profile and reuse that evidence on every route whose chrome matches (see
	 * `chrome-reuse.ts`). Default: on unless `viewports` is given.
	 */
	sharedChrome?: boolean;
	additionalProfiles?: import('../../adapters/page-actions.js').LiberationHooks['additionalProfiles'];
	referenceWidths?: number[];
	/** Declare required cells before navigating, so failed profiles stay pending. */
	declareSourceProfile?: (url: string, profile: import('./capture-profiles.js').CaptureProfile) => void;
	/** Maximum route workers. Explicit values override runtime-memory admission;
	 * defaults to 6 on unconstrained hosts, measured admission under a Node memory constraint. */
	concurrency?: number;
	browserRestartEvery?: number; // default: 100
	cdpPort?: number;
	force?: boolean;
	types?: UrlType[];
	/** Route budget for the whole capture: initial routes and linked admissions together. */
	limit?: number;
	/** Expand rendered same-origin links through the normal capture queue. */
	linkedPages?: import('./linked-frontier.js').LinkedPageLimits;
	/** Routes whose rel=canonical is another inventory route; links to them count as links to that route. */
	linkedCanonicalAliases?: readonly import('../route-aliases.js').CanonicalRouteAlias[];
	screenshotTimeoutMs?: number; // default: 30_000
	/** Capture full-page and scrolled PNGs. Default: false; HTML/CSS and sidecars remain enabled. */
	captureImages?: boolean;
	evaluateTimeoutMs?: number; // default: 5_000
	/** Per-profile uncaught-error ceiling in a one-second bucket (default 2,000). */
	maxPageErrorsPerSecond?: number;
	settleMs?: number; // default: 1_000
	server?: CaptureLogSink;
	verbose?: boolean;
	/** Reject non-public requests and redirect targets during browser capture. */
	publicUrlsOnly?: boolean;
	/**
	 * Per-URL progress callback. Fired after each URL finishes (success,
	 * fail, or skip). `current` is the count of completed URLs (1-indexed),
	 * `total` is the total to capture. Used by the watch TUI so the
	 * "discovery → extraction" gap stops looking like a hang.
	 */
	onProgress?: ( current: number, total: number, url: string ) => void;
	/**
	 * Fired once per route whose documents were saved, with their paths
	 * relative to `outputDir` and whether the capture already stored a URL's bytes.
	 */
	onRouteCaptured?: ( url: string, documents: string[], stored: ( resourceUrl: string ) => boolean ) => void;
	/**
	 * Learn how the source sizes itself by sweeping viewport widths with its
	 * runtime alive, then emit the learned CSS instead of the pixels that
	 * runtime happened to compute at the capture width. Costs one sweep per
	 * captured responsive document, with the same ladder spanning phone,
	 * tablet and desktop widths so each document can reflow wherever it is served.
	 */
	learnFluid?: boolean;
	/** Exact widths to observe when learning. Defaults to an adaptive sample of DEFAULT_SWEEP_WIDTHS. */
	fluidWidths?: number[];
	/**
	 * Adapter hook returning the viewport-specific image variants a platform's
	 * runtime swapped in (seam 2). The capture path stays CDN-agnostic.
	 */
	collectResponsiveImages?: (
		page: import('playwright').Page,
		ctx: import('../../adapters/page-actions.js').LiberationContext
	) => Promise< Record< string, string > >;
	/** Adapter-declared selectors removed from each page before capture (seam 1). */
	removeSelectors?: string[];
	/** Adapter-declared selectors recognizing a client-error shell document; a page whose
	 *  serialized HTML matches one is refused instead of saved (#917). */
	clientErrorShellSelectors?: string[];
	cleanupPolicy?: import('../source-cleanup.js').CleanupPolicy;
	/** Adapter imperative capture hook, run after removeSelectors. Best-effort. */
	prepareCapture?: (
		page: import('playwright').Page,
		ctx: import('../../adapters/page-actions.js').LiberationContext
	) => Promise< void >;
	resolveClientRedirect?: ( page: import('playwright').Page, url: string ) => Promise< string | undefined >;
	/** Adapter-declared telemetry: pending requests it recognizes never hold a readiness wait. */
	telemetryRequest?: import('./page-helpers.js').TelemetryRequest;
	/** Adapter rewrite applied to every serialized HTML artifact before it is stored. */
	canonicalizeHtml?: ( html: string ) => string;
	/** Adapter-declared platform-runtime regions interaction probing never drives. */
	probeExclusions?: readonly import('./probe-exclusions.js').ProbeExclusion[];
	/** Adapter hook run immediately before fluid learning. Best-effort. */
	beforeFluid?: (
		page: import('playwright').Page,
		ctx: import('../../adapters/page-actions.js').LiberationContext
	) => Promise< void >;
	/** Adapter hook run after fluid learning, immediately before serialize. Best-effort. */
	beforeSerialize?: (
		page: import('playwright').Page,
		ctx: import('../../adapters/page-actions.js').LiberationContext
	) => Promise< void >;
	/** Product-owned evidence observer, after source cleanup and before geometry rewriting. */
	observeSource?: ( page: import('playwright').Page, url: string, device: string, errors: readonly string[], browserProfile?: Readonly<{ isMobile: boolean; hasTouch: boolean }>, profile?: import('./capture-profiles.js').CaptureProfile, boundary?: import('../source-navigation.js').ExternalBoundary ) => Promise<void>;
	/**
	 * Routes that produce fresh reference pages. When given, memory admission
	 * estimates these routes and the routes outside the bounded reference
	 * sample separately, so a route without reference pages reserves its own
	 * smaller working set. Default: every route opens reference pages.
	 */
	referenceSampleUrls?: readonly string[];
	/**
	 * Capture time budget window (see `capture-time-budget.ts`). The entrypoint
	 * starts first; no other route starts after `admitUntil`; routes still
	 * running at `abandonAt` are abandoned. Uncaptured routes are reported as
	 * `route_capture_skipped_budget` and counted in `failed`. Default: none.
	 */
	timeBudget?: import('../capture-time-budget.js').CaptureTimeBudgetWindow;
	/**
	 * Per-route deadline in milliseconds: a route that exceeds it is abandoned,
	 * its contexts closed, and it records `route_capture_timeout`. 0 disables it.
	 * Default: derived from the capture time budget and the admitted
	 * concurrency (budget/concurrency, never below `ROUTE_DEADLINE_MIN_MS`), or
	 * `ROUTE_DEADLINE_MIN_MS` without a budget.
	 */
	routeDeadlineMs?: number;
}

export interface ScreenshotResult {
	captured: number;
	skipped: number;
	failed: number;
	browserRestarts: number;
	durationMs: number;
	manifestPath: string;
	/** Every URL processed, including redirect targets queued during capture. */
	urls: string[];
	linkedPageCoverage?: import('./linked-frontier.js').LinkedPageCoverage;
	/** Findings about input routes dropped before capture (`route_off_origin`) or left by the time budget (`route_capture_skipped_budget`). */
	routeDiagnostics?: import('../capture-export-routes.js').RouteDiagnostic[];
	/** The device-mode decision, when `deviceMode` applied (no explicit `viewports`). */
	deviceMode?: import('./device-mode.js').DeviceModeDecision;
	/** The entrypoint's one-time chrome probe per profile and which routes reused it. */
	sharedChrome?: import('./chrome-reuse.js').SharedChromeSummary;
}
