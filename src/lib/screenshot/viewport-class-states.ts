import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { resolveDocumentReferences } from '../document-resource-base.js';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import type { Page } from 'playwright';
import { COARSE_SWEEP_WIDTHS } from './fluid-capture.js';
import { RUNTIME_STYLE_WRITES_KEY } from './runtime-style-writes.js';
import { observeViewportWork, VIEWPORT_WORK_KEY, type ViewportWork } from './viewport-work.js';
import { orElse } from '../failure-class.js';

/**
 * Script-written class state that follows the viewport.
 *
 * A source script can toggle class tokens on resize (a sidebar pinned open at
 * wide widths, its toggle icon drawn open with it). The capture serializes the
 * DOM at one width, so every other width would receive that width's class
 * state. Sweep the coarse widths, find each token whose presence changes with
 * width, locate its breakpoint, and carry the token as a width-scoped alias:
 * the element wears the alias instead, and every readable rule naming the
 * token is projected in place into presence/absence media arms. In the
 * presence arm the alias also satisfies the token, including under :not();
 * in the absence arm only the original token does.
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
		const response = await page.request.get( sheet.href ).catch( orElse( null ) );
		if ( ! response?.ok() ) return null;
		texts.push( await response.text() );
	}
	return texts;
}

type WidthClassAlias = { token: string; alias: string; media: string };
const CONTRACTS_ATTRIBUTE = 'data-blocks-engine-capture-width-class-contracts';

/** Project each affected rule into both states, retaining specificity and context. */
export function aliasRules( sheets: readonly string[], aliases: readonly WidthClassAlias[] ): string[] {
	const copies: string[] = [];
	// Many elements can share one token contract; project it only once.
	const contracts = [ ...new Map( aliases.map( alias => [ `${ alias.token }|${ alias.alias }|${ alias.media }`, alias ] ) ).values() ];
	for ( const css of sheets ) {
		let root: postcss.Root;
		try {
			root = postcss.parse( css );
		} catch {
			continue;
		}
		root.walkRules( rule => {
			if ( rule.parent?.type === 'atrule' && /keyframes$/i.test( ( rule.parent as postcss.AtRule ).name ) ) return;
			let projected = postcss.root().append( rule.clone() );
			let affected = false;
			for ( const { token, alias, media } of contracts ) {
				let named = false;
				try {
					selectorParser( selectors => selectors.walkClasses( node => {
						if ( node.value === token ) named = true;
					} ) ).processSync( rule.selector );
				} catch {
					continue;
				}
				if ( ! named ) continue;
				const active = postcss.atRule( { name: 'media', params: media } );
				const inactive = postcss.atRule( { name: 'media', params: `not (${ media.split( ',' ).map( query => `(${ query })` ).join( ' or ' ) })` } );
				// Compose contracts, so a selector naming several toggled tokens
				// tests all their states rather than emitting competing copies.
				const before = projected.toString();
				// :is() keeps the class specificity, including under nested
				// negation; ordinary elements still test their original token.
				const after = selectorParser( selectors => selectors.walkClasses( node => {
					if ( node.value === token ) node.replaceWith( selectorParser().astSync( `:is(${ node.toString() },.${ alias })` ).first.first! );
				} ) );
				const present = postcss.parse( before );
				present.walkRules( child => { child.selector = after.processSync( child.selector ); } );
				active.append( present.nodes );
				inactive.append( postcss.parse( before ).nodes );
				projected = postcss.root().append( active, inactive );
				affected = true;
			}
			if ( ! affected ) return;
			let copy = projected.toString();
			for ( let parent = rule.parent; parent && parent.type === 'atrule'; parent = parent.parent ) {
				const group = parent as postcss.AtRule;
				if ( ! /^(media|supports|container|layer)$/i.test( group.name ) ) break;
				copy = `@${ group.name } ${ group.params }{${ copy }}`;
			}
			copies.push( copy );
		} );
	}
	return copies;
}

