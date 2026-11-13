import { attributeSourceDevice, categorizeSourceContext, getSourceResponse, sourceDocumentHtml } from '../browser-kit/source-traffic.js';
import { createSourceContext } from '../browser-kit/index.js';
import { assertPublicHttpUrl } from '../media-fetch/safe-fetch.js';
import { navigateSourceDocument, isNavigationTimeout } from '../source-navigation.js';
import { applyCaptureRemovals } from './apply-removals.js';
import { cleanupPolicyForResponse, applySourceCleanup, cleanupPolicy, type CleanupPolicy } from '../source-cleanup.js';
import { captureTriggeredDialogs, type CapturedDialogInteraction, type InteractionStatesReport } from './interaction-capture.js';
import { type ProfileDiagnostic } from './manifest-queue.js';
import { waitForStable, dismissOverlays, withEvaluateTimeout, restoreTopScrollState, settleDocument, observePageTraffic } from './page-helpers.js';
import { type ScreenshotOpts } from './types.js';
import { carrySelectors, recordedSelectors, withCarriedSelectors, inlineRuntimeHash, externalScriptSources, observeSwitchWidth, RouteDeviceEvidence, retryRouteDeviceCheck, compareBodyClasses, compareServerHtml, compareStructure, decideRouteMode, decideSiteMode, replayableRequestHeaders, resampleSiteServerHtml, renderedBodyClasses, renderedElementPaths, renderedElementStructure, SERVER_HTML_IGNORED, shortScroll, STRUCTURE_IGNORED, stylesheetSwitchBoundaries, type ObservedSwitch, visibleControlPaths, type DeviceModeDecision, type DeviceModeRequest, type RouteDeviceDecision, switchProbeIdentity, type SwitchRendering } from './device-mode.js';
import { CHROME_ROOT_ATTRIBUTE, CHROME_REUSED_ATTRIBUTE, OUTSIDE_CHROME, type SharedChromeProbe } from './chrome-reuse.js';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { installReadOnlyProbeGuard, withReadOnlyProbes, lockMainFrameNavigation } from './probe-guards.js';
import { canonicalizeInteractionReport } from './canonicalize-interaction-report.js';
import { boundSharedChromeProbe, probeChromeOnPage } from './chrome-reuse.js';

/** Marks phone-page controls the desktop pass already probes; removed from evidence. */
const DESKTOP_CONTROL_ATTRIBUTE = 'data-lib-desktop-control';

/**
 * Phone-only controls of a reflow-only route's chrome that has no reusable
 * entrypoint evidence: an interior template's header whose links differ from
 * the entrypoint's, say. The route is captured at desktop only, where a phone
 * menu button is not laid out, so the desktop probe never opens it, and its
 * dropdown would ship without the dropdown/dialog evidence that keeps it
 * closed and toggleable. The same document reflows to phone width, so the
 * page is resized there, the unmatched roots' controls not visible at desktop
 * are probed — as the entrypoint's phone-only probe does — and the desktop
 * size is restored. Nothing is resized when those roots hold no such control.
 */
