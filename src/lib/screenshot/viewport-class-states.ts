import { createHash } from 'node:crypto';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import type { Page } from 'playwright';
import { COARSE_SWEEP_WIDTHS, PROBE_QUIET_MS, SEGMENT_STYLE_ATTRIBUTE } from './fluid-capture.js';
import { RUNTIME_STYLE_WRITES_KEY } from './runtime-style-writes.js';

/**
 * Script-written class state that follows the viewport.
 *
 * A source script can toggle class tokens on resize (a sidebar pinned open at
 * wide widths, its toggle icon drawn open with it). The capture serializes the
 * DOM at one width, so every other width would receive that width's class
 * state. Sweep the coarse widths, find each token whose presence changes with
 * width, locate its breakpoint, and carry the token as a width-scoped alias:
 * the element wears the alias instead, and every readable rule naming the
 * token gains a copy naming the alias inside the widths where the source
 * applied it. The copies live in a capture-generated rules block, which the
 * responsive assembly keeps intact with its own media conditions.
 */
export const VIEWPORT_CLASS_PREFIX = 'data-blocks-engine-capture-width-class-';

const STATE_KEY = 'data-liberation.viewport-class-states';

/**
 * `[token, alias]` pairs an element wears as aliases in the serialized copy;
 * the initial-document projection applies them.
 */
export const WIDTH_CLASSES_ATTRIBUTE = 'data-blocks-engine-capture-width-classes';

export interface ViewportClassStatesResult {
	/** Element tokens carried as width-scoped aliases. */
	aliased: number;
	/** Rule copies written for those aliases. */
	rules: number;
	/** Widths the sweep resized to, in order. */
	sampledWidths: number[];
}

interface Toggle { index: number; token: string; base: boolean }

/** Presence runs (inclusive, null = unbounded) as one media query list. */
export function presenceMedia( presence: ReadonlyArray< { width: number; present: boolean } > ): string {
	const sorted = [ ...presence ].sort( ( a, b ) => a.width - b.width );
	const runs: string[] = [];
	for ( let start = 0; start < sorted.length; ) {
		let end = start;
		while ( end + 1 < sorted.length && sorted[ end + 1 ]!.present === sorted[ start ]!.present ) end++;
		if ( sorted[ start ]!.present ) {
			const min = start === 0 ? null : sorted[ start ]!.width;
			const max = end === sorted.length - 1 ? null : sorted[ end + 1 ]!.width - 1;
			const parts = [ min === null ? '' : `(min-width:${ min }px)`, max === null ? '' : `(max-width:${ max }px)` ].filter( Boolean );
			runs.push( parts.length ? parts.join( ' and ' ) : 'all' );
		}
		start = end + 1;
	}
	return runs.join( ',' );
}

/**
 * Every stylesheet the document applies, in cascade order: readable sheets
 * through the CSSOM, cross-origin ones fetched from their href. Null when any
 * sheet cannot be read, since a token's rules there could not be carried.
 */
async function stylesheetTexts( page: Page ): Promise< string[] | null > {
	const sheets = await page.evaluate( () => [ ...document.styleSheets, ...document.adoptedStyleSheets ].map( sheet => {
		try {
			return { css: [ ...sheet.cssRules ].map( rule => rule.cssText ).join( '\n' ) };
		} catch {
			return { href: sheet.href };
		}
	} ) );
	const texts: string[] = [];
	for ( const sheet of sheets ) {
		if ( 'css' in sheet ) {
			texts.push( sheet.css ?? '' );
			continue;
		}
		if ( ! sheet.href ) return null;
		const response = await page.request.get( sheet.href ).catch( () => null );
		if ( ! response?.ok() ) return null;
		texts.push( await response.text() );
	}
	return texts;
}

/**
 * A copy of each rule naming an aliased token, naming the alias instead, kept
 * inside its own conditional groups and the widths the token applied at.
 */
