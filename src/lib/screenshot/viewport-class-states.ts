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
import { closingConnection } from '../browser-kit/api-request-connection.js';

/**
 * Script-written class state that follows the viewport.
 *
 * A source script can toggle class tokens on resize (a sidebar pinned open at
 * wide widths, its toggle icon drawn open with it). The capture serializes the
 * DOM at one width, so every other width would receive that width's class
 * state. Sweep the coarse widths, find each token whose presence changes with
 * width, locate its breakpoint, and carry the token as a width-scoped alias:
 * the element wears the alias instead, and each readable rule that can reach
 * that element through the token is projected in place into presence/absence media arms. In the
 * presence arm the alias also satisfies the token, including under :not();
 * in the absence arm only the original token does.
 */
export const VIEWPORT_CLASS_PREFIX = 'data-blocks-engine-capture-width-class-';

/** Projected sheets already encode the sweep's width conditions. */
export const VIEWPORT_CLASS_RULES_ATTRIBUTE = 'data-blocks-engine-capture-width-class-rules';

const STATE_KEY = 'data-liberation.viewport-class-states';

/**
 * `[token, alias, captureWidthPresence]` tuples an element wears as aliases in the serialized copy;
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
	/** Set when the search budget ran out: unproven toggles were dropped. */
	budgetExhausted?: true;
}

/** Breakpoint-search probes per sweep: about ten bisection steps for six flips. */
const MAX_SEARCH_PROBES = 64;

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
		const response = await page.request.get( sheet.href, { headers: closingConnection() } ).catch( orElse( null ) );
		if ( ! response?.ok() ) return null;
		texts.push( await response.text() );
	}
	return texts;
}

type WidthClassAlias = { token: string; alias: string; media: string };
const CONTRACTS_ATTRIBUTE = 'data-blocks-engine-capture-width-class-contracts';

/**
 * Alternatives of one token belong to different elements, not independent
 * boolean states of the whole selector. Scope each alternative to its wearer;
 * the ordinary-element arm excludes all wearers, including under :not().
 */
function projectAliasGroup( root: postcss.Root, token: string, group: readonly WidthClassAlias[] ): postcss.Root {
	const result = postcss.root();
	let repeated = false;
	root.walkRules( rule => {
		selectorParser( selectors => selectors.each( selector => {
			let count = 0;
			selector.walkClasses( node => {
				if ( node.value !== token ) return;
				count++;
				for ( let parent = node.parent; parent && parent.type !== 'root'; parent = parent.parent ) {
					// A selector-list/relational pseudo can match through a branch
					// that does not name this token; a wearer guard would hide it.
					if ( parent.type === 'pseudo' && parent.value !== ':not' ) repeated = true;
					if ( parent.type === 'selector' && parent.nodes.some( child => child.type === 'combinator' ) && parent.parent?.type === 'pseudo' ) repeated = true;
				}
			} );
			if ( count > 1 ) repeated = true;
		} ) ).processSync( rule.selector );
	} );
	// Multiple subjects (e.g. .tok > .tok or a complex pseudo) cannot be
	// scoped to one wearer. Partition widths rather than doubling states.
	if ( repeated ) {
		const boundaries = [ ...new Set( [ 0, ...group.flatMap( item => [ ...item.media.matchAll( /(min|max)-width:\s*(\d+)px/g ) ].map( match => Number( match[ 2 ] ) + ( match[ 1 ] === 'max' ? 1 : 0 ) ) ) ] ) ].sort( ( a, b ) => a - b );
		for ( let i = 0; i < boundaries.length; i++ ) {
			const min = boundaries[ i ]!;
			const max = boundaries[ i + 1 ];
			const active = group.filter( item => widthMediaMatches( item.media, min ) );
			const copy = root.clone();
			copy.walkRules( rule => {
				rule.selector = selectorParser( selectors => selectors.walkClasses( node => {
					if ( node.value === token && active.length ) node.replaceWith( selectorParser().astSync( `:is(${ node.toString() },${ active.map( item => `.${ item.alias }` ).join( ',' ) })` ).first.first! );
				} ) ).processSync( rule.selector );
			} );
			const media = [ min ? `(min-width:${ min }px)` : '', max === undefined ? '' : `(max-width:${ max - 1 }px)` ].filter( Boolean ).join( ' and ' ) || 'all';
			result.append( postcss.atRule( { name: 'media', params: media } ).append( copy.nodes ) );
		}
		return result;
	}
	const variants = [
		{ alias: '', media: '', active: false },
		...group.flatMap( contract => [
			{ ...contract, active: true },
			{ ...contract, media: `not (${ contract.media.split( ',' ).map( query => `(${ query })` ).join( ' or ' ) })`, active: false },
		] ),
	];
	for ( const variant of variants ) {
		const copy = root.clone();
		copy.walkRules( rule => {
			rule.selector = selectorParser( selectors => {
				const nodes: selectorParser.ClassName[] = [];
				selectors.walkClasses( node => { if ( node.value === token ) nodes.push( node ); } );
				for ( const node of nodes ) {
					// A token under :not() still constrains that pseudo's subject.
					// :has() starts a new relative selector with its own subject.
					let subject: selectorParser.Node = node;
					while ( subject.parent?.type !== 'root' ) {
						const parent = subject.parent;
						if ( ! parent || parent.type === 'selector' && parent.parent?.type !== 'pseudo' ) break;
						if ( parent.type === 'selector' && parent.parent?.value === ':has' ) break;
						subject = parent as selectorParser.Node;
					}
					const guard = variant.alias ? `.${ variant.alias }` : `:not(${ group.map( item => `.${ item.alias }` ).join( ',' ) })`;
					subject.parent!.insertAfter( subject, selectorParser().astSync( `:where(${ guard })` ).first.first! );
					if ( variant.active ) node.replaceWith( selectorParser().astSync( `:is(${ node.toString() },.${ variant.alias })` ).first.first! );
				}
			} ).processSync( rule.selector );
		} );
		if ( variant.media ) result.append( postcss.atRule( { name: 'media', params: variant.media } ).append( copy.nodes ) );
		else result.append( copy.nodes );
	}
	return result;
}

