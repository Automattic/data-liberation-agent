import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { CHROME_AUDIT_PROPERTIES } from '../replicate/chrome-audit-types.js';
import { extractFull } from '../replicate/section-extract.js';
import { SectionSpecsStore } from '../replicate/section-specs-store.js';
import { readSourceCleanup, sweepSourceCleanup, type CleanupPolicy } from '../source-cleanup.js';
import { slugify } from '../url/index.js';
import { SiteAnalysisAggregator } from './aggregator.js';
import { captureChromeFidelity } from './capture-chrome-fidelity.js';
import { normalizeCaptureState, normalizeGeneratedIds, SCRIPT_MOTION_BUDGET_MS, settleScriptMotion } from './capture-state.js';
import { snapshotComponents, type ComponentBaseline } from './component-states.js';
import {
	countBodyTags,
	isRouteDrift,
	isStackingArtifact,
	matchClientErrorShell
} from './document-integrity.js';
import { withDocumentTitle } from './document-title.js';
import { learnAndApplyFluidGeometry, type FluidSeriesMemo } from './fluid-capture.js';
import { sanitizeFrozenHtml } from './freeze.js';
import { markGalleryRoots } from './gallery-capture.js';
import { GlyphColorCache, recordGlyphColors } from './glyph-color.js';
import { markInitialDocument, projectInitialDocument } from './initial-document.js';
import { loadSourceBaseline } from './load-baseline.js';
import { type FailureEntry, type ManifestEntry, type ProfileDiagnostic } from './manifest-queue.js';
import { captureNativeViewTimelines } from './native-view-timelines.js';
import { type ArtifactPlan } from './output-layout.js';
import { pageResponds, withEvaluateTimeout } from './page-helpers.js';
import { type PhaseLedger } from './phase-ledger.js';
import { CapturedResourceStore } from './resource-capture.js';
import { projectRootClassContracts, rootClassContracts, RootClassEvidence, sampleRootClassLadder, type RootClassContract } from './root-class-contracts.js';
import { restoreRuntimeEmoji } from './runtime-emoji.js';
import { restoreLoadTimeSheets } from './runtime-style-writes.js';
import { removeRuntimeWidgets } from './runtime-widgets.js';
import { analyzePage } from './site-analysis.js';
import { preserveStreamedVideoPosters } from './streamed-video.js';
import { captureViewportClassStates, type ViewportClassMemo } from './viewport-class-states.js';

import type { Page } from 'playwright';
import { type SharedChromeProbe } from './chrome-reuse.js';
import { MIDDLE_PROFILE_ID } from './device-mode.js';
import type { GeometryCapture } from './layout-geometry-proof.js';
import { stampScriptedLinkCandidates } from './scripted-links.js';
import {
	type ScreenshotOpts,
	type Viewport
} from './types.js';


import type { CaptureStep } from './capture-steps.js';

export interface CapturePerViewportArgs {
	page: Page;
	absentDocument?: ( html: string ) => Promise<boolean>;
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
	classBreakpoints?: Set<number>;
	classMemo?: ViewportClassMemo;
	fluidWidths?: number[];
	collectResponsiveImages?: (
		page: import( 'playwright' ).Page,
		ctx: import( '../../adapters/page-actions.js' ).LiberationContext
	) => Promise<Record<string, string>>;
	removeSelectors?: string[];
	clientErrorShellSelectors?: string[];
	cleanupPolicy?: CleanupPolicy;
	prepareCapture?: (
		page: import( 'playwright' ).Page,
		ctx: import( '../../adapters/page-actions.js' ).LiberationContext
	) => Promise<void>;
	resolveClientRedirect?: ( page: Page, url: string ) => Promise<string | undefined>;
	/** Resolve a query rendition whose rendered rel=canonical is its query-less route to that route. */
	canonicalQueryAlias?: boolean;
	initScript?: ScreenshotOpts['initScript'];
	beforeFluid?: ScreenshotOpts['beforeFluid'];
	beforeSerialize?: (
		page: import( 'playwright' ).Page,
		ctx: import( '../../adapters/page-actions.js' ).LiberationContext
	) => Promise<void>;
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
	responsiveImages: Record<string, string>;
	/** Accumulates {slug → mobile-DOM scrollHeight} from the mobile viewport, for the
	 *  alt path's iframe mobile-DOM carry. Mutated in place; written once at run end. */
	mobileHeights: Record<string, number>;
	resourceStore: CapturedResourceStore;
	/** Run-scoped glyph colours, shared by every route and profile (#924). */
	glyphColors?: GlyphColorCache;
	publicUrlsOnly: boolean;
	routeScope?: ScreenshotOpts['routeScope'];
}


