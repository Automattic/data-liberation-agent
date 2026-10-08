import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { resolveDocumentReferences } from '../document-resource-base.js';
import { connectBrowser, sourceContextOptions } from '../browser-kit/index.js';
import { classifyUrl, type UrlType } from '../extraction/sitemap.js';
import { assertPublicHttpUrl } from '../media-fetch/safe-fetch.js';
import { navigateSourceDocument, inspectSourceDocument, replaySourceReload, storeExternalBoundary, boundaryIdentity, SOURCE_NAVIGATION_LIMITS, SourceNavigationError } from '../source-navigation.js';
import { CHROME_AUDIT_PROPERTIES } from '../replicate/chrome-audit-types.js';
import { extractFull } from '../replicate/section-extract.js';
import { SectionSpecsStore } from '../replicate/section-specs-store.js';
import { slugify } from '../url/index.js';
import { SiteAnalysisAggregator } from './aggregator.js';
import { applyCaptureRemovals } from './apply-removals.js';
import { accessGateRemoval, applySourceCleanup, readSourceCleanup, sweepSourceCleanup, cleanupPolicy, type CleanupPolicy } from '../source-cleanup.js';
import { accessGateNote, installAccessGatePlaceholder, openAccessGateShell, routeKeptContent, type AccessGateEvidence } from '../access-gate.js';
import { captureChromeFidelity } from './capture-chrome-fidelity.js';
import { CssAggregator } from './css-aggregator.js';
import { CSS_SHORTHAND_REPAIR_FACTORY_SOURCE } from './css-shorthand-repair.js';
import { captureDesignForUrl, captureMobileBodyFragment } from './design-capture-runner.js';
import {
	countBodyTags,
	isRouteDrift,
	isStackingArtifact,
	navigationDocumentUrl,
	serverRedirectTarget,
} from './document-integrity.js';
import { collectMobileChromeLayout } from './dom-capture.js';
import { generateChromeCss, type BakedLayoutMap } from './fixups.js';
import { sanitizeFrozenHtml } from './freeze.js';
import { captureGalleries, alignCapturedGalleries } from './gallery-capture.js';
import { wireCapturedDialogs } from '../static-dialogs.js';
import { captureNativeViewTimelines } from './native-view-timelines.js';
import { learnAndApplyFluidGeometry } from './fluid-capture.js';
import {
	captureRouteNavigation,
	captureTriggeredDialogs,
	type CapturedDialogInteraction,
	type InteractionStatesReport,
} from './interaction-capture.js';
import { applyPagerSlideshowStates, collectPagerSlideshowStates } from './pager-slideshow.js';
import { captureScrollStates, type ScrollStatesReport } from './scroll-state-capture.js';
import { observeViewportEntrances } from '../viewport-entrances.js';
import { hydrateDisclosureContent } from './dynamic-content.js';
import { captureSelectableSetStates } from './selectable-set-capture.js';
import { captureTypedSearchStates } from './typed-search-capture.js';
import { JsAggregator } from './js-aggregator.js';
import { isAbsentDocumentError, isSourceCaptureUrl, nonHtmlDocumentError } from './absent-document.js';
import { ManifestQueue, type ManifestEntry, type FailureEntry } from './manifest-queue.js';
import { validateOutputDir, planArtifacts, planDocumentArtifacts, type ArtifactPlan } from './output-layout.js';
import { validateCaptureProfile, publicCaptureProfile, replayBrowserIdentity } from './capture-profiles.js';
import { rejectedNavigationReason } from './navigation-rejection.js';
import { waitForStable, triggerLazyLoad, dismissOverlays, pageResponds, withEvaluateTimeout, restoreTopScrollState } from './page-helpers.js';
import { CapturedResourceStore } from './resource-capture.js';
import { enforceSameOrigin } from './same-origin.js';
import { preserveStreamedVideoPosters } from './streamed-video.js';
import { sameOriginPageAnchors } from './unscheduled-anchors.js';
import { normalizedUrl, documentRequestUrl } from '../url/route-key.js';
import { analyzePage } from './site-analysis.js';
import {
	defaultViewports,
	SCREENSHOT_DEVICE_SCALE_FACTOR,
	type CaptureLogSink,
	type ScreenshotOpts,
	type ScreenshotResult,
	type Viewport,
} from './types.js';
import type { GeometryCapture } from './layout-geometry-proof.js';
import type { ExtractedNav } from './nav-extract.js';
import type { Browser, BrowserContext, BrowserContextOptions, Page, Route } from 'playwright';

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
	if ( ! server ) return;
	try {
		void server.sendLoggingMessage( { level: 'info', data: message } );
	} catch {
		/* logging transport not available */
	}
}

interface DesignCaptureContext {
	cssAgg: CssAggregator;
	jsAgg?: JsAggregator;
	headLinks: Set< string >;
	cssMediaUrls: Set< string >;
	baseUrl: string;
	includeScripts: boolean;
	/** Run-level accumulator: first non-null value wins. */
	chromeAccum: {
		/** Structured nav data extracted from the header (replaces headerHtml). */
		nav: ExtractedNav | null;
		footerHtml: string | null;
		/** Desktop baked layout map (marker → props). Set on first successful chrome capture. */
		desktopLayoutMap: BakedLayoutMap | null;
		/** Mobile baked layout map (marker → props). Collected during the mobile viewport pass. */
		mobileLayoutMap: BakedLayoutMap | null;
	};
}

interface CapturePerViewportArgs {
	page: Page;
	/** Stop best-effort stages after a crash; recovery belongs to the viewport loop. */
	rendererCrashed: () => boolean;
	learnFluid?: boolean;
	fluidWidths?: number[];
	collectResponsiveImages?: (
		page: import('playwright').Page,
		ctx: import('../../adapters/page-actions.js').LiberationContext
	) => Promise< Record< string, string > >;
	removeSelectors?: string[];
	cleanupPolicy?: CleanupPolicy;
	prepareCapture?: (
		page: import('playwright').Page,
		ctx: import('../../adapters/page-actions.js').LiberationContext
	) => Promise< void >;
	resolveClientRedirect?: ( page: Page, url: string ) => Promise< string | undefined >;
	beforeSerialize?: (
		page: import('playwright').Page,
		ctx: import('../../adapters/page-actions.js').LiberationContext
	) => Promise< void >;
	observeSource?: ScreenshotOpts['observeSource'];
	browserProfile: Readonly<{ isMobile: boolean; hasTouch: boolean }>;
	canonicalizeHtml?: ( html: string ) => string;
	viewport: Viewport;
	plan: ArtifactPlan;
	url: string;
	slug: string;
	archetype: string;
	settleMs: number;
	screenshotTimeoutMs: number;
	evaluateTimeoutMs: number;
	failures: FailureEntry[];
	entry: ManifestEntry;
	aggregator: SiteAnalysisAggregator;
	shouldAnalyze: boolean;
	designCtx?: DesignCaptureContext; // present when design capture is enabled
	outputDir: string;
	/** Accumulates {media id → mobile-variant URL} from the mobile viewport, for
	 *  responsive-image carry. Mutated in place; written once after all captures. */
	responsiveImages: Record< string, string >;
	/** Accumulates {slug → mobile-DOM scrollHeight} from the mobile viewport, for the
	 *  alt path's iframe mobile-DOM carry. Mutated in place; written once at run end. */
	mobileHeights: Record< string, number >;
	resourceStore: CapturedResourceStore;
	publicUrlsOnly: boolean;
}

/** Sleep helper for navigation backoff. */
function navSleep( ms: number ): Promise< void > {
	return new Promise( ( resolve ) => setTimeout( resolve, ms ) );
}

/**
 * Backoff before retrying a throttled / transiently-failed navigation. Honors a
 * numeric `Retry-After` (seconds) when the throttler supplies one; otherwise
 * exponential (1s, 2s, 4s…), capped at 15s.
 */
function navBackoffMs( attempt: number, retryAfter?: string ): number {
	const cap = 15_000;
	const raSec = retryAfter ? Number( retryAfter ) : NaN;
	if ( Number.isFinite( raSec ) && raSec >= 0 ) return Math.min( raSec * 1000, cap );
	return Math.min( 1000 * 2 ** ( attempt - 1 ), cap );
}