/** Evaluate the width-only grammar produced by presenceMedia (unknowns stay possible). */
function widthMediaMatches( media: string, width: number ): boolean {
	let text = media.trim();
	if ( text === 'all' ) return true;
	const feature = /^\((min|max)-width:\s*(\d+)px\)$/.exec( text );
	if ( feature ) return feature[ 1 ] === 'min' ? width >= Number( feature[ 2 ] ) : width <= Number( feature[ 2 ] );
	// Split only at this nesting level, before removing enclosing parentheses.
	for ( const operator of [ ',', ' or ', ' and ' ] ) {
		let depth = 0;
		for ( let i = 0; i < text.length; i++ ) {
			if ( depth === 0 && text.startsWith( operator, i ) ) {
				const left = widthMediaMatches( text.slice( 0, i ), width );
				const right = widthMediaMatches( text.slice( i + operator.length ), width );
				return operator === ' and ' ? left && right : left || right;
			}
			if ( text[ i ] === '(' ) depth++;
			if ( text[ i ] === ')' ) depth--;
		}
	}
	if ( text.startsWith( 'not ' ) ) return ! widthMediaMatches( text.slice( 4 ), width );
	if ( text.startsWith( '(' ) && text.endsWith( ')' ) ) {
		text = text.slice( 1, -1 );
		return widthMediaMatches( text, width );
	}
	return true;
}

/** Drop impossible generated arms rather than shipping contradictory width states. */
function pruneWidthArms( root: postcss.Root, enclosing: readonly string[] = [] ): void {
	const media: string[] = [ ...enclosing ];
	root.walkAtRules( 'media', node => { media.push( node.params ); } );
	const widths = [ 0, ...media.flatMap( query => [ ...query.matchAll( /(?:min|max)-width:\s*(\d+)px/g ) ].flatMap( match => [ Number( match[ 1 ] ), Number( match[ 1 ] ) + 0.5 ] ) ) ];
	root.walkAtRules( 'media', node => {
		const conditions = [ ...enclosing, node.params ];
		for ( let parent = node.parent; parent?.type === 'atrule'; parent = parent.parent ) {
			if ( parent.name === 'media' ) conditions.push( parent.params );
		}
		const known = conditions.filter( query => ! query.replace( /\((?:min|max)-width:\s*\d+px\)|\b(?:not|and|or|all)\b|[(),\s]/g, '' ) );
		if ( ! widths.some( width => known.every( query => widthMediaMatches( query, width ) ) ) ) node.remove();
	} );
}