const SCROLL_OFFSET_RATIO = 1.5;
const CLIENT_ERROR_SHELL_FAILURE = 'client error shell';
async function withScreenshotTimeout<T>( p: Promise<T>, ms: number ): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>( ( _, reject ) => {
		timer = setTimeout( () => reject( new Error( `screenshot timeout after ${ ms }ms` ) ), ms );
	} );
	try {
		return await Promise.race( [p, timeout] );
	} finally {
		if ( timer ) clearTimeout( timer );
	}
}

async function captureLayoutGeometry( page: Page, viewport: Viewport ): Promise<GeometryCapture> {
	return page.evaluate(
		async ( { width, viewportId } ) => {
			const candidateIsSafe = ( candidate: {
				tag: string;
				attributes: Record<string, string>;
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
				for ( const [name, value] of Object.entries( candidate.attributes ) ) {
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
								: [`[${ attribute }`, `${ attribute }=`];
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
				if ( !identities.includes( identity ) ) {
					identities.push( identity );
					node.setAttribute( 'data-blocks-engine-capture-geometry-id', identities.join( ' ' ) );
				}
			};
			const omissions: Record<string, number> = {};
			const omit = ( code: string ) => ( omissions[code] = ( omissions[code] ?? 0 ) + 1 );
			const box = ( node: Element ) => {
				const rect = node.getBoundingClientRect();
				return {
					x: Math.round( rect.x * 1000 ) / 1000,
					y: Math.round( rect.y * 1000 ) / 1000,
					width: Math.round( rect.width * 1000 ) / 1000,
					height: Math.round( rect.height * 1000 ) / 1000,
				};
			};
			const equal = ( left: ReturnType<typeof box>, right: ReturnType<typeof box> ) =>
				['x', 'y', 'width', 'height'].every(
					( key ) =>
						Math.abs( left[key as keyof typeof left] - right[key as keyof typeof right] ) <= 1
				);
			const runtimeSources = Array.from( document.scripts, ( script ) => script.textContent ?? '' );
			const observations: GeometryCapture['observations'] = [];
			for ( const wrapper of Array.from(
				document.body.querySelectorAll( 'div,section,article,main' )
			) ) {
				if ( observations.length >= 64 ) {
					omit( 'candidate_limit' );
					break;
				}
				const target = wrapper.firstElementChild;
				if (
					!target ||
					wrapper.children.length !== 1 ||
					Array.from( wrapper.childNodes ).some(
						( node ) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
					) ||
					[...wrapper.querySelectorAll( '*' ), wrapper].some( ( node ) =>
						[...node.attributes].some( ( attribute ) => /^on/i.test( attribute.name ) )
					)
				) {
					omit( 'runtime_or_semantics_unproven' );
					continue;
				}
				if (
					!candidateIsSafe( {
						tag: wrapper.tagName,
						attributes: Object.fromEntries(
							Array.from( wrapper.attributes, ( attribute ) => [attribute.name, attribute.value] )
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
				if ( !equal( sourceWrapper, sourceTarget ) || !equal( sourceTarget, simulated ) ) {
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
			await new Promise<void>( ( resolve ) =>
				requestAnimationFrame( () => requestAnimationFrame( () => resolve() ) )
			);
			return { schema: 'blocks-engine-capture/layout-geometry-capture/v1', observations, omissions };
		},
		{ width: viewport.width, viewportId: viewport.id }
	);
}


export interface BaselineState {
	componentBaseline: ComponentBaseline;
	initialDocument: string;
	initialTitle?: string;
	rootClassWidths: RootClassContract[];
	rawDocument?: string;
	scriptedLinkSignatures: Awaited<ReturnType<typeof stampScriptedLinkCandidates>>;
	stopped: boolean;
	scrolledReady: boolean;
}
export function createBaselineState(): BaselineState {
	return { componentBaseline: { components: [], controls: [] }, initialDocument: '', rootClassWidths: [], scriptedLinkSignatures: [], stopped: false, scrolledReady: false };
}

export function baselineSteps(
	args: CapturePerViewportArgs,
	sourceLoad: NonNullable<Awaited<ReturnType<typeof loadSourceBaseline>>>,
	state: BaselineState,
	fail: ( stage: FailureEntry['stage'], error: unknown, attempt?: number ) => void,
	sourceErrors: () => string[],
	capturePageHtml: ( page: Page, diagnostics?: ProfileDiagnostic[], serverHtml?: string ) => Promise<string>,
): CaptureStep<{ page: Page }>[] {
	const { page, viewport, plan, url, slug, evaluateTimeoutMs, screenshotTimeoutMs, outputDir, entry, responsiveImages, resourceStore, mobileHeights, shouldAnalyze, aggregator } = args;
	const { serverHtml, navigationUrl, sourcePolicy } = sourceLoad;
	const isDesktop = viewport.id === 'desktop';
	const isMobile = viewport.id === 'mobile';
	const canonicalize = ( html: string ) => args.canonicalizeHtml ? args.canonicalizeHtml( html ) : html;
	const settleScriptEntrances = async () => {
		const outcome = await settleScriptMotion( page );
		if ( outcome?.swept ) process.stderr.write( `[timing] script-motion ${JSON.stringify( { url, viewport: viewport.id, ...outcome } )}\n` );
	};

	const serializeDocument = async ( frozen: boolean ): Promise<{ html: string; documentUrl: { url: string; baseUrl: string } }> => {
		args.diagnostics?.push( ...await removeRuntimeWidgets( page ) );
		await sweepSourceCleanup( page, sourcePolicy );
		await preserveStreamedVideoPosters( page, resourceStore, url ).catch ( () => undefined );
		// Source width changes can rerender emoji replacement images (#954).
		args.diagnostics?.push( ...await restoreRuntimeEmoji( page ) );
		const learned = await capturePageHtml( page, args.diagnostics );
		const baseUrl = await page.evaluate( () => document.baseURI );
		const linkedSheet = ( href: string ) => {
			const absolute = new URL( href, baseUrl ).href;
			const resource = resourceStore.getReplayableResponse( absolute, 'stylesheet' );
			return resource ? { css: readFileSync( resource.path, 'utf8' ), url: absolute } : undefined;
		};
		const projected = projectRootClassContracts( projectInitialDocument( state.initialDocument, learned, linkedSheet ), state.rootClassWidths, linkedSheet );
		const captured = typeof state.initialTitle === 'string' ? withDocumentTitle( projected, state.initialTitle ) : projected;
		state.rawDocument = frozen ? sanitizeFrozenHtml( captured ) : captured;
		const html = canonicalize( state.rawDocument );
		const documentUrl = await page.evaluate( () => ( { url: document.URL, baseUrl: document.baseURI } ) );
		await resourceStore.captureDomDependencies( html, documentUrl.baseUrl );
		return { html, documentUrl };
	};
	return [
		{
			id: 'responsive-images', continuePhase: true, when: () => isMobile && Boolean( args.collectResponsiveImages ), onFailure: 'best-effort', run: async () => {
				Object.assign( responsiveImages, await args.collectResponsiveImages!( page, { url, viewport: 'mobile' } ) );
			}
		},
		{
			id: 'baseline-reset', continuePhase: true, onFailure: 'drop-profile', partial: ( _ctx, error ) => { fail( 'evaluate', `source baseline reset unproven: ${ String( error ) }` ); }, run: async () => {
				await withEvaluateTimeout( normalizeCaptureState( page ), evaluateTimeoutMs );
				await withEvaluateTimeout( normalizeGeneratedIds( page ), evaluateTimeoutMs );
			}
		},
		{
			id: 'layout-geometry', when: () => plan.captureGeometry, onFailure: 'throw', run: async () => {

				let capture: GeometryCapture;
				try {
					capture = await captureLayoutGeometry( page, viewport );
				} catch {
					// Evidence-producing omission, not a step failure policy.
					capture = {
						schema: 'blocks-engine-capture/layout-geometry-capture/v1',
						observations: [],
						omissions: { capture_failed: 1 },
					};
				}
				mkdirSync( dirname( plan.paths.geometry ), { recursive: true } );
				writeFileSync( plan.paths.geometry, `${ JSON.stringify( capture, null, 2 ) }\n` );
			}
		},
		{
			id: 'root-class', when: () => isDesktop && plan.captureHtml, onFailure: 'drop-profile', partial: ( _ctx, error ) => { fail( 'evaluate', `root class source probe unproven: evaluate timeout or failure: ${ String( error ) }` ); }, run: async () => {
				const startedAt = Date.now();
				const onUnproven = ( reason: string ) => args.diagnostics?.push( {
					code: 'root_class_source_probe_unproven', reason: `${ url }: ${ reason }`,
				} );
				const initial = await withEvaluateTimeout( page.evaluate( () => ( {
					width: innerWidth,
					html: [...document.documentElement.classList].sort(),
					body: [...document.body.classList].sort(),
				} ) ), evaluateTimeoutMs );
				// Only the server document separates authored root classes from
				// runtime-added ones; without it, sample this route and prove nothing.
				const ladder = () => sampleRootClassLadder( page, undefined, onUnproven );
				const result = serverHtml
					? await args.rootClassEvidence.contracts( url, serverHtml, initial, ladder )
					: { contracts: rootClassContracts( await ladder() ?? [] ), inheritedFrom: undefined };
				state.rootClassWidths = result.contracts;
				process.stderr.write( `[timing] root-class ${JSON.stringify( { url, durationMs: Date.now() - startedAt, inheritedFrom: result.inheritedFrom } )}\n` );
			}
		},
		{
			id: 'script-motion', bound: { evaluateMs: SCRIPT_MOTION_BUDGET_MS + evaluateTimeoutMs }, onFailure: 'best-effort', run: async () => {
				await settleScriptEntrances();
			}
		},
		{
			id: 'baseline-snapshot', onFailure: 'throw', run: async () => {
				// Initial component states are immutable evidence, read before exploration.
				args.diagnostics?.push( ...await removeRuntimeWidgets( page ) );
				args.diagnostics?.push( ...await restoreRuntimeEmoji( page ) );
				if ( args.beforeSerialize ) await args.beforeSerialize( page, { url, viewport: viewport.id, serverHtml } ).catch ( () => undefined );
				const snapshot = await snapshotComponents( page ).catch ( () => undefined );
				state.componentBaseline = snapshot && Array.isArray( snapshot.components ) ? snapshot : { components: [], controls: [] };
				await markGalleryRoots( page ).catch ( () => undefined );
				// Scripted links are numbered in the serialized document; their destinations
				// are observed after the baseline, with the other interaction probes.
				state.scriptedLinkSignatures = plan.captureHtml || plan.captureMobileHtml ? await stampScriptedLinkCandidates( page, evaluateTimeoutMs ) : [];
				await markInitialDocument( page );
				// Probes above resized the page; serialize source sheets as loaded at this width.
				await restoreLoadTimeSheets( page ).catch ( () => 0 );
				state.initialDocument = await capturePageHtml( page, args.diagnostics, serverHtml );
				if ( await args.absentDocument?.( state.initialDocument ) ) {
					fail( 'goto', 'HTTP 404 (render matches absent nonce sibling)' );
					state.stopped = true;
					return;
				}
				// The serialized head is the initial one, so it is named by the title the
				// browser reported for it, before exploration could retitle the page.
				state.initialTitle = await page.evaluate( () => document.title ).catch ( () => undefined );

			}
		},
		{
			id: 'observe-source', onFailure: 'throw', run: async () => {
				await args.observeSource?.( page, url, viewport.id, sourceErrors(), args.browserProfile, viewport );
			}
		},
		{
			id: 'native-timelines', when: () => plan.captureHtml || plan.captureMobileHtml, onFailure: 'throw', run: async () => {
				// Evidence-producing catch: loseBlock retains the native timeline loss.
				const captureViewport = page.viewportSize();
				const loseBlock = async ( stage: FailureEntry['stage'], loss: Omit<NonNullable<ManifestEntry['blockLosses']>[number], 'unit' | 'profile'> ): Promise<boolean> => {
					try {
						if ( !( await pageResponds( page, evaluateTimeoutMs ) ) ) throw new Error( `no answer to an evaluate within ${ evaluateTimeoutMs }ms` );
						if ( captureViewport ) await withEvaluateTimeout( page.setViewportSize( captureViewport ), evaluateTimeoutMs );
						await withEvaluateTimeout( page.evaluate( () => window.scrollTo( { top: 0, left: 0, behavior: 'instant' } ) ), evaluateTimeoutMs );
					} catch ( error ) {
						fail( stage, `${ loss.reason }; the page did not return to its capture pose: ${ error instanceof Error ? error.message : String( error ) }` );
						return false;
					}
					( entry.blockLosses ??= [] ).push( { ...loss, unit: 'block', profile: viewport.id } );
					return true;
				};
				let unproven: string | undefined;
				try {
					const native = await captureNativeViewTimelines( page, viewport.id, evaluateTimeoutMs );
					if ( native.samples.length || native.status === 'unproven' ) {
						const path = join( outputDir, 'native-view-timelines', viewport.id, `${ slug }.json` );
						mkdirSync( dirname( path ), { recursive: true } );
						writeFileSync( path, JSON.stringify( native, null, 2 ) );
						entry.nativeViewTimelines ??= {};
						entry.nativeViewTimelines[viewport.id] = { path: `native-view-timelines/${ viewport.id }/${ slug }.json`, preserved: native.preserved, losses: native.losses, status: native.status, failures: native.failures };
					}
					if ( native.status === 'unproven' ) unproven = `native timeline source capture unproven: ${ native.failures.join( '; ' ) }`;
				} catch ( error ) {
					unproven = `native timeline capture failed: ${ String( error ) }`;
				}
				// Unproven timelines carry no effects into the page; the evidence record above keeps the loss.
				if ( unproven !== undefined && !( await loseBlock( 'evaluate', { code: 'native_timeline_unproven', reason: unproven, severity: 'warning' } ) ) ) state.stopped = true;
			}
		},
		{
			id: 'fluid', when: () => ( plan.captureHtml || plan.captureMobileHtml ) && Boolean( args.learnFluid ) && viewport.learnFluid !== false, onFailure: 'throw', run: async () => {

				// Sweep classes before learning: resize-driven ancestor state changes can
				// suspend fluid authority and remove segment markers. Learn from the
				// settled post-sweep state, with no class-probe resizes left to undo it.
				const classes = isDesktop ? await captureViewportClassStates( page, {
					...( args.fluidWidths ? { widths: args.fluidWidths } : {} ),
					settleMs: Math.max( args.settleMs, 800 ),
					...( args.classBreakpoints ? { breakpoints: args.classBreakpoints } : {} ),
					...( args.classMemo ? { memo: args.classMemo } : {} ),
				} ).catch ( () => undefined ) : undefined;
				try {
					await args.beforeFluid?.( page, { url, viewport: viewport.id, serverHtml } ).catch ( () => {
						/* best-effort — the sweep learns whatever the hook left in place */
					} );
					const learned = await learnAndApplyFluidGeometry( page, {
						// The middle layout's learned rules name its own geometry ids, never the phone document's.
						document: isDesktop ? 'desktop' : viewport.id === MIDDLE_PROFILE_ID ? 'middle' : 'mobile',
						...( args.fluidWidths ? { widths: args.fluidWidths } : {} ),
						settleMs: Math.max( args.settleMs, 800 ),
						...( args.fluidMemo ? { memo: args.fluidMemo } : {} ),
					} );
					entry[isDesktop ? 'fluid' : 'fluidMobile'] = {
						applied: learned.applied,
						unmodelled: learned.unmodelled,
						breakpoints: learned.breakpoints,
						canvasFloor: learned.canvasFloor,
						byKind: learned.byKind,
						sampledWidths: learned.sampledWidths,
					};
				} catch ( error ) {
					// Evidence-producing diagnostic stays in-step.
					// Never fail a capture over the optimization: a frozen copy still
					// beats no copy, and the diagnostics record that it stayed frozen.
					entry[isDesktop ? 'fluid' : 'fluidMobile'] = {
						applied: 0, unmodelled: 0, breakpoints: [], canvasFloor: null, byKind: {},
						diagnostic: `fluid learning failed: ${ error instanceof Error ? error.message : String( error ) }`,
					};
				}
				if ( classes && classes.aliased > 0 && entry.fluid ) entry.fluid.byKind['viewport-class'] = classes.aliased;
			}
		},
		{
			id: 'srcset-selection', continuePhase: true, when: () => plan.captureHtml || plan.captureMobileHtml, onFailure: 'best-effort', run: async () => {
				await resourceStore.captureSelectedSrcsets( page );
			}
		},
		{
			id: 'before-serialize-cleanup', continuePhase: true, onFailure: 'throw', run: async () => {
				// Remove attributed non-content islands before interaction evidence and HTML.
				args.diagnostics?.push( ...await removeRuntimeWidgets( page ) );
				// Restore runtime emoji replacement images to their authored text (#954),
				// so screenshots, interaction evidence and HTML all record text where the
				// source's emoji script had swapped in Twemoji images.
				args.diagnostics?.push( ...await restoreRuntimeEmoji( page ) );

			}
		},
		{
			id: 'before-serialize', bound: { evaluateMs: SCRIPT_MOTION_BUDGET_MS + evaluateTimeoutMs }, onFailure: 'best-effort', run: async () => {
				await settleScriptEntrances();
			}
		},
		{
			id: 'screenshot', when: () => plan.captureFullpage, onFailure: 'best-effort', partial: ( _ctx, error ) => { const msg = error instanceof Error ? error.message : String( error ); fail( /screenshot timeout/.test( msg ) ? 'screenshot-timeout' : 'screenshot-fullpage', msg ); }, run: async () => {

				const buf = await withScreenshotTimeout(
					page.screenshot( { fullPage: true, type: 'png' } ),
					screenshotTimeoutMs
				);
				mkdirSync( dirname( plan.paths.fullpage ), { recursive: true } );
				writeFileSync( plan.paths.fullpage, buf );
				const rel = `screenshots/${ viewport.id }/${ slug }.png`;
				if ( isDesktop ) entry.desktop = rel;
				else if ( isMobile ) entry.mobile = rel;
			}
		},
		{
			id: 'glyph-colors', when: () => plan.captureHtml || plan.captureMobileHtml, onFailure: 'best-effort', run: async () => {
				await recordGlyphColors( page, {}, args.glyphColors );
			}
		},
		{
			id: 'serialize', when: () => plan.captureHtml, onFailure: 'best-effort', partial: ( _ctx, error ) => { fail( 'content', error ); }, run: async () => {
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
					entry.documents = { ...entry.documents, [viewport.id]: documentUrl };
				}
			}
		},
		{
			id: 'serialize', when: () => isMobile && plan.captureMobileHtml, onFailure: 'best-effort', run: async () => {
				const { html: mhtml, documentUrl } = await serializeDocument( true );
				// Same route-identity guard as the desktop HTML write above — best-effort
				// here too (this carry already silently skips on any other failure), so a
				// drifted mobile capture just leaves the page desktop-only rather than
				// recording a failure of its own.
				if ( !sourceLoad.externalNavigation && !isRouteDrift( page.url(), navigationUrl ) && !isStackingArtifact( mhtml ) && matchClientErrorShell( mhtml, args.clientErrorShellSelectors ) === undefined ) {
					mkdirSync( dirname( plan.paths.htmlMobile ), { recursive: true } );
					writeFileSync( plan.paths.htmlMobile, mhtml );
					args.glyphColors?.defer( plan.paths.htmlMobile, mhtml );
					entry.mobileHtml = relative( outputDir, plan.paths.htmlMobile );
					entry.documents = { ...entry.documents, mobile: documentUrl };
					mobileHeights[slug] = await page.evaluate( () => document.documentElement.scrollHeight );
				}
			}
		},
		{
			id: 'sections', when: () => isDesktop && plan.captureSections, onFailure: 'best-effort', run: async () => {

				const { specs, landmarks } = await extractFull( page, {}, evaluateTimeoutMs );
				SectionSpecsStore.load( outputDir ).set( url, specs, landmarks, {
					width: viewport.width,
					height: viewport.height,
				} );
				// Point at the store's ACTUAL path (keyed by slugify(url)); the screenshot
				// `slug` may be a collision-deduped variant (`-2`), which the store doesn't use.
				entry.sections = `sections/${ slugify( url ) }.json`;
			}
		},
		{
			id: 'sections', when: () => isMobile && plan.captureMobileSections, onFailure: 'best-effort', run: async () => {

				const { specs, landmarks } = await extractFull( page, {}, evaluateTimeoutMs );
				SectionSpecsStore.loadMobile( outputDir ).set( url, specs, landmarks, {
					width: viewport.width,
					height: viewport.height,
				} );
			}
		},
		{
			id: 'scroll-pose', continuePhase: true, when: () => plan.captureScrolled, onFailure: 'best-effort', partial: ( _ctx, error ) => { const msg = error instanceof Error ? error.message : String( error ); fail( /screenshot timeout/.test( msg ) ? 'screenshot-timeout' : 'screenshot-scrolled', msg ); }, run: async () => {
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
					state.scrolledReady = true;
					// Plain viewport-sized screenshot of the now-scrolled page.
					// fullPage:false captures the current viewport — no clip needed.
					// (A clip would have to be inside the 0..viewport.height image, not at
					// the page's absolute scroll position.)

				}
			}
		},
		{
			id: 'screenshot', when: () => state.scrolledReady, onFailure: 'best-effort', partial: ( _ctx, error ) => { const msg = error instanceof Error ? error.message : String( error ); fail( /screenshot timeout/.test( msg ) ? 'screenshot-timeout' : 'screenshot-scrolled', msg ); }, run: async () => {

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
		},
		{
			id: 'analysis', when: () => isDesktop && shouldAnalyze, onFailure: 'best-effort', partial: ( _ctx, error ) => { fail( 'evaluate', error ); }, run: async () => {

				const analysis = await analyzePage( page, evaluateTimeoutMs );
				entry.metadata = analysis.metadata;
				aggregator.add( url, analysis );
			}
		},
		{
			id: 'chrome', when: () => isDesktop && shouldAnalyze, onFailure: 'best-effort', partial: ( _ctx, error ) => { console.error( `[chrome-fidelity] skipped ${ url }: ${ error instanceof Error ? error.message : String( error ) }` ); }, run: async () => {
				// Write into the screenshots dir — where the audit driver reads it from
				// (readChromeFidelity(join(outputDir, 'screenshots'))). Must stay in sync.
				const n = await captureChromeFidelity(
					page,
					url,
					join( outputDir, 'screenshots' ),
					CHROME_AUDIT_PROPERTIES
				);
				console.info( `[chrome-fidelity] ${ url } -> ${ n } elements` );
			}
		},
		{
			id: 'cleanup-audit', onFailure: 'throw', run: async () => {

				const cleanup = await readSourceCleanup( page, sourcePolicy );
				entry.cleanup = { policy: sourcePolicy, reports: [...( entry.cleanup?.reports ?? [] ), cleanup] };
				if ( cleanup.failures.length || cleanup.residual ) throw new Error('Source cleanup incomplete; see cleanup evidence');

			}
		},
	];
}
