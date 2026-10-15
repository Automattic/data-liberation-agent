// src/lib/screenshot/fluid-capture.ts
//
// Drive the width sweep that `fluid-model` learns from.
//
// The source's own runtime is left running while the viewport changes, so what
// we record is the site telling us how it sizes itself. The learned CSS then
// replaces the runtime-written inline pixels, which is what lets the liberated
// copy keep reflowing after that runtime is stripped.
//
import { RUNTIME_STYLE_WRITES_KEY } from './runtime-style-writes.js';
import {
	breakpointsFrom,
	interpolateSamples,
	learnFluidModel,
	learnSegmentedFluidModel,
	learnWidestFluidModel,
	segmentedCss,
	type FluidModel,
	type GeometrySample,
} from './fluid-model.js';
import type { Page } from 'playwright';
import { captureFluidBaseline } from './fluid-baseline.js';
import { applyRuntimeSheetRules, bindRuntimeSheets, observeRuntimeSheets, offsetSegments, runtimeSheetSeries, runtimeSheetsObserved } from './fluid-runtime-sheets.js';

/** Marks elements across viewport changes; removed before serialization. */
const ID_ATTRIBUTE = 'data-blocks-engine-capture-fluid-id';
/** Keys segmented stylesheet rules to their element; survives serialization. */
const SEGMENT_ATTRIBUTE = 'data-blocks-engine-capture-fluid-segment';
/** How far a container percentage may miss the size it replaced at the capture width. */
const CONTAINER_VERIFY_TOLERANCE_PX = 2;
/** Marks the stylesheet block carrying segmented rules as capture-owned. */
export const SEGMENT_STYLE_ATTRIBUTE = 'data-blocks-engine-capture-fluid-rules';
/** Attribute pattern used by the exporter to recognize those blocks. */
export const FLUID_RULES_STYLE_ATTRIBUTE = /\bdata-blocks-engine-capture-fluid-rules\b/i;
/** Only geometry that a runtime plausibly derives from viewport width. */
const LEARNABLE_PROPERTIES = [ 'width', 'height', 'font-size', 'padding-top', 'transform-x', 'inset-top', 'inset-left' ] as const;

export type LearnableProperty = ( typeof LEARNABLE_PROPERTIES )[ number ] | 'left';

export interface FluidSweepOptions {
	/** Distinguishes rule identities when responsive documents share a stylesheet. */
	document?: 'desktop' | 'mobile';
	/**
	 * Widths to observe, sampled exactly as given. Omitted: the coarse widths,
	 * refined within DEFAULT_SWEEP_WIDTHS where the observations need it.
	 */
	widths?: number[];
	/** Minimum observation window after resize, overlapping lazy work and rest. */
	settleMs?: number;
	/** Source-owned motion/readiness before each geometry sample, after rest settling. */
	prepareViewport?: ( page: Page ) => Promise< void >;
	/** Opt in when the source positions relative slides with width-derived left offsets. */
	learnRelativeOffsets?: boolean;
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
 * than adapting. This is geometry, not evidence of a device document switch.
	 */
	canvasFloor: number | null;
	byKind: Record< string, number >;
	/** Widths the sweep sampled, ascending; empty when it never resized. Its length is the sweep's cost. */
	sampledWidths: number[];
}

/** Default ladder: mobile, canvas, and wide, spanning common real viewports.
 *
 * The mobile widths matter: a source that obeys one rule above its mobile
 * breakpoint and another below it (container share changes, different clamp)
 * is unmodelled — or worse, mis-modelled — when every sample sits above the
 * switch. The dense 767–801 run locates a narrow tablet transition.
 *
 * This is the resolution the default sweep can reach, not what it samples:
 * see COARSE_SWEEP_WIDTHS and refinementWidths. */
export const DEFAULT_SWEEP_WIDTHS = [ 390, 600, 767, 768, 769, 775, 783, 791, 799, 800, 801, 1024, 1280, 1440, 1536, 1840, 1920 ];

/**
 * Widths every varying default sweep samples; the ladder refines between them.
 *
 * Each sits on the far side of a common CSS switch, so every interval holds
 * the switches the ladder was built around: phone (390) and large phone (600)
 * below the 767/768 switch, tablet (768) on its far side, desktop (1024) past
 * the 800/801 and 991/992 tablet switches, a common desktop canvas (1440) past
 * 1200/1280, and the widest viewport (1920) past 1536/1600. The first three are
 * the probe that stops a sweep whose geometry is constant.
 */