export async function capturePageHtml( page: Page ): Promise< string > {
	const iframeEvidenceAttributes = {
		src: 'data-dla-visual-iframe-src',
		width: 'data-dla-visual-iframe-width',
		height: 'data-dla-visual-iframe-height',
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

			let source: URL;
			try {
				source = new URL( frame.getAttribute( 'src' ) ?? '', document.baseURI );
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
	await page.evaluate(
		( { factorySrc } ) => {
			( window as typeof window & { __dlaEntrances?: { stamp(): void } } ).__dlaEntrances?.stamp();
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
					owner.textContent = repairShorthandVarCollapse( cssText, owner.textContent ?? '' );
					continue;
				}
				const style = document.createElement( 'style' );
				style.setAttribute( 'data-dla-constructed-stylesheet', '' );
				style.textContent = cssText;
				document.head.appendChild( style );
			}
		},
		{ factorySrc: CSS_SHORTHAND_REPAIR_FACTORY_SOURCE.factorySrc }
	);
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
		return await page.evaluate( () => {
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
			const placeholderGif = /^data:image\/gif;base64,R0lGODlhAQAB/i;
			const srcsetShaped = ( value: string ) => /\s+\d+(?:\.\d+)?[wx](?=\s*(?:,|$))/i.test( value );
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
				const match = /https?:\/\/[^\s,"']+/i.exec( value );
				return match ? durableImageUrl( match[ 0 ] ) : '';
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
				if ( ! placeholderGif.test( attribute ) && ! shaped && ! /^blob:/i.test( attribute ) ) continue;
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
			try {
				return `<!DOCTYPE html>${ document.documentElement.outerHTML }`;
			} finally {
				for ( const boundary of textBoundaries ) boundary.remove();
				for ( const { image, previous } of restoredImages.reverse() ) {
					if ( previous === null ) image.removeAttribute( 'src' );
					else image.setAttribute( 'src', previous );
				}
				for ( const { image, previous, priority } of restoredAspectRatios.reverse() ) {
					if ( previous === '' ) image.style.removeProperty( 'aspect-ratio' );
					else image.style.setProperty( 'aspect-ratio', previous, priority );
				}
				for ( const { element, parent, next } of detached.reverse() ) parent.insertBefore( element, next );
			}
		} );
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
				const identities = node.getAttribute( 'data-dla-geometry-id' )?.split( /\s+/ ) ?? [];
				if ( ! identities.includes( identity ) ) {
					identities.push( identity );
					node.setAttribute( 'data-dla-geometry-id', identities.join( ' ' ) );
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
			return { schema: 'data-liberation/layout-geometry-capture/v1', observations, omissions };
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
		archetype,
		settleMs,
		screenshotTimeoutMs,
		evaluateTimeoutMs,
		failures,
		entry,
		aggregator,
		shouldAnalyze,
		designCtx,
		outputDir,
		responsiveImages,
		mobileHeights,
		resourceStore,
		publicUrlsOnly,
	} = args;
	const now = () => new Date().toISOString();
	const isDesktop = viewport.id === 'desktop';
	const isMobile = viewport.id === 'mobile';
	// The adapter's rewrite of platform-owned identifiers applies to every stored
	// HTML artifact alike, so page HTML and the captured dialogs that refer to it
	// keep naming the same elements.
	const canonicalize = ( html: string ): string => ( args.canonicalizeHtml ? args.canonicalizeHtml( html ) : html );
	const canonicalizeInteractions = < T, >( report: T ): T =>
		args.canonicalizeHtml ? canonicalizeInteractionReport( report, args.canonicalizeHtml ) : report;

	resourceStore.observe( page );
	const sourceErrors: string[] = [];
	if ( args.observeSource ) {
		page.on( 'pageerror', error => sourceErrors.push( `source runtime error: ${ error.message }` ) );
		page.on( 'crash', () => sourceErrors.push( 'source renderer crashed' ) );
	}
	if ( publicUrlsOnly && page.route ) {
		await page.route( '**/*', async ( route ) => {
			const request = route.request();
			try {
				assertPublicHttpUrl( request.url() );
			} catch {
				await route.abort( 'blockedbyclient' );
				return;
			}
			const requestHeaders = request.headers();
			if (
				request.method() === 'GET' &&
				! requestHeaders.range &&
				! requestHeaders.authorization &&
				! requestHeaders.cookie
			) {
				const replay = resourceStore.getReplayableResponse(
					request.url(),
					request.resourceType()
				);
				if ( replay ) {
					await route.fulfill( {
						path: replay.path,
						contentType: replay.contentType,
						headers: replay.headers,
					} );
					return;
				}
			}
			await route.continue();
		} );
	}

	// --- navigation (with 429/503 backoff) ------------------------------------
	// Shopify and other CDNs rate-limit aggressive concurrent capture with HTTP 429
	// (and transient 503s). Without backoff one throttle cascades into wholesale
	// failure (see DISCOVERIES 2026-06-04 — getsnooz's 168-op cascade). Retry the
	// retryable statuses + transient nav errors, honoring Retry-After, before
	// recording the failure. Non-retryable 4xx fail immediately.
	const RETRYABLE_STATUS = new Set( [ 429, 503 ] );
	const MAX_NAV_ATTEMPTS = 4;
	let navigated = false;
	let redirectedTo: string | undefined;
	let navigationUrl = url;
	for ( let attempt = 1; attempt <= MAX_NAV_ATTEMPTS; attempt++ ) {
		try {
			const navigation = await navigateSourceDocument(page, url, {publicUrlsOnly});
			if (navigation.boundary) {
				const boundary = storeExternalBoundary(outputDir, navigation.boundary, viewport.width, args.browserProfile ?? {isMobile: false, hasTouch: false});
				entry.sourceOutcomes = [...(entry.sourceOutcomes ?? []), boundary];
				await args.observeSource?.(page, url, viewport.id, sourceErrors, args.browserProfile, viewport, boundary);
				return;
			}
			const response = navigation.response;
			// Manual acquisition retains the same-site redirect provenance even
			// though the fulfilled browser response has no redirectedFrom chain.
			navigationUrl = navigation.navigationUrl ?? navigationDocumentUrl( url, response?.url?.() ?? url, Boolean( response?.request?.().redirectedFrom() ) );
			redirectedTo = navigation.redirectedTo ?? (response?.request?.().redirectedFrom()
				? serverRedirectTarget( url, response.url() )
				: undefined);
			const status = response ? response.status() : 0;
			if ( status >= 400 ) {
				if ( RETRYABLE_STATUS.has( status ) && attempt < MAX_NAV_ATTEMPTS ) {
					await navSleep( navBackoffMs( attempt, response?.headers()[ 'retry-after' ] ) );
					continue;
				}
				failures.push( {
					url,
					viewport: viewport.id,
					stage: 'goto',
					error: rejectedNavigationReason( status, response?.headers?.() ),
					timestamp: now(),
					attempt,
				} );
				return;
			}
			const notHtml = nonHtmlDocumentError( response?.headers?.()?.[ 'content-type' ] );
			if ( notHtml ) {
				failures.push( {
					url,
					viewport: viewport.id,
					stage: 'goto',
					error: notHtml,
					timestamp: now(),
					attempt,
				} );
				return;
			}
			navigated = true;
			break;
		} catch ( err ) {
			if ( attempt < MAX_NAV_ATTEMPTS && !(err instanceof SourceNavigationError) ) {
				await navSleep( navBackoffMs( attempt ) );
				continue;
			}
			failures.push( {
				url,
				viewport: viewport.id,
				stage: 'goto',
				error: err instanceof Error ? err.message : String( err ),
				timestamp: now(),
				attempt,
			} );
			return;
		}
	}
	if ( ! navigated ) return;
	// The server answered this URL with a redirect to another route, so it is
	// an alias of that route rather than a page of its own; the caller
	// captures the target once, under its own URL.
	if ( redirectedTo ) {
		entry.redirectedTo = redirectedTo;
		return;
	}
	// Some platforms answer 200 before their client router replaces an unavailable
	// child route with its parent. Only an adapter-confirmed target is an alias;
	// all other post-load navigation remains a route-drift failure.
	if ( args.resolveClientRedirect ) {
		const target = await args.resolveClientRedirect( page, url ).catch( () => undefined );
		if ( target && serverRedirectTarget( url, target ) === target ) {
			entry.redirectedTo = target;
			return;
		}
	}
	// Initial declarations have been classified. Any later main-document
	// request during baseline preparation is drift, even if aborting leaves the
	// old DOM intact. Keep the network boundary without hiding the failure.
	const baselineDrift = () => {
		failures.push({url, viewport: viewport.id, stage: 'content', error: 'route drift: unexplained navigation during source baseline capture', timestamp: now(), attempt: 1});
	};
	let releaseBaselineNavigation = await lockMainFrameNavigation(page, baselineDrift, true);
	const sourcePolicy = args.cleanupPolicy ?? cleanupPolicy();
	await applySourceCleanup(page, sourcePolicy);

	// --- settle, dismiss overlays, lazy load ----------------------------------
	await waitForStable( page, settleMs );
	// A provider login withholding the whole route (a members-only page) was
	// removed by the policy, leaving nothing of the page. Capture it as a
	// placeholder inside the site's public shell instead (see access-gate.ts).
	// Read before any probe clicks, so a login pop-up a control opens later is
	// never mistaken for a gated route.
	let accessGate: AccessGateEvidence | undefined;
	const gateRemoval = accessGateRemoval( await readSourceCleanup( page, sourcePolicy ), sourcePolicy );
	const gate = gateRemoval && ! ( await routeKeptContent( page ) ) ? gateRemoval : undefined;
	if ( gate ) {
		const gateTitle = ( await page.title().catch( () => '' ) ).trim();
		// Loading the public shell is this capture's own explained navigation.
		await releaseBaselineNavigation();
		let shell: string | undefined;
		try {
			shell = await openAccessGateShell( page, url );
		} finally {
			releaseBaselineNavigation = await lockMainFrameNavigation( page, baselineDrift, true );
		}
		if ( shell ) {
			await applySourceCleanup( page, sourcePolicy );
			await waitForStable( page, settleMs );
		}
		accessGate = { ...gate, ...( shell ? { shell } : {} ) };
		const placed = await page.evaluate( installAccessGatePlaceholder, {
			route: url, gateTitle, note: accessGateNote( gate.provider ), provider: gate.provider,
		} );
		accessGate.label = placed.label;
		entry.accessGate = accessGate;
	}
	// Dismiss takeover modals / consent banners BEFORE lazy-load (a modal's
	// scroll-lock would defeat the scroll-through) and again AFTER (scrolling can
	// trigger exit-intent / scroll-depth popups). Best-effort: never fails capture.
	const dismissedEarly = await dismissOverlays( page );
	await triggerLazyLoad( page, args.learnFluid === true );
	const dismissedLate = await dismissOverlays( page );
	const dismissedHere = [ ...dismissedEarly, ...dismissedLate ];
	if ( dismissedHere.length > 0 ) {
		// Accumulates within one run (desktop + mobile both append); on a resumed
		// re-capture, updateEntry's shallow spread REPLACES the prior dismissed[] with
		// this run's — intended (we want the most-recent capture's dismissals, not a union).
		entry.dismissed = [ ...( entry.dismissed ?? [] ), ...dismissedHere ];
	}
	// Every step above is bounded and best-effort, so a page whose script has
	// taken over its main thread still arrives here. Nothing after this can make
	// progress on it, so stop now with the real reason instead of letting the
	// next unbounded evaluate wait for the renderer to die.
	if ( ! ( await pageResponds( page, evaluateTimeoutMs ) ) ) {
		failures.push( {
			url,
			viewport: viewport.id,
			stage: 'evaluate',
			error: `page stopped responding while settling (overlay dismissal / lazy load): no answer to an evaluate within ${ evaluateTimeoutMs }ms`,
			timestamp: now(),
			attempt: 1,
		} );
		return;
	}

	// Seam 1: deterministic adapter-declared removals on the settled page, so they
	// pollute neither screenshot, carried HTML, mobile carry, nor SectionSpec.
	await applyCaptureRemovals( page, {
		removeSelectors: args.removeSelectors,
		prepare: args.prepareCapture,
		ctx: { url, viewport: viewport.id },
	} );

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

	// --- html (desktop only) --------------------------------------------------
	if ( plan.captureGeometry ) {
		let capture: GeometryCapture;
		try {
			capture = await captureLayoutGeometry( page, viewport );
		} catch {
			capture = {
				schema: 'data-liberation/layout-geometry-capture/v1',
				observations: [],
				omissions: { capture_failed: 1 },
			};
		}
		mkdirSync( dirname( plan.paths.geometry ), { recursive: true } );
		writeFileSync( plan.paths.geometry, `${ JSON.stringify( capture, null, 2 ) }\n` );
	}

	// Disclosure/accordion panels a runtime unmounts while collapsed (Radix,
	// shadcn/ui, etc.) so the served static markup has no answer text at all —
	// restored here, BEFORE serialization, so the captured HTML carries it.
	// Diagnostics are held until the interaction-states merge below rather than
	// dropped, so the fix is observable in interaction-states.json.
	let disclosureStates: CapturedDialogInteraction[] = [];

	// Seam 1b: replace runtime-computed pixel geometry with the relationship the
	// source actually obeys, learned by resizing while its runtime still runs.
	// Must happen after removals (so stripped chrome is never modelled) and
	// before serialization (so the learned CSS is what gets written).
	// A slideshow driven by its own thumbnails only advances while the source's
	// script is running, so read its states before any layout measurement.
	// Observe actions while source geometry and lazy-image owners are still live.
	// Width learning can freeze hidden overlay boxes; it cannot be the input to an action drive.
	const galleryStates = await captureGalleries(page).catch(() => []);
	const pagerSlideshows = await collectPagerSlideshowStates( page ).catch( () => [] );
	// Browser probes can scroll an offscreen control into view. Native view
	// animations legitimately report finished there; observe the capture's
	// at-top baseline, not the incidental position left by a probe click.
	try { await withEvaluateTimeout( page.evaluate( async () => {
		window.scrollTo( { top: 0, left: 0, behavior: 'instant' } );
		await new Promise<void>( resolve => requestAnimationFrame( () => requestAnimationFrame( () => resolve() ) ) );
	} ), evaluateTimeoutMs ); }
	catch ( error ) {
		failures.push( { url, viewport: viewport.id, stage: 'evaluate', error: `source baseline reset unproven: ${ String( error ) }`, timestamp: now(), attempt: 1 } );
		return;
	}
	await args.observeSource?.( page, url, viewport.id, sourceErrors, args.browserProfile, viewport );
	if ( args.rendererCrashed() ) return;
	if ( plan.captureHtml || plan.captureMobileHtml ) {
		try {
			const native = await captureNativeViewTimelines( page, viewport.id, evaluateTimeoutMs );
			if ( native.samples.length || native.status === 'unproven' ) {
				const path = join( outputDir, 'native-view-timelines', viewport.id, `${ slug }.json` );
				mkdirSync( dirname( path ), { recursive: true } );
				writeFileSync( path, JSON.stringify( native, null, 2 ) );
				entry.nativeViewTimelines ??= {};
				entry.nativeViewTimelines[ viewport.id ] = { path: `native-view-timelines/${ viewport.id }/${ slug }.json`, preserved: native.preserved, losses: native.losses, status: native.status, failures: native.failures };
			}
			if ( native.status === 'unproven' ) {
				failures.push( { url, viewport: viewport.id, stage: 'evaluate', error: `native timeline source capture unproven: ${ native.failures.join( '; ' ) }`, timestamp: now(), attempt: 1 } );
				return;
			}
		} catch ( error ) {
			failures.push( { url, viewport: viewport.id, stage: 'evaluate', error: `native timeline capture failed: ${ String( error ) }`, timestamp: now(), attempt: 1 } );
			return;
		}
	}

	if ( ( plan.captureHtml || plan.captureMobileHtml ) && args.learnFluid && viewport.learnFluid !== false ) {
		try {
			const learned = await learnAndApplyFluidGeometry( page, {
				document: isDesktop ? 'desktop' : 'mobile',
				...( args.fluidWidths ? { widths: args.fluidWidths } : {} ),
				settleMs: Math.max( args.settleMs, 800 ),
			} );
			entry[ isDesktop ? 'fluid' : 'fluidMobile' ] = {
				applied: learned.applied,
				unmodelled: learned.unmodelled,
				breakpoints: learned.breakpoints,
				canvasFloor: learned.canvasFloor,
				byKind: learned.byKind,
			};
		} catch ( error ) {
			// Never fail a capture over the optimization: a frozen copy still
			// beats no copy, and the diagnostics record that it stayed frozen.
			failures.push( {
				url,
				viewport: viewport.id,
				stage: 'content',
				error: `fluid learning failed: ${ error instanceof Error ? error.message : String( error ) }`,
				timestamp: now(),
				attempt: 1,
			} );
		}
	}
	if ( args.rendererCrashed() ) return;

	await applyPagerSlideshowStates( page, pagerSlideshows ).catch( () => {
		/* best-effort — a picker that will not advance must not block capture */
	} );

	if ( args.beforeSerialize ) {
		await args.beforeSerialize( page, {
			url,
			viewport: viewport.id,
		} ).catch( () => {
			/* best-effort — never block capture on a late platform widget */
		} );
	}
	if ( args.rendererCrashed() ) return;

	// Hydrated panels belong to the serialization transaction. Browser probes
	// and width learning can rerender their source items, discarding injected
	// answers or mistaking the new controls for another interactive component.
	if (plan.captureHtml || plan.captureMobileHtml || plan.captureSections || plan.captureMobileSections) {
		disclosureStates = await hydrateDisclosureContent(page);
	}
	// Gallery cycles are part of this viewport's serialization transaction, not
	// a later drive after the baseline HTML has already been saved.
	await alignCapturedGalleries(page, galleryStates);

	// Capture only after every operation that can change the live DOM, then
	// serialize immediately below. This keeps runtime-driven components in the
	// same state across the visual reference and its HTML transaction.
	if ( plan.captureFullpage ) {
		try {
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
			failures.push( {
				url,
				viewport: viewport.id,
				stage: /screenshot timeout/.test( msg ) ? 'screenshot-timeout' : 'screenshot-fullpage',
				error: msg,
				timestamp: now(),
				attempt: 1,
			} );
		}
	}

	if ( args.rendererCrashed() ) return;
	if ( plan.captureHtml ) {
		try {
			// The cleanup observer may have exhausted its budget before the page
			// re-rendered a credit or ad; the saved document must be swept. A source
			// that re-initialized its document after install has no state left to
			// sweep — the policy lets the sweep reinstall on the fresh document.
			await sweepSourceCleanup( page, sourcePolicy );
			await preserveStreamedVideoPosters( page, resourceStore, url ).catch( () => undefined );
			const html = canonicalize( wireCapturedDialogs(await capturePageHtml( page ), galleryStates) );
			const documentUrl = await page.evaluate( () => ( { url: document.URL, baseUrl: document.baseURI } ) );
			await resourceStore.captureDomDependencies( html, documentUrl.baseUrl );
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
			if ( isRouteDrift( capturedUrl, navigationUrl ) ) {
				failures.push( {
					url,
					viewport: viewport.id,
					stage: 'content',
					error: `route drift: captured ${ capturedUrl } while attempting to capture ${ url } (a control navigated the page mid-capture); HTML not persisted`,
					timestamp: now(),
					attempt: 1,
				} );
			} else if ( isStackingArtifact( html ) ) {
				failures.push( {
					url,
					viewport: viewport.id,
					stage: 'content',
					error: `nested document capture (${ countBodyTags(
						html
					) } <body> in one page); HTML not persisted`,
					timestamp: now(),
					attempt: 1,
				} );
			} else {
				mkdirSync( dirname( plan.paths.html ), { recursive: true } );
				writeFileSync( plan.paths.html, html );
				entry.html = relative( outputDir, plan.paths.html );
				entry.documents = { ...entry.documents, [ viewport.id ]: documentUrl };
			}
		} catch ( err ) {
			failures.push( {
				url,
				viewport: viewport.id,
				stage: 'content',
				error: err instanceof Error ? err.message : String( err ),
				timestamp: now(),
				attempt: 1,
			} );
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
			await sweepSourceCleanup( page, sourcePolicy );
			await preserveStreamedVideoPosters( page, resourceStore, url ).catch( () => undefined );
			const mhtml = canonicalize( wireCapturedDialogs(sanitizeFrozenHtml( await capturePageHtml( page ) ), galleryStates) );
			const documentUrl = await page.evaluate( () => ( { url: document.URL, baseUrl: document.baseURI } ) );
			await resourceStore.captureDomDependencies( mhtml, documentUrl.baseUrl );
			// Same route-identity guard as the desktop HTML write above — best-effort
			// here too (this carry already silently skips on any other failure), so a
			// drifted mobile capture just leaves the page desktop-only rather than
			// recording a failure of its own.
			if ( ! isRouteDrift( page.url(), navigationUrl ) && ! isStackingArtifact( mhtml ) ) {
				mkdirSync( dirname( plan.paths.htmlMobile ), { recursive: true } );
				writeFileSync( plan.paths.htmlMobile, mhtml );
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
			failures.push( {
				url,
				viewport: viewport.id,
				stage: /screenshot timeout/.test( msg ) ? 'screenshot-timeout' : 'screenshot-scrolled',
				error: msg,
				timestamp: now(),
				attempt: 1,
			} );
		}
	}

	// --- desktop-only site analysis -------------------------------------------
	if ( args.rendererCrashed() ) return;
	if ( isDesktop && shouldAnalyze ) {
		try {
			const analysis = await analyzePage( page, evaluateTimeoutMs );
			entry.metadata = analysis.metadata;
			aggregator.add( url, analysis );
		} catch ( err ) {
			failures.push( {
				url,
				viewport: viewport.id,
				stage: 'evaluate',
				error: err instanceof Error ? err.message : String( err ),
				timestamp: now(),
				attempt: 1,
			} );
		}
		if ( args.rendererCrashed() ) return;
		// Best-effort: capture source chrome computed-style fingerprint for later
		// carry-vs-source fidelity audits. A failure here MUST NOT break the
		// screenshot run — the try/catch ensures this is never propagated.
		try {
			// Write into the screenshots dir — where the audit driver reads it from
			// (readChromeFidelity(join(outputDir, 'screenshots'))). Must stay in sync.
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

	// --- desktop-only design capture (page/post archetypes only) ---------------
	if ( args.rendererCrashed() ) return;
	if ( isDesktop && designCtx ) {
		try {
			// The design sidecar slug MUST match the WXR item slug used by adapters
			// (item.slug = slugify(url)) so flushPendingImports can find the sidecar
			// by entry.slug. The manifest `slug` may have a collision suffix (-2, -3)
			// when multiple URLs share the same base, so we derive the design sidecar
			// slug directly from the URL — same derivation the adapters use.
			const designSlug = slugify( url );
			const designResult = await captureDesignForUrl( {
				page,
				url,
				slug: designSlug,
				archetype,
				outputDir,
				baseUrl: designCtx.baseUrl,
				includeScripts: designCtx.includeScripts,
				cssAgg: designCtx.cssAgg,
				jsAgg: designCtx.jsAgg,
				headLinks: designCtx.headLinks,
				chromeAccum: designCtx.chromeAccum,
			} );
			if ( designResult ) {
				for ( const u of designResult.cssMediaUrls ) designCtx.cssMediaUrls.add( u );
			}
		} catch ( err ) {
			// Non-fatal — design capture failure does not fail the screenshot run
			// (captureDesignForUrl already catches + logs internally; this guard
			// catches any unexpected throw from the orchestration layer itself)
			console.error(
				`[design] unexpected error for ${ url }: ${
					err instanceof Error ? err.message : String( err )
				}`
			);
		}
	}

	// --- mobile-only chrome layout collection (dual-viewport bake) ------------
	// Collect the mobile computed layout for the chrome using the marker classes
	// assigned during the desktop pass. Only runs once — after the desktop pass
	// has established the chromeAccum with a desktopLayoutMap AND the mobile
	// layout hasn't been collected yet.
	//
	// Limitation: if Wix (or similar) renders a different chrome DOM at mobile
	// (hamburger menu), collectMobileChromeLayout returns null (no markers found)
	// and mobileLayoutMap stays null. generateChromeCss then emits desktop-only
	// rules. The static hamburger is not interactive — known limitation.
	if (
		isMobile &&
		designCtx &&
		designCtx.chromeAccum.desktopLayoutMap !== null &&
		designCtx.chromeAccum.mobileLayoutMap === null
	) {
		try {
			const mobileMap = await collectMobileChromeLayout( page );
			if ( mobileMap && Object.keys( mobileMap ).length > 0 ) {
				designCtx.chromeAccum.mobileLayoutMap = mobileMap;
			}
		} catch ( err ) {
			// Non-fatal — mobile chrome layout collection failure degrades to desktop-only CSS.
			console.error(
				`[design] mobile chrome layout collection failed for ${ url }: ${
					err instanceof Error ? err.message : String( err )
				}`
			);
		}
	}

	// --- mobile-only body fragment capture (dual-viewport page content) --------
	// Capture the chrome-stripped body fragment at the mobile viewport and write
	// design/<slug>.mobile.fragment.html. This is the counterpart to the desktop
	// sidecar written by captureDesignForUrl during the desktop pass. Both sidecars
	// are consumed by flushPendingImports to build the viewport-toggle contentOverride.
	//
	// Only run when:
	//   - this is the mobile viewport pass
	//   - design capture is active (designCtx present)
	//   - the archetype is a design-captured content type (same gate as desktop)
	//
	// The check against `archetype` uses the same DESIGN_CAPTURE_ARCHETYPES set logic.
	// We re-derive the slug the same way the desktop pass does: slugify(url).
	if ( isMobile && designCtx ) {
		const DESIGN_CAPTURE_ARCHETYPES = new Set( [ 'homepage', 'page', 'post', 'gallery', 'event' ] );
		if ( DESIGN_CAPTURE_ARCHETYPES.has( archetype ) ) {
			try {
				const designSlug = ( await import( '../url/index.js' ) ).slugify( url );
				await captureMobileBodyFragment( {
					page,
					slug: designSlug,
					outputDir,
					cssAgg: designCtx.cssAgg,
				} );
			} catch ( err ) {
				// Non-fatal — mobile body capture failure means only desktop fragment is available.
				// flushPendingImports falls back to desktop-only wrapping.
				console.error(
					`[design] mobile body fragment capture failed for ${ url }: ${
						err instanceof Error ? err.message : String( err )
					}`
				);
			}
		}
	}

	// Dialogs and selectable sets are captured only after every baseline artifact
	// so probing a trigger cannot alter screenshots, geometry, sidecars, or page
	// HTML. Each viewport needs its own probe: a desktop dialog must not suppress
	// a mobile-only trigger. Merge their bounded successful evidence rather than
	// replacing a desktop-only dialog with a mobile-only menu.
	if ( args.rendererCrashed() ) return;
	await releaseBaselineNavigation();
	const releaseNavigationLock = await lockMainFrameNavigation( page );
	try {
		await probeInteractions();
	} finally {
		await releaseNavigationLock();
	}
	const cleanup = await readSourceCleanup(page, sourcePolicy);
	entry.cleanup = { policy: sourcePolicy, reports: [...(entry.cleanup?.reports ?? []), cleanup] };
	if (cleanup.failures.length || cleanup.residual) throw new Error('Source cleanup incomplete; see cleanup evidence');

	async function probeInteractions(): Promise< void > {
	try {
		// The scrolled screenshot must not become the resting state for controls
		// whose evidence is replayed against the top-of-document portable baseline.
		await restoreTopScrollState( page );
		await dismissOverlays( page );
		const interactions = await captureTriggeredDialogs( page, url );
		// Route-tab observation is evidence, not a baseline artifact: its failure
		// must not discard the dialog states captured before it.
		try {
			interactions.routeNavigation = await captureRouteNavigation( page, url );
		} catch {
			/* best-effort: capture proceeds with dialog evidence alone */
		}
		// Disclosure/accordion candidates were already resolved (opened, captured,
		// reclosed) before serialization above — folded in here purely as
		// diagnostics, using the same states array + totals the dialog/menu path
		// already reports through, rather than a parallel reporting system.
		interactions.states = [ ...galleryStates, ...disclosureStates, ...interactions.states ];
		try {
			const selectableStates = await captureSelectableSetStates( page );
			if ( selectableStates.length > 0 ) {
				interactions.states = [ ...interactions.states, ...selectableStates ];
			}
			try {
				await dismissOverlays( page );
				interactions.states.push( ...await captureTypedSearchStates( page, selectableStates, { maxDriveMs: 300_000 } ) );
			} catch {
				/* A failed input probe must not misreport a successful selectable drive. */
			}
		} catch ( error ) {
			interactions.states.push( {
				status: 'click-failed',
				kind: 'selectable-set',
				trigger: {
					selector: 'html',
					tag: 'html',
					ariaHaspopup: '',
					dataBindings: {},
				},
				error: ( error instanceof Error ? error.message : String( error ) ).slice( 0, 500 ),
			} );
		}
		if (
			( interactions.states.length > 0 || ( interactions.initialDialogs?.length ?? 0 ) > 0 || ( interactions.routeNavigation?.length ?? 0 ) > 0 ) &&
			hasPromotableInteractionEvidence( entry.interactions, interactions )
		) {
			entry.interactions = mergeInteractionReports( entry.interactions, canonicalizeInteractions( interactions ) );
		}
	} catch {
		/* best-effort: baseline capture remains valid when interaction probing fails */
	}

	// Scroll-driven chrome (a header/logo that shrinks or gains a background once
	// the page scrolls past some offset) is a distinct trigger from clicks, so it
	// gets its own probe. Also runs only after baseline artifacts, and is
	// best-effort: a failed probe must not invalidate the rest of the capture.
	if ( ! entry.scrollStates?.toggles.length ) {
		try {
			const scrollStates = await captureScrollStates( page, url );
			if ( scrollStates.toggles.length > 0 ) {
				entry.scrollStates = scrollStates;
			}
		} catch {
			/* best-effort: baseline capture remains valid when scroll-state probing fails */
		}
	}
	}
}

function hasPromotableInteractionEvidence( previous: InteractionStatesReport | undefined, latest: InteractionStatesReport ): boolean {
	return ! previous || latest.states.some( state => state.status === 'captured' ) ||
		( latest.routeNavigation?.length ?? 0 ) > 0 || latest.initialDialogs?.some( state => state.status === 'captured' ) === true;
}

function mergeInteractionReports(
	previous: InteractionStatesReport | undefined,
	latest: InteractionStatesReport
): InteractionStatesReport {
	if ( ! previous ) return latest;
	const identity = ( state: CapturedDialogInteraction ) =>
		`${ state.kind ?? 'dialog' }:${ state.trigger.id ?? state.trigger.selector }${state.gallery ? ':' + state.gallery.inline.viewport.width : ''}`;
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
	return {
		...latest,
		states,
		routeNavigation: [ ...new Map( [ ...( previous.routeNavigation ?? [] ), ...( latest.routeNavigation ?? [] ) ]
			.map( route => [ route.selector, route ] ) ).values() ],
		...( initialDialogs.length > 0 ? { initialDialogs } : {} ),
	};
}

function mergeCapturedEvidence< T extends { status: string } >(
	previous: T[],
	latest: T[],
	identity: ( state: T ) => string,
	limit = MAX_CAPTURED_DIALOGS
): T[] {
	const merged = new Map< string, T >();
	for ( const state of previous ) merged.set( identity( state ), state );
	for ( const state of latest ) {
		const key = identity( state );
		const existing = merged.get( key );
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
	const startTime = Date.now();

	// --- validate + filter ----------------------------------------------------
	validateOutputDir( opts.outputDir );

	const { devices } = await import('playwright');
	const { defaultBrowserType: _defaultBrowserType, ...IPHONE_17_CONTEXT } = devices['iPhone 17'];
	const viewports = opts.viewports ?? defaultViewports(IPHONE_17_CONTEXT.viewport);
	for ( const viewport of viewports ) validateCaptureProfile( viewport );
	if ( new Set( viewports.map( viewport => viewport.id ) ).size !== viewports.length ) throw new Error( 'Duplicate source capture profile' );
	const rawConcurrency = opts.concurrency ?? 6;
	const concurrency = Math.max( 1, Math.min( 10, rawConcurrency ) );
	const browserRestartEvery = opts.browserRestartEvery ?? 100;
	const screenshotTimeoutMs = opts.screenshotTimeoutMs ?? 30_000;
	const evaluateTimeoutMs = opts.evaluateTimeoutMs ?? 5_000;
	const settleMs = opts.settleMs ?? 1_000;
	const force = opts.force ?? false;
	const server = opts.server;

	let urls = opts.urls.slice();
	if ( opts.types && opts.types.length > 0 ) {
		const allowed = new Set( opts.types );
		urls = urls.filter( ( u ) => allowed.has( classifyUrl( u ) ) );
	}
	if ( typeof opts.limit === 'number' && opts.limit >= 0 ) {
		urls = sampleUrlsByType( urls, opts.limit );
	}
	const representativeAnalysisUrl = selectRepresentativeAnalysisUrl( urls );

	// --- same-origin ---------------------------------------------------------
	// Normalize `primaryUrl` to include a protocol — callers sometimes pass
	// the bare hostname the user typed (e.g. `maus.com`), matching the
	// forgiving convention in fetchSitemap.
	const primaryRef = opts.primaryUrl
		? opts.primaryUrl.includes( '://' )
			? opts.primaryUrl
			: `https://${ opts.primaryUrl }`
		: null;
	enforceSameOrigin( primaryRef, urls );
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

	// --- design capture aggregators (run-level) --------------------------------
	// Constructed once per run; populated during the per-URL capture pass.
	// Only active when opts.captureDesign is true.
	const includeScripts = opts.includeScripts ?? false;
	// Derive a stable base URL from the URL list for first-party checks.
	// Fall back to a bare origin of the first URL if primaryUrl isn't provided.
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
	const cssAgg = new CssAggregator();
	const jsAgg = includeScripts ? new JsAggregator( baseUrl ) : undefined;
	const headLinks = new Set< string >();
	const cssMediaUrls = new Set< string >();
	const resourceStore = new CapturedResourceStore( opts.outputDir, baseUrl );
	if ( opts.captureDesign ) {
		cssAgg.init( opts.outputDir );
	}
	const chromeAccum = {
		nav: null as ExtractedNav | null,
		footerHtml: null as string | null,
		desktopLayoutMap: null as BakedLayoutMap | null,
		mobileLayoutMap: null as BakedLayoutMap | null,
	};
	const designCtx: DesignCaptureContext | undefined = opts.captureDesign
		? { cssAgg, jsAgg, headLinks, cssMediaUrls, baseUrl, includeScripts, chromeAccum }
		: undefined;

	// --- browser -----------------------------------------------------------
	let browser: Browser = ( await connectBrowser( {
		cdpPort: opts.cdpPort,
	} ) ) as unknown as Browser;
	let browserRestarts = 0;
	let urlsSinceRestart = 0;

	// One relaunch shared by every worker that saw the same browser die, bounded
	// so a browser that crashes on every launch still ends the run. An attached
	// (cdpPort) browser is reconnected; if it is gone too, the retry is skipped
	// and the original failures are recorded.
	let crashRelaunch: Promise< boolean > | null = null;
	let crashRelaunches = 0;
	const replaceCrashedBrowser = ( crashed: Browser ): Promise< boolean > => {
		if ( browser !== crashed ) return Promise.resolve( true );
		if ( ! crashRelaunch ) {
			if ( crashRelaunches >= MAX_CRASH_RELAUNCHES ) return Promise.resolve( false );
			crashRelaunches++;
			sendLog( server, '[restart] browser disconnected mid-segment; relaunching' );
			void crashed.close().catch( () => {} );
			crashRelaunch = connectBrowser( { cdpPort: opts.cdpPort } )
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

	let captured = 0;
	let skipped = 0;
	let completed = 0;
	// A redirect alias's target joins the queue unless its route is already in
	// it, so each route is captured once however many URLs redirect to it.
	const queuedRoutes = new Set( urls.map( normalizedUrl ) );
	const allFailures: FailureEntry[] = [];

	const capturedAt = () => new Date().toISOString();

	const processUrl = async ( url: string ): Promise< void > => {
		const routeStartedAt = Date.now();
		const base = slugify( url );
		// On resume the URL may already have an entry — reuse its slug so the
		// existing-artifact check hits the same files we wrote last run. Only
		// claim a new slug for first-time URLs.
		const existing = manifest.getEntry( url );
		const slug = existing ? existing.slug : await manifest.claimSlug( base );
		const plan = planArtifacts( {
			slug,
			outputDir: opts.outputDir,
			// Interrupted captures can leave files without the manifest needed to export them.
			force: force || ! existing?.html || JSON.stringify(existing.cleanup?.policy) !== JSON.stringify(opts.cleanupPolicy ?? cleanupPolicy()),
			captureImages: opts.captureImages,
		} );
		const shouldAnalyzeUrl = url === representativeAnalysisUrl && ! aggregateAlreadyFresh;
		const desktopPlan = shouldAnalyzeUrl ? { ...plan.desktop, needsLoad: true } : plan.desktop;
		const effectivePlan = { ...plan, desktop: desktopPlan };
		const routeProfiles: Viewport[] = viewports.map( profile => ( { ...publicCaptureProfile( profile ),
			referenceWidths: profile.referenceWidths ?? opts.referenceWidths ?? ( profile.id === 'mobile' ? [ 390 ] : profile.id === 'desktop' ? [ 768, 1440 ] : [ profile.width ] ),
		} ) );
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
		const profilePlan = ( profile: Viewport ): ArtifactPlan => profile.id === 'desktop' ? effectivePlan.desktop : profile.id === 'mobile' ? effectivePlan.mobile : planDocumentArtifacts( {
			outputDir: opts.outputDir, slug, id: profile.id, captureImages: opts.captureImages,
			force: force || ! existing?.profiles?.[ profile.id ]?.html || JSON.stringify( existing.profiles?.[ profile.id ]?.recipe ) !== JSON.stringify( profile ),
		} );
		for ( const profile of routeProfiles ) opts.declareSourceProfile?.( url, profile );

		if ( routeProfiles.every( profile => ! profilePlan( profile ).needsLoad ) ) {
			skipped++;
			sendLog( server, `[skip] ${ url } (artifacts exist)` );
			completed++;
			opts.onProgress?.( completed, urls.length, url );
			return;
		}

		// `redirectedTo` is always written, so a URL that stopped redirecting
		// does not keep a prior run's alias through the manifest's merge.
		const entry: ManifestEntry = { slug, capturedAt: capturedAt(), redirectedTo: undefined, externalRedirect: undefined, sourceOutcomes: undefined,
			documents: force ? {} : { ...existing?.documents }, profiles: force ? {} : { ...existing?.profiles } };
		const urlFailures: FailureEntry[] = [];

		for ( const viewport of routeProfiles ) {
			const vpPlan = profilePlan( viewport );
			if ( ! vpPlan.needsLoad ) continue;
			const additional = ! [ 'desktop', 'mobile' ].includes( viewport.id );
			const profileEntry: ManifestEntry = { slug, capturedAt: capturedAt() };

			// Retry a crashed renderer in a fresh context once. A disconnected browser
			// also needs the shared relaunch before the retry.
			for ( let crashRetry = false; ; crashRetry = true ) {
				const attemptBrowser = browser;
				const failuresBefore = urlFailures.length;
				let context: BrowserContext | undefined;
				let rendererCrashed = false;
				let aliasDisagreement = false;
				try {
					// deviceScaleFactor < 1 reduces the OUTPUT pixel count of every
					// screenshot while keeping the rendered layout identical to a
					// standard desktop session — the browser still does its layout
					// pass at the logical viewport (so CSS media queries hit their
					// real desktop branch), but emits a smaller PNG. Mobile stays at
					// scale 1 because its viewport is already small enough that
					// further reduction loses layout detail. See types.ts for the
					// rationale.
					// Each viewport loads as a real browser: builders can select viewport
					// metadata, navigation, and layout from the identity, and anti-bot
					// challenges refuse Playwright's default HeadlessChrome one.
					//
					// entryUrl (not `url`) is what gets navigated to harvest a session:
					// some sources gate every route/asset behind a session only the
					// tokenized ENTRY url establishes. Keyed by origin, so this navigates
					// once per run — every worker and viewport for every route reuses it.
					const sessionContext = await sourceContextOptions( attemptBrowser, entryUrl, { publicUrlsOnly: opts.publicUrlsOnly } );
					const device = viewport.device ? devices[ viewport.device ] : undefined;
					if ( viewport.device && ! device ) throw new Error( `Unknown source device profile: ${ viewport.device }` );
					const { defaultBrowserType: _deviceType, ...deviceContext } = device ?? {};
					const contextOptions: BrowserContextOptions = {
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
					const identity = replayBrowserIdentity( contextOptions );
					context = await attemptBrowser.newContext( contextOptions );
					// tsx/esbuild's keepNames transform wraps named const arrows with
					// `__name(fn, 'name')` calls; that helper doesn't exist in the browser
					// context. Polyfill as a no-op so our evaluate() closures can run.
					// String-form init script bypasses tsx transformation entirely.
					await context.addInitScript( `
	          if (typeof globalThis.__name === 'undefined') {
	            globalThis.__name = function (fn) { return fn; };
	          }
	        ` );
					await context.addInitScript( observeViewportEntrances );
					const page = await context.newPage();
					page.once( 'crash', () => { rendererCrashed = true; } );
					try {
						await capturePerViewport( {
							page,
							rendererCrashed: () => rendererCrashed,
							browserProfile: { isMobile: contextOptions.isMobile ?? false, hasTouch: contextOptions.hasTouch ?? false },
							viewport: { ...viewport, context: identity },
							plan: vpPlan,
							url,
							slug,
							archetype: classifyUrl( url ),
							settleMs,
							screenshotTimeoutMs,
							evaluateTimeoutMs,
							failures: urlFailures,
							entry: profileEntry,
							aggregator,
							shouldAnalyze: viewport.id === 'desktop' && shouldAnalyzeUrl,
							designCtx: additional ? undefined : designCtx,
							outputDir: opts.outputDir,
							responsiveImages,
							mobileHeights,
							resourceStore,
							publicUrlsOnly: opts.publicUrlsOnly ?? false,
							removeSelectors: opts.removeSelectors,
							cleanupPolicy: opts.cleanupPolicy,
							...( opts.collectResponsiveImages
								? { collectResponsiveImages: opts.collectResponsiveImages }
								: {} ),
							...( opts.learnFluid ? { learnFluid: true } : {} ),
							...( opts.fluidWidths ? { fluidWidths: opts.fluidWidths } : {} ),
							prepareCapture: opts.prepareCapture,
							resolveClientRedirect: opts.resolveClientRedirect,
							beforeSerialize: opts.beforeSerialize,
							observeSource: opts.observeSource,
							...( opts.canonicalizeHtml ? { canonicalizeHtml: opts.canonicalizeHtml } : {} ),
						} );
					} finally {
						// HTML and successful interaction evidence precede the final cleanup
						// audit. A late audit failure must record a failure, not erase those
						// artifacts (the prior shared-entry transaction retained them too).
						const previousInteractions = entry.interactions;
						const previousCleanup = entry.cleanup;
						const previousDocuments = entry.documents;
						const previousNativeViewTimelines = entry.nativeViewTimelines;
						// Every profile classifies the same initial document. A redirect
						// alias, local document and external boundary cannot coexist.
						const previousRedirect = entry.redirectedTo;
						const previousOutcomes = entry.sourceOutcomes ?? [];
						const previousLocal = Boolean( entry.html || entry.mobileHtml );
						const profileLocal = Boolean( profileEntry.html || profileEntry.mobileHtml );
						aliasDisagreement = profileEntry.redirectedTo
							? Boolean( ( previousRedirect && previousRedirect !== profileEntry.redirectedTo ) || previousLocal || previousOutcomes.length )
							: Boolean( previousRedirect && ( profileLocal || profileEntry.sourceOutcomes?.length ) );
						if ( viewport.id === 'desktop' ) {
							Object.assign( entry, profileEntry );
						}
						else if ( viewport.id === 'mobile' ) {
							if ( profileEntry.mobile ) entry.mobile = profileEntry.mobile;
							if ( profileEntry.mobileScrolled ) entry.mobileScrolled = profileEntry.mobileScrolled;
							if ( profileEntry.mobileHtml ) entry.mobileHtml = profileEntry.mobileHtml;
							if ( profileEntry.redirectedTo ) entry.redirectedTo = profileEntry.redirectedTo;
							if ( profileEntry.fluidMobile ) entry.fluidMobile = profileEntry.fluidMobile;
						}
						if ( viewport.id !== 'desktop' && profileEntry.sourceOutcomes?.length ) entry.sourceOutcomes = [ ...previousOutcomes, ...profileEntry.sourceOutcomes ];
						entry.documents = { ...previousDocuments, ...profileEntry.documents };
						if ( ! additional && profileEntry.nativeViewTimelines ) entry.nativeViewTimelines = { ...previousNativeViewTimelines, ...profileEntry.nativeViewTimelines };
						if ( ! additional ) {
							const latest = profileEntry.interactions;
							const accepted = latest && hasPromotableInteractionEvidence( previousInteractions, latest );
							entry.interactions = accepted ? mergeInteractionReports( previousInteractions, latest ) : previousInteractions;
						}
						if ( ! additional && ! entry.scrollStates?.toggles.length && profileEntry.scrollStates ) entry.scrollStates = profileEntry.scrollStates;
						if ( profileEntry.cleanup ) entry.cleanup = { policy: profileEntry.cleanup.policy, reports: [ ...( previousCleanup?.reports ?? [] ), ...profileEntry.cleanup.reports ] };
						const htmlPath = viewport.id === 'mobile' ? profileEntry.mobileHtml : profileEntry.html;
						const documentUrl = profileEntry.documents?.[ viewport.id ];
						entry.profiles![ viewport.id ] = { recipe: viewport, viewport: { width: viewport.width, height: viewport.height },
							identity,
							userAgent: contextOptions.userAgent, browserProfile: { isMobile: contextOptions.isMobile ?? false, hasTouch: contextOptions.hasTouch ?? false },
							deviceScaleFactor: contextOptions.deviceScaleFactor ?? 1, html: htmlPath,
							...( documentUrl ? { documentUrl } : {} ),
							// The learner's document label namespaces desktop/mobile rules;
							// every non-desktop pass writes fluidMobile, including extra profiles.
							fluid: viewport.id === 'desktop' ? profileEntry.fluid : profileEntry.fluidMobile,
							nativeViewTimelines: profileEntry.nativeViewTimelines,
							interactions: profileEntry.interactions, scrollStates: profileEntry.scrollStates,
						};
					}
					if ( aliasDisagreement ) throw new Error( 'Source redirect aliases disagree across viewports' );
					if ( additional && profileEntry.redirectedTo ) throw new Error( `Source profile ${ viewport.id } redirected to another document; identity was not captured` );
				} catch ( err ) {
					urlFailures.push( {
						url,
						viewport: viewport.id,
						stage: 'goto',
						error: err instanceof Error ? err.message : String( err ),
						timestamp: new Date().toISOString(),
						attempt: 1,
					} );
				} finally {
					if ( context ) {
						try {
							const pages = context.pages();
							await Promise.all( pages.map( ( page ) => resourceStore.settle( page ) ) );
						} catch {
							/* best-effort; failures are retained in the resource manifest */
						}
					}
					if ( context ) {
						try {
							await context.close();
						} catch {
							/* best-effort */
						}
					}
				}
				if ( rendererCrashed && urlFailures.length === failuresBefore ) {
					urlFailures.push( {
						url,
						viewport: viewport.id,
						stage: 'evaluate',
						error: 'source renderer crashed',
						timestamp: new Date().toISOString(),
						attempt: crashRetry ? 2 : 1,
					} );
				}
				for ( const failure of urlFailures.slice( failuresBefore ) ) {
					failure.attempt = crashRetry ? 2 : failure.attempt;
				}
				const failed = urlFailures.length > failuresBefore;
				if ( ! failed || crashRetry ) break;
				if ( attemptBrowser.isConnected() ) {
					if ( ! rendererCrashed ) break;
					sendLog( server, `[retry] renderer crashed for ${ url } (${ viewport.id }); using a fresh context` );
				} else if ( ! ( await replaceCrashedBrowser( attemptBrowser ) ) ) break;
				urlFailures.length = failuresBefore;
			}
			if ( viewport.id === 'desktop' && entry.html && ! additionalDeclared ) {
				const before = routeProfiles.length;
				declareAdditional( readFileSync( join( opts.outputDir, entry.html ), 'utf8' ) );
				for ( const profile of routeProfiles.slice( before ) ) opts.declareSourceProfile?.( url, profile );
			}
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
			const target = entry.redirectedTo;
			if ( ! queuedRoutes.has( normalizedUrl( target ) ) ) {
				queuedRoutes.add( normalizedUrl( target ) );
				urls.push( target );
			}
			skipped++;
			sendLog( server, `[alias] ${ url } redirects to ${ target }` );
			completed++;
			opts.onProgress?.( completed, urls.length, url );
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
		if ( urlFailures.length === 0 ) {
			captured++;
			sendLog( server, `[ok] ${ url }` );
		} else if ( captureFailures.length === 0 && absentFailures.length > 0 ) {
			skipped++;
			sendLog( server, `[skip] ${ url } (${ absentFailures[ 0 ].error })` );
		} else {
			allFailures.push( ...captureFailures );
			sendLog( server, `[fail] ${ url } (${ captureFailures.length } failures)` );
		}
		completed++;
		process.stderr.write( `[timing] route ${ Date.now() - routeStartedAt }ms ${ url }\n` );
		opts.onProgress?.( completed, urls.length, url );
	};

	try {
		// --- worker pool with browser restart at segment boundaries ----------
		// URLs are processed in segments of browserRestartEvery; WITHIN a segment a
		// continuous pool of `concurrency` workers drains a shared cursor, so a slow
		// page never stalls the others (the old slice loop waited for the slowest
		// URL in every group of `concurrency` before starting the next group). The
		// browser is restarted only between segments to bound memory, preserving the
		// restart-every-N invariant while keeping each worker on a stable browser.
		const segSize = browserRestartEvery > 0 ? browserRestartEvery : urls.length;
		for ( let segStart = 0; segStart < urls.length; segStart += segSize ) {
			// The segment's end is read on every claim: a redirect alias appends
			// its target to `urls`, and the worker that appended it is still
			// running to pick it up.
			const segEnd = () => Math.min( segStart + segSize, urls.length );
			let cursor = segStart;
			const worker = async (): Promise< void > => {
				// `cursor++` is atomic on JS's single-threaded loop: each worker claims a
				// distinct index synchronously before awaiting, so no URL runs twice.
				while ( cursor < segEnd() ) {
					await processUrl( urls[ cursor++ ] );
				}
			};
			const poolSize = Math.max( 1, Math.min( concurrency, segEnd() - segStart ) );
			await Promise.all( Array.from( { length: poolSize }, () => worker() ) );
			urlsSinceRestart += segEnd() - segStart;

			const moreWork = segStart + segSize < urls.length;
			if ( moreWork ) {
				sendLog( server, `[restart] closing browser after ${ urlsSinceRestart } URLs` );
				try {
					await browser.close();
				} catch {
					/* best-effort */
				}
				browser = ( await connectBrowser( { cdpPort: opts.cdpPort } ) ) as unknown as Browser;
				browserRestarts++;
				urlsSinceRestart = 0;
			}
		}
		// Discovery can omit links authored on a captured page. Inspect only a
		// bounded set of those links, using the source session and manual redirects:
		// never request an off-origin Location or persist its (possibly tokenized) URL.
		const scheduled = new Set( urls.map( documentRequestUrl ) );
		const candidates = new Set< string >();
		for ( const url of urls ) {
			const entry = manifest.getEntry( url );
			const htmlPath = entry?.html;
			if ( ! htmlPath || ! existsSync( join( opts.outputDir, htmlPath ) ) ) continue;
			const html = resolveDocumentReferences( readFileSync( join( opts.outputDir, htmlPath ), 'utf8' ), entry?.documents?.desktop?.url ?? url, entry?.documents?.desktop?.baseUrl );
			for ( const link of sameOriginPageAnchors( html, url ) ) {
				if ( ! scheduled.has( documentRequestUrl( link ) ) ) candidates.add( link );
			}
		}
		if ( candidates.size ) {
			let context: BrowserContext | undefined;
			try {
				context = await browser.newContext( await sourceContextOptions( browser, entryUrl, { publicUrlsOnly: opts.publicUrlsOnly } ) );
				for ( const url of [ ...candidates ].slice( 0, 32 ) ) {
					try {
						// A plain rerun must not trust a prior probe when the source changed.
						const prior = manifest.getEntry( url );
						if ( prior ) await manifest.updateEntry( url, { ...prior, externalRedirect: undefined, sourceAbsentStatus: undefined } );
						const inspected = await inspectSourceDocument(url, async (current, timeout) => {
							const response = await context!.request.get(current, {maxRedirects: 0, maxRetries: 0, timeout});
							try { return {url: current, status: response.status(), headers: response.headers(), body: await response.text()}; }
							finally { await response.dispose(); }
						}, opts.publicUrlsOnly);
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
	} finally {
		await resourceStore.flush();
		await manifest.flush();
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
		// Serialize design CSS aggregate if any pages/posts were captured
		if ( designCtx && designCtx.cssAgg.toString().trim() ) {
			try {
				designCtx.cssAgg.serialize( opts.outputDir );
			} catch ( err ) {
				sendLog(
					server,
					`[warn] design cssAgg serialize failed: ${
						err instanceof Error ? err.message : String( err )
					}`
				);
			}
		}
		// Serialize design JS aggregate when includeScripts=true and content was collected
		if ( designCtx && designCtx.jsAgg ) {
			const jsText = designCtx.jsAgg.toString().trim();
			if ( jsText ) {
				try {
					writeFileSync( join( opts.outputDir, 'site.js' ), jsText, 'utf8' );
				} catch ( err ) {
					sendLog(
						server,
						`[warn] design jsAgg serialize failed: ${
							err instanceof Error ? err.message : String( err )
						}`
					);
				}
			}
		}
		try {
			await browser.close();
		} catch {
			/* best-effort */
		}
	}

	const siteCssPath =
		designCtx && designCtx.cssAgg.toString().trim()
			? join( opts.outputDir, 'site.css' )
			: undefined;

	const siteJsTextRaw = designCtx?.jsAgg?.toString().trim();
	const siteJsText = siteJsTextRaw || undefined;

	// --- generate responsive chrome.css from dual-viewport layout maps ----------
	// Emit @media min-width:768px (desktop) + @media max-width:767px (mobile)
	// rules keyed on .dla-fx-N marker classes. Gracefully degrades to desktop-only
	// when mobile layout was not collected (different DOM, mobile capture failed,
	// or captureDesign=false).
	let chromeCssText: string | undefined;
	if ( designCtx?.chromeAccum.desktopLayoutMap ) {
		const css = generateChromeCss(
			designCtx.chromeAccum.desktopLayoutMap,
			designCtx.chromeAccum.mobileLayoutMap ?? undefined
		);
		if ( css.trim() ) {
			chromeCssText = css;
			try {
				writeFileSync( join( opts.outputDir, 'chrome.css' ), css, 'utf8' );
			} catch ( err ) {
				sendLog(
					server,
					`[warn] chrome.css write failed: ${ err instanceof Error ? err.message : String( err ) }`
				);
			}
		}
	}

	return {
		captured,
		skipped,
		failed: allFailures.length,
		browserRestarts,
		durationMs: Date.now() - startTime,
		manifestPath,
		urls,
		siteCssPath,
		cssMediaUrls: designCtx ? [ ...designCtx.cssMediaUrls ] : undefined,
		headLinks: designCtx ? [ ...designCtx.headLinks ] : undefined,
		siteJsText,
		nav: designCtx?.chromeAccum.nav ?? undefined,
		footerHtml: designCtx?.chromeAccum.footerHtml ?? undefined,
		chromeCssText,
	};
}

/**
 * Keep the page on its route while post-baseline probes drive it. A probe can
 * trigger a navigation no click handler can cancel -- a script assigning
 * `location` after a swatch or card is activated -- and a committed navigation
 * replaces the document, taking the capture's in-page evidence with it, so a
 * route whose baseline was already captured would fail. Aborting main-frame
 * document requests leaves the current document in place; every other request
 * falls through to the capture's existing routing.
 */
export async function lockMainFrameNavigation( page: Page, onAttempt?: () => void, allowReload = false ): Promise< () => Promise< void > > {
	if ( ! page.route ) return async () => {};
	let reloads = 0;
	const deadline = Date.now() + SOURCE_NAVIGATION_LIMITS.timeoutMs;
	const guard = async ( route: Route ) => {
		const request = route.request();
		if ( request.isNavigationRequest() && request.frame() === page.mainFrame() ) {
			if (allowReload && request.method() === 'GET' && reloads < SOURCE_NAVIGATION_LIMITS.hops && Date.now() < deadline) {
				const current = new URL(page.url()); current.hash = '';
				if (request.url() === current.href) {
					reloads++;
					try { await replaySourceReload(route, current.href, deadline - Date.now()); return; }
					catch { /* A reload changing identity/outcome remains unexplained drift. */ }
				}
			}
			onAttempt?.();
			await route.abort( 'aborted' );
			return;
		}
		await route.fallback();
	};
	await page.route( '**/*', guard );
	return async () => {
		await page.unroute( '**/*', guard ).catch( () => {} );
	};
}

/**
 * Apply an adapter's HTML rewrite to every string in an interaction report
 * (dialog markup, trigger and dialog selectors), then restate each dialog's
 * byte count, which consumers verify against the markup.
 */
function canonicalizeInteractionReport< T >( report: T, canonicalize: ( html: string ) => string ): T {
	const rewrite = ( value: unknown ): unknown => {
		if ( typeof value === 'string' ) return canonicalize( value );
		if ( Array.isArray( value ) ) return value.map( rewrite );
		if ( value && typeof value === 'object' ) {
			const source = value as Record< string, unknown >;
			const out: Record< string, unknown > = {};
			for ( const [ key, child ] of Object.entries( source ) ) out[ key ] = rewrite( child );
			// A complete dialog's byte count describes its markup; a truncated one
			// records the original size, which the rewrite does not change.
			if (
				typeof source.html === 'string' &&
				typeof out.html === 'string' &&
				source.htmlBytes === Buffer.byteLength( source.html )
			) {
				out.htmlBytes = Buffer.byteLength( out.html );
			}
			return out;
		}
		return value;
	};
	return rewrite( report ) as T;
}