export async function probePhoneOnlyChrome(
	page: Page,
	url: string,
	roots: readonly string[],
	phone: { width: number; height: number }
): Promise< CapturedDialogInteraction[] > {
	const marks = [ CHROME_ROOT_ATTRIBUTE, DESKTOP_CONTROL_ATTRIBUTE ];
	const concealed = await page.evaluate( ( { roots, rootAttribute, desktopAttribute, reusedAttribute } ) => {
		const shown = ( element: Element ) => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle( element );
			return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
		};
		const control = 'button,summary,[role="button"],[aria-controls],[aria-expanded],[aria-haspopup]';
		let hidden = 0;
		for ( const selector of roots ) {
			const root = document.querySelector( selector );
			if ( ! root ) continue;
			root.setAttribute( rootAttribute, '' );
			for ( const element of [ root, ...Array.from( root.querySelectorAll( '*' ) ) ] ) {
				if ( shown( element ) ) element.setAttribute( desktopAttribute, '' );
				// A matching nested landmark is still owned by the entrypoint probe.
				else if ( element.hasAttribute( reusedAttribute ) ) continue;
				// A builder's menu control is a plain element with a pointer cursor.
				else if ( element.matches( control ) || getComputedStyle( element ).cursor === 'pointer' ) hidden++;
			}
		}
		return hidden;
	}, { roots: [ ...roots ], rootAttribute: CHROME_ROOT_ATTRIBUTE, desktopAttribute: DESKTOP_CONTROL_ATTRIBUTE, reusedAttribute: CHROME_REUSED_ATTRIBUTE } );
	const clear = () => page.evaluate( ( names ) => {
		for ( const name of names ) for ( const element of Array.from( document.querySelectorAll( `[${ name }]` ) ) ) element.removeAttribute( name );
	}, marks ).catch( () => undefined );
	if ( ! concealed ) {
		await clear();
		return [];
	}
	const desktop = page.viewportSize();
	const settle = () => page.evaluate( () => new Promise< void >( resolve => requestAnimationFrame( () => requestAnimationFrame( () => setTimeout( resolve, 150 ) ) ) ) );
	try {
		await page.setViewportSize( phone );
		await settle();
		await restoreTopScrollState( page );
		const report = await captureTriggeredDialogs( page, url, { skip: `${ OUTSIDE_CHROME },[${ DESKTOP_CONTROL_ATTRIBUTE }],[${ CHROME_REUSED_ATTRIBUTE }]` } );
		const marker = new RegExp( `\\s(?:${ marks.join( '|' ) })(?:="")?`, 'g' );
		return canonicalizeInteractionReport( report, html => html.replace( marker, '' ) ).states;
	} finally {
		await clear();
		if ( desktop ) {
			await page.setViewportSize( desktop ).catch( () => undefined );
			await settle().catch( () => undefined );
			await restoreTopScrollState( page ).catch( () => undefined );
		}
	}
}

export interface DeviceComparisonArgs {
	governors?: ScreenshotOpts['governors'];
	browser: Browser;
	url: string;
	desktop: BrowserContextOptions;
	phone: BrowserContextOptions;
	publicUrlsOnly: boolean;
	routeScope?: ScreenshotOpts['routeScope'];
	cleanupPolicy?: CleanupPolicy;
	removeSelectors?: string[];
	prepareCapture?: ScreenshotOpts['prepareCapture'];
	initScript?: ScreenshotOpts['initScript'];
	telemetryRequest?: ScreenshotOpts['telemetryRequest'];
	probeDiagnostic?: ( diagnostic: ProfileDiagnostic ) => void;
	deviceEvidence?: RouteDeviceEvidence;
	identityHeaders?: Partial< Record< 'desktop' | 'mobile', Record< string, string > > >;
}

interface DeviceModeProbeArgs extends DeviceComparisonArgs {
	requested: DeviceModeRequest;
	/** Adapter hooks that declare per-device documents. */
	deviceDocuments: string[];
	canonicalizeHtml?: ( html: string ) => string;
	/** Also run the one-time shared-chrome probe on the loaded entrypoint pages. */
	sharedChrome?: boolean;
}

/** Resource types a structure check does without: no decode, little memory. */
const CHECK_BLOCKED_RESOURCES = new Set( [ 'image', 'media', 'font' ] );
const CHECK_LOAD_WAIT_MS = 2_000;
/** Extra wait before a differing route is read a second time. */
const CHECK_RECHECK_MS = 1_500;

/**
 * Load one identity of a route for a desktop/phone comparison and read its
 * server HTML, element paths and body classes. `check` is the cheap per-route
 * form: images, media and fonts are blocked and settling is bounded. The
 * entrypoint probe loads everything, because its phone page also runs the
 * phone-only control probe. Both identities of one comparison always load the
 * same way, so their signatures are comparable.
 */