export const COARSE_SWEEP_WIDTHS = [ 390, 600, 768, 1024, 1440, 1920 ];
const PROBE_WIDTHS = [ 390, 768, 1920 ];
const COLLINEAR_TOLERANCE_PX = 0.5;

/**
 * Ladder widths to sample next: one per interval the observations leave unexplained.
 *
 * An interval between adjacent sampled widths is explained when every series
 * is one straight line across it and a neighbouring sample: a straight run
 * (constant, proportional, affine) predicts every ladder width inside, which
 * interpolateSamples then supplies to the fitters. Anything else (a kink, a
 * jump, a clamp, or a series that appears, vanishes, or stops being pixels
 * there) refines the interval with the ladder width nearest its midpoint,
 * until the change sits between adjacent ladder widths: the same place the
 * full ladder locates it.
 *
 * A clamp is refined rather than explained by its clamped line: interpolating
 * across the knee would invent values, and in a segmented series the boundary
 * is the first ladder width past the knee.
 */
export function refinementWidths( series: Iterable< readonly GeometrySample[] >, sampled: readonly number[], ladder: readonly number[] = DEFAULT_SWEEP_WIDTHS ): number[] {
	const widths = [ ...new Set( sampled ) ].sort( ( a, b ) => a - b );
	const intervals = widths.slice( 0, -1 ).map( ( low, index ) => ( { index, inside: ladder.filter( width => width > low && width < widths[ index + 1 ]! ) } ) )
		.filter( interval => interval.inside.length > 0 );
	const refined = new Set< number >();
	for ( const samples of series ) {
		if ( refined.size === intervals.length ) break;
		const at = new Map( samples.map( sample => [ sample.viewport, sample.value ] ) );
		const value = ( index: number ) => {
			const found = at.get( widths[ index ]! );
			return found !== undefined && Number.isFinite( found ) ? found : null;
		};
		const straight = ( first: number ) => {
			if ( first < 0 || first + 2 >= widths.length ) return false;
			const [ a, b, c ] = [ value( first ), value( first + 1 ), value( first + 2 ) ];
			if ( a === null || b === null || c === null ) return false;
			const [ wa, wb, wc ] = [ widths[ first ]!, widths[ first + 1 ]!, widths[ first + 2 ]! ];
			return Math.abs( b - ( a + ( c - a ) * ( wb - wa ) / ( wc - wa ) ) ) <= COLLINEAR_TOLERANCE_PX;
		};
		let chosen: number | null = null;
		for ( const { index } of intervals ) {
			// Absent (or non-pixel) at both ends: nothing here for this series to learn.
			if ( value( index ) === null && value( index + 1 ) === null ) continue;
			if ( straight( index - 1 ) || straight( index ) ) continue;
			// One change leaves both intervals beside it without a straight window
			// when one of them is the sweep's last. Refining the first can explain
			// the second; if not, it is refined next round at the same width.
			if ( chosen === index - 1 ) continue;
			refined.add( index );
			chosen = index;
		}
	}
	return intervals.filter( ( { index } ) => refined.has( index ) ).map( ( { index, inside } ) => {
		const middle = ( widths[ index ]! + widths[ index + 1 ]! ) / 2;
		return inside.reduce( ( best, width ) => Math.abs( width - middle ) < Math.abs( best - middle ) ? width : best );
	} );
}

/**
 * The series refinement must explain before skipped widths can be interpolated.
 *
 * Perpetually animated elements never rest, so their samples are not evidence
 * of a switch. A varying value may fit its container, so the container is
 * interpolated evidence too; a constant value never consults it.
 */
export function refinementSeries( observations: ReadonlyMap< string, readonly GeometrySample[] >, perpetual: ReadonlySet< string > ): Array< readonly GeometrySample[] > {
	return [ ...observations ].filter( ( [ key ] ) => ! perpetual.has( key.slice( 0, key.indexOf( ':' ) ) ) ).flatMap( ( [ , samples ] ) => {
		const values = samples.map( sample => sample.value );
		const varying = Math.max( ...values ) - Math.min( ...values ) > CONTAINER_VERIFY_TOLERANCE_PX;
		const containers = samples.flatMap( sample => typeof sample.container === 'number' ? [ { viewport: sample.viewport, value: sample.container } ] : [] );
		return varying && containers.length ? [ samples, containers ] : [ samples ];
	} );
}

