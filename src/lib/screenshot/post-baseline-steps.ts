import type { Page } from 'playwright';
import { isIntegrityError } from '../failure-class.js';
import { choiceGroupInteractionLosses } from '../static-dialogs.js';
import { SkipSet, type CaptureStep } from './capture-steps.js';
import { clearChromeMarks, learnSharedChrome, reuseSharedChrome, type ChromeReuse, type SharedChromeProbe } from './chrome-reuse.js';
import { captureCollections } from './collection-capture.js';
import { exploreComponents, popupComponents, type ComponentBaseline, type CapturedComponent } from './component-states.js';
import { probePhoneOnlyChrome } from './device-mode-probe.js';
import { captureGalleries } from './gallery-capture.js';
import { captureTriggeredDialogs, type CapturedDialogInteraction, type InteractionStatesReport } from './interaction-capture.js';
import type { ManifestEntry, ProfileDiagnostic } from './manifest-queue.js';
import { dismissOverlays, restoreTopScrollState } from './page-helpers.js';
import { resolveProbeExclusions, type ProbeExclusion } from './probe-exclusions.js';
import { withReadOnlyProbes } from './probe-guards.js';
import type { CapturedResourceStore } from './resource-capture.js';
import { captureScrollStates } from './scroll-state-capture.js';
import { probeScriptedLinks, SCRIPTED_LINK_BUDGET_MS } from './scripted-links.js';
import { captureSelectableSetStates } from './selectable-set-capture.js';
import { captureTypedSearchStates } from './typed-search-capture.js';
import type { Viewport } from './types.js';

export interface PostBaselineState {
	chrome?: ChromeReuse;
	excluded: Awaited<ReturnType<typeof resolveProbeExclusions>>;
	collections: CapturedComponent[];
	components: CapturedComponent[];
	galleryStates: CapturedDialogInteraction[];
	interactions?: InteractionStatesReport;
	selectableStates: CapturedDialogInteraction[];
	selectableFailed?: boolean;
	/** Chrome probes that completed on this route; only complete probes teach later routes. */
	chromeProbed: { dialogs?: boolean; phoneOnly?: boolean };
	/** Set once the report has been merged into the route; expiry never merges it twice. */
	promoted?: boolean;
	skip: SkipSet;
}

export interface PostBaselineContext {
	page: Page;
	url: string;
	navigationUrl: string;
	viewport: Viewport;
	isDesktop: boolean;
	entry: ManifestEntry;
	resourceStore: CapturedResourceStore;
	componentBaseline: ComponentBaseline;
	sharedChrome?: SharedChromeProbe;
	probeExclusions?: readonly ProbeExclusion[];
	consentViewports?: ReadonlyArray<{ id?: string; width: number; height: number }>;
	reflowPhoneViewport?: { width: number; height: number };
	diagnostics?: ProfileDiagnostic[];
	scriptedLinkSignatures: Parameters<typeof probeScriptedLinks>[1];
	routeRemainingMs(): number;
	promote( report: InteractionStatesReport ): void;
	state: PostBaselineState;
}

export function createPostBaselineState(): PostBaselineState {
	return { excluded: { diagnostics: [] }, collections: [], components: [], galleryStates: [], selectableStates: [], chromeProbed: {}, skip: SkipSet.of() };
}

const phoneOnlyChrome = ( c: PostBaselineContext ) => Boolean( c.isDesktop && c.reflowPhoneViewport && c.state.chrome?.unmatchedRoots?.length );
const collectionSkip = ( s: PostBaselineState ) => s.collections.flatMap( component => component.collection?.controls ?? [] ).join( ',' ) || undefined;
const step = ( value: Omit<CaptureStep<PostBaselineContext>, 'onFailure'> ): CaptureStep<PostBaselineContext> => ( { onFailure: 'best-effort', ...value } );
/** Expiry stops browser work but retains the non-browser partial projection. */
export function retainPartialPostBaseline( c: PostBaselineContext ): void {
	const s = c.state;
	if ( s.promoted ) return;
	if ( ! s.interactions ) {
		s.interactions = { schema: 'blocks-engine-capture/interaction-states/v2', sourceUrl: c.url, viewport: { width: c.viewport.width, height: c.viewport.height }, capturedAt: new Date().toISOString(), states: [ ...( s.chrome?.states ?? [] ) ] };
	}
	if ( ! s.interactions.components ) {
		s.interactions.components = popupComponents( s.interactions.states, s.components.length ? s.components : s.collections );
		s.interactions.states = [ ...s.galleryStates, ...s.interactions.states ];
	}
	s.interactions.coverage = 'partial';
	s.promoted = true;
	c.promote( s.interactions );
}