/** Class tokens eligible for projection; keyframe steps are not selectors. */
function ruleClassNames( rule: postcss.Rule ): Set<string> {
	const names = new Set<string>();
	if ( rule.parent?.type === 'atrule' && /keyframes$/i.test( rule.parent.name ) ) return names;
	try {
		selectorParser( selectors => selectors.walkClasses( node => { names.add( node.value ); } ) ).processSync( rule.selector );
	} catch {
		return new Set();
	}
	return names;
}

/** Project each affected rule into both states, retaining specificity and context. */
export function aliasRules( sheets: readonly string[], aliases: readonly WidthClassAlias[], canMatch: ( selector: string, contract: WidthClassAlias ) => boolean = () => true ): string[] {
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
			const names = ruleClassNames( rule );
			const relevant = contracts.filter( contract => names.has( contract.token ) && canMatch( rule.selector, contract ) );
			if ( relevant.length === 0 ) return;
			const groups = new Map<string, WidthClassAlias[]>();
			for ( const contract of relevant ) {
				const group = groups.get( contract.token ) ?? [];
				group.push( contract );
				groups.set( contract.token, group );
			}
			let projected = postcss.root().append( rule.clone() );
			for ( const [ token, group ] of groups ) {
				if ( group.length > 1 ) {
					projected = projectAliasGroup( projected, token, group );
					continue;
				}
				const contract = group[ 0 ]!;
				const { alias, media } = contract;
				const active = postcss.atRule( { name: 'media', params: media } );
				const inactive = postcss.atRule( { name: 'media', params: `not (${ media.split( ',' ).map( query => `(${ query })` ).join( ' or ' ) })` } );
				// Compose different tokens, never the alternative wearers of one token.
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
			}
			pruneWidthArms( projected );
			let copy = projected.toString();
			for ( let parent = rule.parent; parent && parent.type === 'atrule'; parent = parent.parent ) {
				const group = parent as postcss.AtRule;
				if ( ! /^(media|supports|container|layer)$/i.test( group.name ) ) break;
				copy = `@${ group.name } ${ group.params }{${ copy }}`;
			}
			const wrapped = postcss.parse( copy );
			pruneWidthArms( wrapped );
			copies.push( wrapped.toString() );
		} );
	}
	return copies;
}

/**
 * Test the structural path to each token, not the rule's subject: the token
 * may belong to an ancestor, or be absent under :not(). Ignore state pseudos
 * so the capture width's hover/negation state cannot hide an affected rule.
 */
