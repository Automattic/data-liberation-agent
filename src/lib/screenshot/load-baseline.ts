import type { Page } from 'playwright';
import type { LiberationContext } from '../../adapters/page-actions.js';
import type { ScreenshotOpts, Viewport } from './types.js';
import type { FailureEntry, ManifestEntry, ProfileDiagnostic } from './manifest-queue.js';
import type { PhaseLedger } from './phase-ledger.js';
import { lockMainFrameNavigation } from './probe-guards.js';
import { sourceGovernorFor } from '../browser-kit/source-traffic.js';
import { isSourceTransportThrottle } from '../source-request-governor.js';
import { sameHttpSite } from './same-origin.js';
import { externalNavigationMessage, navigateSourceDocument, storeExternalBoundary, isNavigationTimeout, maxSourceNavigationBudgetMs, SOURCE_LOAD_INCOMPLETE, SOURCE_SCRIPT_NAVIGATION, SOURCE_NAVIGATION_LIMITS, SOURCE_NAVIGATION_SLOW, SourceNavigationError } from '../source-navigation.js';
import { resolveDocumentReferences } from '../document-resource-base.js';
import { applyCaptureRemovals } from './apply-removals.js';
import { accessGateRemoval, cleanupPolicyForResponse, applySourceCleanup, readSourceCleanup, cleanupPolicy, type CleanupPolicy } from '../source-cleanup.js';
import { accessGateNote, installAccessGatePlaceholder, openAccessGateShell, routeKeptContent, type AccessGateEvidence } from '../access-gate.js';
import { navigationDocumentUrl, serverRedirectTarget } from './document-integrity.js';
import { waitForHiddenEmbeds } from './embed-readiness.js';
import { nonHtmlDocumentError } from './absent-document.js';
import { rejectedNavigationReason } from './navigation-rejection.js';
import { waitForStable, triggerLazyLoad, dismissOverlays, pageResponds, withEvaluateTimeout, isEvaluateTimeout } from './page-helpers.js';
import { sameOriginPageAnchors } from './unscheduled-anchors.js';
import { ROUTE_ALIAS_CANONICAL, queryOnlyCanonicalTarget } from '../route-aliases.js';
import { orElse } from '../failure-class.js';

export async function renderedQueryAlias( page: Page, url: string, scope: ScreenshotOpts['routeScope'] ): Promise< string | undefined > {
	const canonical = await page.evaluate( () => ( document.querySelector( 'link[rel~="canonical" i][href]' ) as HTMLLinkElement | null )?.href ).catch( orElse( undefined ) );
	return queryOnlyCanonicalTarget( url, canonical, scope );
}
/** Pause before retrying a navigation that failed for a reason the origin governor does not pace. */
function navBackoff( attempt: number ): Promise< void > {
	return new Promise( resolve => setTimeout( resolve, Math.min( 1000 * 2 ** ( attempt - 1 ), 15_000 ) ) );
}

export interface SourceLoad {
	serverHtml: string | undefined;
	navigationUrl: string;
	sourcePolicy: CleanupPolicy;
	/** Read after load too: the navigation lock can report later drift. */
	readonly externalNavigation: string | undefined;
	releaseBaselineNavigation: () => Promise<void>;
}

interface SourceLoadInput {
	page: Page;
	url: string;
	viewport: Viewport;
	outputDir: string;
	entry: ManifestEntry;
	diagnostics?: ProfileDiagnostic[];
	phases?: PhaseLedger;
	routeScope?: ScreenshotOpts['routeScope'];
	browserProfile: Readonly<{ isMobile: boolean; hasTouch: boolean }>;
	publicUrlsOnly: boolean;
	serverLinks: Set<string>;
	rendererCrashed: () => boolean;
	sourceErrors: () => string[];
	fail: ( stage: FailureEntry['stage'], error: unknown, attempt?: number ) => void;
	cleanupPolicy?: CleanupPolicy;
	resolveClientRedirect?: ( page: Page, url: string ) => Promise<string | undefined>;
	canonicalQueryAlias?: boolean;
	observeSource?: ScreenshotOpts['observeSource'];
	recoverIncompleteDocument?: boolean;
	settleMs: number;
	evaluateTimeoutMs: number;
	consentViewports?: ReadonlyArray<{ id?: string; width: number; height: number }>;
	learnFluid?: boolean;
	removeSelectors?: string[];
	prepareCapture?: ( page: Page, ctx: LiberationContext ) => Promise<void>;
}