export async function loadForComparison( args: DeviceComparisonArgs, options: BrowserContextOptions, viewport: 'desktop' | 'mobile', mode: 'probe' | 'check', contexts: BrowserContext[], timings?: NonNullable< RouteDeviceDecision['checkTimings'] > ) {
	const startedAt = Date.now();
	const context = await createSourceContext( args.browser, options, { governors: args.governors, sourceUrl: args.url } );
	contexts.push( context );
	categorizeSourceContext(context, 'device-check');
	await context.addInitScript( "if(typeof globalThis.__name==='undefined')globalThis.__name=function(fn){return fn;};" );
	const page = await context.newPage();
	await args.initScript?.(page);
	// The comparison and shared-chrome probes wait on the same render-affecting
	// quiet as capture; watch the page's traffic from before its navigation.
	observePageTraffic( page, args.telemetryRequest );
	if ( args.publicUrlsOnly || mode === 'check' ) {
		await page.route( '**/*', async ( route ) => {
			const request = route.request();
			// Embedded documents load whole third-party pages; their <iframe> element stays.
			if ( mode === 'check' && ( CHECK_BLOCKED_RESOURCES.has( request.resourceType() ) || ( request.resourceType() === 'document' && request.frame() !== page.mainFrame() ) ) ) { await route.abort( 'blockedbyclient' ); return; }
			if ( args.publicUrlsOnly ) {
				try { assertPublicHttpUrl( request.url() ); }
				catch { await route.abort( 'blockedbyclient' ); return; }
			}
			await route.fallback();
		} );
	}
	let target = args.url;
	const navigationOptions = { publicUrlsOnly: args.publicUrlsOnly, routeScope: args.routeScope, ...( mode === 'check' ? { loadWaitMs: CHECK_LOAD_WAIT_MS } : {} ) };
	let navigation = await navigateSourceDocument( page, target, navigationOptions );
	// A route is captured under its redirect target; compare that document.
	if ( navigation.redirectedTo ) {
		target = navigation.redirectedTo;
		navigation = await navigateSourceDocument( page, target, navigationOptions );
	}
	// failure-class: operational
	if ( navigation.boundary || navigation.redirectedTo ) throw new Error( `the ${ viewport } document left its route` );
	const status = navigation.response?.status() ?? 0;
	// failure-class: operational
	if ( status >= 400 || status === 0 ) throw new Error( `the ${ viewport } document answered HTTP ${ status }` );
	if ( args.identityHeaders && navigation.response ) args.identityHeaders[ viewport ] = replayableRequestHeaders( await navigation.response.request().allHeaders() );
	const html = await navigation.response?.text().catch( () => undefined );
	const settledAt = Date.now();
	if ( timings ) timings.navigate = Math.max( timings.navigate, settledAt - startedAt );
	await applySourceCleanup( page, cleanupPolicyForResponse(args.cleanupPolicy ?? cleanupPolicy(), navigation.response, html ?? '') );
	if ( mode === 'check' ) {
		// Bounded after the document is parsed: up to CHECK_LOAD_WAIT_MS for
		// `load`, up to 0.5 s of network quiet, the short scroll, then up to 1 s
		// of DOM quiet. Both identities are bounded alike.
		await Promise.race( [ page.waitForLoadState( 'networkidle' ).catch( () => {} ), new Promise( resolve => setTimeout( resolve, 500 ) ) ] );
		await withEvaluateTimeout( shortScroll( page ), 5_000 );
		await settleDocument( page, 'stable', { quietMs: 300, timeoutMs: 1_000 } ).catch( () => {} );
	} else {
		await waitForStable( page );
		await withEvaluateTimeout( shortScroll( page ), 10_000 );
		await waitForStable( page, 2_000 );
	}
	await applyCaptureRemovals( page, { removeSelectors: args.removeSelectors, prepare: args.prepareCapture, ctx: { url: target, viewport } } );
	if ( mode === 'probe' ) await installReadOnlyProbeGuard( page, diagnostic => args.probeDiagnostic?.( diagnostic ) );
	// Reuse the actual navigation identity (including client hints) for a cheap
	// site-probe re-sample. Cookies come from the still-live source context.
	const fetchServerHtml = async () => {
		if ( ! navigation.response ) return undefined;
		const headers = replayableRequestHeaders( await navigation.response.request().allHeaders() );
		const response = await getSourceResponse(context, target, { headers, maxRedirects: 0, maxRetries: 0, timeout: 30_000 });
		try { return response.ok() ? await response.text() : undefined; }
		finally { await response.dispose(); }
	};
	const structure = await withEvaluateTimeout( renderedElementStructure( page ), 10_000 );
	const result = { page, html, target, fetchServerHtml, paths: structure.paths, classTokens: structure.classTokens, bodyClasses: await withEvaluateTimeout( renderedBodyClasses( page ), 10_000 ) };
	if ( timings ) timings.settle = Math.max( timings.settle, Date.now() - settledAt );
	return result;
}

