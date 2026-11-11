// src/lib/screenshot/fluid-capture.ts
//
// Drive the width sweep that `fluid-model` learns from.
//
// The source's own runtime is left running while the viewport changes, so what
// we record is the site telling us how it sizes itself. The learned CSS then
// replaces the runtime-written inline pixels, which is what lets the liberated
// copy keep reflowing after that runtime is stripped.
//
import { parseClipPath, learnClipPath } from './fluid-clip-path.js';
import { RUNTIME_STYLE_WRITES_KEY, restoreLoadTimeSheets, type RuntimeStyleWrites } from './runtime-style-writes.js';
import { VIEWPORT_WORK_KEY, observeViewportWork, type ViewportWork } from './viewport-work.js';
import {
	breakpointsFrom,
	interpolateSamples,
	learnFluidModel,
	learnSegmentedFluidModel,
	learnWidestFluidModel,
	segmentedCss,
	type FluidModel,
	type FluidModelSegment,
	type ViewportFluidModel,
	type GeometrySample,
} from './fluid-model.js';
import type { Page } from 'playwright';
import { captureFluidBaseline, FLUID_RELEASE_ATTRIBUTE } from './fluid-baseline.js';
import { applyRuntimeSheetRules, bindRuntimeSheets, observeRuntimeSheets, offsetSegments, runtimeSheetSeries, runtimeSheetsObserved } from './fluid-runtime-sheets.js';

/** Fit paired translations only inside shared regimes, never across a wrap. */
function translationSegments( x: GeometrySample[], y: GeometrySample[], cuts: number[] ): FluidModelSegment[] {
	const result: FluidModelSegment[] = [];
	const bounds = [ null, ...cuts, null ];
	for ( let index = 0; index < bounds.length - 1; index++ ) {
		const minWidth = bounds[ index ]!;
		const maxWidth = bounds[ index + 1 ] === null ? null : bounds[ index + 1 ]! - 1;
		const inside = ( sample: GeometrySample ) => ( minWidth === null || sample.viewport >= minWidth ) && ( maxWidth === null || sample.viewport <= maxWidth );
		const xs = x.filter( inside ), ys = y.filter( inside );
		if ( ! xs.length || ! ys.length ) continue;
		const fit = ( samples: GeometrySample[] ) => learnFluidModel( samples.map( ( { viewport, value } ) => ( { viewport, value } ) ) );
		const xm = fit( xs ), ym = fit( ys );
		if ( xm.kind !== 'breakpoint' && ym.kind !== 'breakpoint' ) {
			result.push( { minWidth, maxWidth, model: { kind: 'constant', value: 0, css: `translate(${ xm.css }, ${ ym.css })` } } );
			continue;
		}
		// No credible fit: hold each band's own measured pair, not desktop inline
		// geometry. Even a single observation must have a complete declaration.
		for ( let sample = 0; sample < xs.length; sample++ ) {
			const current = xs[ sample ]!;
			const vertical = ys.find( entry => entry.viewport === current.viewport );
			if ( ! vertical ) continue;
			result.push( {
				minWidth: sample === 0 ? minWidth : current.viewport,
				maxWidth: sample === xs.length - 1 ? maxWidth : xs[ sample + 1 ]!.viewport - 1,
				model: { kind: 'constant', value: 0, css: `translate(${ current.value }px, ${ vertical.value }px)` },
			} );
		}
	}
	return result;
}

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
const LEARNABLE_PROPERTIES = [ 'width', 'height', 'font-size', 'padding-top', 'transform-x', 'transform-y', 'transform-scale', 'inset-top', 'inset-left', 'min-height' ] as const;

export type LearnableProperty = ( typeof LEARNABLE_PROPERTIES )[ number ] | 'left';