/** Load and prepare the source document before baseline observation. */
export async function loadSourceBaseline( args: SourceLoadInput ): Promise<SourceLoad | undefined> {
	const { page, url, viewport, outputDir, entry, publicUrlsOnly, sourceErrors, fail, settleMs, evaluateTimeoutMs } = args;
	const isMobile = viewport.id === 'mobile';
	let serverHtml: string | undefined;
	let navigationUrl = url;
	let releaseBaselineNavigation: () => Promise<void> = async () => {};
	let externalNavigation: string | undefined;
	let sourcePolicy = args.cleanupPolicy ?? cleanupPolicy();
	// --- navigation (with 429/503 backoff) ------------------------------------
	// Shopify and other CDNs rate-limit aggressive concurrent capture with HTTP 429
	// (and transient 503s). Without backoff one throttle cascades into wholesale
	// failure (see DISCOVERIES 2026-06-04 — getsnooz's 168-op cascade). Retry the
	// retryable statuses + transient nav errors, honoring Retry-After, before
	// recording the failure. Non-retryable 4xx fail immediately. A timeout is
	// different: repeating the same budget against a slow origin only repeats
	// the same timeout, so it gets exactly one retry with a longer budget, and
	// that slow retry is the last attempt whatever its outcome.
	const RETRYABLE_STATUS = new Set( [ 429, 503 ] );
	const MAX_NAV_ATTEMPTS = 4;
	let budgetMs: number = SOURCE_NAVIGATION_LIMITS.timeoutMs;
	let timedOut: { budgetMs: number; error: string } | undefined;
	let navigated = false;
	let attempt = 0;
	// The origin governor owns Retry-After pauses, refusal confirmation and
	// the blocked-client verdict; this loop adds backoff only below.
	const governor = sourceGovernorFor( page.context?.(), url );
	const mayRetry = () => attempt < MAX_NAV_ATTEMPTS && ! timedOut && ! governor?.blockedClient;
	let redirectedTo: string | undefined;
	while ( ++attempt <= MAX_NAV_ATTEMPTS ) {
		try {
			// Refusal confirmation waits here, outside the navigation budget.
			await governor?.admitSourceRequest();
			args.phases?.enter( 'navigate' );
			const started = Date.now();
			const navigation = await navigateSourceDocument(page, url, {publicUrlsOnly, routeScope: args.routeScope, timeoutMs: budgetMs});
			const answeredMs = Date.now() - started;
			if (navigation.boundary) {
				const boundary = storeExternalBoundary(outputDir, navigation.boundary, viewport.width, args.browserProfile ?? {isMobile: false, hasTouch: false});
				entry.sourceOutcomes = [...(entry.sourceOutcomes ?? []), boundary];
				await args.observeSource?.(page, url, viewport.id, sourceErrors(), args.browserProfile, viewport, boundary);
				return undefined;
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
				if ( RETRYABLE_STATUS.has( status ) && mayRetry() ) continue;
				// Evidence only: a body that cannot be read leaves the plain status.
				const rejectedBody = status === 403 ? await Promise.resolve().then( () => response?.text() ).catch( orElse( undefined ) ) : undefined;
				fail( 'goto', rejectedNavigationReason( status, response?.headers?.(), rejectedBody ), attempt );
				return undefined;
			}
			const notHtml = nonHtmlDocumentError( response?.headers?.()?.[ 'content-type' ] );
			if ( notHtml ) {
				fail( 'goto', notHtml, attempt );
				return undefined;
			}
			// The document arrived; capture's own bounded readiness takes over
			// from here, so a pending subresource is evidence, not a failure.
			if ( navigation.scriptNavigationUrl ) args.diagnostics?.push( { code: SOURCE_SCRIPT_NAVIGATION, reason: `source script navigated the delivered document to ${ navigation.scriptNavigationUrl }; replayed as the same route's reload` } );
			if ( navigation.loadIncomplete ) args.diagnostics?.push( { code: SOURCE_LOAD_INCOMPLETE, reason: `load event did not fire within the ${ budgetMs }ms navigation budget; subresources were still pending` } );
			if ( navigation.subresourceLoss ) args.diagnostics?.push( { code: 'source_subresource_loss', reason: 'Reset or throttled subresource loads remained after bounded document recovery' } );
			if ( timedOut ) args.diagnostics?.push( { code: SOURCE_NAVIGATION_SLOW, reason: `document did not arrive within the ${ timedOut.budgetMs }ms navigation budget (${ timedOut.error }); the single slow-source retry, attempt ${ attempt }, used a ${ budgetMs }ms budget and delivered it in ${ answeredMs }ms` } );
			// Evidence only: a body that cannot be read leaves adapters on their live-DOM path.
			serverHtml = await Promise.resolve().then( () => response?.text() ).catch( orElse( undefined ) );
			sourcePolicy = cleanupPolicyForResponse(args.cleanupPolicy ?? cleanupPolicy(), response, serverHtml ?? '');
			if ( serverHtml ) for ( const link of sameOriginPageAnchors( resolveDocumentReferences( serverHtml, navigationUrl ), navigationUrl ) ) args.serverLinks.add( link );
			navigated = true;
			break;
		} catch ( err ) {
			if ( args.rendererCrashed() ) return undefined;
			if ( isNavigationTimeout( err ) ) {
				if ( mayRetry() ) {
					timedOut = { budgetMs, error: err instanceof Error ? err.message.split( '\n' )[ 0 ]! : String( err ) };
					budgetMs = maxSourceNavigationBudgetMs();
					await navBackoff( attempt );
					continue;
				}
				fail( 'goto', err, attempt );
				return undefined;
			}
			if ( mayRetry() && !(err instanceof SourceNavigationError) ) {
				// The governor paces one refusal; a sustained one also needs this
				// backoff so the route outlasts a burst of resets.
				if ( ! governor || ! isSourceTransportThrottle( err ) || governor.hasSustainedRefusal ) await navBackoff( attempt );
				continue;
			}
			fail( 'goto', err, attempt );
			return undefined;
		}
	}
	if ( ! navigated ) return undefined;
	// The server answered this URL with a redirect to another route, so it is
	// an alias of that route rather than a page of its own; the caller
	// captures the target once, under its own URL.
	if ( redirectedTo ) {
		entry.redirectedTo = redirectedTo;
		return undefined;
	}
	// Some platforms answer 200 before their client router replaces an unavailable
	// child route with its parent. Only an adapter-confirmed target is an alias;
	// all other post-load navigation remains a route-drift failure.
	if ( args.resolveClientRedirect ) {
		const target = await args.resolveClientRedirect( page, url ).catch( orElse( undefined ) );
		if ( target && serverRedirectTarget( url, target ) === target ) {
			entry.redirectedTo = target;
			return undefined;
		}
	}
	// A query rendition (a tracking or source parameter on a link) whose
	// rendered rel=canonical is the same path is that route's document, as
	// export's duplicate detection would conclude after a full capture. Read
	// from the rendered document because server HTML can be withheld from
	// plain HTTP probes (#835). It continues as an alias, so the canonical
	// route is captured once and no rendition spends a full browser pass.
	if ( args.canonicalQueryAlias && new URL( url ).search ) {
		const target = await renderedQueryAlias( page, url, args.routeScope );
		if ( target ) {
			args.diagnostics?.push( { code: ROUTE_ALIAS_CANONICAL, reason: `rendered rel=canonical resolves to ${ target }; captured once under that route` } );
			entry.redirectedTo = target;
			return undefined;
		}
	}
	// Initial declarations have been classified. Any later main-document
	// request during baseline preparation is drift, even if aborting leaves the
	// old DOM intact. Keep the network boundary without hiding the failure.
	const baselineDrift = ( destination: string ) => {
		if ( ! sameHttpSite( destination, url ) ) {
			externalNavigation = externalNavigationMessage( destination );
			fail( 'content', externalNavigation );
		} else {
			fail( 'content', 'route drift: unexplained navigation during source baseline capture' );
		}
	};
	releaseBaselineNavigation = await lockMainFrameNavigation(page, baselineDrift, true);
	await applySourceCleanup(page, sourcePolicy);

	// --- settle, dismiss overlays, lazy load ----------------------------------
	args.phases?.enter( 'settle' );
	if ( args.recoverIncompleteDocument ) await page.waitForTimeout( Math.max( settleMs, 3_000 ) );
	await waitForStable( page );
	// The shorter phone pass must not freeze a load-delayed iframe reveal.
	// No hidden frames means no timer or observer; permanent hides are bounded.
	if ( isMobile ) await withEvaluateTimeout( page.evaluate( waitForHiddenEmbeds, 5_000 ), evaluateTimeoutMs ).catch( orElse( undefined ) );
	// A provider login withholding the whole route (a members-only page) was
	// removed by the policy, leaving nothing of the page. Capture it as a
	// placeholder inside the site's public shell instead (see access-gate.ts).
	// Read before any probe clicks, so a login pop-up a control opens later is
	// never mistaken for a gated route.
	// The settle waits are bounded and best-effort, so a page that stopped
	// answering during them arrives here; bound these reads too.
	let accessGate: AccessGateEvidence | undefined;
	let gate: ReturnType< typeof accessGateRemoval >;
	let gateTitle = '';
	const stoppedResponding = ( error: unknown, during: string ): undefined => {
		if ( ! isEvaluateTimeout( error ) ) throw error; // failure-class: operational
		fail( 'evaluate', `page stopped responding while settling (${ during }): no answer to an evaluate within ${ evaluateTimeoutMs }ms` );
		return undefined;
	};
	try {
		const gateRemoval = accessGateRemoval( await withEvaluateTimeout( readSourceCleanup( page, sourcePolicy ), evaluateTimeoutMs ), sourcePolicy );
		gate = gateRemoval && ! ( await withEvaluateTimeout( routeKeptContent( page ), evaluateTimeoutMs ) ) ? gateRemoval : undefined;
		if ( gate ) gateTitle = ( await withEvaluateTimeout( page.title().catch( orElse( '' ) ), evaluateTimeoutMs ) ).trim();
	} catch ( error ) {
		return stoppedResponding( error, 'source cleanup / access gate' );
	}
	if ( gate ) {
		// Loading the public shell is this capture's own explained navigation.
		await releaseBaselineNavigation();
		let shell: string | undefined;
		try {
			shell = await openAccessGateShell( page, url );
		} finally {
			releaseBaselineNavigation = await lockMainFrameNavigation( page, baselineDrift, true );
		}
		try {
			if ( shell ) {
				await withEvaluateTimeout( applySourceCleanup( page, sourcePolicy ), evaluateTimeoutMs );
				await waitForStable( page );
			}
			accessGate = { ...gate, ...( shell ? { shell } : {} ) };
			const placed = await withEvaluateTimeout( page.evaluate( installAccessGatePlaceholder, {
				route: url, gateTitle, note: accessGateNote( gate.provider ), provider: gate.provider,
			} ), evaluateTimeoutMs );
			accessGate.label = placed.label;
			entry.accessGate = accessGate;
		} catch ( error ) {
			return stoppedResponding( error, 'access-gate shell' );
		}
	}
	// Dismiss takeover modals / consent banners BEFORE lazy-load (a modal's
	// scroll-lock would defeat the scroll-through) and again AFTER (scrolling can
	// trigger exit-intent / scroll-depth popups). Best-effort: never fails capture.
	args.phases?.enter( 'lazy-load' );
	const dismissedEarly = await dismissOverlays( page, { consentViewports: args.consentViewports } );
	await triggerLazyLoad( page, args.learnFluid === true, { expandContent: false } );
	const dismissedLate = await dismissOverlays( page, { consentViewports: args.consentViewports } );
	args.phases?.enter( 'baseline' );
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
		fail( 'evaluate', `page stopped responding while settling (overlay dismissal / lazy load): no answer to an evaluate within ${ evaluateTimeoutMs }ms` );
		return undefined;
	}

	// Seam 1: deterministic adapter-declared removals on the settled page, so they
	// pollute neither screenshot, carried HTML, mobile carry, nor SectionSpec.
	await applyCaptureRemovals( page, {
		removeSelectors: args.removeSelectors,
		prepare: args.prepareCapture,
		ctx: { url, viewport: viewport.id, serverHtml },
	} );

	return { serverHtml, navigationUrl, sourcePolicy, get externalNavigation() { return externalNavigation; }, releaseBaselineNavigation };
}