export function aliasRules( sheets: readonly string[], aliases: ReadonlyArray< { token: string; alias: string; media: string } > ): string[] {
	const copies: string[] = [];
	for ( const css of sheets ) {
		let root: postcss.Root;
		try {
			root = postcss.parse( css );
		} catch {
			continue;
		}
		root.walkRules( rule => {
			if ( rule.parent?.type === 'atrule' && /keyframes$/i.test( ( rule.parent as postcss.AtRule ).name ) ) return;
			for ( const { token, alias, media } of aliases ) {
				let named = false;
				let selector: string;
				try {
					selector = selectorParser( selectors => selectors.walkClasses( node => {
						if ( node.value !== token ) return;
						node.value = alias;
						named = true;
					} ) ).processSync( rule.selector );
				} catch {
					continue;
				}
				if ( ! named ) continue;
				let copy = rule.clone( { selector } ).toString();
				for ( let parent = rule.parent; parent && parent.type === 'atrule'; parent = parent.parent ) {
					const group = parent as postcss.AtRule;
					if ( ! /^(media|supports|container|layer)$/i.test( group.name ) ) break;
					copy = `@${ group.name } ${ group.params }{${ copy }}`;
				}
				copies.push( `@media ${ media }{${ copy }}` );
			}
		} );
	}
	return copies;
}

export type ViewportClassMemo = Map< string, ReadonlyArray< { width: number; present: boolean } > >;