/** Neither or one identity produced a comparable document. `same`: both failed the same way. */
class ComparisonUnavailable extends Error {
	constructor( message: string, readonly same: boolean ) { super( message ); }
}

/**
 * Both identities of a comparison failed alike, so the route has no phone
 * document to keep. A timeout never counts: the check navigates once at the
 * base budget, while capture retries a slow source with a longer one, so a
 * slow route can still deliver both documents.
 */
export function comparisonFailedAlike( desktop: unknown, phone: unknown ): boolean {
	const message = ( reason: unknown ) => String( reason instanceof Error ? reason.message : reason ).replace( /^the (desktop|mobile) /, 'the ' );
	return ! isNavigationTimeout( desktop ) && ! isNavigationTimeout( phone ) && message( desktop ) === message( phone );
}

/** Compare the desktop and phone identities of one route, loaded the same way. */
async function compareIdentities( args: DeviceComparisonArgs, mode: 'probe' | 'check', contexts: BrowserContext[], timings?: NonNullable< RouteDeviceDecision['checkTimings'] > ) {
	const [ desktopLoad, phoneLoad ] = await Promise.allSettled( [ loadForComparison( args, args.desktop, 'desktop', mode, contexts, timings ), loadForComparison( args, args.phone, 'mobile', mode, contexts, timings ) ] );
	if ( desktopLoad.status === 'rejected' || phoneLoad.status === 'rejected' ) {
		const reason = ( result: PromiseSettledResult< unknown > ) => result.status === 'rejected' ? String( result.reason instanceof Error ? result.reason.message : result.reason ).replace( /^the (desktop|mobile) /, 'the ' ) : undefined;
		// failure-class: operational
		throw new ComparisonUnavailable( reason( desktopLoad ) ?? reason( phoneLoad )!, desktopLoad.status === 'rejected' && phoneLoad.status === 'rejected' && comparisonFailedAlike( desktopLoad.reason, phoneLoad.reason ) );
	}
	const desktop = desktopLoad.value;
	const phone = phoneLoad.value;
	// failure-class: operational
	if ( phone.target !== desktop.target ) throw new Error( 'the desktop and phone documents redirect to different routes' );
	const serverHtml: NonNullable< DeviceModeDecision['serverHtml'] > = desktop.html === undefined || phone.html === undefined ? 'unavailable' : compareServerHtml( desktop.html, phone.html );
	return { desktop, phone, url: desktop.target, serverHtml, structure: compareStructure( desktop.paths, phone.paths ), bodyClasses: compareBodyClasses( desktop.bodyClasses, phone.bodyClasses ) };
}

/**
 * Per-route check under a `reflow-only` site. Both identities use the same
 * bounded, resource-blocked policy. Capture's fully loaded desktop is not a
 * comparable baseline: resource load handlers can change its DOM.
 * Both comparison contexts close before the route's capture starts, so the
 * pair never competes with capture's own loads.
 */