function aliasCanMatch( selector: string, { token, alias }: WidthClassAlias, matches: ( selector: string ) => boolean ): boolean {
	let possible = false;
	selectorParser( selectors => selectors.walkClasses( node => {
		if ( possible || node.value !== token ) return;
		let target: selectorParser.Node = node;
		while ( target.parent?.type !== 'selector' || target.parent.parent?.type === 'pseudo' ) {
			if ( ! target.parent ) { possible = true; return; }
			target = target.parent as selectorParser.Node;
			// Relational pseudos need their own subject; retain them conservatively.
			if ( target.type === 'pseudo' && target.value === ':has' ) { possible = true; return; }
		}
		const path = target.parent!.clone();
		const index = target.parent!.nodes.indexOf( target );
		path.nodes[ index ]!.replaceWith( selectorParser.className( { value: alias } ) );
		// Only the compound containing the token and its ancestors constrain
		// the alias wearer. Descendants may themselves change with width.
		const end = path.nodes.findIndex( ( child, i ) => i > index && child.type === 'combinator' );
		if ( end !== -1 ) path.nodes.slice( end ).forEach( child => child.remove() );
		path.walkPseudos( pseudo => { pseudo.remove(); } );
		possible = matches( path.toString() );
	} ) ).processSync( selector );
	return possible;
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
			const copies = aliasRules( [ rule.toString() ], aliases, ( selector, contract ) => {
				try {
					return aliasCanMatch( selector, contract, path => {
						const possible = selectorParser( selectors => selectors.walkClasses( node => {
							const alternatives = aliases.filter( item => item.token === node.value );
							if ( alternatives.length ) node.replaceWith( selectorParser().astSync( `:is(${ node.toString() },${ alternatives.map( item => `.${ item.alias }` ).join( ',' ) })` ).first.first! );
						} ) ).processSync( path );
						return $( possible ).length > 0;
					} );
				} catch {
					// Unsupported selectors must not lose their width contract.
					return true;
				}
			} );
			if ( copies.length ) {
				const projected = postcss.parse( copies.join( '\n' ) );
				const enclosing: string[] = [];
				for ( let parent = rule.parent; parent?.type === 'atrule'; parent = parent.parent ) {
					if ( parent.name === 'media' ) enclosing.push( parent.params );
				}
				pruneWidthArms( projected, enclosing );
				rule.replaceWith( ...projected.nodes );
			}
		}
		return root.toString();
	};
	$( 'style' ).each( ( _, element ) => {
		const style = $( element );
		const original = style.text();
		const projected = project( original );
		if ( projected !== original ) style.attr( VIEWPORT_CLASS_RULES_ATTRIBUTE, '' );
		style.text( projected );
	} );
	$( 'link[rel~="stylesheet"]:not([rel~="alternate"]):not([disabled])' ).each( ( _, element ) => {
		const link = $( element );
		const sheet = linkedSheet( link.attr( 'href' ) ?? '' );
		if ( ! sheet || ! aliases.some( alias => sheet.css.includes( alias.token ) ) ) return;
		const style = $( '<style>' ).attr( VIEWPORT_CLASS_RULES_ATTRIBUTE, '' ).text( project( sheet.css ) );
		const media = link.attr( 'media' );
		if ( media !== undefined ) style.attr( 'media', media );
		const resolved = cheerio.load( resolveDocumentReferences( style.toString(), sheet.url, sheet.url ) );
		link.replaceWith( resolved( 'style' ).toString() );
	} );
	return $.html();
}

/** Shared toggle evidence: a presence series, or a proven rejection. */
export type ViewportClassMemo = Map< string, ReadonlyArray< { width: number; present: boolean } > | 'rejected' >;