/** Baseline artifacts are complete before any of these probes may mutate the page.
 * Cheap whole-page probes run before per-control ones, which can exhaust the
 * shared budget. Scripted links remain last: a client-routed link can
 * re-render the document.
 *
 * Shared chrome is matched first, on the resting baseline page: its states are
 * evidence already recorded on another route, so no later probe (nor the
 * preparation for one) may spend the budget it needs. A route whose probes
 * expire still retains the chrome every other route of its template carries. */
export const postBaselineSteps: CaptureStep<PostBaselineContext>[] = [
	step( { id: 'shared-chrome', bound: 'probe-budget', when: c => Boolean( c.sharedChrome ), run: async c => {
		// The baseline can end on its scrolled screenshot pose.
		await restoreTopScrollState( c.page );
		c.state.chrome = await reuseSharedChrome( c.page, c.sharedChrome!, { learn: true } );
		c.entry.sharedChrome = c.state.chrome?.decision;
	}, partial: ( c, error ) => {
		if ( error !== undefined ) {
			c.state.chrome = { decision: { chromeReused: false, reason: `chrome reuse failed: ${ error instanceof Error ? error.message : String( error ) }` }, states: [] };
			c.entry.sharedChrome = c.state.chrome.decision;
		}
	} } ),
	step( { id: 'dialogs', bound: 'probe-budget', run: async c => {
		if ( ! c.sharedChrome ) await restoreTopScrollState( c.page );
		await withReadOnlyProbes( c.page, () => dismissOverlays( c.page ) );
	} } ),
	// Scroll states are one bounded probe of the page chrome; the per-trigger
	// probes below can spend the whole shared budget on a control-heavy page.
	step( { id: 'scroll-states', bound: 'probe-budget', guard: 'read-only', when: c => ! c.entry.scrollStates?.toggles.length, run: async c => {
		const states = await captureScrollStates( c.page, c.url );
		if ( states?.toggles.length ) c.entry.scrollStates = states;
	} } ),
	step( { id: 'exclusions', bound: 'probe-budget', run: async c => {
		c.state.excluded = await resolveProbeExclusions( c.page, c.probeExclusions );
		c.diagnostics?.push( ...c.state.excluded.diagnostics );
	} } ),
	step( { id: 'collections', bound: 'probe-budget', guard: 'read-only', run: async c => {
		const captured = await captureCollections( c.page, c.state.excluded.skip, diagnostic => c.diagnostics?.push( diagnostic ), c.resourceStore );
		for ( const collection of captured ) {
			( c.entry.blockLosses ??= [] ).push( { code: 'interaction_unreplayable', reason: collection.reason ?? 'Collection control replay unsupported', unit: 'block', profile: c.viewport.id } );
			for ( const member of collection.collection?.members ?? [] ) await c.resourceStore.captureDomDependencies( member.html, c.navigationUrl );
		}
		c.state.collections = captured;
	} } ),
	step( { id: 'components', bound: 'probe-budget', guard: 'read-only', run: async c => {
		const captured = await exploreComponents( c.page, c.componentBaseline, SkipSet.of( c.state.excluded.skip, c.state.chrome?.skip ).selector(), [
			{ id: c.viewport.id, width: c.viewport.width, height: c.viewport.height },
			...( c.consentViewports ?? [] ).filter( candidate => candidate.id !== c.viewport.id ).map( candidate => ( { id: candidate.id, width: candidate.width, height: candidate.height } ) ),
		] );
		for ( const component of captured ) for ( const state of component.states ) await c.resourceStore.captureDomDependencies( state.html, c.navigationUrl );
		c.state.components = [ ...captured, ...c.state.collections ];
	}, partial: c => { c.state.components = [ ...c.state.collections ]; } } ),
	step( { id: 'galleries', bound: 'probe-budget', guard: 'read-only', run: async c => {
		c.state.galleryStates = await captureGalleries( c.page, c.state.components.filter( component => component.slideshow ).map( component => component.selector ) );
	} } ),
	step( { id: 'dialogs', bound: 'probe-budget', guard: 'read-only', run: async c => {
		c.state.skip = SkipSet.of( c.state.chrome?.skip, c.state.excluded.skip ).with( c.componentBaseline.skip );
		const skip = c.state.skip.selector();
		c.state.interactions = skip
			? await captureTriggeredDialogs( c.page, c.url, { skip, navigationSkip: SkipSet.of( c.state.excluded.skip, c.componentBaseline.skip ).selector() ?? '' } )
			: await captureTriggeredDialogs( c.page, c.url );
		if ( c.state.chrome?.states.length ) c.state.interactions.states.push( ...c.state.chrome.states );
		c.state.chromeProbed.dialogs = true;
	}, partial: c => {
		c.state.interactions = { schema: 'blocks-engine-capture/interaction-states/v2', sourceUrl: c.url, viewport: { width: c.viewport.width, height: c.viewport.height }, capturedAt: new Date().toISOString(), states: [] };
		if ( c.state.chrome?.states.length ) c.state.interactions.states.push( ...c.state.chrome.states );
	} } ),
	step( { id: 'shared-chrome', bound: 'probe-budget', guard: 'read-only', when: phoneOnlyChrome, run: async c => {
		const states = await probePhoneOnlyChrome( c.page, c.url, c.state.chrome!.unmatchedRoots!, c.reflowPhoneViewport! );
		c.state.interactions?.states.push( ...states );
		c.state.chromeProbed.phoneOnly = true;
	} } ),
	// Chrome no earlier evidence covered was just probed in place: later routes
	// that render the same chrome reuse those outcomes instead of probing it again.
	step( { id: 'shared-chrome', bound: 'probe-budget', guard: 'read-only', when: c => Boolean(
		c.sharedChrome && c.state.chrome?.learn && c.state.interactions && c.state.chromeProbed.dialogs && ( c.state.chromeProbed.phoneOnly || ! phoneOnlyChrome( c ) )
	), run: async c => {
		await learnSharedChrome( c.page, c.sharedChrome!, c.page.url(), c.state.chrome!.learn!, c.state.interactions!.states );
	} } ),
	step( { id: 'dialogs', continuePhase: true, run: async c => {
		const s = c.state;
		if ( ! s.interactions ) return;
		s.interactions.components = popupComponents( s.interactions.states, s.components );
		s.interactions.states = [ ...s.galleryStates, ...s.interactions.states ];
	} } ),
	step( { id: 'selectable', bound: 'probe-budget', guard: 'read-only', run: async c => {
		const s = c.state;
		if ( ! s.interactions ) return;
		try {
			s.selectableStates = await captureSelectableSetStates( c.page, { skip: SkipSet.of( s.excluded.skip, c.componentBaseline.skip ).with( collectionSkip( s ), s.chrome?.skip ).selector() } );
			s.interactions.states.push( ...s.selectableStates );
			for ( const loss of choiceGroupInteractionLosses( s.selectableStates ) ) ( c.entry.blockLosses ??= [] ).push( { ...loss, unit: 'block', profile: c.viewport.id } );
		} catch ( error ) {
			if ( isIntegrityError( error ) ) throw error; // failure-class: integrity
			// This catch retains evidence, not a failure-containment policy.
			s.selectableFailed = true;
			s.interactions.states.push( { status: 'click-failed', kind: 'selectable-set', trigger: { selector: 'html', tag: 'html', ariaHaspopup: '', dataBindings: {} }, error: ( error instanceof Error ? error.message : String( error ) ).slice( 0, 500 ) } );
		}
	} } ),
	step( { id: 'typed-search', when: c => ! c.state.selectableFailed, bound: 'probe-budget', guard: 'read-only', run: async c => {
		await dismissOverlays( c.page );
		c.state.interactions?.states.push( ...await captureTypedSearchStates( c.page, c.state.selectableStates, { skip: SkipSet.of( c.state.excluded.skip, collectionSkip( c.state ), c.state.chrome?.skip ).selector() } ) );
	} } ),
	step( { id: 'shared-chrome', bound: 'probe-budget', when: c => Boolean( c.state.chrome?.skip ), run: c => clearChromeMarks( c.page ) } ),
	step( { id: 'shared-chrome', continuePhase: true, when: c => Boolean( c.state.interactions ), run: async c => { c.state.promoted = true; c.promote( c.state.interactions! ); } } ),
	step( { id: 'scripted-links', guard: 'read-only', when: c => Boolean( c.scriptedLinkSignatures.length ), run: async c => {
		const startedAt = Date.now();
		const evidence = await probeScriptedLinks( c.page, c.scriptedLinkSignatures, Math.min( SCRIPTED_LINK_BUDGET_MS, c.routeRemainingMs() / 4 ) );
		( c.entry.scriptedLinks ??= {} )[ c.viewport.id ] = evidence;
		process.stderr.write( `[timing] scripted-links ${ JSON.stringify( { url: c.url, profile: c.viewport.id, durationMs: Date.now() - startedAt, candidates: evidence.candidates, resolved: evidence.resolved } ) }\n` );
	} } ),
];