export async function checkRouteDeviceMode( args: DeviceComparisonArgs ): Promise< RouteDeviceDecision > {
	const started = Date.now();
	let switchCandidates: SwitchCandidates | undefined;
	const result = await retryRouteDeviceCheck( async () => {
		const contexts: BrowserContext[] = [];
		try {
			if ( args.publicUrlsOnly ) assertPublicHttpUrl( args.url );
			const documents = await Promise.all( ( [ 'desktop', 'mobile' ] as const ).map( async identity => {
				const context = await createSourceContext( args.browser, identity === 'desktop' ? args.desktop : args.phone, { governors: args.governors, sourceUrl: args.url } );
				attributeSourceDevice(context, identity === 'desktop' ? 'desktop' : 'mobile');
				categorizeSourceContext(context, 'device-check');
				contexts.push( context );
				const headers = args.identityHeaders?.[ identity ];
				if ( ! headers ) return undefined;
				return sourceDocumentHtml(context, args.url, replayableRequestHeaders(headers));
			} ) );
			const [ desktop, phone ] = documents;
			if ( desktop !== undefined && phone !== undefined ) {
				const serverHtml = compareServerHtml( desktop, phone );
				const scripts = externalScriptSources( desktop, args.url );
				const inheritedFrom = serverHtml !== 'different' ? args.deviceEvidence?.covering( scripts, inlineRuntimeHash( desktop, args.url ) ) : undefined;
				if ( inheritedFrom ) return { mode: 'reflow-only', reason: 'same server HTML and external scripts covered by a rendered route check', serverHtml, inheritedFrom, externalScripts: scripts };
			}
		} finally {
			await Promise.all( contexts.map( context => context.close().catch( () => {} ) ) );
		}
		switchCandidates = undefined;
		const rendered = await renderedRouteDeviceMode( args, candidates => { switchCandidates = candidates; } );
		if ( rendered.mode === 'reflow-only' && rendered.externalScripts && rendered.serverHtml !== 'unavailable' ) args.deviceEvidence?.record( args.url, rendered.externalScripts, rendered.inlineRuntimeHash! );
		return rendered;
	} );
	// The same HTML renders differently per identity: find the width where it
	// stops. A failed probe observes nothing and export keeps its fallback.
	const serverHtml = result.serverHtml;
	if ( result.mode === 'dual' && ( serverHtml === 'identical' || serverHtml === 'identical-after-normalization' ) && switchCandidates?.widths.length ) {
		const observed = await probeSwitchWidth( args, serverHtml, switchCandidates ).catch( () => undefined );
		if ( observed !== undefined ) {
			result.switchWidth = observed.switchWidth;
			if ( observed.middleLayout ) result.middleLayout = observed.middleLayout;
		}
	}
	result.checkMs = Date.now() - started;
	process.stderr.write( `[timing] device-check ${ JSON.stringify( { url: args.url, ...result.checkTimings, ...result, total: result.checkMs } ) }\n` );
	return result;
}


/** Stylesheet switch boundaries plus both capture-width renderings they are classified against. */
interface SwitchCandidates { widths: number[]; desktop: SwitchRendering; phone: SwitchRendering }