export async function captureViewportClassStates( page: Page, options: { widths?: readonly number[]; settleMs?: number; breakpoints?: Set< number >; memo?: ViewportClassMemo; budgetMs?: number; maxProbes?: number } = {} ): Promise< ViewportClassStatesResult > {
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
				// Class switches are rendered work; keep a fallback for stopped frames.
				await Promise.race( [ new Promise<void>( resolve => requestAnimationFrame( () => resolve() ) ), work.sleep( 100 ) ] );
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
					// Reflow can bring a scroll entrance into view; its pose is not
					// width state, even when other tokens on this element are.
					const entrance = ( window as typeof window & { __dlaEntrances?: { classTokens( element: Element ): Set<string> } } ).__dlaEntrances?.classTokens( element );
					const added = [ ...now ].filter( token => ! base[ index ]!.has( token ) && ! entrance?.has( token ) );
					const removed = [ ...base[ index ]! ].filter( token => ! now.has( token ) && ! entrance?.has( token ) );
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
	const probe = async ( width: number, repeat = false ) => {
		const known = memo.get( width );
		if ( known && ! repeat ) return known;
		if ( ! repeat ) sampledWidths.push( width );
		await resize( { width, height: original.height } );
		const diff = await page.evaluate( key => ( window as unknown as Record< symbol, { diff(): Record< number, { added: string[]; removed: string[] } > } > )[ Symbol.for( key ) ]!.diff(), STATE_KEY );
		if ( ! repeat ) memo.set( width, diff );
		return diff;
	};
	const present = ( diff: Record< number, { added: string[]; removed: string[] } >, toggle: Toggle ) => {
		const change = diff[ toggle.index ];
		return toggle.base ? ! change?.removed.includes( toggle.token ) : !! change?.added.includes( toggle.token );
	};
	// Breakpoint search is an optimization and must not consume the route:
	// past its probe or time budget an unsampled width is unknown (undefined).
	const stopAt = Date.now() + ( options.budgetMs ?? Infinity );
	const maxProbes = options.maxProbes ?? MAX_SEARCH_PROBES;
	let searched = 0;
	let exhausted = false;
	const presentAt = async ( width: number, toggle: Toggle ) => {
		if ( ! memo.has( width ) ) {
			if ( ! exhausted && ( searched >= maxProbes || Date.now() >= stopAt ) ) exhausted = true;
			if ( exhausted ) return undefined;
			searched++;
		}
		return present( await probe( width ), toggle );
	};
	const done = ( result: ViewportClassStatesResult ): ViewportClassStatesResult => exhausted ? { ...result, budgetExhausted: true } : result;

	try {
		memo.set( original.width, {} );
		const ladder = [ ...new Set( [ ...( options.widths ?? COARSE_SWEEP_WIDTHS ), original.width ] ) ].sort( ( a, b ) => a - b );
		const toggles = new Map< string, Toggle >();
		const presence = new Map< string, Array< { width: number; present: boolean } > >();
		// Chrome identity must not contain measured widths: current-link weight
		// can shift overflow breakpoints without changing the shared navigation.
		// Keep the measured media contract route-local, but name its wearer by
		// the landmark's structure and the element's relative position.
		const chromeKeys = await page.evaluate( key => {
			const elements = ( window as unknown as Record< symbol, { elements: Element[] } > )[ Symbol.for( key ) ]!.elements;
			const roots = new Map<Element, { signature: string; elements: Element[] }>();
			return elements.map( element => {
				const root = element.closest( 'header,nav,footer,[role="banner"],[role="navigation"],[role="contentinfo"]' );
				if ( ! root ) return null;
				let chrome = roots.get( root );
				if ( ! chrome ) {
					const descendants = [ root, ...root.querySelectorAll( '*' ) ].filter( node => ! [ 'SCRIPT', 'STYLE', 'TEMPLATE' ].includes( node.tagName ) );
					chrome = { elements: descendants, signature: JSON.stringify( descendants.map( node => [
						node.tagName, descendants.indexOf( node.parentElement! ), node.id,
						node.getAttribute( 'href' ), node.getAttribute( 'role' ),
						[ ...node.childNodes ].filter( child => child.nodeType === Node.TEXT_NODE ).map( child => child.textContent?.replace( /\s+/g, ' ' ).trim() ).join( ' ' ),
					] ) ) };
					roots.set( root, chrome );
				}
				return `${ chrome.signature }\n${ chrome.elements.indexOf( element ) }`;
			} );
		}, STATE_KEY );
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
		// Repeated siblings (same parent and tag, same classes but the token)
		// toggling one token form a single contract.
		const siblings = await page.evaluate( key => {
			const { elements, base } = ( window as unknown as Record< symbol, { elements: Element[]; base: Set<string>[] } > )[ Symbol.for( key ) ]!;
			const indexes = new Map( elements.map( ( element, index ) => [ element, index ] ) );
			return elements.map( ( element, index ) => ( { parent: indexes.get( element.parentElement! ) ?? -1, tag: element.tagName, classes: [ ...base[ index ]! ] } ) );
		}, STATE_KEY );
		const siblingGroup = ( { index, token }: Toggle ) => {
			const { parent, tag, classes } = siblings[ index ]!;
			return JSON.stringify( [ token, parent, tag, classes.filter( name => name !== token ).sort() ] );
		};
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
		const css = await stylesheetTexts( page );
		if ( css === null ) return { ...none, sampledWidths };
		const named = new Set<string>();
		for ( const sheet of css ) {
			let root: postcss.Root;
			try { root = postcss.parse( sheet ); } catch { continue; }
			root.walkRules( rule => { for ( const token of ruleClassNames( rule ) ) named.add( token ); } );
		}
		const eligible = ( toggle: Toggle ) => {
			const memoKey = `${ signatures[toggle.index] }|${ toggle.token }`;
			if ( ! named.has( toggle.token ) ) options.memo?.set( memoKey, 'rejected' );
			return named.has( toggle.token ) && options.memo?.get( memoKey ) !== 'rejected';
		};
		const reused = new Set<string>();
		for ( const [ key, toggle ] of candidates ) {
			if ( ! eligible( toggle ) ) { candidates.delete( key ); continue; }
			const memoKey = `${ signatures[toggle.index] }|${ toggle.token }`;
			const saved = options.memo?.get( memoKey );
			if ( saved && saved !== 'rejected' ) {
				// Prove the stored series at this route's extremes and at each
				// exact flip (the width either side of it): agreement at the extremes
				// alone cannot see a breakpoint that moved inside the range.
				const ordered = [ ...new Map( saved.map( sample => [ sample.width, sample ] ) ).values() ].sort( ( a, b ) => a.width - b.width );
				const checks = extremes.map( ( width, i ) => ( { width, diff: extremesDiff[ i ]!, expected: saved.find( sample => sample.width === width )?.present } ) );
				let agrees = checks.every( check => check.expected === present( check.diff, toggle ) );
				for ( let i = 1; agrees && i < ordered.length; i++ ) {
					if ( ordered[ i - 1 ]!.present === ordered[ i ]!.present ) continue;
					const flip = ordered[ i ]!.width;
					agrees = await presentAt( flip, toggle ) === ordered[ i ]!.present &&
						await presentAt( flip - 1, toggle ) === ordered[ i - 1 ]!.present;
				}
				if ( agrees ) { toggles.set( key, toggle ); presence.set( key, [ ...saved ] ); reused.add( memoKey ); }
			}
		}
		if ( candidates.size === 0 ) return done( { ...none, sampledWidths } );
		if ( ! [ ...candidates.keys() ].every( key => toggles.has( key ) ) ) {
			for ( const width of ladder ) {
				for ( const [ index, change ] of Object.entries( await probe( width ) ) ) {
					for ( const [ tokens, base ] of [ [ change.added, false ], [ change.removed, true ] ] as const ) {
						for ( const token of tokens ) {
							const toggle = { index: Number( index ), token, base };
							if ( eligible( toggle ) ) toggles.set( `${ index }|${ token }`, toggle );
						}
					}
				}
			}
		}
		if ( ladder.every( width => memo.has( width ) ) ) {
			// Members whose ladder states disagree follow position or time, not
			// the viewport: reject the group without bisecting each member.
			const groups = new Map< string, string[] >();
			for ( const [ key, toggle ] of toggles ) groups.set( siblingGroup( toggle ), [ ...( groups.get( siblingGroup( toggle ) ) ?? [] ), key ] );
			for ( const keys of groups.values() ) {
				const series = new Set( keys.map( key => ladder.map( width => present( memo.get( width )!, toggles.get( key )! ) ).join() ) );
				if ( series.size < 2 ) continue;
				for ( const key of keys ) {
					const toggle = toggles.get( key )!;
					options.memo?.set( `${ signatures[toggle.index] }|${ toggle.token }`, 'rejected' );
					toggles.delete( key );
					presence.delete( key );
				}
			}
		}
		if ( toggles.size === 0 ) return done( { ...none, sampledWidths } );

		// Locate each flip between adjacent ladder widths: the first width
		// that shows the wider side's state.
		for ( const [ key, toggle ] of toggles ) if ( ! presence.has( key ) ) presence.set( key, ladder.map( width => ( { width, present: present( memo.get( width )!, toggle ) } ) ) );
		for ( const [ key, toggle ] of toggles ) {
			const series = presence.get( key )!;
			if ( reused.has( `${ signatures[toggle.index] }|${ toggle.token }` ) ) continue;
			let proven = true;
			for ( let i = 1; proven && i < ladder.length; i++ ) {
				let low = ladder[ i - 1 ]!;
				let high = ladder[ i ]!;
				const wide = present( memo.get( high )!, toggle );
				if ( present( memo.get( low )!, toggle ) === wide ) continue;
				// A breakpoint another route already located is the likeliest one.
				for ( const known of [ ...( options.breakpoints ?? [] ) ].filter( width => width > low + 1 && width <= high ).sort( ( a, b ) => a - b ) ) {
					const atKnown = await presentAt( known, toggle );
					if ( atKnown === undefined ) { proven = false; break; }
					if ( atKnown !== wide ) continue;
					const below = await presentAt( known - 1, toggle );
					if ( below === undefined ) proven = false;
					else if ( below !== wide ) [ low, high ] = [ known - 1, known ];
					break;
				}
				while ( proven && high - low > 1 ) {
					const middle = Math.floor( ( low + high ) / 2 );
					const state = await presentAt( middle, toggle );
					if ( state === undefined ) proven = false;
					else if ( state === wide ) high = middle;
					else low = middle;
				}
				series.push( { width: high, present: wide } );
			}
			// Out of budget: keep the contracts already proven, leave this one unknown.
			if ( ! proven ) { toggles.delete( key ); presence.delete( key ); }
		}

		// Restore the serialized width and keep only tokens the source restores
		// with it: a token that stays changed follows time, not the viewport.
		await resize( original );
		const restored = await page.evaluate( key => ( window as unknown as Record< symbol, { diff(): Record< number, { added: string[]; removed: string[] } > } > )[ Symbol.for( key ) ]!.diff(), STATE_KEY );
		// A return to the original state alone can coincide with a carousel's
		// next cycle. Revisit the ladder and both sides of each learned flip
		// without the probe cache, rejecting tokens that do not reproduce their
		// states. Bisection's intermediate search steps need not be replayed.
		// This also validates contracts borrowed from another route's memo.
		const repeatWidths = new Set( ladder.filter( width => memo.has( width ) ) );
		for ( const series of presence.values() ) {
			const ordered = [ ...series ].sort( ( a, b ) => a.width - b.width );
			for ( let i = 1; i < ordered.length; i++ ) {
				if ( ordered[ i ]!.present === ordered[ i - 1 ]!.present ) continue;
				for ( const width of [ ordered[ i ]!.width - 1, ordered[ i ]!.width ] ) {
					if ( memo.has( width ) ) repeatWidths.add( width );
				}
			}
		}
		const unstable = new Set< string >();
		for ( const width of [ ...repeatWidths ].reverse() ) {
			const previous = memo.get( width )!;
			const repeated = await probe( width, true );
			for ( const [ key, toggle ] of toggles ) {
				if ( present( previous, toggle ) !== present( repeated, toggle ) ) unstable.add( key );
			}
		}
		await resize( original );
		const aliases: Array< { index: number; token: string; base: boolean; alias: string; media: string } > = [];
		for ( const [ key, toggle ] of toggles ) {
			const change = restored[ toggle.index ];
			const memoKey = `${ signatures[toggle.index] }|${ toggle.token }`;
			if ( unstable.has( key ) || change?.added.includes( toggle.token ) || change?.removed.includes( toggle.token ) ) {
				options.memo?.set( memoKey, 'rejected' );
				continue;
			}
			const series = presence.get( key )!;
			const media = presenceMedia( series );
			if ( media === '' || media === 'all' ) {
				options.memo?.set( memoKey, 'rejected' );
				continue;
			}
			if ( ! reused.has( memoKey ) ) options.memo?.set( memoKey, series );
			const ordered = [ ...series ].sort( ( a, b ) => a.width - b.width );
			for ( let i = 1; i < ordered.length; i++ ) {
				if ( ordered[ i ]!.present !== ordered[ i - 1 ]!.present ) options.breakpoints?.add( ordered[ i ]!.width );
			}
			const alias = `${ VIEWPORT_CLASS_PREFIX }${ createHash( 'sha256' ).update( `${ toggle.token }\n${ chromeKeys[ toggle.index ] ?? media }` ).digest( 'hex' ).slice( 0, 12 ) }`;
			aliases.push( { ...toggle, alias, media } );
		}
		if ( aliases.length === 0 ) return done( { ...none, sampledWidths } );

		const copies = aliasRules( css, aliases );
		await page.evaluate( ( { key, aliases, marker, contractsAttribute } ) => {
			const state = ( window as unknown as Record< symbol, { elements: Element[] } > )[ Symbol.for( key ) ]!;
			// The source script may rewrite the class attribute on any later
			// resize, and only capture attributes reach the initial document.
			for ( const { index, token, alias, base } of aliases ) {
				const element = state.elements[ index ]!;
				const pairs = JSON.parse( element.getAttribute( marker ) ?? '[]' ) as Array<[string, string, boolean]>;
				element.setAttribute( marker, JSON.stringify( [ ...pairs, [ token, alias, base ] ] ) );
			}
			document.body.setAttribute( contractsAttribute, JSON.stringify( aliases ) );
		}, { key: STATE_KEY, aliases, marker: WIDTH_CLASSES_ATTRIBUTE, contractsAttribute: CONTRACTS_ATTRIBUTE } );
		const rules = copies.length;
		return done( { aliased: aliases.length, rules, sampledWidths } );
	} finally {
		if ( page.viewportSize()?.width !== original.width ) {
			await resize( original );
		}
		await page.evaluate( key => delete ( window as unknown as Record< symbol, unknown > )[ Symbol.for( key ) ], STATE_KEY );
	}
}
