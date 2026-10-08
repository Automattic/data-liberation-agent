// src/lib/screenshot/fluid-runtime-sheets.ts
//
// Learn offsets a source runtime writes into its own <style> elements.
//
// Some runtimes do not write inline pixels: they regenerate a stylesheet keyed
// by element ids whenever the viewport changes (a columns repeater centring its
// items, for example). Serialization freezes that sheet at the capture width,
// so every other width inherits the capture width's offsets once the runtime is
// gone. A top-level rule whose declared pixel value changes across the sweep
// can only have been rewritten by a runtime, so the sweep itself is the
// ownership proof; the learned rules then ship beside the owning sheet and are
// scoped exactly like it.
//
import type { Page } from 'playwright';
import { learnFluidModel, learnSegmentedFluidModel, segmentedCss, type FluidModelSegment, type GeometrySample } from './fluid-model.js';

/** Marks the learned sibling of a runtime-owned stylesheet. It is source-owned CSS, scoped per document. */
export const RUNTIME_SHEET_RULES_ATTRIBUTE = 'data-dla-fluid-sheet-rules';
/** Offsets a runtime plausibly derives from viewport width; sizes stay with inline learning. */
const OFFSET_PROPERTIES = [ 'left', 'right', 'top', 'bottom', 'inset-inline-start', 'inset-inline-end', 'inset-block-start', 'inset-block-end' ];
const STATE_KEY = '__dlaFluidRuntimeSheets';
const TOLERANCE_PX = 2;

export interface RuntimeSheetRule {
	selector: string;
	property: string;
	css: string;
}

/**
 * Viewport-expressible segments for an offset, or null when it is constant or
 * genuinely unfittable. Holding unfitted samples keeps each observed regime at
 * the value it governed rather than the capture width's.
 */
export function offsetSegments( samples: readonly GeometrySample[] ): FluidModelSegment[] | null {
	const whole = learnFluidModel( samples );
	if ( whole.kind === 'constant' || whole.kind === 'container' ) return null;
	if ( whole.kind !== 'breakpoint' ) return [ { model: whole, minWidth: null, maxWidth: null } ];
	return learnSegmentedFluidModel( samples, { holdUnfitted: true, holdNarrowForBoundedAffine: true } )?.segments ?? null;
}

/** Remember every source stylesheet's text at the capture width, before any resize. */
export async function bindRuntimeSheets( page: Page ): Promise< void > {
	await page.evaluate( ( { key } ) => {
		const baselines = new Map< Element, string >();
		const styles = document.querySelectorAll( 'style' );
		for ( let index = 0; index < styles.length; index++ ) {
			const style = styles[ index ]!;
			if ( ! style.getAttributeNames().some( name => name.startsWith( 'data-dla-' ) ) ) baselines.set( style, style.textContent ?? '' );
		}
		( window as unknown as Record< string, unknown > )[ key ] = { baselines, widths: [] as Array< Map< Element, Record< string, string[] > > > };
	}, { key: STATE_KEY } );
}

/** Record the offsets of every source stylesheet whose text differs from the capture width. */
export async function observeRuntimeSheets( page: Page ): Promise< void > {
	await page.evaluate( ( { key, properties } ) => {
		const state = ( window as unknown as Record< string, { baselines: Map< Element, string >; widths: Array< Map< Element, Record< string, string[] > > > } | undefined > )[ key ];
		if ( ! state ) return;
		const changed = new Map< Element, Record< string, string[] > >();
		for ( const [ style, baseline ] of state.baselines ) {
			if ( ! style.isConnected || style.textContent === baseline ) continue;
			const values: Record< string, string[] > = {};
			const rules = ( style as HTMLStyleElement ).sheet?.cssRules;
			for ( let index = 0; rules && index < rules.length; index++ ) {
				const rule = rules[ index ];
				if ( ! ( rule instanceof CSSStyleRule ) ) continue;
				for ( let property = 0; property < properties.length; property++ ) {
					const value = rule.style.getPropertyValue( properties[ property ]! ).trim();
					if ( ! value ) continue;
					const id = `${ rule.selectorText }\n${ properties[ property ] }`;
					( values[ id ] ??= [] ).push( value );
				}
			}
			changed.set( style, values );
		}
		state.widths.push( changed );
	}, { key: STATE_KEY, properties: OFFSET_PROPERTIES } );
}

/**
 * Learn rules from the recorded sweep, write each beside its owning sheet, and
 * keep only rules that reproduce the capture width's geometry.
 */