export async function captureViewportClassStates( page: Page, options: { widths?: readonly number[]; settleMs?: number; breakpoints?: Set< number >; memo?: ViewportClassMemo } = {} ): Promise< ViewportClassStatesResult > {
	const original = page.viewportSize();
	const none = { aliased: 0, rules: 0, sampledWidths: [] };
	if ( ! original ) return none;
	// Class tokens change with the viewport only when script reacts to it.
	const reactive = await page.evaluate( key => {
		const tracker = ( window as unknown as Record< symbol, { viewportReactive(): boolean } | undefined > )[ Symbol.for( key ) ];
		return tracker ? tracker.viewportReactive() : true;
	}, RUNTIME_STYLE_WRITES_KEY );
	if ( ! reactive ) return none;

	const { settleDocument } = await import( './page-helpers.js' );
	const settle = { quietMs: PROBE_QUIET_MS, timeoutMs: ( options.settleMs ?? 1200 ) + 3500 };
	await page.evaluate( key => {
		const elements = [ ...document.body.querySelectorAll( '*' ) ].filter( element => ! [ 'SCRIPT', 'STYLE', 'TEMPLATE' ].includes( element.tagName ) );
		const tokens = ( element: Element ) => ( element.getAttribute( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean );
		const base = elements.map( element => new Set( tokens( element ) ) );
		Object.defineProperty( window, Symbol.for( key ), { configurable: true, value: {
			// Per element index: tokens added or removed against the serialized width.
			diff: () => {
				const changes: Record< number, { added: string[]; removed: string[] } > = {};
				elements.forEach( ( element, index ) => {
					if ( ! element.isConnected ) return;
					const now = new Set( tokens( element ) );
					const added = [ ...now ].filter( token => ! base[ index ]!.has( token ) );
					const removed = [ ...base[ index ]! ].filter( token => ! now.has( token ) );
					if ( added.length || removed.length ) changes[ index ] = { added, removed };
				} );
				return changes;
			},
			elements,
			base,
		} } );
	}, STATE_KEY );

	const sampledWidths: number[] = [];
	const memo = new Map< number, Record< number, { added: string[]; removed: string[] } > >();
	const probe = async ( width: number ) => {
		const known = memo.get( width );
		if ( known ) return known;
		sampledWidths.push( width );
		await page.setViewportSize( { width, height: original.height } );
		await settleDocument( page, 'viewport-class-probe', settle );
		const diff = await page.evaluate( key => ( window as unknown as Record< symbol, { diff(): Record< number, { added: string[]; removed: string[] } > } > )[ Symbol.for( key ) ]!.diff(), STATE_KEY );
		memo.set( width, diff );
		return diff;
	};
	const present = ( diff: Record< number, { added: string[]; removed: string[] } >, toggle: Toggle ) => {
		const change = diff[ toggle.index ];
		return toggle.base ? ! change?.removed.includes( toggle.token ) : !! change?.added.includes( toggle.token );
	};

	try {
		memo.set( original.width, {} );
		const ladder = [ ...new Set( [ ...( options.widths ?? COARSE_SWEEP_WIDTHS ), original.width ] ) ].sort( ( a, b ) => a - b );
		const toggles = new Map< string, Toggle >();
		const presence = new Map< string, Array< { width: number; present: boolean } > >();
		const signatures = await page.evaluate( key => {
			const elements = ( window as unknown as Record< symbol, { elements: Element[] } > )[ Symbol.for( key ) ]!.elements;
			return elements.map( element => {
				const parts: string[] = [];
				for ( let node: Element | null = element; node; node = node.parentElement ) {
					const position = node.parentElement ? [ ...node.parentElement.children ].filter( sibling => sibling.tagName === node.tagName ).indexOf( node ) : 0;
					parts.push( `${ node.tagName }${ node.id ? `#${ node.id }` : '' }${ [ ...node.classList ].sort().map( name => `.${ name }` ).join( '' ) }:${ position }` );
					if ( node !== element && node.id ) break;
				}
				return parts.join( '<' );
			} );
		}, STATE_KEY );
		// The extremes reveal a viewport-driven runtime; only then is the ladder swept.
		const extremes = [ ladder[ 0 ]!, ladder[ ladder.length - 1 ]! ];
		const extremesDiff: Array<Record<number, { added: string[]; removed: string[] }>> = [];
		for ( const width of extremes ) extremesDiff.push( await probe( width ) );
		if ( extremesDiff.every( diff => Object.keys( diff ).length === 0 ) ) return { ...none, sampledWidths };
		const candidates = new Map<string, Toggle>();
		for ( const diff of extremesDiff ) for ( const [ indexText, change ] of Object.entries( diff ) ) {
			for ( const token of change.added ) candidates.set( `${ indexText }|${ token }`, { index: Number( indexText ), token, base: false } );
			for ( const token of change.removed ) candidates.set( `${ indexText }|${ token }`, { index: Number( indexText ), token, base: true } );
		}
		const reused = new Set<string>();
		for ( const [ key, toggle ] of candidates ) {
			const memoKey = `${ signatures[toggle.index] }|${ toggle.token }`;
			const saved = options.memo?.get( memoKey );
			if ( saved ) {
				const agrees = extremes.every( ( width, i ) => {
					const observation = saved.find( sample => sample.width === width );
					return observation !== undefined && observation.present === present( extremesDiff[i]!, toggle );
				} );
				if ( agrees ) { toggles.set( key, toggle ); presence.set( key, [ ...saved ] ); reused.add( memoKey ); }
			}
		}
		if ( reused.size !== candidates.size ) {
			for ( const width of ladder ) {
				for ( const [ index, change ] of Object.entries( await probe( width ) ) ) {
					for ( const token of change.added ) toggles.set( `${ index }|${ token }`, { index: Number( index ), token, base: false } );
					for ( const token of change.removed ) toggles.set( `${ index }|${ token }`, { index: Number( index ), token, base: true } );
				}
			}
		}
		if ( toggles.size === 0 ) return { ...none, sampledWidths };

		// Locate each flip between adjacent ladder widths: the first width
		// that shows the wider side's state.
		for ( const [ key, toggle ] of toggles ) if ( ! presence.has( key ) ) presence.set( key, ladder.map( width => ( { width, present: present( memo.get( width )!, toggle ) } ) ) );
		for ( const [ key, toggle ] of toggles ) {
			const series = presence.get( key )!;
			if ( reused.has( `${ signatures[toggle.index] }|${ toggle.token }` ) ) continue;
			for ( let i = 1; i < ladder.length; i++ ) {
				let low = ladder[ i - 1 ]!;
				let high = ladder[ i ]!;
				const wide = present( memo.get( high )!, toggle );
				if ( present( memo.get( low )!, toggle ) === wide ) continue;
				// A breakpoint another route already located is the likeliest one.
				for ( const known of [ ...( options.breakpoints ?? [] ) ].filter( width => width > low + 1 && width <= high ).sort( ( a, b ) => a - b ) ) {
					if ( present( await probe( known ), toggle ) !== wide ) continue;
					if ( present( await probe( known - 1 ), toggle ) !== wide ) [ low, high ] = [ known - 1, known ];
					break;
				}
				while ( high - low > 1 ) {
					const middle = Math.floor( ( low + high ) / 2 );
					if ( present( await probe( middle ), toggle ) === wide ) high = middle;
					else low = middle;
				}
				series.push( { width: high, present: wide } );
				options.breakpoints?.add( high );
			}
		}

		// Restore the serialized width and keep only tokens the source restores
		// with it: a token that stays changed follows time, not the viewport.
		await page.setViewportSize( original );
		await settleDocument( page, 'viewport-class-probe', settle );
		const restored = await page.evaluate( key => ( window as unknown as Record< symbol, { diff(): Record< number, { added: string[]; removed: string[] } > } > )[ Symbol.for( key ) ]!.diff(), STATE_KEY );
		const aliases: Array< { index: number; token: string; base: boolean; alias: string; media: string } > = [];
		for ( const [ key, toggle ] of toggles ) {
			const change = restored[ toggle.index ];
			if ( change?.added.includes( toggle.token ) || change?.removed.includes( toggle.token ) ) continue;
			const series = presence.get( key )!;
			if ( ! reused.has( `${ signatures[toggle.index] }|${ toggle.token }` ) ) options.memo?.set( `${ signatures[toggle.index] }|${ toggle.token }`, series );
			const media = presenceMedia( series );
			if ( media === '' || media === 'all' ) continue;
			const alias = `${ VIEWPORT_CLASS_PREFIX }${ createHash( 'sha256' ).update( `${ toggle.token }\n${ media }` ).digest( 'hex' ).slice( 0, 12 ) }`;
			aliases.push( { ...toggle, alias, media } );
		}
		if ( aliases.length === 0 ) return { ...none, sampledWidths };

		const css = await stylesheetTexts( page );
		if ( css === null ) return { ...none, sampledWidths };
		const copies = aliasRules( css, aliases );
		await page.evaluate( ( { key, aliases, attribute, copies, marker } ) => {
			const state = ( window as unknown as Record< symbol, { elements: Element[] } > )[ Symbol.for( key ) ]!;
			// The source script may rewrite the class attribute on any later
			// resize, and only capture attributes reach the initial document.
			for ( const { index, token, alias } of aliases ) {
				const element = state.elements[ index ]!;
				const pairs = JSON.parse( element.getAttribute( marker ) ?? '[]' ) as string[][];
				element.setAttribute( marker, JSON.stringify( [ ...pairs, [ token, alias ] ] ) );
			}
			if ( copies.length ) {
				const style = document.createElement( 'style' );
				style.setAttribute( attribute, '' );
				style.textContent = copies.join( '\n' );
				document.head.appendChild( style );
			}
		}, { key: STATE_KEY, aliases, attribute: SEGMENT_STYLE_ATTRIBUTE, copies, marker: WIDTH_CLASSES_ATTRIBUTE } );
		const rules = copies.length;
		return { aliased: aliases.length, rules, sampledWidths };
	} finally {
		if ( page.viewportSize()?.width !== original.width ) {
			await page.setViewportSize( original );
			await settleDocument( page, 'viewport-class-probe', settle );
		}
		await page.evaluate( key => delete ( window as unknown as Record< symbol, unknown > )[ Symbol.for( key ) ], STATE_KEY );
	}
}