/**
 * Whether every observed series, outside perpetually animated elements, holds
 * one finite value at each of `samples` widths: nothing the sweep could learn
 * varies with width.
 */
export function constantAcross( observations: ReadonlyMap< string, readonly GeometrySample[] >, samples: number, perpetual: ReadonlySet< string > ): boolean {
	for ( const [ key, series ] of observations ) {
		if ( perpetual.has( key.slice( 0, key.indexOf( ':' ) ) ) ) continue;
		if ( series.length !== samples ) return false;
		const first = series[ 0 ]!.value;
		if ( ! Number.isFinite( first ) || series.some( sample => sample.value !== first ) ) return false;
	}
	return true;
}

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
					await waitForRestGeometry( page, baseline );
					await baseline.evaluate( state => state.restore() );
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
	// An explicit ladder is sampled as given; the default samples its coarse
	// widths and refines the ladder only on evidence (see refinementWidths).
	const adaptive = options.widths === undefined;
	const widths = options.widths ?? DEFAULT_SWEEP_WIDTHS;
	const settleMs = options.settleMs ?? 1200;
	const original = page.viewportSize();
	const properties = options.learnRelativeOffsets ? [ ...LEARNABLE_PROPERTIES, 'left' ] : [ ...LEARNABLE_PROPERTIES ];

	const tagged = await baseline.evaluate(
		( state, { attribute, properties, prefix } ) => {
			let index = 0;
			for ( const element of document.querySelectorAll< HTMLElement >( '[style]' ) ) {
				const ignorePadding = element.hasAttribute( 'data-blocks-engine-capture-fluid-ignore-padding' );
				element.removeAttribute( 'data-blocks-engine-capture-fluid-ignore-padding' );
				// Match the declarations the measurement pass can actually learn.
				// A substring match also tagged min-height/max-width and percentages,
				// which produced no observations but still paid for the whole sweep.
				const geometry = state.readGeometry( element );
				const style = geometry.literal;
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
					( property !== 'left' || geometry.position === 'relative' ) &&
					state.pixel( geometry.style.getPropertyValue( property ) ) !== null
				);
				const carriesPixelCustomProperty = /(?:^|;)\s*--[-a-zA-Z0-9_]+\s*:\s*-?\d+(?:\.\d+)?px\s*(?:;|$)/.test( style );
				const carriesMatrixTransform = /(?:^|;)\s*transform\s*:\s*(?:matrix\(|translate(?:3d|x)?\()/i.test( style );
				const carriesAbsoluteInset = geometry.inset !== null;
				if ( ! carriesPixelSize && ! carriesPixelCustomProperty && ! carriesMatrixTransform && ! carriesAbsoluteInset ) {
					continue;
				}
				element.setAttribute( attribute, `${ prefix }${ index++ }` );
			}
			return index;
		},
		{ attribute: ID_ATTRIBUTE, properties, prefix: options.document ? `${ options.document }-` : '' }
	);

	if ( tagged === 0 || await inlineGeometryIsConstant( page, baseline, widths, original, settleMs ) ) {
		await baseline.evaluate( ( state, attribute ) => {
			for ( const element of state.elements() ) element.removeAttribute( attribute );
		}, ID_ATTRIBUTE );
		return { applied: 0, unmodelled: 0, breakpoints: [], canvasFloor: null, byKind: {}, sampledWidths: [] };
	}
	await baseline.evaluate( state => state.bind() );
	await bindRuntimeSheets( page );

	// key: `${id}:${property}` -> observations across widths
	const observations = new Map< string, GeometrySample[] >();
	const nonRelative = new Set( options.learnRelativeOffsets ? await baseline.evaluate( ( state, attribute ) =>
		state.elements().filter( element => state.readGeometry( element ).position !== 'relative' )
			.map( element => element.getAttribute( attribute )! ), ID_ATTRIBUTE ) : [] );

	// Widths in the order they were sampled; runtime-sheet observations align to it.
	const sampledWidths: number[] = [];
	const sample = async ( width: number ) => {
		sampledWidths.push( width );
		await page.setViewportSize( { width, height: original?.height ?? 900 } );
		await waitForRestGeometry( page, baseline, settleMs, true, properties, true );
		await options.prepareViewport?.( page );
		await baseline.evaluate( state => state.reconcile() );
		await observeRuntimeSheets( page );

		const measured = await baseline.evaluate(
			( state, { attribute, properties } ) =>
				state.elements().map( ( element ) => {
					const geometry = state.readGeometry( element );
					const style = geometry.literal;
					const values: Record< string, number | null > = {};
					const containers: Record< string, number | null > = {};
					const customProperties = [ ...style.matchAll( /(?:^|;)\s*(--[-a-zA-Z0-9_]+)\s*:\s*[^;]+/g ) ].map( ( match ) => match[ 1 ]! );
					const elementProperties = [ ...new Set( [ ...properties, ...customProperties ] ) ];
					const parent = geometry.parent;
					const relative = geometry.position === 'relative';
					for ( const property of elementProperties ) {
						if ( property === 'inset-top' || property === 'inset-left' ) {
							values[ property ] = geometry.inset?.[ property === 'inset-top' ? 'top' : 'left' ] ?? null;
							containers[ property ] = null;
							continue;
						}
						if ( property === 'transform-x' ) {
							values[ property ] = geometry.translation;
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
								? property === 'width' || property === 'left'
									? parent.clientWidth
									: parent.clientHeight
								: null;
					}
					for ( const property of elementProperties ) {
						if ( property === 'transform-x' || property === 'inset-top' || property === 'inset-left' ) continue;
						if ( property === 'left' && ! relative ) {
							values[ property ] = null;
							continue;
						}
						const match = new RegExp( `(?:^|;)\\s*${ property }\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px` ).exec( style );
						values[ property ] = match ? Number( match[ 1 ] ) : null;
						if ( property.startsWith( '--' ) && ! match ) {
							const computed = getComputedStyle( element ).getPropertyValue( property ).trim();
							if ( computed ) values[ property ] = null;
						}
					}
					return { id: element.getAttribute( attribute )!, values, containers, relative };
				} ),
			{ attribute: ID_ATTRIBUTE, properties }
		);
		for ( const entry of measured ) {
			if ( ! entry.relative ) nonRelative.add( entry.id );
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
	};
	const perpetual = async () => new Set( await baseline.evaluate( state =>
		[ ...( ( state as unknown as { perpetual?: Set< string > } ).perpetual ?? [] ) ] ) );
	if ( ! adaptive ) {
		for ( const width of widths ) await sample( width );
	} else {
		// The probe widths come first. When every tagged series is identical
		// across them (perpetual movers excluded) and no runtime stylesheet
		// varied, every learned rule would be `constant` — the frozen copy
		// already carries it — so the rest of the sweep is skipped.
		for ( const width of PROBE_WIDTHS ) await sample( width );
		if ( await runtimeSheetsObserved( page ) || ! constantAcross( observations, PROBE_WIDTHS.length, await perpetual() ) ) {
			for ( const width of COARSE_SWEEP_WIDTHS ) if ( ! sampledWidths.includes( width ) ) await sample( width );
			// Refine only intervals some series leaves unexplained.
			for ( ;; ) {
				const series = refinementSeries( observations, await perpetual() );
				const next = refinementWidths( [ ...series, ...await runtimeSheetSeries( page, sampledWidths ) ], sampledWidths, widths );
				if ( next.length === 0 ) break;
				for ( const width of next ) await sample( width );
			}
		}
		// Every skipped ladder width now sits inside a straight interval of every
		// series, so the fitters receive the full ladder's observations.
		const moving = await perpetual();
		for ( const [ key, samples ] of observations ) {
			if ( ! moving.has( key.slice( 0, key.indexOf( ':' ) ) ) ) observations.set( key, interpolateSamples( samples, sampledWidths, widths ) );
		}
	}
	for ( const list of observations.values() ) list.sort( ( a, b ) => a.viewport - b.viewport );

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
		// Any non-relative sample invalidates the entire offset relationship.
		// Fitting the remaining relative samples would erase authored positioning.
		if ( property === 'left' && nonRelative.has( id ) ) continue;
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
		// Absolute insets share one offset owner with runtime-written sheet offsets.
		if ( insetAxis ) {
			const segments = offsetSegments( modelSamples );
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
		// A single relationship may fit no single stretch of the sampled range
		// yet still be recoverable piecewise: sources routinely obey one rule
		// above their mobile breakpoint and another below it. Where every
		// segment fits a viewport-expressible model, ship media-scoped rules
		// instead of freezing.
		const segmented =
			wholeRangeModel.kind === 'breakpoint'
				? learnSegmentedFluidModel( property === 'left'
					? modelSamples.map( ( { viewport, value } ) => ( { viewport, value } ) ) : modelSamples, customProperty
					? { holdUnfitted: true, holdNarrowForBoundedAffine: true }
					: { holdUnfitted: transformX, holdNarrowForBoundedAffine: true } )
				: null;
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
			// Source resize handlers can remove measured nodes; absence is final,
			// not a reason to auto-wait for the old identity to reappear.
			const translation = await baseline.evaluate( ( state, id ) => state.translation( id ), id );
			if ( translation === null ) {
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
	await waitForRestGeometry( page, baseline, settleMs, false, properties );
	await replayReplacedEntrances( page, baseline, properties );
	await baseline.evaluate( state => state.reconcile() );
	// A final resize may write geometry onto roles that never qualified for
	// learning. Restore those roles without replacing the sampled role state.
	await baseline.evaluate( state => state.restore( true ) );
	// The resize back to the capture viewport can switch a transform to another
	// matrix after the sweep. Validate that final state before removing inline
	// transform; otherwise translateX would discard its new components.
	for ( let index = learned.length - 1; index >= 0; index-- ) {
		const entry = learned[ index ]!;
		if ( entry.property === 'left' && options.learnRelativeOffsets &&
			! await baseline.evaluate( ( state, id ) => {
				const element = state.element( id );
				return element !== null && state.readGeometry( element ).position === 'relative';
			}, entry.id ) ) {
			learned.splice( index, 1 );
			unmodelled++;
			continue;
		}
		if ( entry.property !== 'transform' ) continue;
		const translation = await baseline.evaluate( ( state, id ) => state.translation( id ), entry.id );
		if ( translation !== null ) continue;
		learned.splice( index, 1 );
		unmodelled++;
	}

	const { reverted, frozen, frozenWidths, sampled, appliedCss } = await baseline.evaluate(
		( state, { segmentAttribute, entries, tolerance } ) => {
			let revertedCount = 0;
			let frozenCount = 0;
			const frozenWidths: number[] = [];
			const sampledEntries: number[] = [];
			// Accepted rules stay applied while later entries are measured; the
			// capture-owned stylesheet written after this loop replaces them.
			const probes: HTMLStyleElement[] = [];
			// This runs in the page's main world, where a legacy library can have
			// replaced Array.prototype methods (Prototype.js turns `entries()` into a
			// plain copy or deletes it). Index the array instead.
			for ( let index = 0; index < entries.length; index++ ) {
				const entry = entries[ index ]!;
				const element = state.element( entry.id );
				if ( ! element ) continue;
				if ( entry.segmentedCss !== null ) {
					// The rules live in a stylesheet keyed by the persistent
					// attribute, so the runtime's inline pixels must go — an
					// inline declaration would outrank them at every width.
					element.setAttribute( segmentAttribute, entry.id );
					element.style.removeProperty( entry.property );
					continue;
				}
				const axis = entry.property === 'left' ? 'x' : entry.property === 'height' ? 'height' : 'width';
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
	// The runtime has rewritten its own sheets for the capture width by now;
	// learned rules are validated against exactly that geometry.
	const runtimeSheets = await applyRuntimeSheetRules( page, sampledWidths, adaptive ? widths : sampledWidths );
	if ( runtimeSheets.applied > 0 ) byKind[ 'runtime-sheet' ] = runtimeSheets.applied;

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
		applied: learned.length - frozen - frozenWidths.length + runtimeSheets.applied,
		unmodelled: unmodelled + frozen + frozenWidths.length + runtimeSheets.unmodelled,
		breakpoints: [ ...breakpoints ].sort( ( a, b ) => a - b ),
		canvasFloor,
		byKind,
		sampledWidths: [ ...sampledWidths ].sort( ( a, b ) => a - b ),
	};
}

/**
 * One per-width readiness contract: observe resize, lazy work, and at-top rest.
 *
 * Scroll-linked chrome (a header that shrinks once the page is scrolled)
 * re-expands after the sweep returns to the top on the source's own schedule,
 * and the runtime rewrites the geometry that depends on it as it goes.
 * Sampling mid-transition teaches the fitter the scrolled state, which is not
 * the state the copy renders. Watch exactly what is sampled: four consecutive
 * identical reads, one second apart in total, count as rest. The resize window
 * overlaps that observation rather than preceding it. The bound keeps a
 * perpetually animating page from stalling the sweep.
 *
 * Sampled widths share one sweep: the first width's scroll-through visits the
 * document end to end, and a later width can only reach lazy work the earlier
 * sweep missed when the document grew past it or an image that may load newly
 * entered the render tree — both of which the rest loop below observes and
 * re-sweeps. So a width reuses the previous sweep when its document sits
 * inside the swept extent and its pending-image set has no new work, instead
 * of paying a full scroll-through at every width. Entrance replay still
 * sweeps for its own sake: its scroll-through is the point.
 */
async function waitForRestGeometry( page: Page, baseline: Awaited<ReturnType<typeof captureFluidBaseline>>, settleMs = 0, lazy = false, properties: readonly string[] = LEARNABLE_PROPERTIES, reuseSweep = false ): Promise< void > {
	const { withEvaluateTimeout, installImageReachability } = await import( './page-helpers.js' );
	const reachabilityKey = await installImageReachability( page );
	await withEvaluateTimeout( baseline.evaluate( async ( state, { attribute, properties, settleMs, lazy, reuseSweep, reachabilityKey } ) => {
		const started = Date.now();
		const unreachable = ( window as unknown as Record< symbol, ( image: HTMLImageElement ) => boolean > )[ Symbol.for( reachabilityKey ) ];
		// One serialized geometry record per tagged element, keyed by its id, so
		// rest can be judged per element (see `perpetual` below).
		const snapshot = () => new Map( state.elements().map( element => {
				const geometry = state.readGeometry( element );
				const style = geometry.style;
				const pixel = state.pixel;
				const custom = [ ...style ].filter( property => property.startsWith( '--' ) )
					.map( property => [ property, pixel( style.getPropertyValue( property ) ) ] )
					.filter( ( [ , value ] ) => value !== null );
				const id = element.getAttribute( attribute ) ?? '';
				return [ id, JSON.stringify( [ id,
					properties.map( property => pixel( style.getPropertyValue( property ) ) ), custom,
					// Keep the whole transform, not just X: scale/rotation must invalidate
					// rest even when the translation component stays unchanged.
					style.transform, style.transform ? getComputedStyle( element ).transform : null,
					style.inset, geometry.position,
					pixel( style.width ) === null ? null : geometry.parent?.clientWidth,
					pixel( style.height ) === null ? null : geometry.parent?.clientHeight ] ) ] as const;
			} ) );
		// An element whose geometry changes on every observation for
		// PERPETUAL_TICKS in a row is running a perpetual animation (a script
		// writing transforms each frame), not settling. It can never be quiet, so
		// it is excluded from rest for the rest of this wait; every other element
		// must still be quiet. A finite transition shorter than the window settles
		// before it is classified.
		// Classified movers persist on this learning run's baseline state for its
		// later widths: they are the same tagged elements, so each width only
		// needs its own quiet window rather than re-proving the animation. A new
		// run tags afresh and starts with no movers.
		const PERPETUAL_TICKS = 8;
		const streaks = new Map< string, number >();
		const perpetual = ( state as unknown as { perpetual?: Set< string > } ).perpetual ??= new Set< string >();
		const unchanged = ( before: Map< string, string >, after: Map< string, string > ) => {
			let same = true;
			for ( const [ id, record ] of after ) {
				if ( perpetual.has( id ) ) continue;
				if ( before.get( id ) === record ) { streaks.delete( id ); continue; }
				const streak = ( streaks.get( id ) ?? 0 ) + 1;
				streaks.set( id, streak );
				if ( streak >= PERPETUAL_TICKS ) perpetual.add( id );
				else same = false;
			}
			for ( const id of before.keys() ) if ( ! after.has( id ) && ! perpetual.has( id ) ) same = false;
			return same;
		};
		const content = () => ( {
			rendered: new Map( [ ...document.images ].map( image => [ image, image.getClientRects().length > 0 ] ) ),
			sources: new Map( [ ...document.images ].map( image =>
				[ image, JSON.stringify( [ image.currentSrc, image.src, image.getAttribute( 'srcset' ) ] ) ] ) ),
		} );
		// Another sweep can only reach new work when the document grew or an image
		// it may load newly entered the render tree: rendered, still pending, and
		// reachable. Nodes and images that merely toggle within the swept extent
		// (a perpetual rotator, a ticker) give a sweep nothing new to load, and
		// their geometry effect is already part of the sampled snapshot.
		const revealedPending = ( current: ReturnType< typeof content >, swept: ReturnType< typeof content > ) =>
			[ ...current.rendered ].some( ( [ image, rendered ] ) =>
				rendered && swept.rendered.get( image ) !== true && ! image.complete && ! unreachable( image ) );
		// Two height memories with different jobs. The threshold keeps this width's
		// own first read: scroll-linked chrome (a header that shrinks once scrolled)
		// makes the same content shorter mid-sweep and taller again at the top, so
		// regrowth to the at-top height is not new work. The visited extent only
		// accumulates heights a sweep's steps, its return, or a settled tick
		// actually observed — never this width's first read, which can predate this
		// width's resize handler and describe the previous viewport. It is what the
		// reuse test below compares against and what the next width inherits.
		const priorSweep = ( state as unknown as { swept?: { height: number; content: ReturnType< typeof content > | null } } ).swept;
		let sweptHeight = Math.max( document.documentElement.scrollHeight, priorSweep?.height ?? 0 );
		let visitedHeight = priorSweep?.height ?? 0;
		let sweptContent = content();
		const sweep = async () => {
			// This body runs only when this width has new work: the first width,
			// growth past the swept extent, or a newly rendered pending image. The
			// page sits at the top when a sweep begins — the previous sweep returned
			// there, and a reused width never scrolled.
			for ( let y = window.innerHeight; y < document.documentElement.scrollHeight && Date.now() - started < 20_000; y += window.innerHeight ) {
				window.scrollTo( { top: y, left: 0, behavior: 'instant' } );
				await new Promise( resolve => setTimeout( resolve, 60 ) );
				sweptHeight = Math.max( sweptHeight, document.documentElement.scrollHeight );
				visitedHeight = Math.max( visitedHeight, document.documentElement.scrollHeight );
			}
			window.scrollTo( { top: 0, left: 0, behavior: 'instant' } );
			sweptHeight = Math.max( sweptHeight, document.documentElement.scrollHeight );
			visitedHeight = Math.max( visitedHeight, document.documentElement.scrollHeight );
			// Source libraries (e.g. MooTools) replace window.Event; the document's
			// native factory still builds a real event.
			const scrolled = document.createEvent( 'Event' );
			scrolled.initEvent( 'scroll', false, false );
			window.dispatchEvent( scrolled );
		};
		// Reuse the previous sampled width's sweep when it already visited this
		// document's full extent and no image that may load newly entered the
		// render tree: the sweep could reach nothing the rest loop's own guards
		// would not. The swept content is carried across widths so those guards
		// compare against what the last sweep actually saw.
		const priorContent = priorSweep?.content ?? null;
		const reuse = lazy && reuseSweep && priorContent !== null &&
			document.documentElement.scrollHeight <= priorSweep!.height && ! revealedPending( sweptContent, priorContent );
		if ( reuse ) sweptContent = priorContent;
		else if ( lazy ) await sweep();
		// Retain the old rest budget and minimum resize window; only their
		// redundant serial scheduling is removed. Additional sweeps share it.
		const deadline = Date.now() + settleMs + 3500;
		let previous = snapshot();
		let quiet = 0;
		while ( Date.now() < deadline ) {
			await new Promise( ( resolve ) => setTimeout( resolve, 250 ) );
			const currentContent = content();
			const changedImages = [ ...currentContent.sources ].filter( ( [ image, source ] ) => source !== sweptContent.sources.get( image ) );
			const currentHeight = document.documentElement.scrollHeight;
			visitedHeight = Math.max( visitedHeight, currentHeight );
			if ( lazy && ( revealedPending( currentContent, sweptContent ) ||
				changedImages.some( ( [ image ] ) => ! image.complete ) || currentHeight > sweptHeight ) ) {
				// Finite delayed resize/image work can introduce another offscreen
				// tail after the first sweep. Observe it before declaring readiness.
				sweptContent = currentContent;
				await sweep();
				quiet = 0;
				previous = snapshot();
				continue;
			}
			// An existing image's completed rendition is not an offscreen load
			// waiting for another visit. Still restart at-top rest: its intrinsic
			// size can change layout. Pending replacements, new/replaced nodes,
			// revealed images and document growth retain the full sweep above.
			sweptContent = currentContent;
			if ( lazy && changedImages.length ) {
				quiet = 0;
				previous = snapshot();
				continue;
			}
			const current = snapshot();
			quiet = unchanged( previous, current ) ? quiet + 1 : 0;
			previous = current;
			// A display:none device variant cannot be reached by scrolling. Its
			// pending native lazy images do not describe this width's geometry;
			// visibility is re-read above, so a later reveal invalidates the sweep.
			// Native-lazy images clipped out of view by an overflow ancestor are
			// equally unreachable by this vertical sweep.
			const imagesReady = ! lazy || [ ...document.images ].every( image => image.complete || image.getClientRects().length === 0 || unreachable( image ) );
			if ( quiet >= 4 && imagesReady && Date.now() - started >= settleMs ) break;
		}
		// Later widths reuse this wait's visited extent and content (see `reuse`),
		// so what the last sweep actually observed is what they compare against.
		if ( lazy ) {
			( state as unknown as { swept?: { height: number; content: ReturnType< typeof content > | null } } ).swept =
				{ height: visitedHeight, content: sweptContent };
		}
	}, { attribute: ID_ATTRIBUTE, properties: [ ...properties ], settleMs, lazy, reuseSweep, reachabilityKey } ), 25_000 + settleMs );
}

/** Quiet window after a probe resize; outlasts common 250–500 ms resize debounces. */
export const PROBE_QUIET_MS = 600;

/**
 * Whether every tagged inline declaration is the same at every width.
 *
 * Only script can change an inline declaration, so a declaration that no script
 * wrote at load is constant unless a viewport change makes script rewrite it.
 * Without any viewport-reactive registration that cannot happen, and the sweep
 * is skipped without resizing. With one (analytics libraries commonly listen
 * for resize), the narrowest and widest sweep widths are probed: when neither
 * writes nor replaces a tagged element, the declarations are treated as
 * constant. A source without the runtime tracker is always swept.
 */
async function inlineGeometryIsConstant(
	page: Page,
	baseline: Awaited<ReturnType<typeof captureFluidBaseline>>,
	widths: readonly number[],
	original: { width: number; height: number } | null,
	settleMs: number
): Promise< boolean > {
	const observe = () => baseline.evaluate( ( state, { key } ) => {
		const tracker = ( window as unknown as Record< symbol, { written( element: Element ): boolean; viewportReactive(): boolean } | undefined > )[ Symbol.for( key ) ];
		if ( ! tracker ) return null;
		const tagged = state.elements();
		return { count: tagged.length, written: tagged.some( element => tracker.written( element ) ), reactive: tracker.viewportReactive() };
	}, { key: RUNTIME_STYLE_WRITES_KEY } );
	const before = await observe();
	if ( before === null || before.written ) return false;
	// The probe asks only whether script writes the tagged elements, not what
	// geometry they rest at, so a quiet window that outlasts common resize
	// debounces replaces the sampling sweep's scroll-and-rest readiness.
	const { settleDocument } = await import( './page-helpers.js' );
	const probeSettle = { quietMs: PROBE_QUIET_MS, timeoutMs: settleMs + 3500 };
	if ( ! before.reactive ) return true;
	for ( const width of [ Math.min( ...widths ), Math.max( ...widths ) ] ) {
		await page.setViewportSize( { width, height: original?.height ?? 900 } );
		await settleDocument( page, 'fluid-probe', probeSettle );
	}
	if ( original ) await page.setViewportSize( original );
	await settleDocument( page, 'fluid-probe', probeSettle );
	const after = await observe();
	const constant = after !== null && ! after.written && after.count === before.count;
	// A constant document is captured at this viewport without sampling, so it
	// owes the capture width what a sampled return does.
	if ( constant ) await replayReplacedEntrances( page, baseline );
	return constant;
}

/**
 * Replay the capture's scroll-through when the sweep away from the capture
 * viewport made the source replace content it had already rendered.
 *
 * Crossing a breakpoint can remount a subtree the source renders per width.
 * The fresh copy starts before its viewport entrance, so a reveal the
 * capture's scroll-through already played (text whose script-driven gradient
 * fills in once it is scrolled into view) is back at its transparent first
 * frame. Sweep the document as every sampled width is swept, so the copy's
 * entrance observers fire again, then let the inline-style writes they start
 * finish before the capture width is measured or serialized. A document whose
 * elements all survived the sweep kept its entrance state and pays nothing.
 */
async function replayReplacedEntrances( page: Page, baseline: Awaited<ReturnType<typeof captureFluidBaseline>>, properties: readonly string[] = LEARNABLE_PROPERTIES ): Promise< void > {
	if ( ! await baseline.evaluate( state => state.replaced() ) ) return;
	const { settleDocument } = await import( './page-helpers.js' );
	await waitForRestGeometry( page, baseline, 0, true, properties );
	await settleDocument( page, 'fluid-entrance-replay', { quietMs: 200, timeoutMs: 2_000, animations: true } );
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