async function renderedRouteDeviceMode( args: DeviceComparisonArgs, onSwitchCandidates?: ( candidates: SwitchCandidates ) => void ): Promise< RouteDeviceDecision > {
	const startedAt = Date.now();
	const contexts: BrowserContext[] = [];
	const checkTimings = { navigate: 0, settle: 0, equivalence: 0, recheck: 0 };
	try {
		const compared = await compareIdentities( args, 'check', contexts, checkTimings );
		let { structure, bodyClasses } = compared;
		let desktopRendered: SwitchRendering = { paths: compared.desktop.paths, bodyClasses: compared.desktop.bodyClasses, classTokens: compared.desktop.classTokens };
		let phoneRendered: SwitchRendering = { paths: compared.phone.paths, bodyClasses: compared.phone.bodyClasses, classTokens: compared.phone.classTokens };
		const differs = () => structure.differingPaths > 0 || bodyClasses.desktopOnly.length > 0 || bodyClasses.phoneOnly.length > 0;
		let rechecked = false;
		// Two loads race third-party scripts (an embed swapping its placeholder
		// for an iframe, say). Read a difference once more after both pages
		// settle again: a race converges, an identity-driven document does not.
		// Try the exact export equivalence rule first. This is route-local
		// evidence, not a site-wide guess: server HTML and body gates must match.
		let equivalent = false;
		let renderedDocuments: { desktop: string; phone: string } | undefined;
		let runtimeStyles: { desktop: Array<[ string, string ]>; phone: Array<[ string, string ]> } | undefined;
		const equivalenceStartedAt = Date.now();
		if ( compared.serverHtml === 'identical' || compared.serverHtml === 'identical-after-normalization' ) {
			const readStyles = ( page: Page ) => withEvaluateTimeout( page.evaluate( () => Array.from( document.querySelectorAll<HTMLStyleElement>( 'style[id]' ), style => [ style.id, style.textContent ?? '' ] as [ string, string ] ) ), 10_000 );
			const [ desktop, phone ] = await Promise.all( [ readStyles( compared.desktop.page ), readStyles( compared.phone.page ) ] );
			runtimeStyles = { desktop, phone };
		}
		if ( ( compared.serverHtml === 'identical' || compared.serverHtml === 'identical-after-normalization' ) && structure.differingPaths > 0 && ! bodyClasses.desktopOnly.length && ! bodyClasses.phoneOnly.length ) {
			const [ desktop, phone ] = await Promise.all( [ compared.desktop.page.content(), compared.phone.page.content() ] );
			renderedDocuments = { desktop, phone };
			equivalent = decideRouteMode( { serverHtml: compared.serverHtml, structure, bodyClasses, renderedDocuments, runtimeStyles } ).mode === 'reflow-only';
		}
		checkTimings.equivalence += Date.now() - equivalenceStartedAt;
		if ( compared.serverHtml !== 'different' && differs() && ! equivalent ) {
			rechecked = true;
			const recheckStartedAt = Date.now();
			const reread = async ( page: Page ) => {
				await new Promise( resolve => setTimeout( resolve, CHECK_RECHECK_MS ) );
				await settleDocument( page, 'stable', { quietMs: 300, timeoutMs: 1_000 } ).catch( () => {} );
				const structure = await withEvaluateTimeout( renderedElementStructure( page ), 10_000 );
				return { paths: structure.paths, classTokens: structure.classTokens, bodyClasses: await withEvaluateTimeout( renderedBodyClasses( page ), 10_000 ) };
			};
			const [ desktop, phone ] = await Promise.all( [ reread( compared.desktop.page ), reread( compared.phone.page ) ] );
			structure = compareStructure( desktop.paths, phone.paths );
			bodyClasses = compareBodyClasses( desktop.bodyClasses, phone.bodyClasses );
			desktopRendered = desktop;
			phoneRendered = phone;
			checkTimings.recheck = Date.now() - recheckStartedAt;
			renderedDocuments = undefined;
		}
		const finalEquivalenceStartedAt = Date.now();
		if ( ! renderedDocuments && compared.serverHtml !== 'different' && structure.differingPaths > 0 && ! bodyClasses.desktopOnly.length && ! bodyClasses.phoneOnly.length ) {
			// Positional paths cascade when a runtime inserts a widget. After the
			// recheck, let export's equivalence rule decide whether it is content.
			const [ desktop, phone ] = await Promise.all( [ compared.desktop.page.content(), compared.phone.page.content() ] );
			renderedDocuments = { desktop, phone };
		}
		const decided = decideRouteMode( { serverHtml: compared.serverHtml, structure, renderedDocuments, runtimeStyles, bodyClasses: differs() ? bodyClasses : undefined } );
		checkTimings.equivalence += Date.now() - finalEquivalenceStartedAt;
		if ( decided.mode === 'dual' && compared.serverHtml !== 'different' ) onSwitchCandidates?.( { widths: await withEvaluateTimeout( stylesheetSwitchBoundaries( compared.desktop.page ), 10_000 ).catch( () => [] ), desktop: desktopRendered, phone: phoneRendered } );
		return { ...decided, inlineRuntimeHash: compared.desktop.html === undefined ? undefined : inlineRuntimeHash( compared.desktop.html, compared.url ), serverHtml: compared.serverHtml, externalScripts: compared.desktop.html === undefined ? undefined : externalScriptSources( compared.desktop.html, compared.url ), structure, ...( rechecked ? { rechecked } : {} ), checkMs: Date.now() - startedAt, checkTimings };
	} catch ( error ) {
		// Both identities failed alike (an absent route, an off-site redirect):
		// there is no phone document to keep, and capture records the outcome once.
		if ( error instanceof ComparisonUnavailable && error.same ) return { mode: 'reflow-only', reason: `no document in either identity: ${ error.message }`, checkMs: Date.now() - startedAt, checkTimings };
		return { ...decideRouteMode( { error: error instanceof Error ? error.message : String( error ) } ), checkMs: Date.now() - startedAt, checkTimings };
	} finally {
		await Promise.all( contexts.map( context => context.close().catch( () => {} ) ) );
	}
}

