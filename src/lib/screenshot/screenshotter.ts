import { isIntegrityError } from '../failure-class.js';
import { loadSourceBaseline, renderedQueryAlias } from './load-baseline.js';
import { runSteps } from './capture-steps.js';
import { createPostBaselineState, postBaselineSteps, retainPartialPostBaseline } from './post-baseline-steps.js';
import { createRouteAdmission, runtimeMemoryLimit, type RouteKind } from './route-admission.js';
import { installReadOnlyProbeGuard, lockMainFrameNavigation } from './probe-guards.js';
import { canonicalizeInteractionReport } from './canonicalize-interaction-report.js';
import { probeDeviceMode, checkRouteDeviceMode, type DeviceComparisonArgs } from './device-mode-probe.js';
import { probeSharedChrome } from './chrome-reuse.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { incompleteDeviceDocument } from '../responsive-assembly.js';
import { dirname, join, relative } from 'node:path';
import { resolveDocumentReferences } from '../document-resource-base.js';
import { parseSrcset, isSrcsetShaped } from '../srcset.js';
import { SOURCE_SUBFRAME_RUNTIME_ERROR, watchSourceRuntimeErrors } from '../source-readiness.js';
import { forgetSourceDocument, getSourceResponse } from '../browser-kit/source-traffic.js';
import { SourceRequestGovernors } from '../source-request-governor.js';
import { connectBrowser, createSourceContext, sourceContextOptions } from '../browser-kit/index.js';
import { classifyUrl, type UrlType } from '../extraction/sitemap.js';
import { navigateSourceDocument, inspectSourceDocument, boundaryIdentity, SOURCE_LINK_PROBE_REQUEST_MS, SOURCE_NAVIGATION_LIMITS } from '../source-navigation.js';
import { CHROME_AUDIT_PROPERTIES } from '../replicate/chrome-audit-types.js';
import { extractFull } from '../replicate/section-extract.js';
import { SectionSpecsStore } from '../replicate/section-specs-store.js';
import { slugify } from '../url/index.js';
import { SiteAnalysisAggregator } from './aggregator.js';
import { readSourceCleanup, sweepSourceCleanup, cleanupPolicy, type CleanupPolicy } from '../source-cleanup.js';
import { captureChromeFidelity } from './capture-chrome-fidelity.js';
import { CSS_SHORTHAND_REPAIR_FACTORY_SOURCE } from './css-shorthand-repair.js';
import {
	countBodyTags,
	isRouteDrift,
	isStackingArtifact,
	matchClientErrorShell,
	PHONE_REDIRECT_DESKTOP_ONLY,
	profileRedirectMerge,
} from './document-integrity.js';
import { sanitizeFrozenHtml } from './freeze.js';
import { portStaticShadowContent } from './shadow-content.js';
import { normalizeCaptureState, normalizeGeneratedIds, settleScriptMotion, SCRIPT_MOTION_BUDGET_MS } from './capture-state.js';
import { markGalleryRoots } from './gallery-capture.js';
import { snapshotComponents, type ComponentBaseline, type CapturedComponent } from './component-states.js';
import { markInitialDocument, projectInitialDocument } from './initial-document.js';
import { withDocumentTitle } from './document-title.js';
import { wireCapturedDialogs } from '../static-dialogs.js';
import { captureNativeViewTimelines } from './native-view-timelines.js';
import { observeNativeControlState, NATIVE_CONTROL_STATE_ATTRIBUTE, wireNativeControlState } from '../native-control-state.js';
import { learnAndApplyFluidGeometry, type FluidSeriesMemo } from './fluid-capture.js';
import { captureViewportClassStates, type ViewportClassMemo } from './viewport-class-states.js';
import { RootClassEvidence, rootClassContracts, sampleRootClassLadder, projectRootClassContracts, type RootClassContract } from './root-class-contracts.js';
import {
	type CapturedDialogInteraction,
	type InteractionStatesReport,
} from './interaction-capture.js';
import { type ScrollStatesReport } from './scroll-state-capture.js';
import { observeViewportEntrances } from '../viewport-entrances.js';
import { observeRuntimeStyleWrites, restoreLoadTimeSheets } from './runtime-style-writes.js';
import { observeViewportWork } from './viewport-work.js';
import { attributeSourcePhase } from '../browser-kit/source-traffic.js';
import { createPhaseBudget } from './phase-budget.js';
import { AbsentDocumentProbes, isAbsentDocumentError, isSourceCaptureUrl } from './absent-document.js';
import { installRuntimeWidgetAttribution, removeRuntimeWidgets } from './runtime-widgets.js';
import { restoreRuntimeEmoji } from './runtime-emoji.js';
import { cleanPortableScaffolding } from './portable-scaffolding.js';
import { ManifestQueue, type ManifestEntry, type FailureEntry, type ProfileDiagnostic } from './manifest-queue.js';
import { createPhaseLedger, routePhaseBreakdown, type PhaseLedger } from './phase-ledger.js';
import { validateOutputDir, planArtifacts, planDocumentArtifacts, type ArtifactPlan } from './output-layout.js';
import { validateCaptureProfile, publicCaptureProfile, replayBrowserIdentity } from './capture-profiles.js';
import { waitForStable, dismissOverlays, pageResponds, withEvaluateTimeout, isEvaluateTimeout, reportReadiness, settleDocument, waitForFonts } from './page-helpers.js';
import { CapturedResourceStore, installResourceReplay } from './resource-capture.js';
import { enforceSameOrigin, offOriginUrls } from './same-origin.js';
import type { RouteDiagnostic } from '../capture-export-routes.js';
import { preserveStreamedVideoPosters } from './streamed-video.js';
import { GlyphColorCache, recordGlyphColors } from './glyph-color.js';
import { isGoogleMapHost, portRenderedGoogleMaps } from './rendered-google-maps.js';
import { sameOriginPageAnchors } from './unscheduled-anchors.js';
import { LinkedFrontier } from './linked-frontier.js';
import { RouteTimeBudget, RouteDeadlines, deriveRouteDeadlineMs, routeProfileTimeoutDiagnostic, routeTimeoutDiagnostic, type RouteDeadlineAbandonment } from '../capture-time-budget.js';
import { routeInScope, scopedRouteKey, validateRouteScope } from '../url/route-scope.js';
import { stateChangingAction } from '../url/action-url.js';
import { normalizedUrl, documentRequestUrl } from '../url/route-key.js';
import { analyzePage } from './site-analysis.js';
import { guardPageErrors, PAGE_ERROR_STORM } from './page-error-guard.js';

/** Alias request identity → its canonical route's identity, for link counting. */
function linkedAliasMap( aliases?: readonly import('../route-aliases.js').CanonicalRouteAlias[] ): Map< string, string > {
	const map = new Map< string, string >();
	for ( const { url, canonicalUrl } of aliases ?? [] ) {
		try { map.set( documentRequestUrl( url ), documentRequestUrl( canonicalUrl ) ); } catch { /* An unparseable record cannot satisfy any link. */ }
	}
	return map;
}
import {
	defaultViewports,
	SCREENSHOT_DEVICE_SCALE_FACTOR,
	type CaptureLogSink,
	type ScreenshotOpts,
	type ScreenshotResult,
	type Viewport,
} from './types.js';
import type { GeometryCapture } from './layout-geometry-proof.js';
import { RouteDeviceEvidence, summarizeRouteDecisions, type DeviceModeDecision, type RouteDeviceDecision, MIDDLE_PROFILE_ID, middleLayoutSampleWidth } from './device-mode.js';
import { summarizeSharedChrome, type SharedChromeProbe, type SharedChromeRouteDecision } from './chrome-reuse.js';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { stampScriptedLinkCandidates } from './scripted-links.js';

/**
 * Scroll offset multiplier for the scrolled-state screenshot: we scroll to
 * `viewport.height * SCROLL_OFFSET_RATIO` and clip a viewport-sized region
 * starting at that same Y. Both sites (the scroll and the clip origin) must
 * stay in lockstep; changing one changes the other.
 */
const SCROLL_OFFSET_RATIO = 1.5;
const ANALYSIS_SAMPLE_LIMIT = 1;
const MAX_CAPTURED_DIALOGS = 8;
const MAX_CRASH_RELAUNCHES = 3;

/**
 * Per-URL capture pipeline:
 *
 *   URL
 *    │
 *    ▼
 *   classifyUrl/slugify  ──▶  manifest.claimSlug  ──▶  planArtifacts
 *    │                                                 │
 *    │                         ┌───────── needsLoad? ──┤
 *    │                         ▼ no                    ▼ yes
 *    │                   skipped++                   for each viewport:
 *    │                                                 newContext(viewport)
 *    │                                                   │
 *    │                                                   ▼
 *    │                                                 newPage
 *    │                                                   │
 *    │                                                   ▼
 *    │                                                 goto ─── 404/410 (discovered) ──▶ skipped
 *    │                                                   │      other 4xx/throw ──▶ failures[goto]
 *    │                                                   │
 *    │                                                   ▼
 *    │                                                 waitForStable
 *    │                                                   │
 *    │                                                   ▼
 *    │                                                 dismissOverlays (early)
 *    │                                                   │
 *    │                                                   ▼
 *    │                                                 triggerLazyLoad
 *    │                                                   │
 *    │                                                   ▼
 *    │                                                 dismissOverlays (late)
 *    │                                                   │
 *    │                            desktop only          ▼
 *    │                         ┌────────── plan.captureHtml ──▶ page.content → html/<slug>.html
 *    │                         │                        │
 *    │                         │                        ▼
 *    │                         │                      screenshot(fullPage)     ──▶ screenshots/<vp>/<slug>.png
 *    │                         │                        │
 *    │                         │                        ▼
 *    │                         │                      scrollTo(vh*1.5) + clip  ──▶ screenshots/<vp>/<slug>.scrolled.png
 *    │                         │                        │
 *    │                         │         desktop only   ▼
 *    │                         └──────────── analyzePage ──▶ entry.metadata
 *    │                                                   │
 *    │                                                   ▼
 *    │                                                 context.close() (finally)
 *    │                                                   │
 *    ▼                                                   ▼
 *   manifest.updateEntry + recordFailure (batched)
 *
 * Browser restart runs at BATCH BOUNDARIES only — never mid-batch.
 */

/** Race a screenshot promise against a hard timeout. Mirrors withEvaluateTimeout. */
async function withScreenshotTimeout< T >( p: Promise< T >, ms: number ): Promise< T > {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise< never >( ( _, reject ) => {
		timer = setTimeout( () => reject( new Error( `screenshot timeout after ${ ms }ms` ) ), ms );
	} );
	try {
		return await Promise.race( [ p, timeout ] );
	} finally {
		if ( timer ) clearTimeout( timer );
	}
}

/** Best-effort log forwarder — never throws into the capture loop. */
function sendLog( server: CaptureLogSink | undefined, message: string ): void {
	if ( /^\[(?:restart|retry)\]/.test( message ) ) console.error( message );
	if ( ! server ) return;
	try {
		void server.sendLoggingMessage( { level: 'info', data: message } );
	} catch {
		/* logging transport not available */
	}
}

interface CapturePerViewportArgs {
	page: Page;
	absentDocument?: ( html: string ) => Promise< boolean >;
	rootClassEvidence: RootClassEvidence;
	routeDeadlineMs: number;
	routeRemainingMs: () => number;
	serverLinks: Set<string>;
	probeOverrun: ( ms: number ) => void;
	/** Wall-clock accounting for this profile; see phase-ledger.ts. */
	phases?: PhaseLedger;
	/** Stop best-effort stages after a crash or page-error storm. */
	rendererCrashed: () => boolean;
	learnFluid?: boolean;
	/** Swept fluid series shared across this capture's routes. */
	fluidMemo?: FluidSeriesMemo;
	/** Class-state breakpoints located on earlier routes of this capture. */
	classBreakpoints?: Set< number >;
	classMemo?: ViewportClassMemo;
	fluidWidths?: number[];
	collectResponsiveImages?: (
		page: import('playwright').Page,
		ctx: import('../../adapters/page-actions.js').LiberationContext
	) => Promise< Record< string, string > >;
	removeSelectors?: string[];
	clientErrorShellSelectors?: string[];
	cleanupPolicy?: CleanupPolicy;
	prepareCapture?: (
		page: import('playwright').Page,
		ctx: import('../../adapters/page-actions.js').LiberationContext
	) => Promise< void >;
	resolveClientRedirect?: ( page: Page, url: string ) => Promise< string | undefined >;
	/** Resolve a query rendition whose rendered rel=canonical is its query-less route to that route. */
	canonicalQueryAlias?: boolean;
	initScript?: ScreenshotOpts['initScript'];
	beforeFluid?: ScreenshotOpts['beforeFluid'];
	beforeSerialize?: (
		page: import('playwright').Page,
		ctx: import('../../adapters/page-actions.js').LiberationContext
	) => Promise< void >;
	observeSource?: ScreenshotOpts['observeSource'];
	browserProfile: Readonly<{ isMobile: boolean; hasTouch: boolean }>;
	canonicalizeHtml?: ( html: string, document?: string ) => string;
	probeExclusions?: ScreenshotOpts['probeExclusions'];
	/** The entrypoint's one-time chrome probe for this profile; see chrome-reuse.ts. */
	sharedChrome?: SharedChromeProbe;
	/**
	 * Set on the desktop pass of a reflow-only route: its document also serves
	 * phones, so chrome with no reusable entrypoint evidence has its phone-only
	 * controls probed in place at this size (see `probePhoneOnlyChrome`).
	 */
	reflowPhoneViewport?: { width: number; height: number };
	viewport: Viewport;
	consentViewports?: ReadonlyArray<{ id?: string; width: number; height: number }>;
	plan: ArtifactPlan;
	url: string;
	slug: string;
	settleMs: number;
	/** Additional bounded rendering time for a content-incomplete device retry. */
	recoverIncompleteDocument?: boolean;
	screenshotTimeoutMs: number;
	evaluateTimeoutMs: number;
	failures: FailureEntry[];
	/** Non-fatal observations about this profile's capture, recorded on its manifest profile. */
	diagnostics?: ProfileDiagnostic[];
	entry: ManifestEntry;
	aggregator: SiteAnalysisAggregator;
	shouldAnalyze: boolean;
	outputDir: string;
	/** Accumulates {media id → mobile-variant URL} from the mobile viewport, for
	 *  responsive-image carry. Mutated in place; written once after all captures. */
	responsiveImages: Record< string, string >;
	/** Accumulates {slug → mobile-DOM scrollHeight} from the mobile viewport, for the
	 *  alt path's iframe mobile-DOM carry. Mutated in place; written once at run end. */
	mobileHeights: Record< string, number >;
	resourceStore: CapturedResourceStore;
	/** Run-scoped glyph colours, shared by every route and profile (#924). */
	glyphColors?: GlyphColorCache;
	publicUrlsOnly: boolean;
	routeScope?: ScreenshotOpts['routeScope'];
}

/** Failure reason for a route whose source app crashed into its client error shell. */
const CLIENT_ERROR_SHELL_FAILURE = 'client error shell';