/** Rewrite the portable document only; never change source rules during learning. */
export function projectViewportClassRules( html: string, linkedSheet: ( href: string ) => { css: string; url: string } | undefined = () => undefined ): string {
	const $ = cheerio.load( html );
	const marked = $( 'body' ).attr( CONTRACTS_ATTRIBUTE );
	if ( ! marked ) return html;
	const aliases: WidthClassAlias[] = JSON.parse( marked );
	$( 'body' ).removeAttr( CONTRACTS_ATTRIBUTE );
	const project = ( css: string ) => {
		let root: postcss.Root;
		try { root = postcss.parse( css ); } catch { return css; }
		const rules: postcss.Rule[] = [];
		root.walkRules( rule => { rules.push( rule ); } );
		for ( const rule of rules ) {
			if ( rule.parent?.type === 'atrule' && /keyframes$/i.test( rule.parent.name ) ) continue;
			const copies = aliasRules( [ rule.toString() ], aliases );
			if ( copies.length ) rule.replaceWith( ...postcss.parse( copies.join( '\n' ) ).nodes );
		}
		return root.toString();
	};
	$( 'style' ).each( ( _, element ) => { $( element ).text( project( $( element ).text() ) ); } );
	$( 'link[rel~="stylesheet"]:not([rel~="alternate"]):not([disabled])' ).each( ( _, element ) => {
		const link = $( element );
		const sheet = linkedSheet( link.attr( 'href' ) ?? '' );
		if ( ! sheet || ! aliases.some( alias => sheet.css.includes( alias.token ) ) ) return;
		const style = $( '<style>' ).text( project( sheet.css ) );
		const media = link.attr( 'media' );
		if ( media !== undefined ) style.attr( 'media', media );
		const resolved = cheerio.load( resolveDocumentReferences( style.toString(), sheet.url, sheet.url ) );
		link.replaceWith( resolved( 'style' ).toString() );
	} );
	return $.html();
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

	await page.evaluate( observeViewportWork );
	// Wait for the state we sample, not unrelated style writes, carousels or
	// lazy images elsewhere in the document. Pending resize debounces still
	// hold the probe open; two identical class reads prove its resting state.
	const resize = async ( size: { width: number; height: number } ) => {
		await page.evaluate( key => ( window as unknown as Record< symbol, ViewportWork > )[ Symbol.for( key ) ]!.arm(), VIEWPORT_WORK_KEY );
		await page.setViewportSize( size );
		await page.evaluate( async ( { key, workKey, timeoutMs } ) => {
			const work = ( window as unknown as Record< symbol, ViewportWork > )[ Symbol.for( workKey ) ]!;
			await work.release();
			const state = ( window as unknown as Record< symbol, { diff(): unknown } > )[ Symbol.for( key ) ]!;
			const deadline = Date.now() + timeoutMs;
			let previous = JSON.stringify( state.diff() );
			do {
				await work.sleep( 50 );
				const current = JSON.stringify( state.diff() );
				if ( current === previous && work.pending() === 0 ) return;
				previous = current;
			} while ( Date.now() < deadline );
		}, { key: STATE_KEY, workKey: VIEWPORT_WORK_KEY, timeoutMs: ( options.settleMs ?? 1200 ) + 3500 } );
	};
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
		await resize( { width, height: original.height } );
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
				// Prove the stored series at this route's extremes and at each
				// exact flip (the width either side of it): agreement at the extremes
				// alone cannot see a breakpoint that moved inside the range.
				const ordered = [ ...new Map( saved.map( sample => [ sample.width, sample ] ) ).values() ].sort( ( a, b ) => a.width - b.width );
				const checks = extremes.map( ( width, i ) => ( { width, diff: extremesDiff[ i ]!, expected: saved.find( sample => sample.width === width )?.present } ) );
				let agrees = checks.every( check => check.expected === present( check.diff, toggle ) );
				for ( let i = 1; agrees && i < ordered.length; i++ ) {
					if ( ordered[ i - 1 ]!.present === ordered[ i ]!.present ) continue;
					const flip = ordered[ i ]!.width;
					agrees = present( await probe( flip ), toggle ) === ordered[ i ]!.present &&
						present( await probe( flip - 1 ), toggle ) === ordered[ i - 1 ]!.present;
				}
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
		await resize( original );
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
		await page.evaluate( ( { key, aliases, marker, contractsAttribute } ) => {
			const state = ( window as unknown as Record< symbol, { elements: Element[] } > )[ Symbol.for( key ) ]!;
			// The source script may rewrite the class attribute on any later
			// resize, and only capture attributes reach the initial document.
			for ( const { index, token, alias } of aliases ) {
				const element = state.elements[ index ]!;
				const pairs = JSON.parse( element.getAttribute( marker ) ?? '[]' ) as string[][];
				element.setAttribute( marker, JSON.stringify( [ ...pairs, [ token, alias ] ] ) );
			}
			document.body.setAttribute( contractsAttribute, JSON.stringify( aliases ) );
		}, { key: STATE_KEY, aliases, marker: WIDTH_CLASSES_ATTRIBUTE, contractsAttribute: CONTRACTS_ATTRIBUTE } );
		const rules = copies.length;
		return { aliased: aliases.length, rules, sampledWidths };
	} finally {
		if ( page.viewportSize()?.width !== original.width ) {
			await resize( original );
		}
		await page.evaluate( key => delete ( window as unknown as Record< symbol, unknown > )[ Symbol.for( key ) ], STATE_KEY );
	}
}