/**
 * Load the phone identity at each candidate width, the way the route check
 * does, and classify what it renders against both capture-width renderings
 * by structure, body classes and element class tokens (`switchProbeIdentity`):
 * the first boundary above which it stops rendering the phone document is the
 * switch, and a middle rendering ends where the probe stops matching it (see
 * `observeSwitchWidth`).
 */
async function probeSwitchWidth( args: DeviceComparisonArgs, serverHtml: 'identical' | 'identical-after-normalization', candidates: SwitchCandidates ): Promise< ObservedSwitch | undefined > {
	const phone = args.phone.viewport, wide = args.desktop.viewport?.width;
	if ( ! phone || ! wide ) return undefined;
	const identity = switchProbeIdentity( candidates, serverHtml );
	return observeSwitchWidth( candidates.widths, { phone: phone.width, desktop: wide }, async width => {
		const contexts: BrowserContext[] = [];
		try {
			// Probe loads must not replace the capture-width identity headers.
			const loaded = await loadForComparison( { ...args, identityHeaders: undefined }, { ...args.phone, viewport: { ...phone, width } }, 'mobile', 'check', contexts );
			const rendering: SwitchRendering = { paths: loaded.paths, bodyClasses: loaded.bodyClasses, classTokens: loaded.classTokens };
			return { rendered: identity.classify( rendering ), rendering };
		} finally {
			await Promise.all( contexts.map( context => context.close().catch( () => {} ) ) );
		}
	}, identity.same );
}

/**
 * Decide once, on the entrypoint, whether this site can be captured with
 * desktop-only routes at all (see `device-mode.ts`): adapter device documents,
 * persistently different server HTML or a failed probe keep the whole capture `dual`.
 * A first HTML difference is confirmed with paired document-only requests.
 * Rendered structure is decided per route by `checkRouteDeviceMode`.
 *
 * In a `reflow-only` site the probe's fully loaded phone page also runs one
 * interaction probe limited to controls that are not visible at desktop width,
 * such as a hamburger menu, so their states are not lost with the phone pass.
 * Its report merges into the entrypoint route like a phone pass's report would.
 */