export async function applyRuntimeSheetRules( page: Page, widths: readonly number[] ): Promise< { applied: number; unmodelled: number } > {
	const recorded = await page.evaluate( ( { key, properties } ) => {
		const state = ( window as unknown as Record< string, { baselines: Map< Element, string >; widths: Array< Map< Element, Record< string, string[] > > > } | undefined > )[ key ];
		delete ( window as unknown as Record< string, unknown > )[ key ];
		if ( ! state ) return [];
		const owners: Array< { owner: number; values: Array< Record< string, string[] > | null > } > = [];
		const volatile = new Set< Element >();
		for ( const width of state.widths ) for ( const style of width.keys() ) volatile.add( style );
		const parse = ( text: string ) => {
			const values: Record< string, string[] > = {};
			const sheet = new CSSStyleSheet();
			try { sheet.replaceSync( text ); } catch { return null; }
			for ( let index = 0; index < sheet.cssRules.length; index++ ) {
				const rule = sheet.cssRules[ index ];
				if ( ! ( rule instanceof CSSStyleRule ) ) continue;
				for ( let property = 0; property < properties.length; property++ ) {
					const value = rule.style.getPropertyValue( properties[ property ]! ).trim();
					if ( value ) ( values[ `${ rule.selectorText }\n${ properties[ property ] }` ] ??= [] ).push( value );
				}
			}
			return values;
		};
		const styles = [ ...document.querySelectorAll( 'style' ) ];
		for ( const style of volatile ) {
			const owner = styles.indexOf( style as HTMLStyleElement );
			if ( owner < 0 ) continue;
			const baseline = parse( state.baselines.get( style ) ?? '' );
			owners.push( { owner, values: state.widths.map( width => width.get( style ) ?? baseline ) } );
		}
		return owners;
	}, { key: STATE_KEY, properties: OFFSET_PROPERTIES } );

	const byOwner = new Map< number, RuntimeSheetRule[] >();
	let unmodelled = 0;
	for ( const { owner, values } of recorded ) {
		const ids = new Set( values.flatMap( value => Object.keys( value ?? {} ) ) );
		for ( const id of ids ) {
			const [ selector, property ] = id.split( '\n' ) as [ string, string ];
			// A pseudo-element cannot sit inside :is(); such a rule stays frozen.
			if ( /::|:(?:before|after|first-line|first-letter|marker|placeholder)\b/i.test( selector ) ) continue;
			const samples: GeometrySample[] = [];
			for ( let index = 0; index < widths.length; index++ ) {
				const declared = values[ index ]?.[ id ];
				const match = declared?.length === 1 ? /^(-?\d+(?:\.\d+)?)px$/.exec( declared[ 0 ]! ) : null;
				if ( match ) samples.push( { viewport: widths[ index ]!, value: Number( match[ 1 ] ) } );
			}
			// Every width must observe exactly one pixel declaration; anything
			// else is not one relationship the copy can reproduce.
			if ( samples.length !== widths.length ) continue;
			const spread = Math.max( ...samples.map( sample => sample.value ) ) - Math.min( ...samples.map( sample => sample.value ) );
			if ( spread <= TOLERANCE_PX ) continue;
			const segments = offsetSegments( samples );
			if ( segments === null ) { unmodelled++; continue; }
			const rules = byOwner.get( owner ) ?? [];
			rules.push( { selector, property, css: segmentedCss( selector, property, segments ) } );
			byOwner.set( owner, rules );
		}
	}
	if ( byOwner.size === 0 ) return { applied: 0, unmodelled };

	const rejected = await page.evaluate( ( { owners, attribute, tolerance } ) => {
		const styles = [ ...document.querySelectorAll( 'style' ) ];
		let rejectedCount = 0;
		for ( const [ owner, rules ] of owners ) {
			const source = styles[ owner ];
			if ( ! source?.isConnected ) { rejectedCount += rules.length; continue; }
			const learned = document.createElement( 'style' );
			learned.setAttribute( attribute, '' );
			source.after( learned );
			const kept: string[] = [];
			for ( const rule of rules ) {
				let targets: Element[];
				try { targets = [ ...document.querySelectorAll( rule.selector ) ]; } catch { rejectedCount++; continue; }
				const before = targets.map( target => target.getBoundingClientRect() );
				learned.textContent = [ ...kept, rule.css ].join( '\n' );
				const reproduced = targets.every( ( target, index ) => {
					const after = target.getBoundingClientRect();
					return Math.abs( after.x - before[ index ]!.x ) <= tolerance && Math.abs( after.y - before[ index ]!.y ) <= tolerance;
				} );
				if ( reproduced ) kept.push( rule.css );
				else rejectedCount++;
			}
			learned.textContent = kept.join( '\n' );
			if ( ! kept.length ) learned.remove();
		}
		return rejectedCount;
	}, { owners: [ ...byOwner ], attribute: RUNTIME_SHEET_RULES_ATTRIBUTE, tolerance: TOLERANCE_PX } );
	const total = [ ...byOwner.values() ].reduce( ( sum, rules ) => sum + rules.length, 0 );
	return { applied: total - rejected, unmodelled: unmodelled + rejected };
}
