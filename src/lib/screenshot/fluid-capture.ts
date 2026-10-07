// src/lib/screenshot/fluid-capture.ts
//
// Drive the width sweep that `fluid-model` learns from.
//
// The source's own runtime is left running while the viewport changes, so what
// we record is the site telling us how it sizes itself. The learned CSS then
// replaces the runtime-written inline pixels, which is what lets the liberated
// copy keep reflowing after that runtime is stripped.
//
import {
	breakpointsFrom,
	learnFluidModel,
	learnSegmentedFluidModel,
	learnWidestFluidModel,
	segmentedCss,
	type FluidModel,
	type GeometrySample,
} from './fluid-model.js';
import type { Page } from 'playwright';
import { captureFluidBaseline } from './fluid-baseline.js';

/** Marks elements across viewport changes; removed before serialization. */
const ID_ATTRIBUTE = 'data-dla-fluid-id';
/** Keys segmented stylesheet rules to their element; survives serialization. */
const SEGMENT_ATTRIBUTE = 'data-dla-fluid-segment';
/** How far a container percentage may miss the size it replaced at the capture width. */
const CONTAINER_VERIFY_TOLERANCE_PX = 2;
/** Marks the stylesheet block carrying segmented rules as capture-owned. */
export const SEGMENT_STYLE_ATTRIBUTE = 'data-dla-fluid-rules';
/** Attribute pattern used by the exporter to recognize those blocks. */
export const FLUID_RULES_STYLE_ATTRIBUTE = /\bdata-dla-fluid-rules\b/i;
/** Only geometry that a runtime plausibly derives from viewport width. */
const LEARNABLE_PROPERTIES = [ 'width', 'height', 'font-size', 'padding-top', 'transform-x', 'inset-top', 'inset-left' ] as const;

function isPureXTranslationMatrix( matrix: readonly number[] ): boolean {
	return (
		matrix.length === 6 &&
		matrix.every( Number.isFinite ) &&
		Math.abs( matrix[ 0 ]! - 1 ) <= 0.01 &&
		Math.abs( matrix[ 1 ]! ) <= 0.01 &&
		Math.abs( matrix[ 2 ]! ) <= 0.01 &&
		Math.abs( matrix[ 3 ]! - 1 ) <= 0.01 &&
		Math.abs( matrix[ 5 ]! ) <= 0.01
	);
}

function pureXTranslation( transform: string ): number | null {
	const matrix = /^matrix\(\s*([^)]*)\s*\)$/i.exec( transform )?.[ 1 ]?.split( ',' ).map( Number );
	if ( matrix && isPureXTranslationMatrix( matrix ) ) return matrix[ 4 ]!;
	const translate = /^translate(?:3d|x)?\(\s*(-?\d+(?:\.\d+)?)px(?:\s*,\s*0(?:px)?(?:\s*,\s*0(?:px)?)?)?\s*\)$/i.exec( transform.trim() );
	return translate ? Number( translate[ 1 ] ) : null;
}

export type LearnableProperty = ( typeof LEARNABLE_PROPERTIES )[ number ];

export interface FluidSweepOptions {
	/** Distinguishes rule identities when responsive documents share a stylesheet. */
	document?: 'desktop' | 'mobile';
	/** Widths to observe. More widths cost time but sharpen the fit. */
	widths?: number[];
	/** Settle time after each resize, for the runtime to react. */
	settleMs?: number;
	onProgress?: ( ( width: number, elements: number ) => void ) | undefined;
}

export interface FluidLearningResult {
	/** Elements whose inline geometry was replaced with a learned expression. */
	applied: number;
	/** Elements observed but left frozen because no model fit. */
	unmodelled: number;
	/** Widths where some element changed its sizing rule. */
	breakpoints: number[];
	/**
	 * Width at which this document stops shrinking — the widest floor among
	 * learned `max(floor, k*vw)` models. Below it the layout overflows rather
	 * than adapting, which makes it the source's own switching point.
	 */
	canvasFloor: number | null;
	byKind: Record< string, number >;
}