export async function probeDeviceMode( args: DeviceModeProbeArgs ): Promise< { decision: DeviceModeDecision; phoneInteractions?: InteractionStatesReport; url: string; sharedChrome?: Map< string, SharedChromeProbe > } > {
	const startedAt = Date.now();
	const { requested } = args;
	const ignored = { serverHtml: SERVER_HTML_IGNORED, structure: STRUCTURE_IGNORED };
	const deviceDocuments = args.deviceDocuments.join( ', ' );
	if ( requested === 'dual' || ( requested === 'auto' && deviceDocuments ) ) {
		return { url: args.url, decision: { ...decideSiteMode( { requested, deviceDocuments } ), requested, durationMs: Date.now() - startedAt } };
	}
	const contexts: BrowserContext[] = [];
	let url = args.url;
	let serverHtml: DeviceModeDecision['serverHtml'];
	let structure: DeviceModeDecision['structure'];
	try {
		const compared = await compareIdentities( args, 'probe', contexts );
		const { desktop, phone, bodyClasses } = compared;
		url = compared.url;
		const htmlSample = await resampleSiteServerHtml( compared.serverHtml, desktop.fetchServerHtml, phone.fetchServerHtml );
		serverHtml = htmlSample.serverHtml;
		structure = compared.structure;
		const decided = decideSiteMode( { requested, serverHtml } );
		const decision: DeviceModeDecision = { ...decided, requested, url, ...htmlSample, structure, ...( bodyClasses.desktopOnly.length || bodyClasses.phoneOnly.length ? { bodyClasses } : {} ), ignored };
		let phoneInteractions: InteractionStatesReport | undefined;
		if ( decided.mode === 'reflow-only' && structure.differingPaths > 0 ) {
			// The entrypoint's own check then keeps it dual, and its phone pass probes these controls.
			decision.phoneProbe = { status: 'skipped', triggers: 0, captured: 0, reason: 'phone structure differs, so desktop-visible controls cannot be mapped' };
		} else if ( decided.mode === 'reflow-only' ) {
			try {
				// Controls visible at desktop width are the desktop pass's to probe.
				const desktopControls = await withEvaluateTimeout( visibleControlPaths( desktop.page ), 10_000 );
				await renderedElementPaths( phone.page, { attribute: DESKTOP_CONTROL_ATTRIBUTE, paths: desktopControls } );
				await restoreTopScrollState( phone.page );
				await withReadOnlyProbes( phone.page, () => dismissOverlays( phone.page ) );
				const release = await lockMainFrameNavigation( phone.page );
				let report: InteractionStatesReport;
				try {
					report = await withReadOnlyProbes( phone.page, () => captureTriggeredDialogs( phone.page, url, { skip: `[${ DESKTOP_CONTROL_ATTRIBUTE }]` } ) );
				} finally {
					await release();
				}
				const marker = new RegExp( `\\s${ DESKTOP_CONTROL_ATTRIBUTE }(?:="")?`, 'g' );
				report = canonicalizeInteractionReport( report, html => html.replace( marker, '' ) );
				// These states join the desktop document's evidence, so they must name
				// its nodes: a runtime ID counter can number the phone rendering differently.
				report = withCarriedSelectors( report, await withEvaluateTimeout( carrySelectors( phone.page, desktop.page, recordedSelectors( report.states ) ), 10_000 ).catch( () => new Map() ) );
				if ( args.canonicalizeHtml ) report = canonicalizeInteractionReport( report, args.canonicalizeHtml );
				// Initially visible dialogs are not phone-only; the desktop pass owns them.
				const { initialDialogs: _initial, routeNavigation: _routes, ...phoneReport } = report;
				const captured = phoneReport.states.filter( state => state.status === 'captured' ).length;
				decision.phoneProbe = { status: captured ? 'captured' : 'none', triggers: phoneReport.states.length, captured };
				if ( captured ) phoneInteractions = phoneReport;
			} catch ( error ) {
				decision.phoneProbe = { status: 'failed', triggers: 0, captured: 0, reason: error instanceof Error ? error.message : String( error ) };
			}
		}
		decision.durationMs = Date.now() - startedAt;
		// The loaded entrypoint pages also serve the one-time shared-chrome probe,
		// so it costs no extra load. A reflow-only site captures desktop only, and
		// its phone-only states join the desktop evidence; a dual site probes each
		// identity's own, untouched page.
		let sharedChrome: Map< string, SharedChromeProbe > | undefined;
		if ( args.sharedChrome ) {
			const [ desktopChrome, phoneChrome ] = await Promise.all( [
				boundSharedChromeProbe( Date.now(), () => probeChromeOnPage( desktop.page, url, phoneInteractions ? { additionalStates: phoneInteractions.states } : {} ) ),
				decided.mode === 'dual' ? boundSharedChromeProbe( Date.now(), () => probeChromeOnPage( phone.page, url, {} ) ) : undefined,
			] );
			sharedChrome = new Map( [ [ 'desktop', desktopChrome ], ...( phoneChrome ? [ [ 'mobile', phoneChrome ] as const ] : [] ) ] );
		}
		return { url, phoneInteractions, decision, ...( sharedChrome ? { sharedChrome } : {} ) };
	} catch ( error ) {
		const probeError = error instanceof Error ? error.message : String( error );
		return { url, decision: { ...decideSiteMode( { requested, probeError } ), requested, url, ...( serverHtml ? { serverHtml } : {} ), ...( structure ? { structure } : {} ), ignored, durationMs: Date.now() - startedAt } };
	} finally {
		await Promise.all( contexts.map( context => context.close().catch( () => {} ) ) );
	}
}