export async function capturePageHtml( page: Page, diagnostics?: ProfileDiagnostic[], serverHtml?: string ): Promise< string > {
	const iframeEvidenceAttributes = {
		src: 'data-blocks-engine-capture-visual-iframe-src',
		width: 'data-blocks-engine-capture-visual-iframe-width',
		height: 'data-blocks-engine-capture-visual-iframe-height',
	};
	const hydrateMediaSources = () => page.evaluate( ( evidenceAttributes ) => {
		let pendingVideoSource = false;
		for ( const media of document.querySelectorAll( 'audio, video' ) ) {
			const source = media as HTMLMediaElement;
			const resolvedSource = source.currentSrc || source.src;
			// A `blob:` URL (a Media Source Extensions stream, as HLS/DASH players
			// use) names an object that only exists in this page session, so the
			// copy would show a dead player. Drop it rather than persist it; the
			// live element keeps playing, since removing `src` does not reload it.
			// preserveStreamedVideoPosters keeps the element's visual weight.
			const isSessionUrl = ( value: string | null ) => /^blob:/i.test( value?.trim() ?? '' );
			for ( const child of source.querySelectorAll( 'source' ) ) {
				if ( isSessionUrl( child.getAttribute( 'src' ) ) ) child.remove();
			}
			if ( isSessionUrl( source.getAttribute( 'src' ) ) ) source.removeAttribute( 'src' );
			if ( isSessionUrl( resolvedSource ) ) {
				// Stream-backed: nothing durable to write, and nothing left to wait for.
			} else if ( resolvedSource ) source.setAttribute( 'src', resolvedSource );
			else if ( source instanceof HTMLVideoElement ) pendingVideoSource = true;
			for ( const property of [ 'autoplay', 'loop', 'muted' ] as const ) {
				if ( source[ property ] ) source.setAttribute( property, '' );
			}
			if ( source instanceof HTMLVideoElement && source.playsInline ) {
				source.setAttribute( 'playsinline', '' );
			}
		}
		for ( const frame of document.querySelectorAll( 'iframe' ) ) {
			for ( const attribute of Object.values( evidenceAttributes ) ) {
				frame.removeAttribute( attribute );
			}

			// A frame with no src of its own or with srcdoc is not a page to link to;
			// an empty src would resolve to this document's own URL.
			const rawSource = frame.hasAttribute( 'srcdoc' ) ? undefined : frame.getAttribute( 'src' )?.trim();
			if ( ! rawSource ) continue;
			let source: URL;
			try {
				source = new URL( rawSource, document.baseURI );
			} catch {
				continue;
			}
			const bounds = frame.getBoundingClientRect();
			const visible =
				bounds.width > 0 &&
				bounds.height > 0 &&
				Number.isFinite( bounds.width ) &&
				Number.isFinite( bounds.height ) &&
				( typeof frame.checkVisibility !== 'function' ||
					frame.checkVisibility( { checkOpacity: true, checkVisibilityCSS: true } ) );
			if ( source.protocol !== 'https:' || ! source.hostname || ! visible ) continue;

			frame.setAttribute( evidenceAttributes.src, source.href );
			frame.setAttribute( evidenceAttributes.width, String( Math.max( 1, Math.round( bounds.width ) ) ) );
			frame.setAttribute( evidenceAttributes.height, String( Math.max( 1, Math.round( bounds.height ) ) ) );
		}
		return pendingVideoSource;
	}, iframeEvidenceAttributes );
	// Some runtimes attach media URLs after their player shell is visible. Give
	// only pages with source-less video elements a bounded chance to settle.
	for ( let attempt = 0; attempt < 10 && ( await hydrateMediaSources() ) === true; attempt++ ) {
		await page.waitForTimeout( 200 );
	}
	// CSSOM mutations do not update a <style> element's text content, and constructed
	// sheets have no owner node at all, so neither survives markup serialization. Sync
	// each sheet from its active rules so the static capture preserves the styles the
	// browser is actually applying. Runs once, after media settling: appending inside
	// that retry loop would emit a duplicate <style> per attempt.
	//
	// Reading a rule's live cssText is itself lossy for one shape: a shorthand set via
	// var() (e.g. `font: var(--token)`) followed, in the same declaration, by an
	// explicit override of one of that shorthand's own longhands (e.g.
	// `font-style: normal`) becomes a "pending-substitution value" the CSSOM cannot
	// re-serialize — every longhand of the shorthand reads back as an empty
	// declaration and the shorthand itself disappears. getComputedStyle still resolves
	// it correctly; only the declaration *text* is unrecoverable through the CSSOM.
	// Repair against the <style> owner's own pre-mutation textContent (read below,
	// before it is overwritten) — see css-shorthand-repair.ts.
	const stylesRewritten = await page.evaluate(
		( { factorySrc, serverHtml } ) => {
			let rewritten = false;
			( window as typeof window & { __dlaEntrances?: { stamp(): void } } ).__dlaEntrances?.stamp();
			const authoredStyles = new Set<string>();
			if ( serverHtml ) {
				const baseline = new DOMParser().parseFromString( serverHtml, 'text/html' );
				for ( const style of baseline.querySelectorAll( 'style' ) ) authoredStyles.add( style.textContent ?? '' );
			}
			for ( const style of serverHtml ? Array.from( document.querySelectorAll( 'style' ) ) : [] ) {
				if ( authoredStyles.has( style.textContent ?? '' ) ) continue;
				let rules: CSSRuleList;
				try { rules = style.sheet?.cssRules ?? ([] as unknown as CSSRuleList); } catch { continue; }
				const selectors: string[] = [];
				const collect = ( list: CSSRuleList ) => { for ( const rule of Array.from( list ) ) {
					if ( rule instanceof CSSStyleRule ) selectors.push( rule.selectorText );
					else if ( 'cssRules' in rule ) collect( ( rule as CSSGroupingRule ).cssRules );
				} };
				collect( rules );
				if ( selectors.length && ! selectors.some( selector => { try { return document.querySelector( selector ) !== null; } catch { return true; } } ) ) {
					const bytes = new TextEncoder().encode( style.textContent ?? '' ).length;
					style.remove();
					( window as typeof window & { __dlaOmittedRuntimeStyles?: Array<{ bytes: number; rules: number }> } ).__dlaOmittedRuntimeStyles ??= [];
					( window as typeof window & { __dlaOmittedRuntimeStyles?: Array<{ bytes: number; rules: number }> } ).__dlaOmittedRuntimeStyles!.push( { bytes, rules: selectors.length } );
				}
			}
			const repairShorthandVarCollapse = new Function( 'return (' + factorySrc + ')' )()();
			const sheets = new Set( [ ...document.styleSheets, ...document.adoptedStyleSheets ] );
			for ( const sheet of sheets ) {
				const owner = sheet.ownerNode;
				if ( owner instanceof HTMLLinkElement ) continue;
				let cssText = '';
				try {
					cssText = Array.from( sheet.cssRules ).map( ( rule ) => rule.cssText ).join( '\n' );
				} catch {
					// Cross-origin sheet: .cssRules throws. Its <link> is captured separately.
					continue;
				}
				if ( ! cssText ) continue;
				if ( owner instanceof HTMLStyleElement && document.documentElement.contains( owner ) ) {
					// Stylesheets copied from a linked resource already have their source
					// text in the DOM. Replacing it with Chromium's cssRules serialization
					// can change nested/media CSS semantics (notably responsive form grids).
					// Keep the source text; constructed sheets still use the active rules
					// below because they have no serializable owner node.
					if ( owner.hasAttribute( 'data-href' ) ) continue;
					const sourceText = owner.textContent ?? '';
					// Compare parsed rules, not formatting. Re-parsing the live owner even
					// with equivalent text resets its FontFaces and runtime measurements.
					const sourceSheet = new CSSStyleSheet();
					sourceSheet.replaceSync( sourceText );
					const sourceRules = Array.from( sourceSheet.cssRules ).map( rule => rule.cssText ).join( '\n' );
					if ( sourceRules === cssText ) continue;
					owner.textContent = repairShorthandVarCollapse( cssText, sourceText );
					rewritten = true;
					continue;
				}
				const style = document.createElement( 'style' );
				style.setAttribute( 'data-blocks-engine-capture-constructed-stylesheet', '' );
				style.textContent = cssText;
				document.head.appendChild( style );
				rewritten = true;
			}
			return rewritten;
		},
		{ factorySrc: CSS_SHORTHAND_REPAIR_FACTORY_SOURCE.factorySrc, serverHtml: serverHtml ?? '' }
	);
	if ( stylesRewritten ) {
		await waitForFonts( page );
		// Font events can schedule runtime geometry writes after fonts.ready.
		await settleDocument( page, 'stable', { quietMs: 500, timeoutMs: 5_000 } );
	}
	try {
		// Serialize in the renderer's current task. page.content() round-trips through
		// DevTools and can race framework hydration, pairing a newer class namespace
		// with older CSS.
		//
		// An empty custom element whose defining script the portable copy never
		// runs is kept only if it shows or shapes something here: it paints, or
		// taking it out moves its parent or next sibling. Otherwise it is an empty
		// runtime hook; leave it out of the document, then restore it so later
		// probes still see the live page.
		//
		// The installed source cleanup sweeps first, in this same task: the
		// settle and media waits above give the source time to mount a widget
		// after the last sweep, and no source script runs between these two.
		const result = await page.evaluate( ( { observeControlSource, controlAttribute, portMapsSource, mapHostSource, iframeEvidenceAttributes, scaffoldingSource, shadowSource, parseSrcsetSource, srcsetShapedSource } ) => {
			( window as unknown as { __dlaCleanup?: { sweep: () => void } } ).__dlaCleanup?.sweep();
			const box = ( node: Element | null ) => {
				const bounds = node?.getBoundingClientRect();
				return bounds ? `${ bounds.x },${ bounds.y },${ bounds.width },${ bounds.height }` : '';
			};
			const paints = ( element: Element ) => {
				const style = getComputedStyle( element );
				return (
					style.backgroundImage !== 'none' ||
					! /^(?:transparent|rgba\([^)]*,\s*0\))$/.test( style.backgroundColor ) ||
					[ style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth ].some(
						( width ) => parseFloat( width ) > 0
					) ||
					( style.outlineStyle !== 'none' && parseFloat( style.outlineWidth ) > 0 ) ||
					style.boxShadow !== 'none'
				);
			};
			const restoredImages: Array< { image: HTMLImageElement; previous: string | null } > = [];
			const restoredAspectRatios: Array< { image: HTMLImageElement; previous: string; priority: string } > = [];
			const restoredBackgrounds: Array< { element: HTMLElement; previous: string | null; classes: string | null; status: string | null } > = [];
			const placeholderGif = /^data:image\/gif;base64,R0lGODlhAQAB/i;
			const srcsetShaped = new Function( 'return (' + srcsetShapedSource + ')' )() as typeof isSrcsetShaped;
			const srcsetCandidates = new Function( 'return (' + parseSrcsetSource + ')' )() as typeof parseSrcset;
			const durableImageUrl = ( value: string | null | undefined ): string => {
				const url = ( value ?? '' ).trim();
				if ( ! url || /^blob:/i.test( url ) || placeholderGif.test( url ) || srcsetShaped( url ) ) return '';
				try {
					const parsed = new URL( url, document.baseURI );
					return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
				} catch {
					return '';
				}
			};
			const firstHttpUrl = ( value: string ): string => {
				for ( const candidate of srcsetCandidates( value ) ) {
					const url = durableImageUrl( candidate.url );
					if ( url ) return url;
				}
				return '';
			};
			const detached: Array< { element: Element; parent: Node; next: Node | null } > = [];
			for ( const element of Array.from( document.body?.querySelectorAll( '*' ) ?? [] ) ) {
				if ( element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || ! element.localName.includes( '-' ) ) continue;
				if ( element.shadowRoot || element.childElementCount > 0 || ( element.textContent ?? '' ).trim() !== '' ) continue;
				if ( paints( element ) ) continue;
				const parent = element.parentElement;
				if ( ! parent ) continue;
				const next = element.nextSibling;
				const sibling = element.nextElementSibling;
				const before = box( parent ) + box( sibling );
				element.remove();
				if ( box( parent ) + box( sibling ) === before ) detached.push( { element, parent, next } );
				else parent.insertBefore( element, next );
			}
			// A lazy loader leaves the 1x1 GIF, or a density list, in the src
			// attribute while the loaded file is currentSrc (or a data-* / source
			// srcset). outerHTML keeps the attribute, so write the loaded URL
			// immediately before serializing, then put the live attribute back.
			for ( const image of document.querySelectorAll( 'img' ) ) {
				// Responsive image components often put the rendered ratio on the
				// image's owning layer through a custom property. Keep that computed
				// contract in the static artifact: the source stylesheet/runtime may
				// not be present when the localized image is laid out again.
				const imageStyle = getComputedStyle( image );
				const rendered = image.getBoundingClientRect();
				if ( imageStyle.aspectRatio !== 'auto' && rendered.width > 0 && rendered.height > 0 ) {
					restoredAspectRatios.push( {
						image,
						previous: image.style.getPropertyValue( 'aspect-ratio' ),
						priority: image.style.getPropertyPriority( 'aspect-ratio' ),
					} );
					// `auto <ratio>` lets a localized image use its different intrinsic
					// ratio, so retain the source's rendered ratio in that case. A fixed
					// authored ratio must stay fixed: a max-width-constrained image can
					// have a different rendered box ratio at every viewport width.
					image.style.setProperty(
						'aspect-ratio',
						/^auto\s/i.test( imageStyle.aspectRatio )
							? `${ rendered.width } / ${ rendered.height }`
							: imageStyle.aspectRatio
					);
				}
				const attribute = image.getAttribute( 'src' ) ?? '';
				const shaped = srcsetShaped( attribute );
				if ( attribute.trim() && ! placeholderGif.test( attribute ) && ! shaped && ! /^blob:/i.test( attribute ) ) continue;
				let next = durableImageUrl( image.currentSrc );
				if ( ! next ) {
					for ( const name of [ 'data-src', 'data-lazy-src', 'data-original', 'data-image' ] ) {
						next = durableImageUrl( image.getAttribute( name ) );
						if ( next ) break;
					}
				}
				if ( ! next ) {
					const srcset =
						image.getAttribute( 'srcset' ) ||
						image.getAttribute( 'data-srcset' ) ||
						( shaped ? attribute : '' ) ||
						image.closest( 'picture' )?.querySelector( 'source[srcset]' )?.getAttribute( 'srcset' ) ||
						'';
					next = firstHttpUrl( srcset );
				}
				if ( ! next || next === attribute ) continue;
				restoredImages.push( { image, previous: image.getAttribute( 'src' ) } );
				image.setAttribute( 'src', next );
			}
			// Lazy background loaders (vanilla-lazyload, lazysizes) keep the real image
			// in data-bg and paint it only once the element enters the viewport. An
			// element the capture never scrolled in, or that still paints the 1x1
			// placeholder, would otherwise serialize as an empty box.
			const backgrounds = Array.from( document.body?.querySelectorAll< HTMLElement >( '[data-bg]' ) ?? [] );
			// Snapshot loaded peers before restoring anything: a synthesized state must
			// never become evidence for another element's loader contract.
			const loadedBackgrounds = backgrounds.filter( ( element ) => {
				const painted = getComputedStyle( element ).backgroundImage;
				return element.getAttribute( 'data-ll-status' ) === 'loaded' && painted !== 'none' && ! painted.includes( 'data:image/gif' );
			} ).map( ( element ) => ( { classes: Array.from( element.classList ), status: element.getAttribute( 'data-ll-status' )! } ) );
			for ( const element of backgrounds ) {
				const declared = ( element.getAttribute( 'data-bg' ) ?? '' ).trim().replace( /^url\(\s*(["']?)(.*?)\1\s*\)$/i, '$2' );
				const next = durableImageUrl( declared );
				if ( ! next ) continue;
				const painted = getComputedStyle( element ).backgroundImage;
				if ( painted !== 'none' && ! /^url\(\s*["']?data:image\/gif;(?:[^,]*;)?base64,R0lGODlhAQAB/i.test( painted ) ) continue;
				restoredBackgrounds.push( { element, previous: element.getAttribute( 'style' ), classes: element.getAttribute( 'class' ), status: element.getAttribute( 'data-ll-status' ) } );
				element.style.setProperty( 'background-image', `url("${ next.replace( /"/g, '%22' ) }")` );
				// A loader's hidden pre-load state (e.g. `.lazy{opacity:0}`) would hide
				// the restored image. Adopt only those loaded-peer tokens that measurably
				// reveal this element without changing its box, so peer component classes
				// never leak in, whichever stylesheet (or origin) holds the reveal rule.
				const hidden = ( style: CSSStyleDeclaration ) => style.visibility === 'hidden' || Number.parseFloat( style.opacity ) === 0;
				if ( ! hidden( getComputedStyle( element ) ) ) continue;
				const peer = loadedBackgrounds.find( ( candidate ) => candidate.classes.some( ( token ) => element.classList.contains( token ) ) );
				if ( ! peer ) continue;
				const box = ( style: CSSStyleDeclaration ) => [ style.display, style.position, style.width, style.height, style.top, style.left, style.transform ].join( '|' );
				const before = box( getComputedStyle( element ) );
				// Measure end states: a reveal transition would still read its start value.
				const transition = [ element.style.getPropertyValue( 'transition' ), element.style.getPropertyPriority( 'transition' ) ] as const;
				element.style.setProperty( 'transition', 'none', 'important' );
				for ( const token of peer.classes.filter( ( candidate ) => ! element.classList.contains( candidate ) ) ) {
					element.classList.add( token );
					const style = getComputedStyle( element );
					if ( hidden( style ) || box( style ) !== before ) element.classList.remove( token );
				}
				if ( transition[ 0 ] ) element.style.setProperty( 'transition', transition[ 0 ], transition[ 1 ] );
				else element.style.removeProperty( 'transition' );
				if ( element.getAttribute( 'class' ) !== restoredBackgrounds[ restoredBackgrounds.length - 1 ].classes ) {
					element.setAttribute( 'data-ll-status', peer.status );
				}
			}
			// outerHTML concatenates adjacent Text nodes. Re-parsing that string
			// coalesces source shaping runs, which can change subpixel advances and
			// painted glyphs even when the text and element boxes are identical.
			// Empty comments preserve those parser boundaries without adding an
			// element, a character, or CSS. Raw-text/RCDATA elements cannot use them.
			const textBoundaries: Comment[] = [];
			for ( const element of document.querySelectorAll( '*' ) ) {
				if ( /^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)$/i.test( element.localName ) ) continue;
				for ( const node of Array.from( element.childNodes ) ) {
					if ( node.nodeType !== Node.TEXT_NODE || node.nextSibling?.nodeType !== Node.TEXT_NODE ) continue;
					const boundary = document.createComment( '' );
					element.insertBefore( boundary, node.nextSibling );
					textBoundaries.push( boundary );
				}
			}
			// Scripts can build flow content inside <p>, but the HTML parser closes
			// the paragraph at these tags. Use parser-stable spans for serialization
			// only, preserving attributes, child identities and the observed display.
			const repairParagraphDescendants = () => {
				const closingTags = new Set( 'address article aside blockquote details dialog div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section table ul'.split( ' ' ) );
				const candidates = Array.from( document.querySelectorAll( 'p *' ) )
					.filter( ( element ) => element.namespaceURI === 'http://www.w3.org/1999/xhtml' && closingTags.has( element.localName ) )
					.map( ( element ) => ( { element, display: getComputedStyle( element ).display } ) );
				const replacements: Array< { element: Element; span: HTMLSpanElement } > = [];
				for ( const { element, display } of candidates ) {
					const span = document.createElement( 'span' );
					for ( const attribute of Array.from( element.attributes ) ) span.setAttribute( attribute.name, attribute.value );
					span.append( ...Array.from( element.childNodes ) );
					element.replaceWith( span );
					if ( getComputedStyle( span ).display !== display ) span.style.setProperty( 'display', display, 'important' );
					replacements.push( { element, span } );
				}
				return () => {
					for ( const { element, span } of replacements.reverse() ) {
						element.append( ...Array.from( span.childNodes ) );
						span.replaceWith( element );
					}
				};
			};
			const restoreParagraphDescendants = repairParagraphDescendants();
			try {
				// Keep authored reset defaults in markup and observed properties in a
				// typed inert contract. Neither fact may be substituted for the other.
				const observeControl = new Function( 'return (' + observeControlSource + ')' )() as typeof observeNativeControlState;
				const snapshot = document.documentElement.cloneNode( true ) as HTMLElement;
				const controls = document.documentElement.querySelectorAll( 'input, textarea, select' );
				const copies = snapshot.querySelectorAll( 'input, textarea, select' );
				controls.forEach( ( control, index ) => {
					copies[ index ]!.setAttribute( controlAttribute, JSON.stringify( observeControl( control ) ) );
				} );
				const portMaps = new Function( 'return (' + portMapsSource + ')' )() as typeof portRenderedGoogleMaps;
				const clean = new Function( 'return (' + scaffoldingSource + ')' )() as typeof cleanPortableScaffolding;
				const portShadow = new Function( 'return (' + shadowSource + ')' )() as typeof portStaticShadowContent;
				const flattenShadow = portShadow( document, snapshot );
				const findings = clean( document, snapshot );
				portMaps( document, snapshot, iframeEvidenceAttributes, new Function( 'return (' + mapHostSource + ')' )() as typeof isGoogleMapHost );
				flattenShadow();
				// The copy is always serialized as a standards-mode document. A quirks-mode
				// source laid out lines and tables under different rules, so record the
				// mode the source rendered in for the transform to honor.
				if ( document.compatMode === 'BackCompat' ) snapshot.setAttribute( 'data-blocks-engine-capture-compat-mode', 'BackCompat' );
				// Source cleanup hides a match the source runtime re-rendered after
				// its removal, rather than fighting the runtime. Leave it out of the
				// copy. This runs last: the walks above pair document and snapshot
				// nodes by position.
				for ( const hidden of snapshot.querySelectorAll( '[data-blocks-engine-capture-cleanup-hidden]' ) ) hidden.remove();
				return { html: `<!DOCTYPE html>${ snapshot.outerHTML }`, findings, omittedStyles: ( window as typeof window & { __dlaOmittedRuntimeStyles?: Array<{ bytes: number; rules: number }> } ).__dlaOmittedRuntimeStyles ?? [] };
			} finally {
				restoreParagraphDescendants();
				for ( const boundary of textBoundaries ) boundary.remove();
				for ( const { image, previous } of restoredImages.reverse() ) {
					if ( previous === null ) image.removeAttribute( 'src' );
					else image.setAttribute( 'src', previous );
				}
				for ( const { element, previous, classes, status } of restoredBackgrounds.reverse() ) {
					if ( previous === null ) element.removeAttribute( 'style' );
					else element.setAttribute( 'style', previous );
					if ( classes === null ) element.removeAttribute( 'class' );
					else element.setAttribute( 'class', classes );
					if ( status === null ) element.removeAttribute( 'data-ll-status' );
					else element.setAttribute( 'data-ll-status', status );
				}
				for ( const { image, previous, priority } of restoredAspectRatios.reverse() ) {
					if ( previous === '' ) image.style.removeProperty( 'aspect-ratio' );
					else image.style.setProperty( 'aspect-ratio', previous, priority );
				}
				for ( const { element, parent, next } of detached.reverse() ) parent.insertBefore( element, next );
			}
		}, { observeControlSource: observeNativeControlState.toString(), controlAttribute: NATIVE_CONTROL_STATE_ATTRIBUTE, portMapsSource: portRenderedGoogleMaps.toString(), mapHostSource: isGoogleMapHost.toString(), iframeEvidenceAttributes, scaffoldingSource: cleanPortableScaffolding.toString(), shadowSource: portStaticShadowContent.toString(), parseSrcsetSource: parseSrcset.toString(), srcsetShapedSource: isSrcsetShaped.toString() } );
		diagnostics?.push( ...result.findings );
		for ( const omitted of result.omittedStyles ?? [] ) diagnostics?.push( { code: 'runtime_stylesheet_omitted', reason: `Omitted unmatched runtime stylesheet (${ omitted.bytes } bytes, ${ omitted.rules } rules)` } );
		return wireNativeControlState( result.html );
	} finally {
		await page.evaluate( ( evidenceAttributes ) => {
			for ( const frame of document.querySelectorAll( 'iframe' ) ) {
				for ( const attribute of Object.values( evidenceAttributes ) ) {
					frame.removeAttribute( attribute );
				}
			}
		}, iframeEvidenceAttributes );
	}
}

export function geometryCandidateIsSafe( candidate: {
	tag: string;
	attributes: Record< string, string >;
	runtimeSources: string[];
} ): boolean {
	const tag = candidate.tag.toLowerCase();
	if ( /^(?:article|aside|footer|form|header|main|nav|section)$/.test( tag ) ) return false;
	const identity = `${ candidate.attributes.class ?? '' } ${ candidate.attributes.id ?? '' }`;
	if (
		/(?:^|[^a-z0-9])(?:band|carousel|loop|marquee|mask|rail|scroller|slider|ticker|track|viewport)(?:[^a-z0-9]|$)/i.test(
			identity
		)
	)
		return false;
	for ( const [ name, value ] of Object.entries( candidate.attributes ) ) {
		const attribute = name.toLowerCase();
		if (
			/^on/.test( attribute ) ||
			/^aria-/.test( attribute ) ||
			/^(?:id|role|tabindex|contenteditable|action|method|name|for|href|type|disabled)$/.test(
				attribute
			)
		)
			return false;
		const references =
			attribute === 'id'
				? [
						`#${ value }`,
						`getElementById(${ value }`,
						`getElementById('${ value }`,
						`getElementById("${ value }`,
				  ]
				: attribute === 'class'
				? value
						.split( /\s+/ )
						.filter( Boolean )
						.map( ( className ) => `.${ className }` )
				: [ `[${ attribute }`, `${ attribute }=` ];
		if (
			references.some( ( reference ) =>
				candidate.runtimeSources.some( ( source ) => source.includes( reference ) )
			)
		)
			return false;
	}
	return true;
}

async function captureLayoutGeometry( page: Page, viewport: Viewport ): Promise< GeometryCapture > {
	return page.evaluate(
		async ( { width, viewportId } ) => {
			const candidateIsSafe = ( candidate: {
				tag: string;
				attributes: Record< string, string >;
				runtimeSources: string[];
			} ) => {
				const tag = candidate.tag.toLowerCase();
				if ( /^(?:article|aside|footer|form|header|main|nav|section)$/.test( tag ) ) return false;
				const identity = `${ candidate.attributes.class ?? '' } ${ candidate.attributes.id ?? '' }`;
				if (
					/(?:^|[^a-z0-9])(?:band|carousel|loop|marquee|mask|rail|scroller|slider|ticker|track|viewport)(?:[^a-z0-9]|$)/i.test(
						identity
					)
				)
					return false;
				for ( const [ name, value ] of Object.entries( candidate.attributes ) ) {
					const attribute = name.toLowerCase();
					if (
						/^on/.test( attribute ) ||
						/^aria-/.test( attribute ) ||
						/^(?:id|role|tabindex|contenteditable|action|method|name|for|href|type|disabled)$/.test(
							attribute
						)
					)
						return false;
					const references =
						attribute === 'id'
							? [
									`#${ value }`,
									`getElementById(${ value }`,
									`getElementById('${ value }`,
									`getElementById("${ value }`,
							  ]
							: attribute === 'class'
							? value
									.split( /\s+/ )
									.filter( Boolean )
									.map( ( className ) => `.${ className }` )
							: [ `[${ attribute }`, `${ attribute }=` ];
					if (
						references.some( ( reference ) =>
							candidate.runtimeSources.some( ( source ) => source.includes( reference ) )
						)
					)
						return false;
				}
				return true;
			};
			const markIdentity = ( node: Element, identity: string ) => {
				const identities = node.getAttribute( 'data-blocks-engine-capture-geometry-id' )?.split( /\s+/ ) ?? [];
				if ( ! identities.includes( identity ) ) {
					identities.push( identity );
					node.setAttribute( 'data-blocks-engine-capture-geometry-id', identities.join( ' ' ) );
				}
			};
			const omissions: Record< string, number > = {};
			const omit = ( code: string ) => ( omissions[ code ] = ( omissions[ code ] ?? 0 ) + 1 );
			const box = ( node: Element ) => {
				const rect = node.getBoundingClientRect();
				return {
					x: Math.round( rect.x * 1000 ) / 1000,
					y: Math.round( rect.y * 1000 ) / 1000,
					width: Math.round( rect.width * 1000 ) / 1000,
					height: Math.round( rect.height * 1000 ) / 1000,
				};
			};
			const equal = ( left: ReturnType< typeof box >, right: ReturnType< typeof box > ) =>
				[ 'x', 'y', 'width', 'height' ].every(
					( key ) =>
						Math.abs( left[ key as keyof typeof left ] - right[ key as keyof typeof right ] ) <= 1
				);
			const runtimeSources = Array.from( document.scripts, ( script ) => script.textContent ?? '' );
			const observations: GeometryCapture[ 'observations' ] = [];
			for ( const wrapper of Array.from(
				document.body.querySelectorAll( 'div,section,article,main' )
			) ) {
				if ( observations.length >= 64 ) {
					omit( 'candidate_limit' );
					break;
				}
				const target = wrapper.firstElementChild;
				if (
					! target ||
					wrapper.children.length !== 1 ||
					Array.from( wrapper.childNodes ).some(
						( node ) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
					) ||
					[ ...wrapper.querySelectorAll( '*' ), wrapper ].some( ( node ) =>
						[ ...node.attributes ].some( ( attribute ) => /^on/i.test( attribute.name ) )
					)
				) {
					omit( 'runtime_or_semantics_unproven' );
					continue;
				}
				if (
					! candidateIsSafe( {
						tag: wrapper.tagName,
						attributes: Object.fromEntries(
							Array.from( wrapper.attributes, ( attribute ) => [ attribute.name, attribute.value ] )
						),
						runtimeSources,
					} )
				) {
					omit( 'runtime_or_semantics_unproven' );
					continue;
				}
				const wrapperStyle = getComputedStyle( wrapper );
				const targetStyle = getComputedStyle( target );
				if (
					! /^(block|flex|grid)$/.test( targetStyle.display ) ||
					wrapperStyle.display !== targetStyle.display
				) {
					omit( 'display_unproven' );
					continue;
				}
				const sourceWrapper = box( wrapper );
				const sourceTarget = box( target );
				const wrapperHtml = wrapper as HTMLElement;
				const priorDisplay = wrapperHtml.style.display;
				wrapperHtml.style.display = 'contents';
				const simulated = box( target );
				wrapperHtml.style.display = priorDisplay;
				if ( ! equal( sourceWrapper, sourceTarget ) || ! equal( sourceTarget, simulated ) ) {
					omit( 'geometry_unproven' );
					continue;
				}
				// Desktop and mobile DOMs can be composed into one portable document.
				// Scope IDs to their captured viewport so both bindings remain unique.
				const wrapperIdentity = `${ viewportId }-wrapper-${ observations.length }`;
				const targetIdentity = `${ viewportId }-target-${ observations.length }`;
				markIdentity( wrapper, wrapperIdentity );
				markIdentity( target, targetIdentity );
				observations.push( {
					wrapperIdentity,
					targetIdentity,
					viewport: width,
					state: 'default',
					wrapper: sourceWrapper,
					target: sourceTarget,
					simulated,
					facts: {
						display: targetStyle.display,
						position: targetStyle.position,
						visibility: targetStyle.visibility,
						childCount: wrapper.children.length,
					},
					invariants: { runtime: true, semantics: true },
				} );
			}
			await new Promise< void >( ( resolve ) =>
				requestAnimationFrame( () => requestAnimationFrame( () => resolve() ) )
			);
			return { schema: 'blocks-engine-capture/layout-geometry-capture/v1', observations, omissions };
		},
		{ width: viewport.width, viewportId: viewport.id }
	);
}

async function capturePerViewport( args: CapturePerViewportArgs ): Promise< void > {
	const {
		page,
		viewport,
		plan,
		url,
		slug,
		settleMs,
		screenshotTimeoutMs,
		evaluateTimeoutMs,
		failures,
		entry,
		aggregator,
		shouldAnalyze,
		outputDir,
		responsiveImages,
		mobileHeights,
		resourceStore,
		publicUrlsOnly,
	} = args;
	const now = () => new Date().toISOString();
	/** Records one stage failure for this route and viewport. */
	const fail = ( stage: FailureEntry['stage'], error: unknown, attempt = 1 ): void => {
		failures.push( { url, viewport: viewport.id, stage, error: error instanceof Error ? error.message : String( error ), timestamp: now(), attempt } );
	};
	const isDesktop = viewport.id === 'desktop';
	const isMobile = viewport.id === 'mobile';
	// The adapter's rewrite of platform-owned identifiers applies to every stored
	// HTML artifact alike, so page HTML and the captured dialogs that refer to it
	// keep naming the same elements.
	const canonicalize = ( html: string ): string => ( args.canonicalizeHtml ? args.canonicalizeHtml( html ) : html );
	// Dialog markup holds only part of the page, so it is named after the raw
	// document it was captured from and keeps meeting the page CSS.
	let rawDocument: string | undefined;
	const canonicalizeInteractions = < T, >( report: T ): T => {
		const canonicalizeHtml = args.canonicalizeHtml;
		return canonicalizeHtml ? canonicalizeInteractionReport( report, html => canonicalizeHtml( html, rawDocument ) ) : report;
	};

	resourceStore.observe( page );
	const sourceCrashes: string[] = [];
	const sourceRuntime = args.observeSource ? await watchSourceRuntimeErrors( page ) : undefined;
	if ( args.observeSource ) page.on( 'crash', () => sourceCrashes.push( 'source renderer crashed' ) );
	/** Blocking source errors so far; subframe errors become capture diagnostics. */
	const sourceErrors = (): string[] => {
		const settled = sourceRuntime?.settle();
		for ( const reason of settled?.diagnostics ?? [] ) {
			if ( ! args.diagnostics?.some( item => item.code === SOURCE_SUBFRAME_RUNTIME_ERROR && item.reason === reason ) ) args.diagnostics?.push( { code: SOURCE_SUBFRAME_RUNTIME_ERROR, reason } );
		}
		return [ ...( settled?.reasons ?? [] ), ...sourceCrashes ];
	};
	await installResourceReplay( page, resourceStore, publicUrlsOnly );

	const sourceLoad = await loadSourceBaseline( {
		page, url, viewport, outputDir, entry, publicUrlsOnly, sourceErrors, fail, settleMs, evaluateTimeoutMs,
		diagnostics: args.diagnostics,
		phases: args.phases,
		routeScope: args.routeScope,
		browserProfile: args.browserProfile,
		serverLinks: args.serverLinks,
		rendererCrashed: args.rendererCrashed,
		cleanupPolicy: args.cleanupPolicy,
		resolveClientRedirect: args.resolveClientRedirect,
		canonicalQueryAlias: args.canonicalQueryAlias,
		observeSource: args.observeSource,
		recoverIncompleteDocument: args.recoverIncompleteDocument,
		consentViewports: args.consentViewports,
		learnFluid: args.learnFluid,
		removeSelectors: args.removeSelectors,
		prepareCapture: args.prepareCapture,
	} );
	if ( ! sourceLoad ) return;
	const { serverHtml, navigationUrl, sourcePolicy, releaseBaselineNavigation } = sourceLoad;

	// Install once, inactive outside the scoped interaction drives below.
	await installReadOnlyProbeGuard( page, diagnostic => args.diagnostics?.push( diagnostic ) );

	// --- responsive image map (mobile only) -----------------------------------
	// Some platforms swap each image for a viewport-specific crop at runtime.
	// Recording {media id → variant URL} lets the export serve that crop via
	// <picture> with no JavaScript. Which URLs are variants is adapter
	// knowledge (seam 2), so the capture path never learns a CDN's shape.
	// Best-effort: a read failure must not fail the screenshot.
	if ( isMobile && args.collectResponsiveImages ) {
		try {
			Object.assign(
				responsiveImages,
				await args.collectResponsiveImages( page, { url, viewport: 'mobile' } )
			);
		} catch {
			/* best-effort — never block capture on the responsive-image probe */
		}
	}

	// Sweeps and adapter preparation may leave a scrolled pose. Initial evidence
	// must describe the same settled top state before geometry or components.
	try {
		await withEvaluateTimeout( normalizeCaptureState( page ), evaluateTimeoutMs );
		await withEvaluateTimeout( normalizeGeneratedIds( page ), evaluateTimeoutMs );
	} catch ( error ) {
		fail( 'evaluate', `source baseline reset unproven: ${ String( error ) }` );
		return;
	}

	// Best-effort: a page that does not answer keeps whatever pose it reached.
	const settleScriptEntrances = async () => {
		const outcome = await withEvaluateTimeout( settleScriptMotion( page ), SCRIPT_MOTION_BUDGET_MS + evaluateTimeoutMs ).catch( () => undefined );
		if ( outcome?.swept ) process.stderr.write( `[timing] script-motion ${ JSON.stringify( { url, viewport: viewport.id, ...outcome } ) }\n` );
	};

	// --- html (desktop only) --------------------------------------------------
	if ( plan.captureGeometry ) {
		args.phases?.enter( 'layout-geometry' );
		let capture: GeometryCapture;
		try {
			capture = await captureLayoutGeometry( page, viewport );
		} catch {
			capture = {
				schema: 'blocks-engine-capture/layout-geometry-capture/v1',
				observations: [],
				omissions: { capture_failed: 1 },
			};
		}
		mkdirSync( dirname( plan.paths.geometry ), { recursive: true } );
		writeFileSync( plan.paths.geometry, `${ JSON.stringify( capture, null, 2 ) }\n` );
	}

	// Measure while the source runtime still owns layout. Later observation,
	// fluid learning and serialization hooks may freeze timers or change DOM
	// geometry; their root classes are not evidence of source width behavior.
	let rootClassWidths: RootClassContract[] = [];
	if ( isDesktop && plan.captureHtml ) {
		args.phases?.enter( 'root-class' );
		try {
			const startedAt = Date.now();
			const onUnproven = ( reason: string ) => args.diagnostics?.push( {
				code: 'root_class_source_probe_unproven', reason: `${ url }: ${ reason }`,
			} );
			const initial = await withEvaluateTimeout( page.evaluate( () => ( {
				width: innerWidth,
				html: [ ...document.documentElement.classList ].sort(),
				body: [ ...document.body.classList ].sort(),
			} ) ), evaluateTimeoutMs );
			// Only the server document separates authored root classes from
			// runtime-added ones; without it, sample this route and prove nothing.
			const ladder = () => sampleRootClassLadder( page, undefined, onUnproven );
			const result = serverHtml
				? await args.rootClassEvidence.contracts( url, serverHtml, initial, ladder )
				: { contracts: rootClassContracts( await ladder() ?? [] ), inheritedFrom: undefined };
			rootClassWidths = result.contracts;
			process.stderr.write( `[timing] root-class ${ JSON.stringify( { url, durationMs: Date.now() - startedAt, inheritedFrom: result.inheritedFrom } ) }\n` );
		} catch ( error ) {
			// A bounded probe cannot safely hand a nonresponding renderer to
			// subsequent DOM reads. Lose this profile rather than hang capture.
			fail( 'evaluate', `root class source probe unproven: evaluate timeout or failure: ${ String( error ) }` );
			return;
		}
	}

	// The root-class ladder resized the page; a runtime that remounts on resize
	// replayed its script entrances. Read the initial document at rest.
	args.phases?.enter( 'script-motion' );
	await settleScriptEntrances();
	args.phases?.enter( 'baseline-snapshot' );
	// Initial component states are immutable evidence, read before exploration.
	args.diagnostics?.push( ...await removeRuntimeWidgets( page ) );
	args.diagnostics?.push( ...await restoreRuntimeEmoji( page ) );
	if ( args.beforeSerialize ) await args.beforeSerialize( page, { url, viewport: viewport.id, serverHtml } ).catch( () => undefined );
	const snapshot = await snapshotComponents( page ).catch( () => undefined );
	const componentBaseline: ComponentBaseline = snapshot && Array.isArray( snapshot.components ) ? snapshot : { components: [], controls: [] };
	await markGalleryRoots( page ).catch( () => undefined );
	// Scripted links are numbered in the serialized document; their destinations
	// are observed after the baseline, with the other interaction probes.
	const scriptedLinkSignatures = plan.captureHtml || plan.captureMobileHtml ? await stampScriptedLinkCandidates( page, evaluateTimeoutMs ) : [];
	await markInitialDocument( page );
	// Probes above resized the page; serialize source sheets as loaded at this width.
	await restoreLoadTimeSheets( page ).catch( () => 0 );
	const initialDocument = await capturePageHtml( page, args.diagnostics, serverHtml );
	if ( await args.absentDocument?.( initialDocument ) ) {
		fail( 'goto', 'HTTP 404 (render matches absent nonce sibling)' );
		return;
	}
	// The serialized head is the initial one, so it is named by the title the
	// browser reported for it, before exploration could retitle the page.
	const initialTitle = await page.evaluate( () => document.title ).catch( () => undefined );

	// Seam 1b: replace runtime-computed pixel geometry with the relationship the
	// source actually obeys, learned by resizing while its runtime still runs.
	// Must happen after removals (so stripped chrome is never modelled) and
	// before serialization (so the learned CSS is what gets written).
	args.phases?.enter( 'observe-source' );
	await args.observeSource?.( page, url, viewport.id, sourceErrors(), args.browserProfile, viewport );
	if ( args.rendererCrashed() ) return;
	// A failed native timeline probe loses that block of evidence,
	// not the page: record the loss and keep serializing once the page answers
	// again at its capture viewport and at-top pose. A page that no longer
	// answers (a stalled main thread) cannot be serialized, so the route fails.
	const captureViewport = page.viewportSize();
	const loseBlock = async ( stage: FailureEntry['stage'], loss: Omit< NonNullable< ManifestEntry['blockLosses'] >[ number ], 'unit' | 'profile' > ): Promise< boolean > => {
		try {
			if ( ! ( await pageResponds( page, evaluateTimeoutMs ) ) ) throw new Error( `no answer to an evaluate within ${ evaluateTimeoutMs }ms` );
			if ( captureViewport ) await withEvaluateTimeout( page.setViewportSize( captureViewport ), evaluateTimeoutMs );
			await withEvaluateTimeout( page.evaluate( () => window.scrollTo( { top: 0, left: 0, behavior: 'instant' } ) ), evaluateTimeoutMs );
		} catch ( error ) {
			fail( stage, `${ loss.reason }; the page did not return to its capture pose: ${ error instanceof Error ? error.message : String( error ) }` );
			return false;
		}
		( entry.blockLosses ??= [] ).push( { ...loss, unit: 'block', profile: viewport.id } );
		return true;
	};
	if ( plan.captureHtml || plan.captureMobileHtml ) {
		let unproven: string | undefined;
		try {
			args.phases?.enter( 'native-timelines' );
			const native = await captureNativeViewTimelines( page, viewport.id, evaluateTimeoutMs );
			if ( native.samples.length || native.status === 'unproven' ) {
				const path = join( outputDir, 'native-view-timelines', viewport.id, `${ slug }.json` );
				mkdirSync( dirname( path ), { recursive: true } );
				writeFileSync( path, JSON.stringify( native, null, 2 ) );
				entry.nativeViewTimelines ??= {};
				entry.nativeViewTimelines[ viewport.id ] = { path: `native-view-timelines/${ viewport.id }/${ slug }.json`, preserved: native.preserved, losses: native.losses, status: native.status, failures: native.failures };
			}
			if ( native.status === 'unproven' ) unproven = `native timeline source capture unproven: ${ native.failures.join( '; ' ) }`;
		} catch ( error ) {
			unproven = `native timeline capture failed: ${ String( error ) }`;
		}
		// Unproven timelines carry no effects into the page; the evidence record above keeps the loss.
		if ( unproven !== undefined && ! ( await loseBlock( 'evaluate', { code: 'native_timeline_unproven', reason: unproven, severity: 'warning' } ) ) ) return;
	}

	if ( ( plan.captureHtml || plan.captureMobileHtml ) && args.learnFluid && viewport.learnFluid !== false ) {
		args.phases?.enter( 'fluid' );
		// Sweep classes before learning: resize-driven ancestor state changes can
		// suspend fluid authority and remove segment markers. Learn from the
		// settled post-sweep state, with no class-probe resizes left to undo it.
		const classes = isDesktop ? await captureViewportClassStates( page, {
			...( args.fluidWidths ? { widths: args.fluidWidths } : {} ),
			settleMs: Math.max( args.settleMs, 800 ),
			...( args.classBreakpoints ? { breakpoints: args.classBreakpoints } : {} ),
			...( args.classMemo ? { memo: args.classMemo } : {} ),
		} ).catch( () => undefined ) : undefined;
		try {
			await args.beforeFluid?.( page, { url, viewport: viewport.id, serverHtml } ).catch( () => {
				/* best-effort — the sweep learns whatever the hook left in place */
			} );
			const learned = await learnAndApplyFluidGeometry( page, {
				// The middle layout's learned rules name its own geometry ids, never the phone document's.
				document: isDesktop ? 'desktop' : viewport.id === MIDDLE_PROFILE_ID ? 'middle' : 'mobile',
				...( args.fluidWidths ? { widths: args.fluidWidths } : {} ),
				settleMs: Math.max( args.settleMs, 800 ),
				...( args.fluidMemo ? { memo: args.fluidMemo } : {} ),
			} );
			entry[ isDesktop ? 'fluid' : 'fluidMobile' ] = {
				applied: learned.applied,
				unmodelled: learned.unmodelled,
				breakpoints: learned.breakpoints,
				canvasFloor: learned.canvasFloor,
				byKind: learned.byKind,
				sampledWidths: learned.sampledWidths,
			};
		} catch ( error ) {
			// Never fail a capture over the optimization: a frozen copy still
			// beats no copy, and the diagnostics record that it stayed frozen.
			entry[ isDesktop ? 'fluid' : 'fluidMobile' ] = {
				applied: 0, unmodelled: 0, breakpoints: [], canvasFloor: null, byKind: {},
				diagnostic: `fluid learning failed: ${ error instanceof Error ? error.message : String( error ) }`,
			};
		}
		if ( classes && classes.aliased > 0 && entry.fluid ) entry.fluid.byKind[ 'viewport-class' ] = classes.aliased;
	}
	if ( args.rendererCrashed() ) return;
	if ( plan.captureHtml || plan.captureMobileHtml ) {
		await resourceStore.captureSelectedSrcsets( page ).catch( () => undefined );
	}

	// Remove attributed non-content islands before interaction evidence and HTML.
	args.diagnostics?.push( ...await removeRuntimeWidgets( page ) );
	// Restore runtime emoji replacement images to their authored text (#954),
	// so screenshots, interaction evidence and HTML all record text where the
	// source's emoji script had swapped in Twemoji images.
	args.diagnostics?.push( ...await restoreRuntimeEmoji( page ) );
	args.phases?.enter( 'before-serialize' );
	if ( args.rendererCrashed() ) return;
	// Width sweeps resize the page too. The screenshot and every serialization
	// below read the entrances' rest pose, never a replay still in flight.
	await settleScriptEntrances();
	if ( args.rendererCrashed() ) return;

	// Capture only after every operation that can change the live DOM, then
	// serialize immediately below. This keeps runtime-driven components in the
	// same state across the visual reference and its HTML transaction.
	if ( plan.captureFullpage ) {
		try {
			args.phases?.enter( 'screenshot' );
			const buf = await withScreenshotTimeout(
				page.screenshot( { fullPage: true, type: 'png' } ),
				screenshotTimeoutMs
			);
			mkdirSync( dirname( plan.paths.fullpage ), { recursive: true } );
			writeFileSync( plan.paths.fullpage, buf );
			const rel = `screenshots/${ viewport.id }/${ slug }.png`;
			if ( isDesktop ) entry.desktop = rel;
			else if ( isMobile ) entry.mobile = rel;
		} catch ( err ) {
			const msg = err instanceof Error ? err.message : String( err );
			fail( /screenshot timeout/.test( msg ) ? 'screenshot-timeout' : 'screenshot-fullpage', msg );
		}
	}

	if ( args.rendererCrashed() ) return;
	// Record the rendered colour of single-colour icon glyphs as
	// `data-blocks-engine-capture-glyph-color`, so compile never has to decode image bytes (#769).
	// Bounded; a miss loses only that evidence.
	if ( plan.captureHtml || plan.captureMobileHtml ) {
		args.phases?.enter( 'glyph-colors' );
		await recordGlyphColors( page, {}, args.glyphColors ).catch( () => undefined );
		if ( args.rendererCrashed() ) return;
	}
	// The cleanup observer may have exhausted its budget before the page
	// re-rendered a credit or ad; the saved document must be swept. A source
	// that re-initialized its document after install has no state left to
	// sweep — the policy lets the sweep reinstall on the fresh document.
	// A frozen document (the static mobile carry) also has its scripts stripped.
	const serializeDocument = async ( frozen: boolean ): Promise< { html: string; documentUrl: { url: string; baseUrl: string } } > => {
		args.phases?.enter( 'serialize' );
		args.diagnostics?.push( ...await removeRuntimeWidgets( page ) );
		await sweepSourceCleanup( page, sourcePolicy );
		await preserveStreamedVideoPosters( page, resourceStore, url ).catch( () => undefined );
		// Source width changes can rerender emoji replacement images (#954).
		args.diagnostics?.push( ...await restoreRuntimeEmoji( page ) );
		const learned = await capturePageHtml( page, args.diagnostics );
		const baseUrl = await page.evaluate( () => document.baseURI );
		const linkedSheet = ( href: string ) => {
			const absolute = new URL( href, baseUrl ).href;
			const resource = resourceStore.getReplayableResponse( absolute, 'stylesheet' );
			return resource ? { css: readFileSync( resource.path, 'utf8' ), url: absolute } : undefined;
		};
		const projected = projectRootClassContracts( projectInitialDocument( initialDocument, learned, linkedSheet ), rootClassWidths, linkedSheet );
		const captured = typeof initialTitle === 'string' ? withDocumentTitle( projected, initialTitle ) : projected;
		rawDocument = frozen ? sanitizeFrozenHtml( captured ) : captured;
		const html = canonicalize( rawDocument );
		const documentUrl = await page.evaluate( () => ( { url: document.URL, baseUrl: document.baseURI } ) );
		await resourceStore.captureDomDependencies( html, documentUrl.baseUrl );
		return { html, documentUrl };
	};
	if ( plan.captureHtml ) {
		try {
			const { html, documentUrl } = await serializeDocument( false );
			const shellSelector = matchClientErrorShell( html, args.clientErrorShellSelectors );
			// Refuse to persist a capture whose page navigated away from the route we
			// were asked to capture: every DOM-mutating step above (lazy-load probing,
			// disclosure hydration, dialog probing…) runs on a live, script-controlled
			// page, and this is the first point the actual document is compared against
			// the intended one. A drifted document is a real, successfully-rendered
			// page — just the WRONG one — so there is no corrupted markup to detect the
			// way isStackingArtifact does; only comparing identities catches it.
			// Recovering (re-navigating and re-running the capture) is not attempted:
			// the fullpage screenshot above already ran on the drifted page too, so a
			// re-fetched HTML would still be paired with the wrong screenshot. Refusing
			// and recording it — the same discipline as isStackingArtifact below — keeps
			// the receipt honest instead of shipping a mismatched pair silently.
			const capturedUrl = page.url();
			if ( sourceLoad.externalNavigation ) {
				// A blocked external request leaves the loader DOM intact, not a public
				// route; the failure was recorded when the lock blocked it.
			} else if ( isRouteDrift( capturedUrl, navigationUrl ) ) {
				fail( 'content', `route drift: captured ${ capturedUrl } while attempting to capture ${ url } (a control navigated the page mid-capture); HTML not persisted` );
			} else if ( isStackingArtifact( html ) ) {
				fail( 'content', `nested document capture (${ countBodyTags( html ) } <body> in one page); HTML not persisted` );
			} else if ( shellSelector !== undefined ) {
				// The source's client runtime crashed under capture and replaced the
				// document with its framework error shell. It is never page content:
				// refuse it and let the route fail by name (route_capture_failed).
				fail( 'content', `${ CLIENT_ERROR_SHELL_FAILURE }: the page's client runtime replaced the document with its framework error shell (matched ${ shellSelector }); HTML not persisted` );
			} else {
				mkdirSync( dirname( plan.paths.html ), { recursive: true } );
				writeFileSync( plan.paths.html, html );
				args.glyphColors?.defer( plan.paths.html, html );
				entry.html = relative( outputDir, plan.paths.html );
				entry.documents = { ...entry.documents, [ viewport.id ]: documentUrl };
			}
		} catch ( err ) {
			fail( 'content', err );
		}
	}
	if ( args.rendererCrashed() ) return;

	// --- mobile-DOM carry (mobile only) ---------------------------------------
	// On the mobile pass, the mobile UA + isMobile emulation make JS builders like
	// Wix serve their SEPARATE ~320px mobile DOM (classic/adaptive sites; desktop-DOM
	// sites are identical, harmless). Persist that full document (scripts stripped, so
	// it renders statically) + its height to html-mobile/. The alt reconstruct carries
	// it in a viewport-isolated iframe to reproduce the mobile layout the desktop DOM
	// can't reflow to. Best-effort: a miss leaves the page desktop-only.
	if ( isMobile && plan.captureMobileHtml ) {
		try {
			const { html: mhtml, documentUrl } = await serializeDocument( true );
			// Same route-identity guard as the desktop HTML write above — best-effort
			// here too (this carry already silently skips on any other failure), so a
			// drifted mobile capture just leaves the page desktop-only rather than
			// recording a failure of its own.
			if ( ! sourceLoad.externalNavigation && ! isRouteDrift( page.url(), navigationUrl ) && ! isStackingArtifact( mhtml ) && matchClientErrorShell( mhtml, args.clientErrorShellSelectors ) === undefined ) {
				mkdirSync( dirname( plan.paths.htmlMobile ), { recursive: true } );
				writeFileSync( plan.paths.htmlMobile, mhtml );
				args.glyphColors?.defer( plan.paths.htmlMobile, mhtml );
				entry.mobileHtml = relative( outputDir, plan.paths.htmlMobile );
				entry.documents = { ...entry.documents, mobile: documentUrl };
				mobileHeights[ slug ] = await page.evaluate( () => document.documentElement.scrollHeight );
			}
		} catch {
			/* best-effort — desktop-only carry for this page on failure */
		}
	}

	// --- section specs (desktop only) -----------------------------------------
	// Capture extractFull from the SAME settled page so reconstruction can read
	// the specs from disk instead of re-running Playwright. Desktop 1440×900
	// matches the live-extract basis, so geometry/fullBleed agree. STRICTLY
	// best-effort: a spec-capture miss must NOT mark the (successful) screenshot
	// as failed — reconstruction falls back to a live extract when the cache is
	// absent. So this never touches `failures[]`; it just leaves `entry.sections`
	// unset.
	if ( isDesktop && plan.captureSections ) {
		try {
			args.phases?.enter( 'sections' );
			const { specs, landmarks } = await extractFull( page, {}, evaluateTimeoutMs );
			SectionSpecsStore.load( outputDir ).set( url, specs, landmarks, {
				width: viewport.width,
				height: viewport.height,
			} );
			// Point at the store's ACTUAL path (keyed by slugify(url)); the screenshot
			// `slug` may be a collision-deduped variant (`-2`), which the store doesn't use.
			entry.sections = `sections/${ slugify( url ) }.json`;
		} catch {
			/* best-effort — reconstruction live-extracts when the spec cache is missing */
		}
	}
	if ( isMobile && plan.captureMobileSections ) {
		try {
			args.phases?.enter( 'sections' );
			const { specs, landmarks } = await extractFull( page, {}, evaluateTimeoutMs );
			SectionSpecsStore.loadMobile( outputDir ).set( url, specs, landmarks, {
				width: viewport.width,
				height: viewport.height,
			} );
		} catch {
			/* best-effort — desktop section evidence remains available */
		}
	}

	// --- scrolled screenshot --------------------------------------------------
	if ( args.rendererCrashed() ) return;
	if ( plan.captureScrolled ) {
		try {
			const docHeight = await page.evaluate( () => document.documentElement.scrollHeight );
			const scrollY = viewport.height * SCROLL_OFFSET_RATIO;
			if ( docHeight < scrollY + viewport.height ) {
				// Page is shorter than scroll-offset + viewport. No distinct scrolled
				// state to capture. Skip silently (not a failure).
			} else {
				// Explicit-instant: css scroll-behavior:smooth would GLIDE here and
				// the snap would clip mid-glide at the wrong scroll origin (see
				// page-helpers triggerLazyLoad for the full smooth-scroll rationale).
				await page.evaluate(
					( y: number ) => window.scrollTo( { top: y, left: 0, behavior: 'instant' } ),
					scrollY
				);
				// Plain viewport-sized screenshot of the now-scrolled page.
				// fullPage:false captures the current viewport — no clip needed.
				// (A clip would have to be inside the 0..viewport.height image, not at
				// the page's absolute scroll position.)
				args.phases?.enter( 'screenshot' );
				const buf = await withScreenshotTimeout(
					page.screenshot( { fullPage: false, type: 'png' } ),
					screenshotTimeoutMs
				);
				mkdirSync( dirname( plan.paths.scrolled ), { recursive: true } );
				writeFileSync( plan.paths.scrolled, buf );
				const rel = `screenshots/${ viewport.id }/${ slug }.scrolled.png`;
				if ( isDesktop ) entry.desktopScrolled = rel;
				else if ( isMobile ) entry.mobileScrolled = rel;
			}
		} catch ( err ) {
			const msg = err instanceof Error ? err.message : String( err );
			fail( /screenshot timeout/.test( msg ) ? 'screenshot-timeout' : 'screenshot-scrolled', msg );
		}
	}

	// --- desktop-only site analysis -------------------------------------------
	if ( args.rendererCrashed() ) return;
	if ( isDesktop && shouldAnalyze ) {
		try {
			args.phases?.enter( 'analysis' );
			const analysis = await analyzePage( page, evaluateTimeoutMs );
			entry.metadata = analysis.metadata;
			aggregator.add( url, analysis );
		} catch ( err ) {
			fail( 'evaluate', err );
		}
		if ( args.rendererCrashed() ) return;
		// Best-effort: capture source chrome computed-style fingerprint for later
		// carry-vs-source fidelity audits. A failure here MUST NOT break the
		// screenshot run — the try/catch ensures this is never propagated.
		try {
			// Write into the screenshots dir — where the audit driver reads it from
			// (readChromeFidelity(join(outputDir, 'screenshots'))). Must stay in sync.
			args.phases?.enter( 'chrome' );
			const n = await captureChromeFidelity(
				page,
				url,
				join( outputDir, 'screenshots' ),
				CHROME_AUDIT_PROPERTIES
			);
			console.info( `[chrome-fidelity] ${ url } -> ${ n } elements` );
		} catch ( err ) {
			console.error(
				`[chrome-fidelity] skipped ${ url }: ${
					err instanceof Error ? err.message : String( err )
				}`
			);
		}
	}

	// Dialogs and selectable sets are captured only after every baseline artifact
	// so probing a trigger cannot alter screenshots, geometry, sidecars, or page
	// HTML. The per-device documents probe separately: a desktop dialog must not
	// suppress a mobile-only trigger, and their bounded successful evidence merges
	// instead of replacing a desktop-only dialog with a mobile-only menu. An
	// additional profile (an adapter's third document) contributes no interaction
	// evidence: mergeProfile accepts desktop and mobile reports alone, and every
	// consumer (interaction-states.json, export media localization, fidelity)
	// reads that route-level report, so probing an additional profile produced
	// evidence no stage ever read. Its captured artifacts (HTML, screenshots,
	// fluid geometry, hydrated disclosures) are unaffected: they are produced and
	// consumed per profile before this point.
	let probesExpired = false;
	if ( args.rendererCrashed() ) return;
	// Audit the authoritative resting document before a timed-out optional
	// probe can close its page. Probe mutations are never serialized as baseline.
	args.phases?.enter( 'cleanup-audit' );
	const cleanup = await readSourceCleanup(page, sourcePolicy);
	entry.cleanup = { policy: sourcePolicy, reports: [...(entry.cleanup?.reports ?? []), cleanup] };
	if (cleanup.failures.length || cleanup.residual) throw new Error('Source cleanup incomplete; see cleanup evidence');
	await releaseBaselineNavigation();
	if ( isDesktop || isMobile ) {
		const releaseNavigationLock = await lockMainFrameNavigation( page );
		try {
			await probeInteractions();
		} finally {
			await releaseNavigationLock();
		}
	}
	if ( args.rendererCrashed() || probesExpired ) return;

	async function probeInteractions(): Promise< void > {
		const budget = createPhaseBudget( page, Math.min( args.routeDeadlineMs || 600_000, args.routeRemainingMs() ), diagnostic => {
			probesExpired = true;
			args.diagnostics?.push( diagnostic );
		}, args.probeOverrun );
		const state = createPostBaselineState();
		const promote = ( interactions: InteractionStatesReport ) => {
			if ( budget.expired() ) interactions.coverage = 'partial';
			if (
				( budget.expired() || interactions.states.length > 0 || ( interactions.components?.length ?? 0 ) > 0 || ( interactions.initialDialogs?.length ?? 0 ) > 0 || ( interactions.routeNavigation?.length ?? 0 ) > 0 ) &&
				hasPromotableInteractionEvidence( entry.interactions, interactions )
			) entry.interactions = mergeInteractionReports( entry.interactions, canonicalizeInteractions( interactions ) );
		};
		const context = {
			page, url, navigationUrl, viewport, isDesktop, entry, resourceStore, componentBaseline,
			sharedChrome: args.sharedChrome, probeExclusions: args.probeExclusions,
			consentViewports: args.consentViewports, reflowPhoneViewport: args.reflowPhoneViewport,
			diagnostics: args.diagnostics, scriptedLinkSignatures, routeRemainingMs: args.routeRemainingMs,
			state, promote,
		};
		await runSteps( postBaselineSteps, context, { ledger: args.phases, budget, rendererCrashed: args.rendererCrashed } );
		if ( budget.expired() && ! args.rendererCrashed() ) retainPartialPostBaseline( context );
	}

}

// An inline cycle is proven per viewport even when no lightbox opens; its
// HTML was wired from it, so the report must carry the same evidence.
function isProvenInlineGallery( state: CapturedDialogInteraction ): boolean {
	return state.gallery?.inline.coverage === 'complete' && state.gallery.inline.restoration === 'verified';
}

function hasPromotableInteractionEvidence( previous: InteractionStatesReport | undefined, latest: InteractionStatesReport ): boolean {
	return ! previous || latest.coverage === 'partial' || ( latest.components?.length ?? 0 ) > 0 || latest.states.some( state => state.status === 'captured' || isProvenInlineGallery( state ) ) ||
		( latest.routeNavigation?.length ?? 0 ) > 0 || latest.initialDialogs?.some( state => state.status === 'captured' ) === true;
}

/**
 * Merges one profile's interaction evidence into the route's report.
 *
 * `keepPrevious` is for a phone pass over a different (dual) document. Its
 * selectors and trigger ids name nodes in the phone document: platform
 * runtimes number ids per document, so a phone `#1` can be the menu toggle
 * where the desktop `#1` is a dropdown. A selector alone therefore does not
 * identify a control across the two passes; the observed control label does
 * too. Evidence for another control is kept beside the desktop evidence (the
 * export resolves a colliding id by that label), and evidence for the same
 * control never replaces what the earlier pass recorded.
 */
export function mergeInteractionReports(
	previous: InteractionStatesReport | undefined,
	latest: InteractionStatesReport,
	{ keepPrevious = false }: { keepPrevious?: boolean } = {}
): InteractionStatesReport {
	if ( ! previous ) return latest;
	const mergeCapturedEvidence = < T extends { status: string } >( prior: T[], next: T[], identity: ( state: T ) => string, limit?: number ): T[] =>
		mergeCapturedEvidenceInto( prior, next, identity, limit, keepPrevious );
	const control = ( label: string | undefined ) => keepPrevious ? `:${ ( label ?? '' ).replace( /\s+/g, ' ' ).trim().toLowerCase() }` : '';
	const identity = ( state: CapturedDialogInteraction ) =>
		`${ state.kind ?? 'dialog' }:${ state.trigger.id ?? state.trigger.selector }${state.gallery ? ':' + state.gallery.inline.viewport.width : ''}${ control( state.trigger.label ) }`;
	const componentKey = ( component: CapturedComponent ) =>
		`${ component.selector }${ control( component.states.find( state => state.evidence )?.evidence?.trigger.label ) }`;
	const ofKind =
		( kind: NonNullable< CapturedDialogInteraction[ 'kind' ] > | 'dialog' ) =>
		( state: CapturedDialogInteraction ) =>
			( state.kind ?? 'dialog' ) === kind;
	const states = [
		...mergeCapturedEvidence(
			previous.states.filter( ofKind( 'gallery' ) ),
			latest.states.filter( ofKind( 'gallery' ) ),
			identity,
			Number.POSITIVE_INFINITY
		),
		...mergeCapturedEvidence(
			previous.states.filter( ofKind( 'typed-search' ) ),
			latest.states.filter( ofKind( 'typed-search' ) ), identity, Number.POSITIVE_INFINITY
		),
		...mergeCapturedEvidence(
			previous.states.filter( ofKind( 'disclosure' ) ),
			latest.states.filter( ofKind( 'disclosure' ) ),
			identity,
			Number.POSITIVE_INFINITY
		),
		...mergeCapturedEvidence(
			previous.states.filter( ofKind( 'dialog' ) ),
			latest.states.filter( ofKind( 'dialog' ) ),
			identity
		),
		...mergeCapturedEvidence(
			previous.states.filter( ofKind( 'selectable-set' ) ),
			latest.states.filter( ofKind( 'selectable-set' ) ),
			identity,
			Number.POSITIVE_INFINITY
		),
		...mergeCapturedEvidence(
			previous.states.filter( ofKind( 'choice-group' ) ),
			latest.states.filter( ofKind( 'choice-group' ) ),
			identity,
			Number.POSITIVE_INFINITY
		),
	];
	const initialDialogs = mergeCapturedEvidence(
		previous.initialDialogs ?? [],
		latest.initialDialogs ?? [],
		( state ) => state.dialog.id ?? state.dialog.selector
	);
	const byIdentity = < T, >( prior: T[], next: T[], key: ( item: T ) => string ): T[] =>
		keepPrevious ? [ ...prior, ...next.filter( item => ! prior.some( known => key( known ) === key( item ) ) ) ] : [ ...prior, ...next ];
	return {
		...( keepPrevious ? previous : latest ),
		...( previous.coverage === 'partial' || latest.coverage === 'partial' ? { coverage: 'partial' as const } : {} ),
		components: [ ...new Map( byIdentity( previous.components ?? [], latest.components ?? [], componentKey ).map( component => {
			const prior = previous.components?.find(node => node.selector === component.selector);
			if (!component.slideshow || !prior?.slideshow || prior === component) return [componentKey( component ), component] as const;
			return [componentKey( component ), { ...component, slideshow: { ...component.slideshow,
				views: [...prior.slideshow.views, ...component.slideshow.views].filter((view, index, all) => all.findIndex(other => other.width === view.width) === index),
				navigation: [...prior.slideshow.navigation, ...component.slideshow.navigation].filter((mode, index, all) => all.findIndex(other => other.mode === mode.mode) === index),
			} }] as const;
		} ) ).values() ],
		states,
		routeNavigation: [ ...new Map( byIdentity( previous.routeNavigation ?? [], latest.routeNavigation ?? [], route => route.selector )
			.map( route => [ route.selector, route ] ) ).values() ],
		...( initialDialogs.length > 0 ? { initialDialogs } : {} ),
	};
}

function mergeCapturedEvidenceInto< T extends { status: string } >(
	previous: T[],
	latest: T[],
	identity: ( state: T ) => string,
	limit = MAX_CAPTURED_DIALOGS,
	keepPrevious = false
): T[] {
	const merged = new Map< string, T >();
	for ( const state of previous ) merged.set( identity( state ), state );
	for ( const state of latest ) {
		const key = identity( state );
		const existing = merged.get( key );
		if ( keepPrevious && existing ) continue;
		if ( state.status === 'captured' || existing?.status !== 'captured' ) merged.set( key, state );
	}
	const states = Array.from( merged.values() );
	const ordered = [
		...states.filter( ( state ) => state.status === 'captured' ),
		...states.filter( ( state ) => state.status !== 'captured' ),
	];
	return Number.isFinite( limit ) ? ordered.slice( 0, limit ) : ordered;
}

/**
 * Common homepage path slugs used by builders that DON'T serve the home page at
 * the bare root (e.g. a sitemap whose only "home" entry is `/home`). Matched
 * case-insensitively against the exact pathname (trailing slash tolerated).
 */
const HOMEPAGE_SLUGS = new Set( [ '/home', '/index', '/home-page', '/homepage' ] );

/**
 * Pick the URL that represents the site's home page. Prefers a URL that
 * `classifyUrl` recognizes as 'homepage' (path `/` or empty). When none exists
 * — some sites have no bare-root entry and serve home at `/home` — fall back to
 * the first URL whose path is a well-known homepage slug, and only then to
 * `urls[0]`. Returns null for an empty list.
 */
export function getHomepageUrl( urls: string[] ): string | null {
	if ( urls.length === 0 ) return null;
	const classified = urls.find( ( url ) => classifyUrl( url ) === 'homepage' );
	if ( classified ) return classified;
	const slugMatch = urls.find( ( url ) => {
		let path: string;
		try {
			path = new URL( url ).pathname.toLowerCase();
		} catch {
			path = url.toLowerCase();
		}
		return HOMEPAGE_SLUGS.has( path.replace( /\/$/, '' ) || '/' );
	} );
	return slugMatch ?? urls[ 0 ];
}

/**
 * Reduce `urls` to at most `limit` entries. When the truncation would drop
 * pages AND the filtered set spans more than one `UrlType`, sample EVENLY
 * across the present types (round-robin in stable first-seen order) instead of
 * taking the first N — a small sample of a sitemap that happens to lead with
 * dozens of one kind (e.g. news posts) would otherwise miss the design-defining
 * info pages entirely. The homepage URL is always included even if the
 * round-robin would have dropped it. When `limit >= count` or only one type is
 * present, the original order is preserved (still guaranteeing homepage
 * inclusion).
 */
function sampleUrlsByType( urls: string[], limit: number ): string[] {
	if ( urls.length <= limit ) return urls;

	const homepage = getHomepageUrl( urls );

	// Group URLs by type, preserving first-seen type order and per-type order.
	const buckets = new Map< UrlType, string[] >();
	for ( const url of urls ) {
		const type = classifyUrl( url );
		const bucket = buckets.get( type );
		if ( bucket ) bucket.push( url );
		else buckets.set( type, [ url ] );
	}

	let selected: string[];
	if ( buckets.size <= 1 ) {
		// Single type — first-N is already representative.
		selected = urls.slice( 0, limit );
	} else {
		// Round-robin across the type buckets until we hit the limit.
		const order = [ ...buckets.keys() ];
		const out: string[] = [];
		let added = true;
		while ( out.length < limit && added ) {
			added = false;
			for ( const type of order ) {
				if ( out.length >= limit ) break;
				const bucket = buckets.get( type )!;
				if ( bucket.length > 0 ) {
					out.push( bucket.shift()! );
					added = true;
				}
			}
		}
		selected = out;
	}

	// Guarantee the homepage is present even if the sample dropped it. Swap it in
	// for the last slot rather than overflow `limit`.
	if ( homepage && ! selected.includes( homepage ) ) {
		if ( selected.length < limit ) selected.push( homepage );
		else selected[ selected.length - 1 ] = homepage;
	}
	return selected;
}

function selectRepresentativeAnalysisUrl( urls: string[] ): string | null {
	if ( urls.length === 0 || ANALYSIS_SAMPLE_LIMIT <= 0 ) return null;
	return getHomepageUrl( urls );
}

function hasSingleUrlAggregate( outputDir: string ): boolean {
	const files = [ 'palette.json', 'typography.json', 'breakpoints.json' ];
	for ( const file of files ) {
		try {
			const path = join( outputDir, file );
			if ( ! existsSync( path ) ) return false;
			const parsed = JSON.parse( readFileSync( path, 'utf8' ) ) as { sampledUrls?: unknown };
			if ( parsed.sampledUrls !== ANALYSIS_SAMPLE_LIMIT ) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * Capture per-viewport screenshots + html + site metadata for a list of URLs.
 * Resumable via manifest.json / failures.json; same-origin enforced; output
 * directory validated against path traversal.
 */
export async function captureScreenshots( opts: ScreenshotOpts ): Promise< ScreenshotResult > {
	opts = { ...opts, governors: opts.governors ?? new SourceRequestGovernors() };
	const startTime = Date.now();

	// --- validate + filter ----------------------------------------------------
	validateOutputDir( opts.outputDir );

	const { devices } = await import('playwright');
	const { defaultBrowserType: _defaultBrowserType, ...IPHONE_17_CONTEXT } = devices['iPhone 17'];
	const viewports = opts.viewports ?? defaultViewports(IPHONE_17_CONTEXT.viewport);
	for ( const viewport of viewports ) validateCaptureProfile( viewport );
	if ( new Set( viewports.map( viewport => viewport.id ) ).size !== viewports.length ) throw new Error( 'Duplicate source capture profile' );
	// Each profile loads as a real browser: builders can select viewport
	// metadata, navigation, and layout from the identity, and anti-bot
	// challenges refuse Playwright's default HeadlessChrome one.
	// Keep desktop DPR native: source scripts can use it for geometry as well
	// as raster resolution. Reducing it is not a screenshot-only optimization.
	// Resolve device/caller overrides first. createSourceContext then applies the
	// matching wire and navigator identity to this final UA, not the desktop seed.
	const profileContextOptions = ( viewport: Viewport, sessionContext: BrowserContextOptions ): BrowserContextOptions => {
		const device = viewport.device ? devices[ viewport.device ] : undefined;
		if ( viewport.device && ! device ) throw new Error( `Unknown source device profile: ${ viewport.device }` );
		const { defaultBrowserType: _deviceType, ...deviceContext } = device ?? {};
		return {
			...( viewport.id === 'mobile'
				? { ...sessionContext, ...IPHONE_17_CONTEXT }
				: sessionContext ),
			deviceScaleFactor:
				viewport.id === 'desktop'
					? SCREENSHOT_DEVICE_SCALE_FACTOR
					: viewport.id === 'mobile' ? IPHONE_17_CONTEXT.deviceScaleFactor : 1,
			ignoreHTTPSErrors: true,
			...deviceContext, ...viewport.context,
			viewport: { width: viewport.width, height: viewport.height },
		};
	};
	const rawConcurrency = opts.concurrency ?? 6;
	const fluidMemo: FluidSeriesMemo = new Map();
	const classBreakpoints = new Set< number >();
	const classMemo: ViewportClassMemo = new Map();
	const concurrency = Math.max( 1, Math.floor( Math.min( 10, rawConcurrency ) ) || 1 );
	// Node reports the process group's memory constraint, including Chromium's
	// children. RSS of this Node process alone misses the dominant capture owner.
	// Explicit concurrency remains caller-owned. Otherwise every runtime is
	// bounded: a process group without a cgroup limit (zero, or the unlimited
	// uint64 sentinel) is still bounded by the machine, as in a microVM sized to
	// the capture. Calibrate on one complete route (including its fresh
	// reference pages) before admitting parallel routes.
	const memoryLimit = opts.concurrency === undefined ? runtimeMemoryLimit() : 0;
	// A sampled route that resolves to a redirect alias hands its sample slot to
	// the route holding its document (see `onRouteAlias`).
	const referenceRoutes = opts.referenceSampleUrls ? new Set( opts.referenceSampleUrls ) : undefined;
	const admission = createRouteAdmission( { memoryLimit, referenceRoutes, report: message => sendLog( server, message ) } );
	const memoryAdmission = admission.enabled;
	const browserRestartEvery = opts.browserRestartEvery ?? 100;
	const screenshotTimeoutMs = opts.screenshotTimeoutMs ?? 30_000;
	const evaluateTimeoutMs = opts.evaluateTimeoutMs ?? 5_000;
	const settleMs = opts.settleMs ?? 1_000;
	const absentDocumentProbes = new AbsentDocumentProbes();
	const force = opts.force ?? false;
	const server = opts.server;

	// --- same-origin ---------------------------------------------------------
	// Normalize `primaryUrl` to include a protocol — callers sometimes pass
	// the bare hostname the user typed (e.g. `maus.com`), matching the
	// forgiving convention in fetchSitemap.
	const primaryRef = opts.primaryUrl
		? opts.primaryUrl.includes( '://' )
			? opts.primaryUrl
			: `https://${ opts.primaryUrl }`
		: null;
	// The first route is the entry route: off its origin the capture is not of
	// this site, so it fails closed (SameOriginViolation is an IntegrityError).
	// Any other discovered URL off that origin is dropped before it can take a
	// route budget slot, as a `route_off_origin` finding.
	enforceSameOrigin( primaryRef, opts.urls.slice( 0, 1 ) );
	const offOrigin = offOriginUrls( primaryRef, opts.urls );
	const routeDiagnostics: RouteDiagnostic[] = offOrigin.violations.map( url => ( {
		code: 'route_off_origin', url, reason: `discovered URL is outside the entry origin ${ offOrigin.expected }`, unit: 'route', severity: 'warning',
	} ) );

	if (opts.routeScope) validateRouteScope(opts.routeScope);
	if (opts.primaryUrl && !routeInScope(opts.primaryUrl, opts.routeScope)) throw new Error('Source URL is outside its adapter route scope');
	const offOriginRoutes = new Set( offOrigin.violations );
	let urls = opts.urls.filter(url => ! offOriginRoutes.has( url ) && routeInScope(url, opts.routeScope));
	if ( opts.types && opts.types.length > 0 ) {
		const allowed = new Set( opts.types );
		urls = urls.filter( ( u ) => allowed.has( classifyUrl( u ) ) );
	}
	if ( typeof opts.limit === 'number' && opts.limit >= 0 ) {
		urls = sampleUrlsByType( urls, opts.limit );
	}
	const frontier = opts.linkedPages ? new LinkedFrontier( {
		...opts.linkedPages,
		capturePageLimit: opts.limit !== undefined && opts.limit >= 0 ? opts.limit : undefined,
	}, startTime, opts.routeScope, linkedAliasMap( opts.linkedCanonicalAliases ), opts.linkedCanonicalAliases ?? [],
		opts.primaryUrl ? { sourceUrl: opts.primaryUrl, runtimePaths: opts.runtimePaths } : undefined ) : undefined;
	if (frontier) urls = [...new Set(urls.map(documentRequestUrl))].filter(url => frontier.admit(url, 0, startTime, 'inventory'));
	// Under a time budget the entrypoint starts first, so the budget never skips it.
	const budgetEntrypoint = opts.timeBudget ? urls.find( url => isSourceCaptureUrl( url, opts.primaryUrl ) ) ?? urls[ 0 ] : undefined;
	if ( budgetEntrypoint !== undefined ) urls = [ budgetEntrypoint, ...urls.filter( url => url !== budgetEntrypoint ) ];
	const routeBudget = opts.timeBudget && budgetEntrypoint !== undefined ? new RouteTimeBudget( opts.timeBudget, budgetEntrypoint ) : undefined;
	// Per-route deadline (#817): a stalled route holds its slot for a bounded
	// duration, not until some outer deadline ends the whole capture. Derived
	// from the capture time budget and the admitted concurrency, floored, and
	// configurable; 0 disables it.
	const routeDeadlineMs = deriveRouteDeadlineMs( opts.routeDeadlineMs, opts.timeBudget?.timeBudgetMs, concurrency );
	// Contexts a route leaves open: the deadline closes them so its in-flight
	// waits fail instead of running on unwitnessed.
	const routeContexts = new Map< string, Set< BrowserContext > >();
	const trackRouteContext = ( url: string, context: BrowserContext ): void => {
		let contexts = routeContexts.get( url );
		if ( ! contexts ) routeContexts.set( url, contexts = new Set() );
		contexts.add( context );
	};
	const untrackRouteContext = ( url: string, context: BrowserContext ): void => {
		const contexts = routeContexts.get( url );
		if ( ! contexts ) return;
		contexts.delete( context );
		if ( ! contexts.size ) routeContexts.delete( url );
	};
	const probeOverruns = new Map<string, number>();
	const serverLinks = new Map<string, Set<string>>();
	// Route-level `route_capture_timeout` rows: routes the deadline abandoned
	// before any profile completed. They count as failed routes.
	const deadlineRows: RouteDiagnostic[] = [];
	// Profile-level rows of routes the deadline abandoned after at least one
	// profile completed: those routes keep their completed profiles.
	const profileDeadlineRows: RouteDiagnostic[] = [];
	// Per running route: commit its completed profiles at the deadline and
	// return the profiles it lost, or undefined when nothing completed.
	const partialRouteCommits = new Map< string, ( abandonment: RouteDeadlineAbandonment ) => string[] | undefined >();
	const partialCommitWrites: Promise< void >[] = [];
	const routeDeadlines = new RouteDeadlines( routeDeadlineMs, ( url, abandonment ) => {
		const lostProfiles = partialRouteCommits.get( url )?.( abandonment );
		partialRouteCommits.delete( url );
		if ( lostProfiles ) profileDeadlineRows.push( ...lostProfiles.map( id => routeProfileTimeoutDiagnostic( url, routeDeadlineMs, abandonment, id ) ) );
		else deadlineRows.push( routeTimeoutDiagnostic( url, routeDeadlineMs, abandonment ) );
		const profile = abandonment.profile ? ` (${ abandonment.profile })` : '';
		const kept = lostProfiles ? `; kept its completed profiles${ lostProfiles.length ? `, lost ${ lostProfiles.join( ', ' ) }` : '' }` : '';
		const message = `[deadline] ${ url } abandoned at the ${ routeDeadlineMs }ms route deadline during the "${ abandonment.phase }" phase${ profile }${ kept }`;
		sendLog( server, message );
		process.stderr.write( `${ message }
` );
		for ( const context of routeContexts.get( url ) ?? [] ) void context.close().catch( () => {} );
		routeContexts.delete( url );
	} );
	// The phase a still-running route entered last, from the per-profile phase
	// observers, so a deadline abandonment names it.
	const routeDeadlinesNote = ( url: string, profile: string, phase: string ): void => routeDeadlines.note( url, phase, profile );
	const representativeAnalysisUrl = selectRepresentativeAnalysisUrl( urls );

	// The URL a session (if any) is harvested from — see sourceContextOptions
	// call below. Falls back to the first route when no primaryUrl was given
	// (e.g. a direct captureScreenshots() call), which just reproduces the
	// prior no-session behavior for that origin.
	const entryUrl = primaryRef ?? urls[ 0 ] ?? '';

	// --- output layout -------------------------------------------------------
	mkdirSync( join( opts.outputDir, 'screenshots', 'desktop' ), { recursive: true } );
	mkdirSync( join( opts.outputDir, 'screenshots', 'mobile' ), { recursive: true } );
	mkdirSync( join( opts.outputDir, 'html' ), { recursive: true } );

	// --- manifest -----------------------------------------------------------
	const manifestPath = join( opts.outputDir, 'screenshots', 'manifest.json' );
	const manifest = new ManifestQueue( manifestPath );
	await manifest.init();
	if ( force ) await manifest.resetFailures();

	// Site-wide {media id → mobile-variant URL}, accumulated from each page's
	// mobile pass, written once at the end for the alt reconstruct to consume.
	const responsiveImages: Record< string, string > = existsSync(
		join( opts.outputDir, 'responsive-images.json' )
	)
		? ( JSON.parse(
				readFileSync( join( opts.outputDir, 'responsive-images.json' ), 'utf8' )
		  ) as Record< string, string > )
		: {};

	// {slug → mobile-DOM scrollHeight} for the alt path's iframe mobile-DOM carry.
	// Resume merges with a prior run (like responsiveImages); written at run end.
	const mobileHeights: Record< string, number > = existsSync(
		join( opts.outputDir, 'html-mobile', 'heights.json' )
	)
		? ( JSON.parse(
				readFileSync( join( opts.outputDir, 'html-mobile', 'heights.json' ), 'utf8' )
		  ) as Record< string, number > )
		: {};

	// --- site-analysis aggregator -------------------------------------------
	// Collects palette/typography/breakpoints for one representative URL
	// (homepage when present). The design-foundation fast path uses this as
	// directional evidence; full-page screenshots still get captured for
	// later per-page/template work.
	const aggregator = new SiteAnalysisAggregator();
	const aggregateAlreadyFresh = ! force && hasSingleUrlAggregate( opts.outputDir );

	const baseUrl = opts.primaryUrl
		? opts.primaryUrl.includes( '://' )
			? opts.primaryUrl
			: `https://${ opts.primaryUrl }`
		: ( () => {
				try {
					const u = new URL( urls[ 0 ] ?? 'https://localhost' );
					return `${ u.protocol }//${ u.host }`;
				} catch {
					return 'https://localhost';
				}
		  } )();
	const resourceStore = new CapturedResourceStore( opts.outputDir, baseUrl, undefined, opts.maxTotalBytes );
	// One glyph colour per distinct glyph across the run, so a shared footer
	// serializes the same evidence on every route (#924).
	const glyphColors = new GlyphColorCache();

	// --- browser -----------------------------------------------------------
	let browser: Browser = ( await connectBrowser( {} ) ) as unknown as Browser;
	let browserRestarts = 0;
	let urlsSinceRestart = 0;

	// One relaunch shared by every worker that saw the same browser die, bounded
	// so a browser that crashes on every launch still ends the run.
	let crashRelaunch: Promise< boolean > | null = null;
	let crashRelaunches = 0;
	const replaceCrashedBrowser = ( crashed: Browser ): Promise< boolean > => {
		if ( browser !== crashed ) return Promise.resolve( true );
		// The time budget closed this browser on purpose.
		if ( routeBudget?.abandoning ) return Promise.resolve( false );
		if ( ! crashRelaunch ) {
			if ( crashRelaunches >= MAX_CRASH_RELAUNCHES ) return Promise.resolve( false );
			crashRelaunches++;
			sendLog( server, '[restart] browser disconnected mid-segment; relaunching' );
			void crashed.close().catch( () => {} );
			crashRelaunch = connectBrowser( {} )
				.then(
					( next ) => {
						browser = next as unknown as Browser;
						browserRestarts++;
						return true;
					},
					() => false
				)
				.finally( () => {
					crashRelaunch = null;
				} );
		}
		return crashRelaunch;
	};

	// --- device mode ---------------------------------------------------------
	// The entrypoint gates the site before any route (device-mode.ts). Under a
	// reflow-only site each route is then captured at desktop only unless its
	// own cheap phone check finds a different document.
	let deviceMode: DeviceModeDecision | undefined;
	/** Desktop-only profiles for a reflow route; undefined when every route is dual. */
	let reflowViewports: Viewport[] | undefined;
	let routeComparison: Omit< DeviceComparisonArgs, 'browser' | 'url' > | undefined;
	const routeDecisions: Array< { url: string } & RouteDeviceDecision > = [];
	let phoneInteractions: { url: string; report: InteractionStatesReport } | undefined;
	const desktopProfile = viewports.find( viewport => viewport.id === 'desktop' );
	const phoneProfile = viewports.find( viewport => viewport.id === 'mobile' );
	const entrypoint = urls.find( url => isSourceCaptureUrl( url, opts.primaryUrl ) ) ?? urls[ 0 ];
	const sharedChromeEnabled = Boolean( entrypoint && ( opts.sharedChrome ?? ! opts.viewports ) && ( urls.length > 1 || frontier ) );
	const sharedChromeResults = new Map< string, SharedChromeProbe >();
	const rootClassEvidence = new RootClassEvidence();
	if ( ! opts.viewports && desktopProfile && phoneProfile && entrypoint ) {
		const sessionContext = await sourceContextOptions( browser, entryUrl, { publicUrlsOnly: opts.publicUrlsOnly, governors: opts.governors } );
		const requested = opts.deviceMode ?? 'dual';
		const comparison = {
			sourceTelemetry: opts.sourceTelemetry,
			resourceStore,
			deviceEvidence: new RouteDeviceEvidence(),
			identityHeaders: {},
			desktop: profileContextOptions( desktopProfile, sessionContext ),
			phone: profileContextOptions( phoneProfile, sessionContext ),
			governors: opts.governors, publicUrlsOnly: opts.publicUrlsOnly ?? false, routeScope: opts.routeScope,
			cleanupPolicy: opts.cleanupPolicy, removeSelectors: opts.removeSelectors, prepareCapture: opts.prepareCapture, initScript: opts.initScript,
			telemetryRequest: opts.telemetryRequest,
		};
		const probed = await probeDeviceMode( {
			...comparison, probeDiagnostic: diagnostic => routeDiagnostics.push( { ...diagnostic, url: entrypoint! } ), browser, url: entrypoint, requested, canonicalizeHtml: opts.canonicalizeHtml, sharedChrome: sharedChromeEnabled,
			deviceDocuments: [
				...( opts.deviceDocumentSelection ? [ 'documentSelection' ] : [] ),
				...( opts.additionalProfiles ? [ 'additionalProfiles' ] : [] ),
				...( opts.collectResponsiveImages ? [ 'responsiveImages' ] : [] ),
			],
		} );
		deviceMode = probed.decision;
		if ( probed.phoneInteractions ) phoneInteractions = { url: probed.url, report: probed.phoneInteractions };
		for ( const [ profile, result ] of probed.sharedChrome ?? [] ) sharedChromeResults.set( profile, result );
		if ( deviceMode.mode === 'reflow-only' ) {
			// A reflow route's desktop document also freezes the phone-width reference cell.
			reflowViewports = viewports.filter( viewport => viewport !== phoneProfile ).map( viewport => viewport === desktopProfile
				? { ...viewport, referenceWidths: viewport.referenceWidths ?? opts.referenceWidths ?? [ 390, 768, 1440 ] }
				: viewport );
			// A forced reflow-only capture (a testing override) checks no route.
			if ( requested === 'auto' ) routeComparison = comparison;
		}
		const message = `[device-mode] ${ deviceMode.mode } (${ deviceMode.durationMs }ms): ${ deviceMode.reason }${ deviceMode.phoneProbe ? `; phone-only controls: ${ deviceMode.phoneProbe.status } (${ deviceMode.phoneProbe.captured }/${ deviceMode.phoneProbe.triggers } captured)` : '' }`;
		sendLog( server, message );
		process.stderr.write( `${ message }\n` );
	}

	// --- shared chrome -------------------------------------------------------
	// The entrypoint's chrome is probed once per built-in profile before any
	// route, on the device-mode probe's pages when it loaded them, and reused by
	// every route whose chrome matches (chrome-reuse.ts). A single-route capture
	// has nothing to share.
	const sharedChromeDecisions: Array< { url: string; profile: string } & SharedChromeRouteDecision > = [];
	if ( sharedChromeEnabled ) {
		const profiles = ( reflowViewports ?? viewports ).filter( viewport => ( viewport.id === 'desktop' || viewport.id === 'mobile' ) && ! sharedChromeResults.has( viewport.id ) );
		const sessionContext = profiles.length ? await sourceContextOptions( browser, entryUrl, { publicUrlsOnly: opts.publicUrlsOnly, governors: opts.governors } ) : undefined;
		await Promise.all( profiles.map( async viewport => {
			sharedChromeResults.set( viewport.id, await probeSharedChrome( {
				probeDiagnostic: diagnostic => routeDiagnostics.push( { ...diagnostic, url: entrypoint! } ),
				browser, url: entrypoint!, options: profileContextOptions( viewport, sessionContext! ), viewport: viewport.id as 'desktop' | 'mobile',
				sourceTelemetry: opts.sourceTelemetry,
				governors: opts.governors, publicUrlsOnly: opts.publicUrlsOnly ?? false, routeScope: opts.routeScope,
				cleanupPolicy: opts.cleanupPolicy, removeSelectors: opts.removeSelectors, prepareCapture: opts.prepareCapture, initScript: opts.initScript,
				telemetryRequest: opts.telemetryRequest,
			} ) );
		} ) );
		for ( const [ profile, result ] of sharedChromeResults ) {
			const message = `[shared-chrome] ${ profile } ${ result.status } (${ result.durationMs }ms)${ result.evidence
				? `: ${ result.evidence.landmarks.length } chrome landmarks, ${ result.evidence.states.length } states (${ result.evidence.unanchored } outside chrome)`
				: `: ${ result.reason }` }`;
			sendLog( server, message );
			process.stderr.write( `${ message }\n` );
		}
	}
	const sharedChromeFor = ( viewport: Viewport ): SharedChromeProbe | undefined => {
		if ( ! sharedChromeEnabled || ( viewport.id !== 'desktop' && viewport.id !== 'mobile' ) ) return undefined;
		return sharedChromeResults.get( viewport.id ) ?? { status: 'skipped', reason: `the entrypoint chrome was not probed for the ${ viewport.id } profile`, durationMs: 0 };
	};

	let captured = 0;
	let skipped = 0;
	let completed = 0;
	// A redirect alias's target joins the queue unless its route is already in
	// it, so each route is captured once however many URLs redirect to it.
	const queuedRoutes = new Map( urls.map( url => [ normalizedUrl( scopedRouteKey( url, opts.routeScope ) ), url ] ) );
	const enqueue = (target: string, depth: number, ownership: 'linked' | 'alias' = 'linked', redirectFrom?: string): string | undefined => {
		if (!routeInScope(target, opts.routeScope)) return;
		const key = scopedRouteKey(target, opts.routeScope);
		const identity = normalizedUrl(key);
		const existing = queuedRoutes.get(identity);
		// A slash redirect must replace its own request address, but must not
		// replace a different route that already owns the destination identity.
		if (existing !== undefined && (existing !== redirectFrom || documentRequestUrl(existing) === key)) return existing;
		if (frontier && !frontier.admit(key, depth, Date.now(), ownership, redirectFrom)) return;
		if (frontier) target = key;
		queuedRoutes.set(identity, target);
		urls.push(target);
		return target;
	};
	// Routes, not failure records: failures.json keeps one record per
	// viewport × stage × attempt, the summary counts each failed URL once.
	const failedRoutes = new Set< string >();

	const capturedAt = () => new Date().toISOString();

	const reusedRoutes = new Set< string >();
	const processUrl = async ( url: string, reuseOnly = false ): Promise< void > => {
		const routeStartedAt = Date.now();
		const base = slugify( url );
		// On resume the URL may already have an entry — reuse its slug so the
		// existing-artifact check hits the same files we wrote last run. Only
		// claim a new slug for first-time URLs.
		const existing = manifest.getEntry( url );
		if ( reuseOnly && ! existing ) return;
		const slug = existing ? existing.slug : await manifest.claimSlug( base );
		// A document beside an alias is an ambiguous earlier outcome (a run whose
		// profiles disagreed, or a route that began redirecting): recapture it.
		const ambiguousDocument = Boolean( existing?.html && existing.redirectedTo );
		const plan = planArtifacts( {
			slug,
			outputDir: opts.outputDir,
			// Interrupted captures can leave files without the manifest needed to export them.
			force: force || ambiguousDocument || ! existing?.html || JSON.stringify(existing.cleanup?.policy) !== JSON.stringify(opts.cleanupPolicy ?? cleanupPolicy()),
			captureImages: opts.captureImages,
		} );
		const shouldAnalyzeUrl = url === representativeAnalysisUrl && ! aggregateAlreadyFresh;
		const desktopPlan = shouldAnalyzeUrl ? { ...plan.desktop, needsLoad: true } : plan.desktop;
		const effectivePlan = { ...plan, desktop: desktopPlan };
		const finishAlias = ( target: string ): void => {
			const targetRoute = enqueue(target, frontier?.depths.get(url) ?? 0, 'alias', url);
			// The alias's reference evidence belongs to the canonical route.
			if ( targetRoute ) {
				if ( referenceRoutes?.has( url ) ) referenceRoutes.add( targetRoute );
				opts.onRouteAlias?.( url, targetRoute );
			}
			skipped++;
			sendLog( server, `[alias] ${ url } redirects to ${ target }` );
			completed++;
			opts.onProgress?.( completed, urls.length, url );
		};
		// Query renditions can resolve from one rendered navigation. Do this
		// before opening the device comparison pair, using the same canonical
		// reader and alias ownership path as baseline capture (#1077).
		if ( reflowViewports && routeComparison && ! reuseOnly && ( force || ! existing?.deviceMode ) &&
			new URL( url ).search && ( ! primaryRef || documentRequestUrl( url ) !== documentRequestUrl( primaryRef ) ) ) {
			const context = await createSourceContext( browser, profileContextOptions( desktopProfile!, await sourceContextOptions( browser, entryUrl, { publicUrlsOnly: opts.publicUrlsOnly, governors: opts.governors } ) ), { governors: opts.governors, sourceUrl: entryUrl, sourceTelemetry: opts.sourceTelemetry } );
			trackRouteContext( url, context );
			let target: string | undefined;
			try {
				const page = await context.newPage();
				await opts.initScript?.( page ).catch( () => undefined );
				const navigation = await navigateSourceDocument( page, url, { publicUrlsOnly: opts.publicUrlsOnly ?? false, routeScope: opts.routeScope, timeoutMs: SOURCE_NAVIGATION_LIMITS.timeoutMs } );
				if ( ! navigation.boundary && ! navigation.redirectedTo && ( navigation.response?.status() ?? 0 ) < 400 ) {
					target = await renderedQueryAlias( page, url, opts.routeScope );
				}
			} catch {
				// An inconclusive early visit leaves the normal capture/retry path in charge.
			} finally {
				await context.close().catch( () => undefined );
				untrackRouteContext( url, context );
			}
			if ( target ) {
				if ( routeBudget && ! routeBudget.commit( url ) ) return;
				if ( ! routeDeadlines.commit( url ) ) return;
				await manifest.updateEntry( url, { slug, capturedAt: capturedAt(), redirectedTo: target } );
				finishAlias( target );
				return;
			}
		}
		// Decide before capture opens its context: the check's comparison pair
		// must not compete with capture's own loads (#1155). Its wall time is
		// attributed to the desktop profile as `device-check`.
		// Preserve the site-level UA document evidence for export even when
		// dual capture skips per-route comparison.
		let routeDevice: RouteDeviceDecision | undefined = deviceMode?.mode === 'dual' && deviceMode.serverHtml === 'different'
			? { mode: deviceMode.mode, reason: deviceMode.reason, serverHtml: deviceMode.serverHtml }
			: undefined;
		let deviceCheckMs: number | undefined;
		if ( reflowViewports ) {
			if ( ! force && existing?.deviceMode ) routeDevice = existing.deviceMode;
			else if ( reuseOnly ) return;
			else if ( routeComparison ) {
				const checkStartedAt = Date.now();
				routeDevice = await checkRouteDeviceMode( { ...routeComparison, browser, url } );
				deviceCheckMs = Date.now() - checkStartedAt;
			}
			else routeDevice = { mode: 'reflow-only', reason: 'reflow-only capture was requested' };
			if ( routeDevice ) routeDecisions.push( { url, ...routeDevice } );
			if ( routeDevice?.mode === 'dual' ) {
				const message = `[device-mode] ${ url } dual${ routeDevice.checkMs === undefined ? '' : ` (check ${ routeDevice.checkMs }ms)` }: ${ routeDevice.reason }`;
				sendLog( server, message );
				process.stderr.write( `${ message }\n` );
			}
		}
		const routeViewports = routeDevice?.mode === 'reflow-only' ? reflowViewports! : viewports;
		const routeProfiles: Viewport[] = routeViewports.map( profile => ( { ...publicCaptureProfile( profile ),
			referenceWidths: profile.referenceWidths ?? opts.referenceWidths ?? ( profile.id === 'mobile' ? [ 390 ] : profile.id === 'desktop' ? [ 768, 1440 ] : [ profile.width ] ),
		} ) );
		// A dual route whose source renders a bounded third layout between its
		// phone and desktop documents captures that layout too: one desktop-identity
		// viewport inside the range, assembled as the middle document (#1379).
		const middleWidth = routeDevice?.mode === 'dual' ? middleLayoutSampleWidth( routeDevice.middleLayout ) : undefined;
		if ( middleWidth !== undefined && desktopProfile && routeProfiles.some( profile => profile.id === 'mobile' ) ) {
			routeProfiles.push( { ...publicCaptureProfile( desktopProfile ), id: MIDDLE_PROFILE_ID, width: middleWidth, referenceWidths: [ middleWidth ] } );
		}
		let additionalDeclared = false;
		const declareAdditional = ( html: string ): void => {
			if ( additionalDeclared ) return;
			additionalDeclared = true;
			for ( const profile of opts.additionalProfiles?.( html ) ?? [] ) {
				validateCaptureProfile( profile );
				if ( routeProfiles.some( other => other.id === profile.id ) ) throw new Error( `Duplicate source capture profile: ${ profile.id }` );
				routeProfiles.push( { ...publicCaptureProfile( profile ), referenceWidths: profile.referenceWidths ?? opts.referenceWidths ?? [ profile.width ] } );
			}
		};
		if ( ! force && existing?.html && existsSync( join( opts.outputDir, existing.html ) ) ) declareAdditional( readFileSync( join( opts.outputDir, existing.html ), 'utf8' ) );
		// A resumed run that reuses the desktop document instead of loading it.
		const reusedDesktop = ! force && ! effectivePlan.desktop.needsLoad && Boolean( existing?.html ) && ! existing?.redirectedTo;
		// A prior run found the phone identity sent to a separate mobile site;
		// while that desktop document stands, the phone identity is not reloaded.
		const reusedPhoneSentTo = reusedDesktop ? existing?.phoneSentTo : undefined;
		const mobilePlan = reusedPhoneSentTo ? { ...effectivePlan.mobile, needsLoad: false } : effectivePlan.mobile;
		const profilePlan = ( profile: Viewport ): ArtifactPlan => profile.id === 'desktop' ? effectivePlan.desktop : profile.id === 'mobile' ? mobilePlan : planDocumentArtifacts( {
			outputDir: opts.outputDir, slug, id: profile.id, captureImages: opts.captureImages,
			force: force || ! existing?.profiles?.[ profile.id ]?.html || JSON.stringify( existing.profiles?.[ profile.id ]?.recipe ) !== JSON.stringify( profile ),
		} );
		for ( const profile of routeProfiles ) opts.declareSourceProfile?.( url, profile );
		if ( reusedPhoneSentTo ) opts.withdrawSourceProfile?.( url, 'mobile' );

		if ( routeProfiles.every( profile => ! profilePlan( profile ).needsLoad ) ) {
			// Abandoned-at-deadline routes record nothing a later export could trip on.
			if ( routeBudget && ! routeBudget.commit( url ) ) return;
			if ( ! routeDeadlines.commit( url ) ) return;
			routeBudget?.reuse( url );
			reusedRoutes.add( url );
			skipped++;
			sendLog( server, `[skip] ${ url } (artifacts exist)` );
			completed++;
			opts.onProgress?.( completed, urls.length, url );
			return;
		}

		if ( reuseOnly ) return;

		// `redirectedTo` is always written, so a URL that stopped redirecting
		// does not keep a prior run's alias through the manifest's merge.
		const entry: ManifestEntry = { slug, capturedAt: capturedAt(), redirectedTo: undefined, phoneSentTo: reusedPhoneSentTo, externalRedirect: undefined, sourceOutcomes: undefined, blockLosses: undefined, deviceMode: routeDevice,
			documents: force ? {} : { ...existing?.documents }, profiles: force ? {} : { ...existing?.profiles } };
		const urlFailures: FailureEntry[] = [];
		// Profiles merged into `entry`: complete evidence the per-route deadline
		// keeps when it abandons a later profile.
		const mergedProfiles = new Set< string >();
		partialRouteCommits.set( url, abandonment => {
			if ( ! mergedProfiles.size || ! ( entry.html || entry.mobileHtml ) || entry.redirectedTo || entry.sourceOutcomes?.length ) return undefined;
			if ( routeBudget && ! routeBudget.commit( url ) ) return undefined;
			const lost = routeProfiles.filter( profile => ! mergedProfiles.has( profile.id ) && profilePlan( profile ).needsLoad ).map( profile => profile.id );
			// A snapshot: the abandoned route keeps unwinding, and nothing it does
			// afterwards reaches the manifest.
			const committed = structuredClone( entry );
			const failures: FailureEntry[] = [
				...urlFailures,
				...lost.map( id => ( {
					url, viewport: id, stage: 'deadline' as const, error: routeProfileTimeoutDiagnostic( url, routeDeadlineMs, abandonment, id ).reason, timestamp: capturedAt(), attempt: 1,
				} ) ),
			];
			partialCommitWrites.push( ( async () => {
				for ( const failure of failures ) await manifest.recordFailure( failure );
				await manifest.updateEntry( url, committed );
			} )() );
			captured++;
			completed++;
			sendLog( server, `[degraded] ${ url } (route deadline; ${ mergedProfiles.size } completed profile(s) kept)` );
			opts.onProgress?.( completed, urls.length, url );
			return lost;
		} );
		const mergeProfile = ( viewport: Viewport, profileEntry: ManifestEntry, additional: boolean ): boolean => {
			const previousInteractions = entry.interactions;
			const previousCleanup = entry.cleanup;
			const previousDocuments = entry.documents;
			const previousNativeViewTimelines = entry.nativeViewTimelines;
			const previousScriptedLinks = entry.scriptedLinks;
			const previousBlockLosses = entry.blockLosses ?? [];
			const previousOutcomes = entry.sourceOutcomes ?? [];
			const redirectMerge = profileRedirectMerge( viewport.id, {
				redirectedTo: profileEntry.redirectedTo,
				local: Boolean( profileEntry.html || profileEntry.mobileHtml ),
				external: Boolean( profileEntry.sourceOutcomes?.length ),
			}, {
				redirectedTo: entry.redirectedTo,
				local: Boolean( entry.html || entry.mobileHtml ),
				// A resumed run reuses the desktop document without merging a pass.
				desktopLocal: Boolean( entry.html ) || ( reusedDesktop && ! entry.redirectedTo ),
				external: Boolean( previousOutcomes.length ),
			} );
			const aliasDisagreement = redirectMerge === 'disagree';
			if ( redirectMerge === 'phone-only' ) {
				// The route keeps its desktop document; the phone identity's
				// destination is a separate mobile site, not this route's alias.
				// No phone profile, document or reference cell remains, so nothing
				// downstream mistakes the route for one with a phone document.
				entry.phoneSentTo = profileEntry.redirectedTo;
				sendLog( server, `[${ PHONE_REDIRECT_DESKTOP_ONLY }] ${ url } (${ viewport.id }): the phone identity is sent to ${ entry.phoneSentTo } while desktop renders this route; captured at desktop only` );
				// Written as undefined so the manifest merge drops an earlier run's phone artifacts.
				entry.mobileHtml = undefined; entry.mobile = undefined; entry.mobileScrolled = undefined; entry.fluidMobile = undefined;
				if ( entry.profiles ) delete entry.profiles.mobile;
				if ( entry.documents ) delete entry.documents.mobile;
				opts.withdrawSourceProfile?.( url, viewport.id );
				return false;
			}
			const profileRecord = profileEntry.profiles?.[ viewport.id ];
			const { profiles: _profiles, ...passEntry } = profileEntry;
			if ( viewport.id === 'desktop' ) Object.assign( entry, passEntry );
			else if ( viewport.id === 'mobile' ) {
				if ( profileEntry.mobile ) entry.mobile = profileEntry.mobile;
				if ( profileEntry.mobileScrolled ) entry.mobileScrolled = profileEntry.mobileScrolled;
				if ( profileEntry.mobileHtml ) entry.mobileHtml = profileEntry.mobileHtml;
				if ( profileEntry.redirectedTo ) entry.redirectedTo = profileEntry.redirectedTo;
				if ( profileEntry.fluidMobile ) entry.fluidMobile = profileEntry.fluidMobile;
			}
			if ( viewport.id !== 'desktop' && profileEntry.sourceOutcomes?.length ) entry.sourceOutcomes = [ ...previousOutcomes, ...profileEntry.sourceOutcomes ];
			entry.documents = { ...previousDocuments, ...profileEntry.documents };
			const blockLosses = [ ...previousBlockLosses, ...( profileEntry.blockLosses ?? [] ) ];
			entry.blockLosses = blockLosses.length ? blockLosses : undefined;
			if ( ! additional && profileEntry.nativeViewTimelines ) entry.nativeViewTimelines = { ...previousNativeViewTimelines, ...profileEntry.nativeViewTimelines };
			// Each profile's document is lowered with its own observations.
			entry.scriptedLinks = previousScriptedLinks || profileEntry.scriptedLinks ? { ...previousScriptedLinks, ...profileEntry.scriptedLinks } : undefined;
			if ( ! additional ) {
				const latest = profileEntry.interactions;
				const accepted = latest && hasPromotableInteractionEvidence( previousInteractions, latest );
				// A dual route's phone pass explored a different document.
				const keepPrevious = viewport.id === 'mobile' && routeDevice?.mode === 'dual';
				entry.interactions = accepted ? mergeInteractionReports( previousInteractions, latest, { keepPrevious } ) : previousInteractions;
			}
			if ( ! additional && ! entry.scrollStates?.toggles.length && profileEntry.scrollStates ) entry.scrollStates = profileEntry.scrollStates;
			if ( profileEntry.cleanup ) entry.cleanup = { policy: profileEntry.cleanup.policy, reports: [ ...( previousCleanup?.reports ?? [] ), ...profileEntry.cleanup.reports ] };
			if ( profileRecord ) entry.profiles![ viewport.id ] = profileRecord;
			return aliasDisagreement;
		};
		const captureProfile = async ( viewport: Viewport, recovery = false ): Promise< { profileEntry: ManifestEntry; failures: FailureEntry[]; additional: boolean } | undefined > => {
			// A route abandoned at its deadline captures no further profiles.
			if ( ! routeDeadlines.commit( url ) ) return undefined;
			const vpPlan = recovery
				? planArtifacts( { outputDir: opts.outputDir, slug, force: true, captureImages: opts.captureImages } )[ viewport.id as 'desktop' | 'mobile' ]
				: profilePlan( viewport );
			if ( ! vpPlan.needsLoad ) return undefined;
			const additional = ! [ 'desktop', 'mobile' ].includes( viewport.id );
			const profileEntry: ManifestEntry = { slug, capturedAt: capturedAt() };
			const profileFailures: FailureEntry[] = [];
			let identity: ReturnType< typeof replayBrowserIdentity > | undefined;
			let contextOptions: BrowserContextOptions | undefined;

			// Retry a crashed renderer, or a source app that crashed into its client
			// error shell, in a fresh context once. A disconnected browser also needs
			// the shared relaunch before the retry.
			for ( let crashRetry = false; ; crashRetry = true ) {
				if (crashRetry) forgetSourceDocument(opts.governors, url);
				const attemptBrowser = browser;
				const failuresBefore = profileFailures.length;
				let context: BrowserContext | undefined;
				let rendererCrashed = false;
				let errorGuard: ReturnType< typeof guardPageErrors > | undefined;
				// A stalled route names the step it entered last (#817) through the
				// per-route deadline's abandonment reason; `route-phases` times the rest.
				const phases = createPhaseLedger( Date.now, ( phase ) => {
					routeDeadlinesNote( url, viewport.id, phase );
					if (context) attributeSourcePhase(context, phase);
				} );
				const profileDiagnostics: ProfileDiagnostic[] = [];
				phases.enter( 'context' );
				try {
					// entryUrl (not `url`) is what gets navigated to harvest a session:
					// some sources gate every route/asset behind a session only the
					// tokenized ENTRY url establishes. Keyed by origin, so this navigates
					// once per run — every worker and viewport for every route reuses it.
					contextOptions = profileContextOptions( viewport, await sourceContextOptions( attemptBrowser, entryUrl, { publicUrlsOnly: opts.publicUrlsOnly, governors: opts.governors } ) );
					identity = replayBrowserIdentity( contextOptions );
					context = await createSourceContext( attemptBrowser, contextOptions, { governors: opts.governors, sourceUrl: entryUrl, sourceTelemetry: opts.sourceTelemetry } );
					trackRouteContext( url, context );
					// tsx/esbuild's keepNames transform wraps named const arrows with
					// `__name(fn, 'name')` calls; that helper doesn't exist in the browser
					// context. Polyfill as a no-op so our evaluate() closures can run.
					// String-form init script bypasses tsx transformation entirely.
					await context.addInitScript( `
	          if (typeof globalThis.__name === 'undefined') {
	            globalThis.__name = function (fn) { return fn; };
	          }
	        ` );
					await installRuntimeWidgetAttribution( context );
					await context.addInitScript( observeViewportEntrances );
					await context.addInitScript( observeRuntimeStyleWrites );
					await context.addInitScript( observeViewportWork );
					const page = await context.newPage();
					await opts.initScript?.( page ).catch( () => undefined );
					errorGuard = guardPageErrors( page, reason => {
						profileDiagnostics.push( { code: PAGE_ERROR_STORM, reason } );
						profileFailures.push( { url, viewport: viewport.id, stage: 'evaluate', error: `${ PAGE_ERROR_STORM }: ${ reason }`, timestamp: new Date().toISOString(), attempt: 1 } );
					}, opts.maxPageErrorsPerSecond );
					reportReadiness( page, ( name, outcome ) => phases.wait( name, outcome ), opts.telemetryRequest );
					page.once( 'crash', () => { rendererCrashed = true; } );
					try {
						await capturePerViewport( {
							page,
							rootClassEvidence,
							absentDocument: isSourceCaptureUrl( url, opts.primaryUrl ?? urls[ 0 ] ) ? undefined : html => absentDocumentProbes.matches( url, html, async sibling => {
								// Same identity and source-governed context, but never navigate the
								// candidate itself or add the nonce to the discovery frontier.
								let probe: Page | undefined;
								try {
									probe = await context!.newPage();
									const navigation = await navigateSourceDocument( probe, sibling, { publicUrlsOnly: opts.publicUrlsOnly ?? false, routeScope: opts.routeScope, timeoutMs: SOURCE_NAVIGATION_LIMITS.timeoutMs } );
									const status = navigation.response?.status() ?? 0;
									if ( status !== 200 || navigation.boundary || navigation.redirectedTo || navigation.scriptNavigationUrl ) return undefined;
									await waitForStable( probe );
									await dismissOverlays( probe );
									return { status, html: await probe.content() };
								} catch ( error ) {
									if ( isIntegrityError( error ) ) throw error; // failure-class: integrity
									return undefined;
								} finally {
									await probe?.close().catch( () => {} );
								}
							} ),
							routeDeadlineMs,
							routeRemainingMs: () => routeDeadlineMs ? Math.max( 1, routeDeadlineMs - ( Date.now() - routeStartedAt ) ) : 600_000,
							probeOverrun: ms => probeOverruns.set( url, ( probeOverruns.get( url ) ?? 0 ) + ms ),
							serverLinks: serverLinks.get( url ) ?? ( serverLinks.set( url, new Set() ), serverLinks.get( url )! ),
							phases,
							rendererCrashed: () => rendererCrashed || Boolean( errorGuard?.stopped() ),
							browserProfile: { isMobile: contextOptions.isMobile ?? false, hasTouch: contextOptions.hasTouch ?? false },
							viewport: { ...viewport, context: identity },
							plan: vpPlan,
							url,
							slug,
							settleMs,
							recoverIncompleteDocument: recovery,
							screenshotTimeoutMs,
							evaluateTimeoutMs,
							failures: profileFailures,
							diagnostics: profileDiagnostics,
							entry: profileEntry,
							aggregator,
							shouldAnalyze: viewport.id === 'desktop' && shouldAnalyzeUrl,
							outputDir: opts.outputDir,
							responsiveImages,
							mobileHeights,
							resourceStore,
							glyphColors,
							publicUrlsOnly: opts.publicUrlsOnly ?? false,
							routeScope: opts.routeScope,
							removeSelectors: opts.removeSelectors,
							clientErrorShellSelectors: opts.clientErrorShellSelectors,
							cleanupPolicy: opts.cleanupPolicy,
							...( opts.collectResponsiveImages
								? { collectResponsiveImages: opts.collectResponsiveImages }
								: {} ),
							...( opts.learnFluid ? { learnFluid: true, fluidMemo, classBreakpoints, classMemo } : {} ),
							...( opts.fluidWidths ? { fluidWidths: opts.fluidWidths } : {} ),
							prepareCapture: opts.prepareCapture,
							sharedChrome: sharedChromeFor( viewport ),
							consentViewports: viewports,
							...( routeDevice?.mode === 'reflow-only' && viewport.id === 'desktop' && phoneProfile
								? { reflowPhoneViewport: { width: phoneProfile.width, height: phoneProfile.height } }
								: {} ),
							resolveClientRedirect: opts.resolveClientRedirect,
							// The entrypoint is the capture's own identity, never an alias.
							canonicalQueryAlias: ! primaryRef || documentRequestUrl( url ) !== documentRequestUrl( primaryRef ),
							beforeFluid: opts.beforeFluid,
							beforeSerialize: opts.beforeSerialize,
							observeSource: opts.observeSource,
							...( opts.canonicalizeHtml ? { canonicalizeHtml: opts.canonicalizeHtml } : {} ),
							...( opts.probeExclusions ? { probeExclusions: opts.probeExclusions } : {} ),
						} );
					} finally {
						phases.enter( 'record' );
						// HTML and successful interaction evidence precede the final cleanup
						// audit. A late audit failure must record a failure, not erase those
						// artifacts (the prior shared-entry transaction retained them too).
						if ( identity && contextOptions ) {
							const documentUrl = profileEntry.documents?.[ viewport.id ];
							profileEntry.profiles = { [ viewport.id ]: {
								recipe: viewport, viewport: { width: viewport.width, height: viewport.height }, identity,
								userAgent: contextOptions.userAgent, browserProfile: { isMobile: contextOptions.isMobile ?? false, hasTouch: contextOptions.hasTouch ?? false },
								deviceScaleFactor: contextOptions.deviceScaleFactor ?? 1, html: viewport.id === 'mobile' ? profileEntry.mobileHtml : profileEntry.html,
								...( documentUrl ? { documentUrl } : {} ),
								fluid: viewport.id === 'desktop' ? profileEntry.fluid : profileEntry.fluidMobile,
								nativeViewTimelines: profileEntry.nativeViewTimelines,
								interactions: profileEntry.interactions, scrollStates: profileEntry.scrollStates,
								...( profileEntry.sharedChrome ? { sharedChrome: profileEntry.sharedChrome } : {} ),
								...( profileDiagnostics.length ? { diagnostics: profileDiagnostics } : {} ),
							} };
							for ( const diagnostic of profileDiagnostics ) sendLog( server, `[${ diagnostic.code }] ${ url } (${ viewport.id }): ${ diagnostic.reason }` );
						}
						if ( additional && profileEntry.redirectedTo ) throw new Error( `Source profile ${ viewport.id } redirected to another document; identity was not captured` );
					}
				} catch ( err ) {
					profileFailures.push( {
						url,
						viewport: viewport.id,
						stage: 'goto',
						error: err instanceof Error ? err.message : String( err ),
						timestamp: new Date().toISOString(),
						attempt: 1,
					} );
				} finally {
					errorGuard?.dispose();
					if ( context ) {
						phases.enter( 'resource-settle' );
						try {
							const pages = context.pages();
							await Promise.all( pages.map( ( page ) => resourceStore.settle( page ) ) );
						} catch {
							/* best-effort; failures are retained in the resource manifest */
						}
						phases.enter( 'context-close' );
						try {
							await context.close();
						} catch {
							/* best-effort */
						}
						untrackRouteContext( url, context );
					}
					const profileRecord = profileEntry.profiles?.[ viewport.id ];
					if ( profileRecord ) {
						profileRecord.phases = phases.finish();
						if ( viewport.id === 'desktop' && deviceCheckMs !== undefined && ! profileRecord.phases.some( phase => phase.phase === 'device-check' ) ) profileRecord.phases.unshift( { phase: 'device-check', ms: deviceCheckMs } );
						profileRecord.readiness = phases.readiness();
					}
				}
				if ( rendererCrashed && profileFailures.length === failuresBefore ) {
					profileFailures.push( {
						url,
						viewport: viewport.id,
						stage: 'evaluate',
						error: 'source renderer crashed',
						timestamp: new Date().toISOString(),
						attempt: crashRetry ? 2 : 1,
					} );
				}
				for ( const failure of profileFailures.slice( failuresBefore ) ) {
					failure.attempt = crashRetry ? 2 : failure.attempt;
				}
				const failed = profileFailures.length > failuresBefore;
				if ( ! failed || crashRetry || errorGuard?.stopped() ) break;
				if ( attemptBrowser.isConnected() ) {
					const shellCrashed = profileFailures.slice( failuresBefore ).some( failure => failure.error.startsWith( CLIENT_ERROR_SHELL_FAILURE ) );
					if ( ! rendererCrashed && ! shellCrashed ) break;
					sendLog( server, `[retry] ${ rendererCrashed ? 'renderer crashed' : CLIENT_ERROR_SHELL_FAILURE } for ${ url } (${ viewport.id }); using a fresh context` );
				} else if ( ! ( await replaceCrashedBrowser( attemptBrowser ) ) ) break;
				profileFailures.length = failuresBefore;
				profileEntry.blockLosses = undefined;
			}
			return { profileEntry, failures: profileFailures, additional };
		};
		const builtInProfiles = ( [ 'desktop', 'mobile' ] as const )
			.map( id => routeProfiles.find( profile => profile.id === id ) )
			.filter( ( profile ): profile is Viewport => Boolean( profile ) );
		// The built-in profiles run concurrently unless memory admission finds no
		// room for a second profile: the memory now available must still cover
		// every running route's reservation plus one more route-sized share.
		// Either way each is merged, in profile order, as soon as it completes, so
		// a route abandoned at its deadline keeps the profiles that finished.
		const builtInPending = builtInProfiles.length > 1 && memoryAdmission && ! admission.roomForParallelProfiles( admission.kind( url ) )
			? undefined
			: builtInProfiles.map( viewport => captureProfile( viewport ) );
		for ( const pending of builtInPending ?? [] ) pending.catch( () => {} );
		for ( let index = 0; index < builtInProfiles.length; index++ ) {
			const viewport = builtInProfiles[ index ]!;
			const result = builtInPending ? await builtInPending[ index ] : await captureProfile( viewport );
			if ( ! result ) continue;
			// Abandoned at the deadline: nothing from a later-settling profile is merged.
			if ( ! routeDeadlines.commit( url ) ) continue;
			mergedProfiles.add( viewport.id );
			if ( result.profileEntry.sharedChrome ) sharedChromeDecisions.push( { url, profile: viewport.id, ...result.profileEntry.sharedChrome } );
			urlFailures.push( ...result.failures );
			if ( mergeProfile( viewport, result.profileEntry, result.additional ) ) urlFailures.push( {
				url, viewport: viewport.id, stage: 'goto', error: 'Source redirect aliases disagree across viewports', timestamp: new Date().toISOString(), attempt: 1,
			} );
			if ( viewport.id === 'desktop' && entry.html && ! additionalDeclared ) {
				const before = routeProfiles.length;
				declareAdditional( readFileSync( join( opts.outputDir, entry.html ), 'utf8' ) );
				for ( const profile of routeProfiles.slice( before ) ) opts.declareSourceProfile?.( url, profile );
			}
		}
		// Only now do both fully serialized device documents exist. Retry a
		// content-poor shell through the same capture owner, in a fresh context,
		// with all artifacts forced and a longer settling interval.
		if ( entry.html && entry.mobileHtml && ! entry.redirectedTo ) {
			const assess = () => incompleteDeviceDocument(
				readFileSync( join( opts.outputDir, entry.html! ), 'utf8' ),
				readFileSync( join( opts.outputDir, entry.mobileHtml! ), 'utf8' )
			);
			const before = assess();
			if ( before ) {
				const viewport = builtInProfiles.find( profile => profile.id === before.device );
				const retry = viewport && await captureProfile( viewport, true );
				if ( retry ) {
					urlFailures.push( ...retry.failures );
					mergeProfile( viewport!, retry.profileEntry, false );
				}
				const after = assess();
				const record = entry.profiles?.[ before.device ];
				if ( record ) {
					const diagnostic = { code: 'device_document_incomplete', reason: JSON.stringify( { before, after: after ?? null, recovery: after ? 'single-document' : 'recaptured' } ) };
					( record.diagnostics ??= [] ).push( diagnostic );
					sendLog( server, `[${ diagnostic.code }] ${ url }: ${ diagnostic.reason }` );
				}
				// Retain both raw artifacts as evidence. Responsive assembly uses
				// the same assessment to ship only the complete document if needed.
			}
		}
		for ( const viewport of routeProfiles.filter( profile => ! [ 'desktop', 'mobile' ].includes( profile.id ) ) ) {
			const result = await captureProfile( viewport );
			if ( ! result ) continue;
			if ( ! routeDeadlines.commit( url ) ) continue;
			mergedProfiles.add( viewport.id );
			urlFailures.push( ...result.failures );
			if ( mergeProfile( viewport, result.profileEntry, result.additional ) ) urlFailures.push( {
				url, viewport: viewport.id, stage: 'goto', error: 'Source redirect aliases disagree across viewports', timestamp: new Date().toISOString(), attempt: 1,
			} );
		}

		// Reflow-only: phone-only control states from the device-mode probe join
		// the entrypoint's report, as a phone pass's report would have.
		if ( phoneInteractions && routeDevice?.mode !== 'dual' && entry.html && ! entry.redirectedTo && documentRequestUrl( url ) === documentRequestUrl( phoneInteractions.url ) ) {
			entry.interactions = mergeInteractionReports( entry.interactions, phoneInteractions.report );
			phoneInteractions = undefined;
		}

		if (entry.sourceOutcomes?.length) {
			if (urlFailures.length || entry.html || entry.mobileHtml || entry.redirectedTo || entry.sourceOutcomes.length !== routeProfiles.length ||
				new Set(entry.sourceOutcomes.map(boundaryIdentity)).size !== 1) {
				urlFailures.push({url, viewport: 'all', stage: 'goto', error: 'External source outcomes are incomplete or disagree across viewports', timestamp: capturedAt(), attempt: 1});
			} else {
				entry.externalRedirect = true;
				// A fresh external observation cannot retain an earlier local document.
				entry.html = undefined; entry.mobileHtml = undefined; entry.desktop = undefined; entry.mobile = undefined; entry.cleanup = undefined;
			}
		}
		// A route abandoned at the time budget's deadline records nothing. One
		// abandoned at its per-route deadline recorded its completed profiles,
		// if any, when the deadline fired; nothing it did afterwards is recorded.
		if ( routeBudget && ! routeBudget.commit( url ) ) return;
		if ( ! routeDeadlines.commit( url ) ) return;
		partialRouteCommits.delete( url );
		for ( const f of urlFailures ) {
			await manifest.recordFailure( f );
		}
		await manifest.updateEntry( url, entry );

		if (entry.externalRedirect) {
			skipped++;
			sendLog(server, `[external] ${url} (observed initial-document boundary; destination not fetched)`);
			completed++; opts.onProgress?.(completed, urls.length, url);
			return;
		}
		if ( entry.redirectedTo && !urlFailures.length ) {
			finishAlias( entry.redirectedTo );
			return;
		}

		if ( entry.dismissed && entry.dismissed.length > 0 ) {
			sendLog(
				server,
				`[overlay] ${ url } dismissed ${ entry.dismissed.length } (${ entry.dismissed
					.map( ( d ) => d.method )
					.join( ',' ) })`
			);
		}

		const absentFailures = urlFailures.filter(
			( failure ) => isAbsentDocumentError( failure.error )
		);
		const captureFailures =
			isSourceCaptureUrl( url, opts.primaryUrl )
				? urlFailures
				: urlFailures.filter( ( failure ) => ! isAbsentDocumentError( failure.error ) );
		// Capture work spent the memory being measured even if a profile or
		// stage failed. Reused artifacts, absent documents and redirect aliases
		// do not calibrate. Plain routes calibrate only once a sample was
		// attributed to their kind.
		if ( memoryAdmission && ( entry.html || entry.mobileHtml || absentFailures.length === 0 ) && ! entry.redirectedTo ) {
			admission.calibrate( admission.kind( url ) );
		}
		if ( urlFailures.length === 0 ) {
			captured++;
			sendLog( server, `[ok] ${ url }` );
		} else if ( captureFailures.length === 0 && absentFailures.length > 0 ) {
			frontier?.diagnostics.push({code: 'linked_page_outcome_unproven', url, reason: `${absentFailures[0].error}; source-error/non-HTML frozen outcome is not implemented`});
			skipped++;
			sendLog( server, `[skip] ${ url } (${ absentFailures[ 0 ].error })` );
		} else if ( entry.html && ! entry.redirectedTo ) {
			// Saved HTML is a captured route. The failed stages are findings on it
			// (`route_capture_degraded`, projected by export from failures.json),
			// not a failed route.
			captured++;
			sendLog( server, `[degraded] ${ url } (${ urlFailures.length } stage failures; HTML saved)` );
		} else {
			failedRoutes.add( url );
			sendLog( server, `[fail] ${ url } (${ captureFailures.length } failures)` );
		}
		if ( ( entry.html || entry.mobileHtml ) && ! entry.redirectedTo ) {
			const documents = [ entry.html, entry.mobileHtml, ...Object.values( entry.profiles ?? {} ).map( profile => profile.html ) ];
			opts.onRouteCaptured?.( url, [ ...new Set( documents.filter( ( path ): path is string => Boolean( path ) ) ) ], resource => resourceStore.has( resource ) );
		}
		completed++;
		const routeMs = Date.now() - routeStartedAt;
		const routePhases = routePhaseBreakdown( Object.values( entry.profiles ?? {} ).map( profile => profile.phases ), routeMs );
		process.stderr.write( `[timing] route-phases ${ JSON.stringify( { url, ...routePhases } ) }\n` );
		process.stderr.write( `[timing] route ${ routeMs }ms ${ url }\n` );
		opts.onProgress?.( completed, urls.length, url );
	};

	try {
		// Reuse before admission: checkpoints must not lose existing pages just
		// because the clock/reserve prevents starting another browser route.
		if ( opts.timeBudget?.checkpoint && ! force ) {
			for ( const url of urls ) await processUrl( url, true );
		}
		// --- worker pool with browser restart at segment boundaries ----------
		// URLs are processed in segments of browserRestartEvery; WITHIN a segment a
		// continuous pool of `concurrency` workers drains a shared cursor, so a slow
		// page never stalls the others (the old slice loop waited for the slowest
		// URL in every group of `concurrency` before starting the next group). The
		// browser is restarted only between segments to bound memory, preserving the
		// restart-every-N invariant while keeping each worker on a stable browser.
		let segStart = 0;
		while (segStart < urls.length && ! routeBudget?.closed()) {
			const waveEnd = urls.length;
			while ( segStart < waveEnd && ! routeBudget?.closed() ) {
				if ( browserRestartEvery > 0 && urlsSinceRestart >= browserRestartEvery ) {
					sendLog( server, `[restart] closing browser after ${ urlsSinceRestart } URLs` );
					await browser.close().catch( () => {} );
					browser = ( await connectBrowser( {} ) ) as unknown as Browser;
					browserRestarts++;
					urlsSinceRestart = 0;
				}
				// Appended aliases and linked documents belong to the next wave.
				// Finish the entrypoint before admitting its successors when the
				// caller learns priorities from that already-rendered document.
				const entryFirst = segStart === 0 && opts.prioritizePendingRoutes;
				if ( segStart === 1 && opts.prioritizePendingRoutes ) {
					urls.splice( segStart, urls.length - segStart, ...opts.prioritizePendingRoutes( urls.slice( segStart ) ) );
				}
				const segEnd = entryFirst ? 1 : browserRestartEvery > 0
					? Math.min( waveEnd, segStart + browserRestartEvery - urlsSinceRestart )
					: waveEnd;
				let cursor = segStart;
				const running = new Set< Promise<void> >();
				const runningKinds = new Map< Promise<void>, RouteKind >();
				const timer = memoryAdmission ? setInterval( admission.sample, 100 ) : undefined;
				const budgetAdmits = (): boolean => {
					while ( cursor < segEnd && reusedRoutes.has( urls[ cursor ]! ) ) cursor++;
					return cursor < segEnd && ( ! routeBudget || routeBudget.admits( urls[ cursor ]!, running.size + 1 ) );
				};
				try {
					while ( ( cursor < segEnd && budgetAdmits() ) || running.size ) {
						while ( cursor < segEnd && budgetAdmits() && running.size < concurrency && admission.admit( admission.kind( urls[ cursor ]! ), runningKinds.values(), completed ) ) {
							const url = urls[ cursor++ ];
							const kind = admission.kind( url );
							routeBudget?.start( url );
							if ( memoryAdmission ) process.stderr.write( `[memory-admission] ${ JSON.stringify( admission.diagnostic( kind, running.size + 1, url ) ) }\n` );
							admission.start( kind );
							const pending = processUrl( url ).finally( () => { partialRouteCommits.delete( url ); admission.release( kind ); routeBudget?.finish( url, probeOverruns.get( url ) ); routeDeadlines.finish( url ); } ).then( () => {
								if ( memoryAdmission ) admission.sample();
							} );
							// The slot frees even if abandonment unwinds slowly: the route's own
							// deadline resolves the race at the deadline, after it abandoned the
							// route and closed its contexts.
							const slot = Promise.race( [ pending, routeDeadlines.start( url ) ] );
							running.add( slot );
							runningKinds.set( slot, kind );
							// The race observes fatal rejection before browser cleanup.
							void slot.then( () => { running.delete( slot ); runningKinds.delete( slot ); }, () => {} );
						}
						if ( ! running.size ) break;
						if ( ! routeBudget ) await Promise.race( running );
						else {
							await routeBudget.wait( running );
							if ( await routeBudget.abandonIfDue( running, () => browser.close().catch( () => {} ) ) ) break;
						}
					}
				} finally {
					if ( timer ) clearInterval( timer );
					// Drain existing context cleanup without suppressing fatal errors.
					await ( routeBudget ? routeBudget.drain( running ) : Promise.allSettled( running ) );
				}
				urlsSinceRestart += segEnd - segStart;
				segStart = segEnd;
			}
			// Deadline-kept profiles are in the manifest before links are read from it.
			await Promise.allSettled( partialCommitWrites );
			// Even after the budget closes, offer this wave's links to the
			// frontier so rejected targets receive budget diagnostics.
			// Expand a breadth-first wave from actual rendered artifacts. The normal
			// navigation/capture contract proves local documents and external boundaries;
			// successful HTML is never reduced to a classification-only probe.
			const scheduled = new Set( urls.map( documentRequestUrl ) );
			const candidates = new Set< string >();
			const candidateDepths = new Map<string, number>();
			for ( const url of urls ) {
				for ( const serverLink of serverLinks.get( url ) ?? [] ) {
					const link = routeInScope( serverLink, opts.routeScope ) ? scopedRouteKey( serverLink, opts.routeScope ) : serverLink;
					if ( routeInScope( link, opts.routeScope ) && ! scheduled.has( documentRequestUrl( link ) ) ) {
						candidates.add( link );
						candidateDepths.set( link, 1 + ( frontier?.depths.get( url ) ?? 0 ) );
					}
				}
				const entry = manifest.getEntry( url );
				if ( ! entry?.html ) continue;
				const documents: Array<{ path: string; document?: { url?: string; baseUrl?: string } }> = [ { path: join( opts.outputDir, entry.html ), document: entry.documents?.desktop } ];
				if ( frontier && ( ! reflowViewports || entry.mobileHtml ) ) documents.push( { path: join( opts.outputDir, entry.mobileHtml ?? join( 'html-mobile', `${ entry.slug }.html` ) ), document: entry.documents?.mobile } );
				for ( const { path: htmlPath, document } of documents ) {
					if ( ! existsSync( htmlPath ) ) continue;
					const html = resolveDocumentReferences( readFileSync( htmlPath, 'utf8' ), document?.url ?? url, document?.baseUrl );
					const collectionLinks = ( entry.interactions?.components ?? [] ).flatMap( component => component.collection?.members.flatMap( member => member.url ? [ member.url ] : [] ) ?? [] ).filter( link => new URL( link ).origin === new URL( url ).origin );
					for ( const anchor of [ ...sameOriginPageAnchors( html, url ), ...collectionLinks ] ) {
						if (!routeInScope(anchor, opts.routeScope)) continue;
						const link = scopedRouteKey( anchor, opts.routeScope );
						if ( ! scheduled.has( documentRequestUrl( link ) ) ) {
							candidates.add(link);
							candidateDepths.set(link, Math.min(candidateDepths.get(link) ?? Infinity, 1 + (frontier?.depths.get(url) ?? 0)));
						}
					}
				}
			}
			if (frontier) {
				for (const url of candidates) enqueue(url, candidateDepths.get(url)!);
			} else if ( candidates.size ) {
				let context: BrowserContext | undefined;
				try {
					context = await createSourceContext( browser, await sourceContextOptions( browser, entryUrl, { publicUrlsOnly: opts.publicUrlsOnly, governors: opts.governors } ), { governors: opts.governors, sourceUrl: entryUrl, sourceTelemetry: opts.sourceTelemetry } );
					// Inspecting an action URL performs the action; export names it instead.
					for ( const url of [ ...candidates ].filter( url => ! stateChangingAction( url ) ).slice(0, 32) ) {
						try {
							// A plain rerun must not trust a prior probe when the source changed.
							const prior = manifest.getEntry( url );
							if ( prior ) await manifest.updateEntry( url, { ...prior, externalRedirect: undefined, sourceAbsentStatus: undefined } );
							const inspected = await inspectSourceDocument(url, async (current, timeout) => {
								const response = await getSourceResponse(context!, current, {maxRedirects: 0, maxRetries: 0, timeout: Math.min(SOURCE_LINK_PROBE_REQUEST_MS, timeout)});
								try { return {url: current, status: response.status(), headers: response.headers(), body: await response.text()}; }
								finally { await response.dispose(); }
							}, opts.publicUrlsOnly, SOURCE_NAVIGATION_LIMITS.timeoutMs, opts.routeScope);
							if (inspected.status === 404 || inspected.status === 410) await manifest.updateEntry(url, {slug: prior?.slug ?? await manifest.claimSlug(slugify(url)), capturedAt: capturedAt(), sourceAbsentStatus: inspected.status});
							else if (inspected.boundary) await manifest.updateEntry(url, {slug: prior?.slug ?? await manifest.claimSlug(slugify(url)), capturedAt: capturedAt(), externalRedirect: true});
						} catch {
							// Unknown outcomes remain blocking uncaptured links at export.
						}
					}
				} catch {
					// Inspection is evidence-only; a browser/session failure leaves links unresolved.
				} finally {
					await context?.close().catch( () => {} );
				}
			}
		}
	} finally {
		// Settle glyphs deferred on earlier routes with colours learned later.
		glyphColors.resolveDeferred();
		await resourceStore.flush();
		await Promise.allSettled( partialCommitWrites );
		await manifest.flush();
		if (frontier) writeFileSync(join(opts.outputDir, 'linked-page-coverage.json'), JSON.stringify(frontier.coverage(), null, 2));
		// Persist the accumulated responsive-image map (mobile variants) for the
		// alt reconstruct. Best-effort; merge-on-resume already loaded any prior map.
		if ( Object.keys( responsiveImages ).length > 0 ) {
			try {
				writeFileSync(
					join( opts.outputDir, 'responsive-images.json' ),
					JSON.stringify( responsiveImages, null, 2 )
				);
			} catch ( err ) {
				sendLog(
					server,
					`[warn] responsive-images serialize failed: ${
						err instanceof Error ? err.message : String( err )
					}`
				);
			}
		}
		// Persist mobile-DOM heights (alt iframe carry). The html-mobile/<slug>.html
		// documents are written per-page during capture; this is their size sidecar.
		if ( Object.keys( mobileHeights ).length > 0 ) {
			try {
				mkdirSync( join( opts.outputDir, 'html-mobile' ), { recursive: true } );
				writeFileSync(
					join( opts.outputDir, 'html-mobile', 'heights.json' ),
					JSON.stringify( mobileHeights, null, 2 )
				);
			} catch ( err ) {
				sendLog(
					server,
					`[warn] mobile-heights serialize failed: ${
						err instanceof Error ? err.message : String( err )
					}`
				);
			}
		}
		if ( aggregator.hasSamples() ) {
			try {
				aggregator.serialize( opts.outputDir );
			} catch ( err ) {
				sendLog(
					server,
					`[warn] aggregator serialize failed: ${
						err instanceof Error ? err.message : String( err )
					}`
				);
			}
		}
		try {
			await browser.close();
		} catch {
			/* best-effort */
		}
	}


	// Routes the time budget left uncaptured are missing routes: counted as failed.
	const budgetDiagnostics = routeBudget?.diagnostics( urls ) ?? [];
	if ( budgetDiagnostics.length ) sendLog( server, `[budget] ${ budgetDiagnostics.length } of ${ urls.length } routes left uncaptured by the ${ opts.timeBudget!.timeBudgetMs }ms capture time budget` );
	for (const origin of new Set(urls.map(url => new URL(url).origin))) {
		const blocked = opts.governors?.forOrigin(origin).blockedClient;
		if (blocked) routeDiagnostics.push({ code: blocked.code, url: origin, reason: blocked.message, ...blocked.evidence });
	}
	routeDiagnostics.push( ...budgetDiagnostics, ...deadlineRows, ...profileDeadlineRows );
	return {
		captured,
		skipped,
		failed: failedRoutes.size + budgetDiagnostics.filter( row => row.code !== 'route_omitted_by_budget' ).length + deadlineRows.length,
		browserRestarts,
		durationMs: Date.now() - startTime,
		manifestPath,
		urls,
		...(frontier ? {linkedPageCoverage: frontier.coverage()} : {}),
		...(routeDiagnostics.length ? {routeDiagnostics} : {}),
		...(deviceMode ? {deviceMode: reflowViewports ? {...deviceMode, routes: summarizeRouteDecisions(routeDecisions)} : deviceMode} : {}),
		...(entrypoint && sharedChromeResults.size ? {sharedChrome: summarizeSharedChrome(entrypoint, sharedChromeResults, sharedChromeDecisions)} : {}),
	};
}