export interface FluidSweepOptions {
	/** Distinguishes rule identities when responsive documents share a stylesheet. */
	document?: 'desktop' | 'mobile' | 'middle';
	/**
	 * Widths to observe, sampled exactly as given. Omitted: the coarse widths,
	 * refined within DEFAULT_SWEEP_WIDTHS where the observations need it.
	 */
	widths?: number[];
	/** Extra rest budget after each resize, beyond the base bound, for slow runtimes. */
	settleMs?: number;
	/** Source-owned motion/readiness before each geometry sample, after rest settling. */
	prepareViewport?: ( page: Page ) => Promise< void >;
	/** Opt in when the source positions relative slides with width-derived left offsets. */
	learnRelativeOffsets?: boolean;
	/**
	 * Swept series shared by the routes of one capture (see FluidSeriesMemo).
	 * Applies to the default adaptive ladder only.
	 */
	memo?: FluidSeriesMemo;
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
// Desktop scale regimes can drop below the reference before returning to
// identity (rather than simply clamping). Keep samples inside that regime.
export const DEFAULT_SWEEP_WIDTHS = [ 320, 360, 390, 414, 600, 767, 768, 769, 775, 783, 791, 799, 800, 801, 900, 1024, 1200, 1280, 1366, 1440, 1536, 1840, 1920 ];

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

/**
 * Fully swept series from earlier routes of one capture, keyed by document and
 * element signature, then by property.
 *
 * Repeated chrome sized by script (a banner whose height tracks the viewport)
 * answers the same on every route, yet each route would pay the whole ladder
 * to relearn it. Each element reuses its stored ladder when its signature and
 * property set match and every probe matches exactly (value, container and
 * transform origin, except identity scales). Only unexplained elements drive
 * further sampling; their swept series join the memo for later routes.
 */
export type FluidSeriesMemo = Map< string, ReadonlyMap< string, readonly GeometrySample[] > >;

function reuseSweptSeries(
	observations: ReadonlyMap< string, readonly GeometrySample[] >,
	keyOf: ( id: string ) => string | null,
	memo: FluidSeriesMemo
): Map< string, GeometrySample[] > {
	const properties = new Map< string, number >();
	for ( const key of observations.keys() ) {
		const id = key.slice( 0, key.indexOf( ':' ) );
		properties.set( id, ( properties.get( id ) ?? 0 ) + 1 );
	}
	const reused = new Map< string, GeometrySample[] >();
	const unexplained = new Set< string >();
	for ( const [ key, probed ] of observations ) {
		const id = key.slice( 0, key.indexOf( ':' ) );
		const signature = keyOf( id );
		const stored = signature === null ? undefined : memo.get( signature );
		const series = stored?.get( key.slice( id.length + 1 ) );
		if ( ! stored || ! series || stored.size !== properties.get( id ) ) {
			unexplained.add( id );
			continue;
		}
		for ( const sample of probed ) {
			const match = series.find( candidate => candidate.viewport === sample.viewport );
			if ( ! match || ! Object.is( match.value, sample.value ) || ( match.container ?? null ) !== ( sample.container ?? null ) ||
				( !( match.value === 1000 && sample.value === 1000 ) && match.transformOrigin !== sample.transformOrigin ) ) unexplained.add( id );
		}
		reused.set( key, series.map( sample => ( { ...sample } ) ) );
	}
	// One mismatched property invalidates reuse for the whole element.
	for ( const key of reused.keys() ) if ( unexplained.has( key.slice( 0, key.indexOf( ':' ) ) ) ) reused.delete( key );
	return reused;
}
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
		const straight = ( first: number, interval: number ) => {
			if ( first < 0 || first + 2 >= widths.length ) return false;
			const [ a, b, c ] = [ value( first ), value( first + 1 ), value( first + 2 ) ];
			if ( a === null || b === null || c === null ) return false;
			const [ wa, wb, wc ] = [ widths[ first ]!, widths[ first + 1 ]!, widths[ first + 2 ]! ];
			const slopeChange = ( c - b ) / ( wc - wb ) - ( b - a ) / ( wb - wa );
			// A short neighbouring span must not hide a step across the interval we explain.
			return Math.abs( slopeChange * ( widths[ interval + 1 ]! - widths[ interval ]! ) ) <= COLLINEAR_TOLERANCE_PX;
		};
		let chosen: number | null = null;
		for ( const { index } of intervals ) {
			// Absent (or non-pixel) at both ends: nothing here for this series to learn.
			if ( value( index ) === null && value( index + 1 ) === null ) continue;
			if ( straight( index - 1, index ) || straight( index, index ) ) continue;
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
 * Whether a series ever held pixels. A non-pixel custom property (a colour, a
 * font stack, `auto`) is observed only because it shares an inline style with
 * a pixel one; it carries no geometry, so nothing could be learned from it.
 */
function holdsPixels( series: readonly GeometrySample[] ): boolean {
	return series.some( sample => Number.isFinite( sample.value ) );
}

/**
 * Whether every observed series, outside perpetually animated elements and
 * series that never held pixels, holds one finite value at each of `samples`
 * widths: nothing the sweep could learn varies with width.
 */
export function constantAcross( observations: ReadonlyMap< string, readonly GeometrySample[] >, samples: number, perpetual: ReadonlySet< string > ): boolean {
	for ( const [ key, series ] of observations ) {
		if ( perpetual.has( key.slice( 0, key.indexOf( ':' ) ) ) || ! holdsPixels( series ) ) continue;
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
	// Rest after a resize ends on the delayed work it scheduled (see waitForRestGeometry).
	await withEvaluateTimeout( page.evaluate( observeViewportWork ), 8000 );
	// Observe source inline lengths before width learning removes segmented ones.
	const lifted = await liftViewportHeights( page, options.settleMs ?? 1200 ).catch( () => 0 );
	const heightLengths = lifted > 0 ? await page.evaluateHandle( attribute => [ ...document.querySelectorAll< HTMLElement >( `[${ attribute }]` ) ].flatMap( element => {
		const properties = element.getAttribute( attribute )!.split( ' ' );
		element.removeAttribute( attribute );
		return properties.map( property => ( { element, property, css: element.style.getPropertyValue( property ) } ) );
	} ), VIEWPORT_HEIGHT_LIFTED_ATTRIBUTE ) : null;
	const baseline = await captureFluidBaseline( page, ID_ATTRIBUTE );
	let completed = false;
	try {
		const result = await learnFluidGeometry( page, options, baseline );
		completed = true;
		if ( heightLengths ) await baseline.evaluate( ( state, entries ) => state.retain( entries ), heightLengths );
		if ( lifted > 0 ) {
			result.applied += lifted;
			result.byKind[ 'viewport-height' ] = lifted;
		}
		return result;
	} finally {
		try {
			await withEvaluateTimeout( ( async () => {
				if ( ! completed ) {
					await baseline.evaluate( state => state.restore() );
					if ( original ) await resizeViewport( page, original );
					await waitForRestGeometry( page, baseline );
					await baseline.evaluate( state => state.restore() );
				}
				await baseline.evaluate( state => state.cleanup() );
			} )(), 8000 );
		} finally {
			await baseline.dispose();
			await heightLengths?.dispose();
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
	// Resizes before learning (class sweeps, the probes below) can leave a
	// history-dependent runtime's sheets off their load-time capture-width text.
	await restoreLoadTimeSheets( page );
	const properties = options.learnRelativeOffsets ? [ ...LEARNABLE_PROPERTIES, 'left' ] : [ ...LEARNABLE_PROPERTIES ];

	const tagged = await baseline.evaluate(
		( state, { attribute, properties, prefix } ) => {
			let index = 0;
			for ( const element of document.querySelectorAll< HTMLElement >( '[style]' ) ) {
				const ignorePadding = element.hasAttribute( 'data-blocks-engine-capture-fluid-ignore-padding' );
				element.removeAttribute( 'data-blocks-engine-capture-fluid-ignore-padding' );
				// Match the declarations the measurement pass can actually learn.
				// Substring tagging of min-height/max-width and percentages paid for
				// whole sweeps without observations. Only actual pixel values qualify.
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
					// No source scripts can rewrite an authored minimum on a static page.
					( property !== 'min-height' || document.scripts.length > 0 ) &&
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
				if ( ! carriesPixelSize && ! carriesPixelCustomProperty && ! carriesMatrixTransform && ! carriesAbsoluteInset && ! /^(polygon|inset|rect)\(/.test( element.style.clipPath ) ) {
					continue;
				}
				element.setAttribute( attribute, `${ prefix }${ index++ }` );
			}
			// Bind in the tagging task: a resize handler can replace these nodes
			// before the next browser evaluation gets a turn.
			state.bind();
			return index;
		},
		{ attribute: ID_ATTRIBUTE, properties, prefix: options.document ? `${ options.document }-` : '' }
	);

	if ( tagged === 0 ? ! await sourceSheetsVary( page, widths, original, settleMs ) : await inlineGeometryIsConstant( page, baseline, widths, original, settleMs ) ) {
		await baseline.evaluate( ( state, attribute ) => {
			for ( const element of state.elements() ) element.removeAttribute( attribute );
		}, ID_ATTRIBUTE );
		return { applied: 0, unmodelled: 0, breakpoints: [], canvasFloor: null, byKind: {}, sampledWidths: [] };
	}
	await restoreLoadTimeSheets( page );
	await bindRuntimeSheets( page );
	// The element path up to its nearest identified ancestor, with sibling
	// position. A signature two tagged elements share (repeated components
	// reusing one id) cannot key a reuse: only those elements are left out.
	const signatures = adaptive && options.memo ? await baseline.evaluate( ( state, attribute ) => {
		const step = ( node: Element ) => {
			const position = node.parentElement ? [ ...node.parentElement.children ].filter( sibling => sibling.tagName === node.tagName ).indexOf( node ) : 0;
			// Root classes commonly encode per-route runtime state. Keep classes
			// on every other element; the geometry probes still validate reuse.
			const classes = node === document.body || node === document.documentElement ? [] : [ ...node.classList ];
			return `${ node.tagName }${ node.id ? `#${ node.id }` : '' }${ classes.sort().map( name => `.${ name }` ).join( '' ) }:${ position }`;
		};
		const byId: Record< string, string > = {};
		for ( const element of state.elements() ) {
			const path: string[] = [];
			for ( let node: Element | null = element; node; node = node.parentElement ) {
				path.push( step( node ) );
				if ( node !== element && node.id ) break;
			}
			byId[ element.getAttribute( attribute )! ] = path.join( '<' );
		}
		const counts = new Map< string, number >();
		for ( const signature of Object.values( byId ) ) counts.set( signature, ( counts.get( signature ) ?? 0 ) + 1 );
		for ( const [ id, signature ] of Object.entries( byId ) ) if ( counts.get( signature )! > 1 ) delete byId[ id ];
		return byId;
	}, ID_ATTRIBUTE ) : null;
	const memoKey = ( id: string ) => signatures?.[ id ] === undefined ? null : `${ options.document ?? '' }|${ signatures[ id ] }`;

	// key: `${id}:${property}` -> observations across widths
	const observations = new Map< string, GeometrySample[] >();
	const redundantMinHeight = new Map< string, boolean >();
	const clips = new Map<string, { template: string; count: number; valid: boolean }>();
	const nonRelative = new Set( options.learnRelativeOffsets ? await baseline.evaluate( ( state, attribute ) =>
		state.elements().filter( element => state.readGeometry( element ).position !== 'relative' )
			.map( element => element.getAttribute( attribute )! ), ID_ATTRIBUTE ) : [] );

	// Widths in the order they were sampled; runtime-sheet observations align to it.
	const sampledWidths: number[] = [];
	const sample = async ( width: number ) => {
		sampledWidths.push( width );
		await resizeViewport( page, { width, height: original?.height ?? 900 } );
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
					const declared: Record< string, string > = {};
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
						if ( property === 'transform-scale' ) {
							const scale = state.uniformScale( element );
							// Fit in pixel-sized units so the existing two-pixel tolerance
							// means 0.2% scale error, not two whole scale factors.
							values[ property ] = scale === null ? Number.NaN : scale * 1000;
							continue;
						}
						if ( property === 'transform-x' || property === 'transform-y' ) {
							values[ property ] = geometry.translation?.[ property === 'transform-x' ? 'x' : 'y' ] ?? null;
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
							property !== 'min-height' &&
							property !== 'transform-x'
								? property === 'width' || property === 'left'
									? parent.clientWidth
									: parent.clientHeight
								: null;
					}
					for ( const property of elementProperties ) {
						if ( property === 'transform-scale' || property === 'transform-x' || property === 'transform-y' || property === 'inset-top' || property === 'inset-left' ) continue;
						if ( property === 'left' && ! relative ) {
							values[ property ] = null;
							continue;
						}
						const match = new RegExp( `(?:^|;)\\s*${ property }\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px` ).exec( style );
						values[ property ] = match ? Number( match[ 1 ] ) : null;
						if ( property.startsWith( '--' ) && ! match ) {
							const computed = getComputedStyle( element ).getPropertyValue( property ).trim();
							if ( computed ) values[ property ] = null;
							// Keep the declared non-pixel value (`100%`, a calc()) so the
							// learner can carry that regime instead of discarding it.
							const raw = new RegExp( `(?:^|;)\\s*${ property }\\s*:\\s*([^;]+)` ).exec( style )?.[ 1 ]
								?.replace( /\s*!\s*important\s*$/i, '' ).trim();
							if ( raw ) declared[ property ] = raw;
						}
					}
					const transformOrigin = getComputedStyle( element ).transformOrigin;
					const rect = element.getBoundingClientRect();
					const minHeight = element.style.getPropertyValue( 'min-height' );
					let redundantMinHeight = false;
					// A zero minimum never holds a box open. Restore the literal
					// attribute: CSSOM reserializes every declaration (`width:0`
					// becomes `width: 0px`), which later samples would read as new geometry.
					if ( /^\s*\d*\.?\d+px\s*$/.test( minHeight ) && parseFloat( minHeight ) > 0 ) {
						const literal = element.getAttribute( 'style' )!;
						element.style.removeProperty( 'min-height' );
						redundantMinHeight = Math.abs( rect.height - element.getBoundingClientRect().height ) <= 2;
						element.setAttribute( 'style', literal );
					}
					return { id: element.getAttribute( attribute )!, values, declared, containers, relative, transformOrigin, redundantMinHeight,
						clip: element.style.clipPath, clipWidth: rect.width, clipHeight: rect.height };
				} ),
			{ attribute: ID_ATTRIBUTE, properties }
		);
		for ( const entry of measured ) {
			if ( ! redundantMinHeight.has( entry.id ) ) redundantMinHeight.set( entry.id, entry.redundantMinHeight );
			else if ( ! entry.redundantMinHeight ) redundantMinHeight.set( entry.id, false );
			if ( ! entry.relative ) nonRelative.add( entry.id );
			const shape = parseClipPath( entry.clip );
			if ( shape || clips.has( entry.id ) || /^(polygon|inset|rect)\(/.test( entry.clip ) ) {
				const clip = clips.get( entry.id ) ?? { template: shape?.template ?? '', count: shape?.values.length ?? 0, valid: shape !== null && sampledWidths.length === 1 };
				clip.valid &&= shape !== null && shape.template === clip.template;
				clips.set( entry.id, clip );
				for ( let index = 0; index < clip.count; index++ ) {
					const key = `${ entry.id }:clip-${ index }`;
					const list = observations.get( key ) ?? [];
					list.push( { viewport: width, value: shape?.values[ index ] ?? NaN,
						container: clip.template.startsWith( 'inset(' ) && clip.count === 1 ? null
							: shape?.vertical[ index ] ? entry.clipHeight : entry.clipWidth } );
					observations.set( key, list );
				}
			}
			for ( const property of Object.keys( entry.values ) as LearnableProperty[] ) {
				const value = entry.values[ property ];
				const key = `${ entry.id }:${ property }`;
				const list = observations.get( key ) ?? [];
				if ( value === null || value === undefined ) {
					if ( property.startsWith( '--' ) || property === 'min-height' ) {
						const cssValue = entry.declared?.[ property ];
						list.push( { viewport: width, value: Number.NaN, ...( cssValue ? { cssValue } : {} ) } );
						observations.set( key, list );
					}
					continue;
				}
				list.push( { viewport: width, value, container: entry.containers?.[ property ] ?? null,
					...( property === 'transform-scale' ? { transformOrigin: entry.transformOrigin } : {} ),
				} );
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
		// Probe first, then reuse explained elements independently. Only the
		// unexplained series drive the remaining sweep. If those are constant
		// (perpetual movers excluded) and runtime sheets are constant too,
		// the probes suffice; repeated chrome keeps its stored ladder.
		for ( const width of PROBE_WIDTHS ) await sample( width );
		for ( const [ id, redundant ] of redundantMinHeight ) if ( redundant ) observations.delete( `${ id }:min-height` );
		const sheets = await runtimeSheetsObserved( page );
		// Runtime stylesheets and perpetual movers are learned per route.
		const memo = signatures && ! sheets && ( await perpetual() ).size === 0 ? options.memo! : null;
		const reused = memo ? reuseSweptSeries( observations, memoKey, memo ) : new Map< string, GeometrySample[] >();
		const unexplained = () => new Map( [ ...observations ].filter( ( [ key ] ) => ! reused.has( key ) ) );
		const sheetObservations = sheets ? await runtimeSheetSeries( page, sampledWidths ) : [];
		const sheetsConstant = ( ! sheets || sheetObservations.length > 0 ) && sheetObservations.every( series => series.length === PROBE_WIDTHS.length &&
			series.every( sample => Number.isFinite( sample.value ) && sample.value === series[ 0 ]!.value ) );
		if ( ! sheetsConstant || ! constantAcross( unexplained(), PROBE_WIDTHS.length, await perpetual() ) ) {
			for ( const width of COARSE_SWEEP_WIDTHS ) if ( ! sampledWidths.includes( width ) ) await sample( width );
			// Runtime-fitted phone text can have an offset as well as a slope.
			// Observe below 390 and a third interior phone width: a bounded
			// quantized affine fit needs three non-clamped observations.
			const phoneSeries = [ ...refinementSeries( unexplained(), await perpetual() ), ...await runtimeSheetSeries( page, sampledWidths ) ];
			if ( phoneSeries.some( series => {
				const phone = series.find( sample => sample.viewport === 390 );
				const large = series.find( sample => sample.viewport === 600 );
				return phone && large && phone.value !== large.value;
			} ) ) {
				for ( const width of [ 320, 360, 414 ] ) await sample( width );
			}
			// Refine only intervals unexplained elements or runtime sheets need.
			for ( ;; ) {
				const series = refinementSeries( unexplained(), await perpetual() );
				const next = refinementWidths( [ ...series, ...await runtimeSheetSeries( page, sampledWidths ) ], sampledWidths, widths );
				if ( next.length === 0 ) break;
				for ( const width of next ) await sample( width );
			}
		}
		// Every skipped ladder width now sits inside a straight interval of every
		// series, so the fitters receive the full ladder's observations.
		const moving = await perpetual();
		for ( const [ key, samples ] of observations ) {
			if ( reused.has( key ) ) observations.set( key, reused.get( key )! );
			else if ( ! moving.has( key.slice( 0, key.indexOf( ':' ) ) ) ) observations.set( key, interpolateSamples( samples, sampledWidths, widths ) );
		}
		// A redundant minimum can be sampled again by another element's sweep;
		// discard it after the sweep too, so its partial series cannot be fitted.
		for ( const [ id, redundant ] of redundantMinHeight ) if ( redundant ) observations.delete( `${ id }:min-height` );
		// A sweep past the probes is what later routes may reuse.
		if ( memo && sampledWidths.length > PROBE_WIDTHS.length && moving.size === 0 ) {
			const byElement = new Map< string, Map< string, readonly GeometrySample[] > >();
			for ( const [ key, samples ] of observations ) {
				const id = key.slice( 0, key.indexOf( ':' ) );
				const signature = memoKey( id );
				if ( signature === null ) continue;
				const series = byElement.get( signature ) ?? new Map();
				series.set( key.slice( id.length + 1 ), samples.map( sample => ( { ...sample } ) ) );
				byElement.set( signature, series );
			}
			for ( const [ key, series ] of byElement ) memo.set( key, series );
		}
	}
	for ( const list of observations.values() ) list.sort( ( a, b ) => a.viewport - b.viewport );

	// Sibling translations share regime boundaries: a wrap observed on one
	// item also bounds the fits of items whose X alone looks linear there.
	const translationGroups = await baseline.evaluate( ( state, attribute ) => {
		const parents = new Map<Element, string[]>();
		for ( const element of state.elements() ) {
			if ( ! element.parentElement ) continue;
			const ids = parents.get( element.parentElement ) ?? [];
			ids.push( element.getAttribute( attribute )! );
			parents.set( element.parentElement, ids );
		}
		return [ ...parents.values() ];
	}, ID_ATTRIBUTE );
	const translationCuts = new Map<string, number[]>();
	for ( const ids of translationGroups ) {
		const cuts = new Set<number>();
		for ( const id of ids ) for ( const axis of [ 'x', 'y' ] ) {
			const samples = observations.get( `${ id }:transform-${ axis }` ) ?? [];
			if ( learnFluidModel( samples ).kind !== 'breakpoint' ) continue;
			const segmented = learnSegmentedFluidModel( samples, { holdUnfitted: true, holdNarrowForBoundedAffine: true } );
			for ( const segment of segmented?.segments ?? [] ) if ( segment.minWidth !== null ) cuts.add( segment.minWidth );
		}
		for ( const id of ids ) translationCuts.set( id, [ ...cuts ].sort( ( a, b ) => a - b ) );
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
	const positioned = new Set( await baseline.evaluate( ( state, attribute ) =>
		state.elements().filter( element => [ 'absolute', 'fixed' ].includes( state.readGeometry( element ).position ) )
			.map( element => element.getAttribute( attribute )! ), ID_ATTRIBUTE ) );
	const byKind: Record< string, number > = {};
	const breakpoints = new Set< number >();
	let canvasFloor: number | null = null;
	let unmodelled = 0;

	for ( const [ key, samples ] of observations ) {
		// Not a geometry series, so neither learned nor unmodelled.
		if ( ! holdsPixels( samples ) || key.includes( ':clip-' ) ) continue;
		const [ id, property ] = key.split( ':' ) as [ string, LearnableProperty ];
		// Any non-relative sample invalidates the entire offset relationship.
		// Fitting the remaining relative samples would erase authored positioning.
		if ( property === 'left' && nonRelative.has( id ) ) continue;
		if ( property === 'transform-scale' ) {
			// Never fit a partial series through rotation, skew, translation or absence.
			if ( samples.some( sample => ! Number.isFinite( sample.value ) ) ) continue;
			const model = learnFluidModel( samples );
			if ( model.kind === 'constant' ) continue;
			// Scale has no percentage length basis: fit container-dependent series
			// against the viewport and carry each fitted regime as a media rule.
			// Hold unfitted observations rather than rejecting fitted desktop runs
			// because the same document has a nonlinear narrow-screen regime.
			const segmented = model.kind === 'breakpoint' || model.kind === 'container'
				? learnSegmentedFluidModel( samples.map( ( { viewport, value } ) => ( { viewport, value } ) ), { holdUnfitted: true, holdNarrowForBoundedAffine: true } )
				: null;
			if ( ( model.kind === 'breakpoint' || model.kind === 'container' ) && segmented === null ) { unmodelled++; continue; }
			// Only actual non-identity observations own the origin; the reference
			// may have neither transform nor origin. Never invent an origin model.
			const origins = new Set( samples.filter( sample => sample.value !== 1000 && sample.transformOrigin !== undefined )
				.map( sample => sample.transformOrigin! ) );
			if ( origins.size !== 1 ) { unmodelled++; continue; }
			const kind = segmented ? 'segmented' : model.kind;
			byKind[ kind ] = ( byKind[ kind ] ?? 0 ) + 1;
			for ( const segment of segmented?.segments ?? [] ) {
				if ( segment.minWidth !== null ) breakpoints.add( segment.minWidth );
			}
			learned.push( {
				// Keep the scale owner identifiable during final-state validation;
				// segmented rules, not this inline placeholder, own its value.
				id, property: 'transform', css: model.kind === 'breakpoint' || model.kind === 'container' ? 'scale(1)' : `scale(calc(${ model.css } / 1000px))`,
				fallbackCss: null, containerRelative: false, sampledCss: null,
				segmentedCss: segmented ? segmentedCss( `[${ SEGMENT_ATTRIBUTE }="${ id }"]`, 'transform', segmented.segments.map( segment => ( {
					...segment, model: { ...segment.model, css: `scale(calc(${ segment.model.css } / 1000px))` },
				} ) ) ) : null,
			}, {
				id, property: 'transform-origin', css: [ ...origins ][ 0 ]!,
				fallbackCss: null, containerRelative: false, sampledCss: null, segmentedCss: null,
			} );
			continue;
		}
		if ( property === 'transform-y' ) continue; // Both axes have one transform owner.
		const transformX = property === 'transform-x';
		// Identity scale samples also parse as translations. A partial translation
		// fit must not overwrite the scale owner's rules in those wider regimes.
		const scales = observations.get( `${ id }:transform-scale` );
		if ( transformX && scales?.some( sample => Number.isFinite( sample.value ) && sample.value !== 1000 ) ) continue;
		// Preserve fitted dimension regimes even when an isolated observation
		// fits no run: holding that observation locally is better than freezing
		// the capture width everywhere. This applies to positioned frames as
		// well as scaled ones. Constant dimensions keep their existing path.
		const varyingDimension = ( property === 'width' || property === 'height' ) &&
			( positioned.has( id ) || scales?.some( sample => Number.isFinite( sample.value ) && sample.value !== 1000 ) ) &&
			! constantAcross( new Map( [ [ key, samples ] ] ), samples.length, new Set() );
		const insetAxis = property === 'inset-top' || property === 'inset-left';
		const customProperty = property.startsWith( '--' );
		// A constant minimum already survives serialization without learned CSS.
		if ( property === 'min-height' && constantAcross( new Map( [ [ key, samples ] ] ), samples.length, new Set() ) ) continue;
		// A runtime can switch a custom property between pixels and a declared
		// non-pixel value (`100%`) with width. Each contiguous regime gets its
		// own bounded rule so no fit leaks into a width range it never observed.
		if ( customProperty && samples.some( sample => ! Number.isFinite( sample.value ) ) ) {
			const regimes = customPropertyRegimes( samples );
			unmodelled += regimes.unmodelled;
			if ( regimes.segments.length === 0 ) continue;
			byKind.segmented = ( byKind.segmented ?? 0 ) + 1;
			for ( const segment of regimes.segments ) if ( segment.minWidth !== null ) breakpoints.add( segment.minWidth );
			learned.push( {
				id,
				property,
				css: '',
				fallbackCss: null,
				containerRelative: false,
				sampledCss: null,
				segmentedCss: segmentedCss( `[${ SEGMENT_ATTRIBUTE }="${ id }"]`, property, regimes.segments ),
			} );
			continue;
		}
		const modelSamples = samples;
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
			( wholeRangeModel.kind === 'breakpoint' || ( property === 'min-height' && samples.some( sample => ! Number.isFinite( sample.value ) ) ) )
				? learnSegmentedFluidModel( property === 'left'
					? modelSamples.map( ( { viewport, value } ) => ( { viewport, value } ) ) : modelSamples, customProperty
					? { holdUnfitted: true, holdNarrowForBoundedAffine: true }
					: { holdUnfitted: transformX || varyingDimension || property === 'min-height', holdNarrowForBoundedAffine: true, preserveAbsence: property === 'min-height' } )
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
		if ( transformX ) {
			const vertical = observations.get( `${ id }:transform-y` ) ?? [];
			if ( wholeRangeModel.kind === 'constant' && learnFluidModel( vertical ).kind === 'constant' && ! translationCuts.get( id )?.length ) continue;
			// Source resize handlers can remove measured nodes; absence is final,
			// not a reason to auto-wait for the old identity to reappear.
			const translation = await baseline.evaluate( ( state, id ) => state.translation( id ), id );
			if ( translation === null ) {
				// The runtime may have switched this transform after the sweep; do not
				// replace a newly rotated, scaled, or skewed matrix.
				unmodelled++;
				continue;
			}
			const transformSegments = translationSegments( samples, vertical, translationCuts.get( id ) ?? [] );
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
					transformSegments
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
		if ( model.kind === 'breakpoint' || ( property === 'min-height' && samples.some( sample => ! Number.isFinite( sample.value ) ) ) ) {
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
			// A height fallback is applied eagerly to keep runtime-owned parents
			// definite. It must fit every width, not just the widest regime:
			// otherwise it replaces a correct container fit with desktop-only vw.
			const viewportOnly = property === 'height'
				? learnFluidModel( viewportSamples )
				: learnWidestFluidModel( viewportSamples );
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

	const movingClips = await perpetual();
	for ( const [ id, clip ] of clips ) {
		if ( movingClips.has( id ) ) { unmodelled++; continue; }
		const series = Array.from( { length: clip.count }, ( _, index ) => observations.get( `${ id }:clip-${ index }` ) ?? [] );
		const shape = clip.valid ? learnClipPath( clip.template, series, `[${ SEGMENT_ATTRIBUTE }="${ id }"]`, `capture-clip-${ id }` ) : null;
		if ( ! shape ) { unmodelled++; continue; }
		for ( const kind of shape.kinds ) byKind[ kind ] = ( byKind[ kind ] ?? 0 ) + 1;
		learned.push( { id, property: 'clip-path', css: shape.css, fallbackCss: null, containerRelative: false,
			sampledCss: null, segmentedCss: shape.rules ? `${ shape.rules }\n[${ SEGMENT_ATTRIBUTE }="${ id }"] { clip-path: ${ shape.css }; }` : null } );
	}

	// Seed each source role with its capture baseline BEFORE returning the
	// viewport. Resize handlers can clone the previous state before updating it;
	// they must inherit the capture baseline rather than the widest sweep sample.
	// The source then owns the final clone state. Learned CSS follows that resize.
	await baseline.evaluate( state => state.restore() );
	if ( original ) await resizeViewport( page, original );
	await waitForRestGeometry( page, baseline, settleMs, false, properties );
	await replayReplacedEntrances( page, baseline, properties );
	await baseline.evaluate( state => state.reconcile() );
	// A final resize may write geometry onto roles that never qualified for
	// learning. Restore those roles without replacing the sampled role state.
	await baseline.evaluate( state => state.restore( true ) );
	// The resize back to the capture viewport can switch a transform to another
	// matrix after the sweep. Validate that final state before removing inline
	// transform; otherwise the learned translation would discard its new components.
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
		if ( entry.css.startsWith( 'scale(' ) ) {
			if ( await baseline.evaluate( ( state, id ) => {
				const element = state.element( id );
				return element !== null && state.uniformScale( element ) !== null;
			}, entry.id ) ) continue;
			learned.splice( index, 1 );
			unmodelled++;
			continue;
		}
		const translation = await baseline.evaluate( ( state, id ) => state.translation( id ), entry.id );
		if ( translation !== null ) continue;
		learned.splice( index, 1 );
		unmodelled++;
	}

	// The origin belongs to the scale: a rejected final transform must not
	// leave an otherwise-unlearned origin behind.
	for ( let index = learned.length - 1; index >= 0; index-- ) {
		const entry = learned[ index ]!;
		if ( entry.property === 'transform-origin' && ! learned.some( candidate => candidate.id === entry.id && candidate.property === 'transform' ) ) {
			learned.splice( index, 1 );
		}
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
		// A redundant minimum is held removed like a segmented declaration with
		// no rule: the source rewrites it on every resize, including the last one.
		entries: [
			...learned.map( entry => ( { id: entry.id, property: entry.property, css: entry.css, segmented: entry.segmentedCss !== null } ) ),
			...[ ...redundantMinHeight ].filter( ( [ , redundant ] ) => redundant ).map( ( [ id ] ) => ( { id, property: 'min-height', css: '', segmented: true } ) ),
		],
		segmentAttribute: SEGMENT_ATTRIBUTE,
		width: original?.width,
	} );
	// The runtime has rewritten its own sheets for the capture width by now;
	// learned rules are validated against exactly that geometry, as it stood
	// at load.
	await restoreLoadTimeSheets( page );
	const runtimeSheets = await applyRuntimeSheetRules( page, sampledWidths, adaptive ? widths : sampledWidths );
	if ( runtimeSheets.applied > 0 ) byKind[ 'runtime-sheet' ] = runtimeSheets.applied;
	if ( runtimeSheets.pruned > 0 ) byKind[ 'runtime-fitted' ] = runtimeSheets.pruned;

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

/** Inline lengths a runtime may derive from the viewport height. */
const VIEWPORT_HEIGHT_PROPERTIES = [ 'height', 'max-height', 'min-height' ] as const;
/** Holds height-probe samples privately until the lift; removed after. */
const VIEWPORT_HEIGHT_ATTRIBUTE = 'data-blocks-engine-capture-viewport-height';
const VIEWPORT_HEIGHT_LIFTED_ATTRIBUTE = 'data-blocks-engine-capture-viewport-height-lifted';
/** How far the probe moves the viewport height; any distinct height proves the relation. */
const VIEWPORT_HEIGHT_PROBE_PX = 137;

/**
 * Express runtime height-dependent inline lengths as affine viewport CSS.
 *
 * The width sweep holds height constant, so it cannot learn these lengths.
 * Probe runtime-written lengths only on viewport-reactive pages (alongside
 * the existing full-height candidates). Style mutations and a changed value
 * at fixed width establish height reactivity; only then does a second height
 * supplies a second live sample. The restored source baseline must match its
 * initial value within 1px. Its inline bytes may be a normalized rest pose,
 * so derive the slope from the two live probes, not from that rest pose.
 * Unchanged lengths stay on the width-learned path.
 *
 * Returns the number of declarations rewritten.
 */
async function liftViewportHeights( page: Page, settleMs: number ): Promise< number > {
	const original = page.viewportSize();
	if ( ! original ) return 0;
	const candidates = await page.evaluate( ( { attribute, properties, key, release } ) => {
		const tracker = ( window as unknown as Record< symbol, RuntimeStyleWrites | undefined > )[ Symbol.for( key ) ];
		let count = 0;
		for ( const element of document.querySelectorAll< HTMLElement >( '[style]' ) ) {
			const matched = properties.filter( property => {
				const value = /^(-?\d+(?:\.\d+)?)px$/.exec( element.style.getPropertyValue( property ).trim() );
				return value !== null && ( Math.abs( Number( value[ 1 ] ) - window.innerHeight ) <= 1 ||
					( tracker?.viewportReactive() && tracker.written( element ) ) );
			} );
			if ( ! matched.length ) continue;
			element.setAttribute( attribute, JSON.stringify( matched.map( property => ( {
				property, initial: parseFloat( element.style.getPropertyValue( property ) ), height: innerHeight,
			} ) ) ) );
			element.setAttribute( release, matched.join( ' ' ) );
			count++;
		}
		return count;
	}, { attribute: VIEWPORT_HEIGHT_ATTRIBUTE, properties: [ ...VIEWPORT_HEIGHT_PROPERTIES ], key: RUNTIME_STYLE_WRITES_KEY, release: FLUID_RELEASE_ATTRIBUTE } );
	if ( candidates === 0 ) return 0;
	const { settleDocument } = await import( './page-helpers.js' );
	const settle = { quietMs: PROBE_QUIET_MS, timeoutMs: settleMs + 3500 };
	const marked = { attribute: VIEWPORT_HEIGHT_ATTRIBUTE, release: FLUID_RELEASE_ATTRIBUTE, liftedAttribute: VIEWPORT_HEIGHT_LIFTED_ATTRIBUTE };
	let proven = false;
	let lifted = 0;
	try {
		// Learned authority pins the declarations it fitted at the capture width;
		// release them so the runtime may answer the probe, as it would in the source.
		await page.evaluate( key => {
			( window as unknown as Record< symbol, RuntimeStyleWrites | undefined > )[ Symbol.for( key ) ]?.heightProbe( true );
		}, RUNTIME_STYLE_WRITES_KEY );
		await page.setViewportSize( { width: original.width, height: original.height + VIEWPORT_HEIGHT_PROBE_PX } );
		await settleDocument( page, 'fluid-viewport-height', settle );
		// Only style mutations during this height-only resize constitute evidence.
		const changedCount = await page.evaluate( ( { attribute, key } ) => {
			let count = 0;
			const changed = ( window as unknown as Record< symbol, RuntimeStyleWrites | undefined > )[ Symbol.for( key ) ]?.heightProbe( false );
			for ( const element of document.querySelectorAll< HTMLElement >( `[${ attribute }]` ) ) {
				const samples: Array<{ property: string; initial: number; height: number; slope?: number; probe?: number; probeHeight?: number }> = JSON.parse( element.getAttribute( attribute )! );
				const followed = samples.filter( sample => {
					const value = element.style.getPropertyValue( sample.property ).trim();
					if ( changed && ! changed.includes( element ) || ! /^-?\d+(?:\.\d+)?px$/.test( value ) ) return false;
					const delta = parseFloat( value ) - sample.initial;
					if ( Math.abs( delta ) <= 1 ) return false;
					sample.slope = delta / ( innerHeight - sample.height );
					sample.probe = parseFloat( value );
					sample.probeHeight = innerHeight;
					return true;
				} );
				element.setAttribute( attribute, JSON.stringify( followed ) );
				count += followed.length;
			}
			return count;
		}, { attribute: VIEWPORT_HEIGHT_ATTRIBUTE, key: RUNTIME_STYLE_WRITES_KEY } );
		if ( changedCount > 0 ) {
			await page.setViewportSize( { width: original.width, height: original.height + 2 * VIEWPORT_HEIGHT_PROBE_PX } );
			await settleDocument( page, 'fluid-viewport-height', settle );
			await page.evaluate( attribute => {
				for ( const element of document.querySelectorAll< HTMLElement >( `[${ attribute }]` ) ) {
					const samples: Array<{ property: string; initial: number; height: number; slope: number; probe: number; probeHeight: number; intercept?: number }> = JSON.parse( element.getAttribute( attribute )! );
					element.setAttribute( attribute, JSON.stringify( samples.filter( sample => {
						const value = element.style.getPropertyValue( sample.property ).trim();
						if ( ! /^-?\d+(?:\.\d+)?px$/.test( value ) ) return false;
						sample.slope = ( parseFloat( value ) - sample.probe ) / ( innerHeight - sample.probeHeight );
						sample.intercept = sample.probe - sample.slope * sample.probeHeight;
						return Math.abs( parseFloat( value ) - sample.probe ) > 1;
					} ) ) );
				}
			}, VIEWPORT_HEIGHT_ATTRIBUTE );
		}
		proven = true;
	} finally {
		await page.setViewportSize( original );
		await settleDocument( page, 'fluid-viewport-height', settle );
		lifted = await page.evaluate( async ( { attribute, release, proven, liftedAttribute } ) => {
			let count = 0;
			const elements = [ ...document.querySelectorAll< HTMLElement >( `[${ attribute }]` ) ];
			const viewportSized = ( element: HTMLElement, property: string ) => {
				const value = /^(-?\d+(?:\.\d+)?)px$/.exec( element.style.getPropertyValue( property ).trim() );
				return value !== null && Math.abs( Number( value[ 1 ] ) - window.innerHeight ) <= 1;
			};
			for ( const element of proven ? elements : [] ) {
				const samples: Array<{ property: string; initial: number; height: number; slope: number; intercept: number }> = JSON.parse( element.getAttribute( attribute )! );
				const followed = samples.filter( sample => {
					const value = element.style.getPropertyValue( sample.property ).trim();
					return /^-?\d+(?:\.\d+)?px$/.test( value ) && Math.abs( parseFloat( value ) - sample.initial ) <= 1;
				} ).map( sample => sample.property );
				// A proven viewport-relative height carries its bounds with it: a px
				// max-height or min-height equal to the same capture viewport height
				// was set to that viewport height alongside it (a runtime may write a
				// bound once at load and not refresh it, or learned authority may hold
				// it through the probe). Left in px it would clamp the lifted height
				// back to the capture viewport at any other viewport height.
				const lift = followed.includes( 'height' ) && viewportSized( element, 'height' )
					? [ ...new Set( [ ...followed, 'max-height', 'min-height' ] ) ]
					: followed;
				for ( const property of lift ) {
					// The runtime restored the capture height; it must still match.
					const sample = samples.find( sample => sample.property === property && followed.includes( property ) );
					if ( ! sample && ! viewportSized( element, property ) ) continue;
					const css = sample
						? `calc(${ Number( ( sample.slope * 100 ).toFixed( 5 ) ) }vh + ${ Number( ( sample.intercept ).toFixed( 5 ) ) }px)`
						: '100vh';
					element.style.setProperty( property, css, element.style.getPropertyPriority( property ) );
					element.setAttribute( liftedAttribute, `${ element.getAttribute( liftedAttribute ) ?? '' } ${ property }`.trim() );
					count++;
				}
			}
			// Learned authority consumes a release marker on its next observation;
			// drop any it never observed along with the candidate marks.
			await new Promise( resolve => setTimeout( resolve, 0 ) );
			for ( const element of elements ) {
				element.removeAttribute( attribute );
				element.removeAttribute( release );
			}
			return count;
		}, { ...marked, proven } );
	}
	return lifted;
}

/**
 * Resize with the viewport-work tracker armed, so the timeouts the resize
 * schedules are pending until `waitForRestGeometry` observes them run.
 */
async function resizeViewport( page: Page, size: { width: number; height: number } ): Promise< void > {
	await page.evaluate( key => ( window as unknown as Record< symbol, ViewportWork > )[ Symbol.for( key ) ]!.arm(), VIEWPORT_WORK_KEY );
	await page.setViewportSize( size );
}

/**
 * One per-width readiness contract: observe resize, lazy work, and at-top rest.
 *
 * Scroll-linked chrome (a header that shrinks once the page is scrolled)
 * re-expands after the sweep returns to the top on the source's own schedule,
 * and the runtime rewrites the geometry that depends on it as it goes.
 * Sampling mid-transition teaches the fitter the scrolled state, which is not
 * the state the copy renders. Watch exactly what is sampled: rest is 200 ms of
 * unchanged geometry, checked every 16 ms, once no timeout the resize or scroll
 * scheduled is still pending (see viewport-work.ts). A debounced resize handler is
 * waited for because its timeout is pending, not because a fixed window
 * happens to outlast it. The quiet window also covers frame-driven refits and
 * intermittently updated motion (such as a 150 ms animation timer). The bound
 * keeps a perpetually animating page from stalling the sweep.
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
	await withEvaluateTimeout( baseline.evaluate( async ( state, { attribute, properties, settleMs, lazy, reuseSweep, reachabilityKey, workKey } ) => {
		const started = Date.now();
		const work = ( window as unknown as Record< symbol, ViewportWork > )[ Symbol.for( workKey ) ]!;
		const sleep = work.sleep;
		// The resize that preceded this wait armed the tracker.
		await work.release();
		const unreachable = ( window as unknown as Record< symbol, ( image: HTMLImageElement ) => boolean > )[ Symbol.for( reachabilityKey ) ];
		// One serialized geometry record per tagged element, keyed by its id, so
		// rest can be judged per element (see `perpetual` below).
		const snapshot = () => {
			state.reconcile();
			return new Map( state.elements().map( element => {
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
					style.clipPath ? `${ style.inset };clip-path:${ style.clipPath }` : style.inset, geometry.position,
					pixel( style.width ) === null ? null : geometry.parent?.clientWidth,
					pixel( style.height ) === null ? null : geometry.parent?.clientHeight ] ) ] as const;
			} ) );
		};
		// An element whose geometry keeps changing without a quiet window for
		// PERPETUAL_MS is running a perpetual animation (a script
		// writing transforms each frame), not settling. It can never be quiet, so
		// it is excluded from rest for the rest of this wait; every other element
		// must still be quiet. A finite transition shorter than the window settles
		// before it is classified.
		// Classified movers persist on this learning run's baseline state for its
		// later widths: they are the same tagged elements, so each width only
		// needs its own quiet window rather than re-proving the animation. A new
		// run tags afresh and starts with no movers.
		// Preserve the old eight 250 ms observations' two-second motion window.
		const PERPETUAL_MS = 2000;
		const QUIET_MS = 200;
		const streaks = new Map< string, { started: number; changed: number } >();
		const perpetual = ( state as unknown as { perpetual?: Set< string > } ).perpetual ??= new Set< string >();
		const unchanged = ( before: Map< string, string >, after: Map< string, string > ) => {
			let same = true;
			const now = Date.now();
			for ( const [ id, record ] of after ) {
				if ( perpetual.has( id ) ) continue;
				const prior = streaks.get( id );
				if ( before.get( id ) === record ) {
					if ( prior && now - prior.changed >= QUIET_MS ) streaks.delete( id );
					continue;
				}
				const streak = prior ?? { started: now, changed: now };
				streak.changed = now;
				streaks.set( id, streak );
				if ( now - streak.started >= PERPETUAL_MS ) perpetual.add( id );
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
			// Timeouts the sweep's scroll events schedule are viewport work too.
			work.arm();
			// This body runs only when this width has new work: the first width,
			// growth past the swept extent, or a newly rendered pending image. The
			// page sits at the top when a sweep begins — the previous sweep returned
			// there, and a reused width never scrolled.
			for ( let y = window.innerHeight; y < document.documentElement.scrollHeight && Date.now() - started < 20_000; y += window.innerHeight ) {
				window.scrollTo( { top: y, left: 0, behavior: 'instant' } );
				await sleep( 60 );
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
			await work.release();
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
		// The rest budget bounds a page that never rests. Additional sweeps share it.
		const deadline = Date.now() + settleMs + 3500;
		let previous = snapshot();
		let quietSince = Date.now();
		while ( Date.now() < deadline ) {
			// Short, untracked polling also progresses when the page stops rendering frames.
			await sleep( 16 );
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
				quietSince = Date.now();
				previous = snapshot();
				continue;
			}
			// An existing image's completed rendition is not an offscreen load
			// waiting for another visit. Still restart at-top rest: its intrinsic
			// size can change layout. Pending replacements, new/replaced nodes,
			// revealed images and document growth retain the full sweep above.
			sweptContent = currentContent;
			if ( lazy && changedImages.length ) {
				quietSince = Date.now();
				previous = snapshot();
				continue;
			}
			const current = snapshot();
			if ( ! unchanged( previous, current ) ) quietSince = Date.now();
			previous = current;
			// A display:none device variant cannot be reached by scrolling. Its
			// pending native lazy images do not describe this width's geometry;
			// visibility is re-read above, so a later reveal invalidates the sweep.
			// Native-lazy images clipped out of view by an overflow ancestor are
			// equally unreachable by this vertical sweep.
			const imagesReady = ! lazy || [ ...document.images ].every( image => image.complete || image.getClientRects().length === 0 || unreachable( image ) );
			// Pending timeouts cover debounces. A missing tagged role can also
			// be between an unwrap and an rAF-driven refit: allow a second quiet
			// window for its replacement, without charging intact documents that wait.
			if ( Date.now() - quietSince >= QUIET_MS * ( state.missing() ? 2 : 1 ) && imagesReady && work.pending() === 0 ) break;
		}
		// Later widths reuse this wait's visited extent and content (see `reuse`),
		// so what the last sweep actually observed is what they compare against.
		if ( lazy ) {
			( state as unknown as { swept?: { height: number; content: ReturnType< typeof content > | null } } ).swept =
				{ height: visitedHeight, content: sweptContent };
		}
	}, { attribute: ID_ATTRIBUTE, properties: [ ...properties ], settleMs, lazy, reuseSweep, reachabilityKey, workKey: VIEWPORT_WORK_KEY } ), 25_000 + settleMs );
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
	// Min-height-only pages previously paid no full sampling sweeps. Test their
	// declarations with the existing cheap resize probe, even when script wrote
	// them at load, so a constant equalizer still pays no scroll/rest sweep.
	const minima = await baseline.evaluate( state => {
		const elements = state.elements();
		if ( ! elements.every( element => {
			const geometry = state.readGeometry( element );
			return [ ...geometry.style ].every( property => property === 'min-height' || state.pixel( geometry.style.getPropertyValue( property ) ) === null ) && geometry.translation === null && geometry.inset === null;
		} ) ) return null;
		return elements.map( element => state.readGeometry( element ).literal );
	} );
	const before = await observe();
	if ( minima === null && ( before === null || before.written ) ) return false;
	// The probe asks only whether script writes the tagged elements, not what
	// geometry they rest at, so a quiet window that outlasts common resize
	// debounces replaces the sampling sweep's scroll-and-rest readiness.
	const { settleDocument } = await import( './page-helpers.js' );
	const probeSettle = { quietMs: PROBE_QUIET_MS, timeoutMs: settleMs + 3500 };
	if ( minima === null && ! before!.reactive ) return true;
	let unchangedMinima = minima !== null;
	// A runtime-rewritten sheet is learned by the sweep even when the inline
	// geometry is constant, so the same probe reads the sheets too.
	const sheets = await sourceSheetText( page );
	let sheetsVaried = false;
	for ( const width of [ Math.min( ...widths ), Math.max( ...widths ) ] ) {
		await page.setViewportSize( { width, height: original?.height ?? 900 } );
		await settleDocument( page, 'fluid-probe', probeSettle );
		sheetsVaried ||= await sourceSheetText( page ) !== sheets;
		if ( minima !== null ) {
			const current = await baseline.evaluate( state => state.elements().map( element => state.readGeometry( element ).literal ) );
			unchangedMinima &&= JSON.stringify( current ) === JSON.stringify( minima );
		}
	}
	if ( original ) await page.setViewportSize( original );
	await settleDocument( page, 'fluid-probe', probeSettle );
	const after = await observe();
	const constant = ! sheetsVaried && ( minima !== null ? unchangedMinima : after !== null && ! after.written && after.count === before!.count );
	// A constant document is captured at this viewport without sampling, so it
	// owes the capture width what a sampled return does.
	if ( constant ) await replayReplacedEntrances( page, baseline );
	return constant;
}

/** Source stylesheet text; a runtime that rewrites a sheet per width changes it. */
const sourceSheetText = ( page: Page ) => page.evaluate( () => JSON.stringify( [ ...document.querySelectorAll( 'style' ) ]
	.filter( style => ! style.getAttributeNames().some( name => name.startsWith( 'data-blocks-engine-capture-' ) ) )
	.map( style => style.textContent ?? '' ) ) );

/**
 * Whether a runtime rewrites a source `<style>` at the width extremes on a page
 * with no inline geometry to learn. Such a sheet is learned on its own evidence;
 * a page whose script never listens to the viewport pays no resize.
 */
async function sourceSheetsVary(
	page: Page,
	widths: readonly number[],
	original: { width: number; height: number } | null,
	settleMs: number
): Promise< boolean > {
	const reactive = await page.evaluate( key => ( window as unknown as Record< symbol, { viewportReactive(): boolean } | undefined > )[ Symbol.for( key ) ]?.viewportReactive() ?? false, RUNTIME_STYLE_WRITES_KEY );
	if ( ! reactive ) return false;
	const baseline = await sourceSheetText( page );
	const { settleDocument } = await import( './page-helpers.js' );
	const probeSettle = { quietMs: PROBE_QUIET_MS, timeoutMs: settleMs + 3500 };
	let varied = false;
	for ( const width of [ Math.min( ...widths ), Math.max( ...widths ) ] ) {
		await page.setViewportSize( { width, height: original?.height ?? 900 } );
		await settleDocument( page, 'fluid-probe', probeSettle );
		if ( await sourceSheetText( page ) !== baseline ) { varied = true; break; }
	}
	if ( original ) await page.setViewportSize( original );
	await settleDocument( page, 'fluid-probe', probeSettle );
	return varied;
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

/**
 * Bounded rules for a custom property that switches between pixel runs and
 * declared non-pixel values (`100%`) with width.
 *
 * Each contiguous run of the width-sorted series is one regime, governing from
 * its first sampled width up to the width before the next regime begins (the
 * outermost regimes extend indefinitely). A pixel run is fitted alone; a
 * non-pixel run carries its declared literal when every sample agrees on it,
 * and is otherwise left unmodelled.
 */
function customPropertyRegimes( samples: readonly GeometrySample[] ): { segments: FluidModelSegment[]; unmodelled: number } {
	const regimes: GeometrySample[][] = [];
	for ( const sample of [ ...samples ].sort( ( a, b ) => a.viewport - b.viewport ) ) {
		const current = regimes.at( -1 );
		if ( current && Number.isFinite( current[ 0 ]!.value ) === Number.isFinite( sample.value ) ) current.push( sample );
		else regimes.push( [ sample ] );
	}
	const segments: FluidModelSegment[] = [];
	let unmodelled = 0;
	const constantPx = ( value: number ): ViewportFluidModel => {
		const rounded = Math.round( value * 100 ) / 100;
		return { kind: 'constant', css: `${ rounded }px`, value: rounded };
	};
	regimes.forEach( ( run, index ) => {
		const minWidth = index === 0 ? null : run[ 0 ]!.viewport;
		const maxWidth = index === regimes.length - 1 ? null : regimes[ index + 1 ]![ 0 ]!.viewport - 1;
		const clip = ( segment: FluidModelSegment ): FluidModelSegment => ( {
			model: segment.model,
			minWidth: segment.minWidth === null ? minWidth : minWidth === null ? segment.minWidth : Math.max( segment.minWidth, minWidth ),
			maxWidth: segment.maxWidth === null ? maxWidth : maxWidth === null ? segment.maxWidth : Math.min( segment.maxWidth, maxWidth ),
		} );
		if ( ! Number.isFinite( run[ 0 ]!.value ) ) {
			const literal = run[ 0 ]!.cssValue;
			if ( literal && run.every( sample => sample.cssValue === literal ) ) {
				segments.push( { model: { kind: 'constant', css: literal, value: Number.NaN }, minWidth, maxWidth } );
			} else unmodelled++;
			return;
		}
		if ( run.length < 3 ) {
			// Too few observations for a relationship: hold each one from its width.
			const sub = run.map( ( sample, at ) => ( {
				model: constantPx( sample.value ),
				minWidth: at === 0 ? null : sample.viewport,
				maxWidth: at === run.length - 1 ? null : run[ at + 1 ]!.viewport - 1,
			} ) );
			segments.push( ...sub.map( clip ) );
			return;
		}
		const fitted = learnWidestFluidModel( run );
		const model = fitted.kind === 'container'
			? learnWidestFluidModel( run.map( ( { viewport, value } ) => ( { viewport, value } ) ) )
			: fitted;
		if ( model.kind !== 'breakpoint' && model.kind !== 'container' ) {
			segments.push( { model, minWidth, maxWidth } );
			return;
		}
		const segmented = learnSegmentedFluidModel( run, { holdUnfitted: true, holdNarrowForBoundedAffine: true } );
		if ( segmented === null ) { unmodelled++; return; }
		segments.push( ...segmented.segments.map( clip ).filter( segment =>
			segment.minWidth === null || segment.maxWidth === null || segment.minWidth <= segment.maxWidth ) );
	} );
	return { segments, unmodelled };
}