/** Default ladder: mobile, canvas, and wide, spanning common real viewports.
 *
 * The mobile widths matter: a source that obeys one rule above its mobile
 * breakpoint and another below it (container share changes, different clamp)
 * is unmodelled — or worse, mis-modelled — when every sample sits above the
 * switch. */
export const DEFAULT_SWEEP_WIDTHS = [ 390, 600, 767, 768, 769, 775, 783, 791, 799, 800, 801, 1024, 1280, 1440, 1536, 1840, 1920 ];

/**
 * Observe inline geometry across widths, fit a model per element and property,
 * and write the learned CSS back into the live DOM.
 *
 * Returns without touching the page when nothing carries runtime-written
 * geometry, so a purely declarative site pays only the sweep.
 */
export async function learnAndApplyFluidGeometry(
	page: Page,
	options: FluidSweepOptions = {}
): Promise< FluidLearningResult > {
	const { withEvaluateTimeout } = await import( './page-helpers.js' );
	const original = page.viewportSize();
	const baseline = await captureFluidBaseline( page, ID_ATTRIBUTE );
	let completed = false;
	try {
		const result = await learnFluidGeometry( page, options, baseline );
		completed = true;
		return result;
	} finally {
		try {
			await withEvaluateTimeout( ( async () => {
				if ( ! completed ) {
					await baseline.evaluate( state => state.restore() );
					if ( original ) await page.setViewportSize( original );
					await waitForRestGeometry( page, ID_ATTRIBUTE );
					await baseline.evaluate( state => state.reconcile() );
				}
				await baseline.evaluate( state => state.cleanup() );
			} )(), 8000 );
		} finally {
			await baseline.dispose();
		}
	}
}

async function learnFluidGeometry(
	page: Page,
	options: FluidSweepOptions,
	baseline: Awaited<ReturnType<typeof captureFluidBaseline>>
): Promise<FluidLearningResult> {
	const widths = options.widths ?? DEFAULT_SWEEP_WIDTHS;
	const settleMs = options.settleMs ?? 1200;
	const original = page.viewportSize();

	const tagged = await page.evaluate(
		( { attribute, properties, prefix } ) => {
			let index = 0;
			for ( const element of document.querySelectorAll< HTMLElement >( '[style]' ) ) {
				const ignorePadding = element.hasAttribute( 'data-dla-fluid-ignore-padding' );
				element.removeAttribute( 'data-dla-fluid-ignore-padding' );
				// Match the declarations the measurement pass can actually learn.
				// A substring match also tagged min-height/max-width and percentages,
				// which produced no observations but still paid for the whole sweep.
				const style = element.getAttribute( 'style' ) ?? '';
				const blankParagraph = element.tagName === 'P' &&
					! ( element.textContent ?? '' ).replace( /[ \t\r\n]/g, '' ) &&
					! element.querySelector( ':not(br)' ) &&
					[ '::before', '::after' ].every( pseudo =>
						[ 'none', 'normal', '""', "''" ].includes( getComputedStyle( element, pseudo ).content )
					);
				const carriesPixelSize = properties.some( property =>
					// Adapters can annotate platform-owned closed-state padding without
					// teaching generic capture about their DOM or runtime.
					( property !== 'padding-top' || ! ignorePadding ) &&
					// Empty editorial paragraphs carry font formatting even though they
					// have no text/glyph to size. Retain that native CSS unchanged; explicit
					// spacer dimensions, real text and generated glyphs still qualify.
					!( property === 'font-size' && blankParagraph ) &&
					/^-?\d+(?:\.\d+)?px$/.test( element.style.getPropertyValue( property ).trim() )
				);
				const carriesPixelCustomProperty = /(?:^|;)\s*--[-a-zA-Z0-9_]+\s*:\s*-?\d+(?:\.\d+)?px\s*(?:;|$)/.test( style );
				const carriesMatrixTransform = /(?:^|;)\s*transform\s*:\s*(?:matrix\(|translate(?:3d|x)?\()/i.test( style );
				const carriesAbsoluteInset = getComputedStyle( element ).position === 'absolute' &&
					/(?:^|;)\s*inset\s*:\s*-?\d+(?:\.\d+)?px\s+auto\s+auto\s+-?\d+(?:\.\d+)?px\s*(?:;|$)/.test( style );
				if ( ! carriesPixelSize && ! carriesPixelCustomProperty && ! carriesMatrixTransform && ! carriesAbsoluteInset ) {
					continue;
				}
				element.setAttribute( attribute, `${ prefix }${ index++ }` );
			}
			return index;
		},
		{ attribute: ID_ATTRIBUTE, properties: LEARNABLE_PROPERTIES, prefix: options.document ? `${ options.document }-` : '' }
	);

	if ( tagged === 0 ) {
		return { applied: 0, unmodelled: 0, breakpoints: [], canvasFloor: null, byKind: {} };
	}
	await baseline.evaluate( state => state.bind() );

	// key: `${id}:${property}` -> observations across widths
	const observations = new Map< string, GeometrySample[] >();

	for ( const width of widths ) {
		await page.setViewportSize( { width, height: original?.height ?? 900 } );
		await page.waitForTimeout( settleMs );
		// Lazy content that has not loaded reports no geometry, which would
		// teach the fitter from holes. Scroll the page to settle it first.
		await page.evaluate( async () => {
			const step = window.innerHeight;
			for ( let y = 0; y < document.documentElement.scrollHeight; y += step ) {
				window.scrollTo( { top: y, left: 0, behavior: 'instant' } );
				await new Promise( ( resolve ) => setTimeout( resolve, 60 ) );
			}
			window.scrollTo( { top: 0, left: 0, behavior: 'instant' } );
			// Some scroll-reactive runtimes only recompute their top-of-page state
			// from the scroll handler; scrollTo alone does not emit that event.
			window.dispatchEvent( new Event( 'scroll' ) );
		} );
		// The copy renders at rest — what a reader at the top of the page
		// sees — so the samples must be taken there too. Scroll-linked chrome
		// (a header that shrinks once the page has been scrolled) re-expands
		// on the way back to the top on its own schedule; a fixed delay either
		// races it or wastes time. Wait for the geometry actually being
		// measured to go quiet instead.
		await waitForRestGeometry( page, ID_ATTRIBUTE );
		await baseline.evaluate( state => state.reconcile() );

		const measured = await page.evaluate(
			( { attribute, properties } ) =>
				[ ...document.querySelectorAll< HTMLElement >( `[${ attribute }]` ) ].map( ( element ) => {
					const style = element.getAttribute( 'style' ) ?? '';
					const values: Record< string, number | null > = {};
					const containers: Record< string, number | null > = {};
					const customProperties = [ ...style.matchAll( /(?:^|;)\s*(--[-a-zA-Z0-9_]+)\s*:\s*[^;]+/g ) ].map( ( match ) => match[ 1 ]! );
					const elementProperties = [ ...new Set( [ ...properties, ...customProperties ] ) ];
					const parent = element.parentElement;
					for ( const property of elementProperties ) {
						if ( property === 'inset-top' || property === 'inset-left' ) {
							const inset = /(?:^|;)\s*inset\s*:\s*(-?\d+(?:\.\d+)?)px\s+auto\s+auto\s+(-?\d+(?:\.\d+)?)px\s*(?:;|$)/.exec( style );
							values[ property ] = getComputedStyle( element ).position === 'absolute' && inset
								? Number( inset[ property === 'inset-top' ? 1 : 2 ] ) : null;
							containers[ property ] = null;
							continue;
						}
						if ( property === 'transform-x' ) {
							const transform = /(?:^|;)\s*transform\s*:\s*([^;]+)/i.exec( style )?.[ 1 ]?.trim();
							if ( transform ) {
								const matrix = /^matrix\(\s*([^)]*)\s*\)$/i.exec( transform )?.[ 1 ]?.split( ',' ).map( Number );
								const translated = /^translate(?:3d|x)?\(\s*(-?\d+(?:\.\d+)?)px(?:\s*,\s*0(?:px)?(?:\s*,\s*0(?:px)?)?)?\s*\)$/i.exec( transform );
								const pureMatrix = matrix && matrix.length === 6 && matrix.every( Number.isFinite ) &&
									Math.abs( matrix[ 0 ]! - 1 ) <= 0.01 && Math.abs( matrix[ 1 ]! ) <= 0.01 &&
									Math.abs( matrix[ 2 ]! ) <= 0.01 && Math.abs( matrix[ 3 ]! - 1 ) <= 0.01 && Math.abs( matrix[ 5 ]! ) <= 0.01;
								values[ property ] = pureMatrix ? matrix[ 4 ]! : translated ? Number( translated[ 1 ] ) : null;
							} else values[ property ] = null;
							continue;
						}
						// `font-size` is excluded: CSS resolves a font
						// percentage against the parent font size, not its width,
						// and container-query units assume the exported copy
						// reflows the parent box the way the source did — which a
						// canvas/grid layout frozen into static flow does not.
						// `padding-top` is excluded as well: its percentage
						// resolves against the containing block's width, which
						// the sweep does not observe on the vertical axis.
						containers[ property ] =
							parent &&
							! property.startsWith( '--' ) &&
							property !== 'font-size' &&
							property !== 'padding-top' &&
							property !== 'transform-x'
								? property === 'width'
									? parent.clientWidth
									: parent.clientHeight
								: null;
					}
					for ( const property of elementProperties ) {
						if ( property === 'transform-x' || property === 'inset-top' || property === 'inset-left' ) continue;
						const match = new RegExp( `(?:^|;)\\s*${ property }\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px` ).exec( style );
						values[ property ] = match ? Number( match[ 1 ] ) : null;
						if ( property.startsWith( '--' ) && ! match ) {
							const computed = getComputedStyle( element ).getPropertyValue( property ).trim();
							if ( computed ) values[ property ] = null;
						}
					}
					return { id: element.getAttribute( attribute )!, values, containers };
				} ),
			{ attribute: ID_ATTRIBUTE, properties: LEARNABLE_PROPERTIES as unknown as string[] }
		);
		for ( const entry of measured ) {
			for ( const property of Object.keys( entry.values ) as LearnableProperty[] ) {
				const value = entry.values[ property ];
				const key = `${ entry.id }:${ property }`;
				const list = observations.get( key ) ?? [];
				if ( value === null || value === undefined ) {
					if ( property.startsWith( '--' ) ) {
						list.push( { viewport: width, value: Number.NaN } );
						observations.set( key, list );
					}
					continue;
				}
				list.push( { viewport: width, value, container: entry.containers?.[ property ] ?? null } );
				observations.set( key, list );
			}
		}
		options.onProgress?.( width, measured.length );
	}

	const learned: Array< {
		id: string;
		property: string;
		css: string;
		fallbackCss: string | null;
		/** The declaration is a percentage of the parent, which must be verified. */
		containerRelative: boolean;
		/** Media-scoped rules replace the inline declaration entirely. */
		segmentedCss: string | null;
		/** Media-scoped rules from the sampled sizes, for a percentage that fails verification. */
		sampledCss: string | null;
		/** Whole-range model kind, used when capture-width validation rejects it. */
		kind?: FluidModel['kind'];
	} > = [];
	const byKind: Record< string, number > = {};
	const breakpoints = new Set< number >();
	let canvasFloor: number | null = null;
	let unmodelled = 0;

	for ( const [ key, samples ] of observations ) {
		const [ id, property ] = key.split( ':' ) as [ string, LearnableProperty ];
		const transformX = property === 'transform-x';
		const insetAxis = property === 'inset-top' || property === 'inset-left';
		const customProperty = property.startsWith( '--' );
		const modelSamples = customProperty ? widestFiniteRun( samples ) : samples;
		const wholeRangeModel = learnFluidModel( modelSamples );
		const model: FluidModel = learnWidestFluidModel( modelSamples );
		byKind[ model.kind ] = ( byKind[ model.kind ] ?? 0 ) + 1;
		if ( wholeRangeModel.kind === 'breakpoint' ) {
			for ( const width of breakpointsFrom( wholeRangeModel.samples ) ) breakpoints.add( width );
		}
		// A single relationship may fit no single stretch of the sampled range
		// yet still be recoverable piecewise: sources routinely obey one rule
		// above their mobile breakpoint and another below it. Where every
		// segment fits a viewport-expressible model, ship media-scoped rules
		// instead of freezing.
		const segmented =
			wholeRangeModel.kind === 'breakpoint'
				? learnSegmentedFluidModel( modelSamples, customProperty || insetAxis
					? { holdUnfitted: true, holdNarrowForBoundedAffine: true }
					: { holdUnfitted: transformX, holdNarrowForBoundedAffine: true } )
				: null;
		if ( insetAxis ) {
			const segments = segmented?.segments ?? ( wholeRangeModel.kind !== 'breakpoint' && wholeRangeModel.kind !== 'constant' && wholeRangeModel.kind !== 'container'
				? [ { model: wholeRangeModel, minWidth: null, maxWidth: null } ] : null );
			if ( segments === null ) continue;
			learned.push( {
				id,
				property: property === 'inset-top' ? 'top' : 'left',
				css: '',
				fallbackCss: null,
				containerRelative: false,
				sampledCss: null,
				segmentedCss: segmentedCss( `[${ SEGMENT_ATTRIBUTE }="${ id }"]`, property === 'inset-top' ? 'top' : 'left', segments ),
			} );
			continue;
		}
		if ( customProperty && model.kind !== 'breakpoint' && modelSamples.length >= 3 ) {
			const customModel =
				model.kind === 'container'
					? learnWidestFluidModel( modelSamples.map( ( sample ) => ( { viewport: sample.viewport, value: sample.value } ) ) )
					: model;
			if ( customModel.kind === 'breakpoint' || customModel.kind === 'container' ) {
				unmodelled++;
				continue;
			}
			learned.push( {
				id,
				property,
				css: customModel.kind === 'constant' ? customModel.css : '',
				fallbackCss: null,
				containerRelative: false,
				sampledCss: null,
				segmentedCss:
					customModel.kind === 'constant'
						? null
						: segmentedCss( `[${ SEGMENT_ATTRIBUTE }="${ id }"]`, property, [
								{
									model: customModel,
									minWidth: modelSamples[ 0 ]!.viewport,
									maxWidth: null,
								},
							] ),
			} );
			continue;
		}
		if ( transformX && ( model.kind !== 'breakpoint' || segmented !== null ) ) {
			const element = await page.locator( `[${ ID_ATTRIBUTE }="${ id }"]` ).first().getAttribute( 'style' );
			const transform = /(?:^|;)\s*transform\s*:\s*([^;]+)/i.exec( element ?? '' )?.[ 1 ]?.trim();
			if ( ! transform || pureXTranslation( transform ) === null ) {
				// The runtime may have switched this transform after the sweep; do not
				// replace a newly rotated, scaled, skewed, or vertically shifted matrix.
				unmodelled++;
				continue;
			}
			const valueFor = ( css: string ) => `translateX(${ css })`;
			const transformSegments =
				segmented?.segments ?? ( model.kind === 'breakpoint' ? [] : [ { model, minWidth: null, maxWidth: null } ] );
			learned.push( {
				id,
				property: 'transform',
				css: '',
				fallbackCss: null,
				containerRelative: false,
				sampledCss: null,
				segmentedCss: segmentedCss(
					`[${ SEGMENT_ATTRIBUTE }="${ id }"]`,
					'transform',
					transformSegments.map( ( segment ) => ( {
						...segment,
						model: { ...segment.model, css: valueFor( segment.model.css ) },
					} ) )
				),
			} );
			continue;
		}
		if ( segmented !== null ) {
			byKind[ model.kind ] = Math.max( 0, ( byKind[ model.kind ] ?? 0 ) - 1 );
			byKind.segmented = ( byKind.segmented ?? 0 ) + 1;
			for ( const segment of segmented.segments ) {
				if ( segment.minWidth !== null ) breakpoints.add( segment.minWidth );
			}
			learned.push( {
				id,
				property,
				css: '',
				fallbackCss: null,
				containerRelative: false,
				sampledCss: null,
				segmentedCss: segmentedCss(
					`[${ SEGMENT_ATTRIBUTE }="${ id }"]`,
					property,
					segmented.segments
				),
			} );
			continue;
		}
		if ( model.kind === 'breakpoint' ) {
			// Leaving the frozen value is the honest outcome: a wrong formula
			// would be worse than an admittedly fixed one.
			unmodelled++;
			continue;
		}
		if ( model.kind === 'floored' && property === 'width' ) {
			canvasFloor = Math.max( canvasFloor ?? 0, model.floor );
		}
		// A percentage only resolves against a parent that has a definite size on
		// that axis. Carry the viewport fit so a container model that collapses
		// can fall back to the previous behaviour instead of to nothing.
		let fallbackCss: string | null = null;
		let sampledCss: string | null = null;
		if ( model.kind === 'container' ) {
			const viewportSamples = samples.map( ( sample ) => ( { viewport: sample.viewport, value: sample.value } ) );
			const viewportOnly = learnWidestFluidModel( viewportSamples );
			const varying = Math.max( ...viewportSamples.map( ( sample ) => sample.value ) ) -
				Math.min( ...viewportSamples.map( ( sample ) => sample.value ) ) > CONTAINER_VERIFY_TOLERANCE_PX;
			// A shrink-to-fit intermediate can make 100% collapse. The widest
			// shortcut may fit only its narrow constant regime, even though the
			// source grew across the rest of the sweep. Try the complete bounded
			// viewport relationship before accepting that frozen constant.
			const sampled = viewportOnly.kind === 'breakpoint' || ( viewportOnly.kind === 'constant' && varying )
				? learnSegmentedFluidModel( viewportSamples, { holdUnfitted: true } )
				: null;
			if ( sampled !== null ) {
				sampledCss = segmentedCss( `[${ SEGMENT_ATTRIBUTE }="${ id }"]`, property, sampled.segments );
			} else if ( viewportOnly.kind !== 'breakpoint' ) {
				fallbackCss = viewportOnly.css;
			}
		}
		// A captured runtime can give a parent a definite height that disappears
		// when its scripts are removed. A viewport fit keeps a learned height
		// definite in the static document instead of collapsing to 0px.
		const css = property === 'height' && fallbackCss !== null ? fallbackCss : model.css;
		learned.push( {
			id,
			property,
			css,
			fallbackCss,
			containerRelative: model.kind === 'container' && css === model.css,
			segmentedCss: null,
			sampledCss,
			kind: model.kind,
		} );
	}

	// Seed each source role with its capture baseline BEFORE returning the
	// viewport. Resize handlers can clone the previous state before updating it;
	// they must inherit the capture baseline rather than the widest sweep sample.
	// The source then owns the final clone state. Learned CSS follows that resize.
	await baseline.evaluate( state => state.restore() );
	if ( original ) await page.setViewportSize( original );
	await page.waitForTimeout( settleMs );
	await waitForRestGeometry( page, ID_ATTRIBUTE );
	await baseline.evaluate( state => state.reconcile() );
	// The resize back to the capture viewport can switch a transform to another
	// matrix after the sweep. Validate that final state before removing inline
	// transform; otherwise translateX would discard its new components.
	for ( let index = learned.length - 1; index >= 0; index-- ) {
		const entry = learned[ index ]!;
		if ( entry.property !== 'transform' ) continue;
		const style = await page.locator( `[${ ID_ATTRIBUTE }="${ entry.id }"]` ).first().getAttribute( 'style' );
		const transform = /(?:^|;)\s*transform\s*:\s*([^;]+)/i.exec( style ?? '' )?.[ 1 ]?.trim();
		if ( transform && pureXTranslation( transform ) !== null ) continue;
		learned.splice( index, 1 );
		unmodelled++;
	}

	const { reverted, frozen, frozenWidths, sampled, appliedCss } = await page.evaluate(
		( { attribute, segmentAttribute, entries, tolerance } ) => {
			let revertedCount = 0;
			let frozenCount = 0;
			const frozenWidths: number[] = [];
			const sampledEntries: number[] = [];
			// Accepted rules stay applied while later entries are measured; the
			// capture-owned stylesheet written after this loop replaces them.
			const probes: HTMLStyleElement[] = [];
			for ( const [ index, entry ] of entries.entries() ) {
				const element = document.querySelector< HTMLElement >( `[${ attribute }="${ entry.id }"]` );
				if ( ! element ) continue;
				if ( entry.segmentedCss !== null ) {
					// The rules live in a stylesheet keyed by the persistent
					// attribute, so the runtime's inline pixels must go — an
					// inline declaration would outrank them at every width.
					element.setAttribute( segmentAttribute, entry.id );
					element.style.removeProperty( entry.property );
					continue;
				}
				const axis = entry.property === 'height' ? 'height' : 'width';
				const before = element.getBoundingClientRect()[ axis ];
				const runtimeValue = element.style.getPropertyValue( entry.property );
				const runtimePriority = element.style.getPropertyPriority( entry.property );
				element.style.setProperty( entry.property, entry.css );
				if ( ! entry.containerRelative ) {
					// A fit learned outside the capture width may describe a clone's
					// transient wide state. Never replace its returned width with a
					// relationship that fails this source observation.
					if ( entry.property === 'width' && Math.abs( element.getBoundingClientRect().width - before ) > tolerance ) {
						element.style.setProperty( entry.property, runtimeValue, runtimePriority );
						entry.css = runtimeValue;
						frozenWidths.push( index );
					}
					continue;
				}

				// Verify rather than assume: a percentage only resolves against a
				// parent with a definite size on this axis. A shrink-to-fit parent
				// measures exactly its child at every sampled width, so the fit
				// looks perfect, yet the percentage then collapses it. Fall back
				// to the viewport fit, then to rules following the sampled sizes,
				// and keep the runtime's pixels only when neither is available.
				const after = element.getBoundingClientRect()[ axis ];
				if ( Math.abs( after - before ) <= tolerance ) continue;
				if ( entry.fallbackCss !== null ) {
					element.style.setProperty( entry.property, entry.fallbackCss );
					if ( Math.abs( element.getBoundingClientRect()[ axis ] - before ) <= tolerance ) {
						entry.css = entry.fallbackCss;
						revertedCount++;
						continue;
					}
				}
				if ( entry.sampledCss !== null ) {
					// Held to the same verification: the rules must reproduce
					// the capture width's size before they replace its pixels.
					const probe = document.createElement( 'style' );
					probe.textContent = entry.sampledCss;
					document.head.appendChild( probe );
					const hadSegment = element.hasAttribute( segmentAttribute );
					element.setAttribute( segmentAttribute, entry.id );
					element.style.removeProperty( entry.property );
					const sampledSize = element.getBoundingClientRect()[ axis ];
					if ( Math.abs( sampledSize - before ) <= tolerance ) {
						probes.push( probe );
						entry.segmentedCss = entry.sampledCss;
						sampledEntries.push( index );
						continue;
					}
					probe.remove();
					if ( ! hadSegment ) element.removeAttribute( segmentAttribute );
				}
				element.style.setProperty( entry.property, runtimeValue, runtimePriority );
				entry.css = runtimeValue;
				frozenCount++;
			}
			for ( const probe of probes ) probe.remove();
			return { reverted: revertedCount, frozen: frozenCount, frozenWidths, sampled: sampledEntries, appliedCss: entries.map( entry => entry.css ) };
		},
		{
			attribute: ID_ATTRIBUTE,
			segmentAttribute: SEGMENT_ATTRIBUTE,
			entries: learned,
			tolerance: CONTAINER_VERIFY_TOLERANCE_PX,
		}
	);

	for ( const [ index, css ] of appliedCss.entries() ) learned[ index ]!.css = css;
	for ( const index of sampled ) learned[ index ]!.segmentedCss = learned[ index ]!.sampledCss;
	const segmentedRules = learned
		.map( ( entry ) => entry.segmentedCss )
		.filter( ( css ): css is string => css !== null );
	if ( segmentedRules.length > 0 ) {
		await page.evaluate(
			( { styleAttribute, rules } ) => {
				const style = document.createElement( 'style' );
				style.setAttribute( styleAttribute, '' );
				style.textContent = rules.join( '\n' );
				document.head.appendChild( style );
			},
			{ styleAttribute: SEGMENT_STYLE_ATTRIBUTE, rules: segmentedRules }
		);
	}
	await baseline.evaluate( ( state, { entries, segmentAttribute, width } ) => state.activate( entries, segmentAttribute, width ), {
		entries: learned.map( entry => ( { id: entry.id, property: entry.property, css: entry.css, segmented: entry.segmentedCss !== null } ) ),
		segmentAttribute: SEGMENT_ATTRIBUTE,
		width: original?.width,
	} );

	if ( reverted > 0 ) {
		byKind.container = Math.max( 0, ( byKind.container ?? 0 ) - reverted );
		byKind.proportional = ( byKind.proportional ?? 0 ) + reverted;
	}
	if ( frozen > 0 ) byKind.container = Math.max( 0, ( byKind.container ?? 0 ) - frozen );
	for ( const index of frozenWidths ) {
		const kind = learned[ index ]!.kind!;
		byKind[ kind ] = Math.max( 0, ( byKind[ kind ] ?? 0 ) - 1 );
	}
	if ( sampled.length > 0 ) {
		byKind.container = Math.max( 0, ( byKind.container ?? 0 ) - sampled.length );
		byKind.segmented = ( byKind.segmented ?? 0 ) + sampled.length;
	}

	return {
		applied: learned.length - frozen - frozenWidths.length,
		unmodelled: unmodelled + frozen + frozenWidths.length,
		breakpoints: [ ...breakpoints ].sort( ( a, b ) => a - b ),
		canvasFloor,
		byKind,
	};
}

/**
 * Wait until the runtime stops rewriting the inline styles being measured.
 *
 * Scroll-linked chrome (a header that shrinks once the page is scrolled)
 * re-expands after the sweep returns to the top on the source's own schedule,
 * and the runtime rewrites the geometry that depends on it as it goes.
 * Sampling mid-transition teaches the fitter the scrolled state, which is not
 * the state the copy renders. Watch exactly what is sampled: four consecutive
 * identical reads, one second apart in total, count as rest. The bound keeps a
 * perpetually animating page from stalling the sweep.
 */
async function waitForRestGeometry( page: Page, attribute: string ): Promise< void > {
	await page.evaluate( async ( { attribute } ) => {
		const snapshot = () =>
			[ ...document.querySelectorAll( `[${ attribute }]` ) ]
				.map( ( element ) => element.getAttribute( 'style' ) ?? '' )
				.join( '\n' );
		const deadline = Date.now() + 3500;
		let previous = snapshot();
		let quiet = 0;
		while ( Date.now() < deadline && quiet < 4 ) {
			await new Promise( ( resolve ) => setTimeout( resolve, 250 ) );
			const current = snapshot();
			quiet = current === previous ? quiet + 1 : 0;
			previous = current;
		}
	}, { attribute } );
}

/** The last contiguous stretch of numeric pixel custom-property observations. */
function widestFiniteRun( samples: readonly GeometrySample[] ): GeometrySample[] {
	const runs: GeometrySample[][] = [];
	let run: GeometrySample[] = [];
	for ( const sample of [ ...samples ].sort( ( a, b ) => a.viewport - b.viewport ) ) {
		if ( Number.isFinite( sample.value ) ) run.push( sample );
		else if ( run.length ) {
			runs.push( run );
			run = [];
		}
	}
	if ( run.length ) runs.push( run );
	return runs.at( -1 ) ?? [];
}
