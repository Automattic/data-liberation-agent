import type { CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import postcss, { type Container } from 'postcss';
import selectorParser from 'postcss-selector-parser';

interface Rule {
	selector: string;
	properties: string[];
	/** Unknown selectors must conflict regardless of specificity. */
	specificity?: string;
	/** The selector without interaction states: every element it could ever match. */
	matchSelector?: string;
	/** Rules on different pseudo-element boxes never compete. */
	pseudoElement: string;
}
interface Sheet {
	barrier: boolean;
	rules: Rule[];
	/** Each family's @font-face rules, normalized; identical sets commute. */
	fonts: Map<string, string>;
	keyframes: Set<string>;
}

function propertyFamily( property: string ): string {
	if ( property.startsWith( '--' ) ) return property;
	const name = property.toLowerCase().replace( /^-(webkit|moz|ms|o)-/, '' );
	if ( name === 'line-height' ) return 'font';
	if ( [ 'top', 'right', 'bottom', 'left' ].includes( name ) ) return 'inset';
	if ( name === 'columns' ) return 'column';
	if ( /^(white-space|text-wrap)/.test( name ) ) return 'white';
	if ( /^(?:(?:grid-)?(?:row-|column-)?gap)$/.test( name ) ) return 'gap';
	if ( /^(place|align|justify)-/.test( name ) ) return 'alignment';
	return name.split( '-' )[ 0 ];
}

/** Structural pseudo-classes the captured DOM answers; anything else is state. */
const STRUCTURAL_PSEUDO = /^:(?:root|empty|(?:first|last|only)-(?:child|of-type)|nth-(?:last-)?(?:child|of-type))$/;

/** Interaction states a static DOM can't answer; dropping them only widens the match. */
const STATE_PSEUDO = /^:(?:hover|active|focus|focus-visible|focus-within|visited|link|any-link|target|checked|enabled|disabled|placeholder-shown|valid|invalid|required|optional|read-only|read-write|indeterminate)$/;
const PSEUDO_ELEMENT = /^::?(?:before|after|first-line|first-letter|placeholder|selection|marker|backdrop|file-selector-button)$/;

/**
 * Exact selector specificity, or undefined when the DOM can't evaluate the
 * selector. With `widen`, interaction states (and a trailing pseudo-element)
 * are removed in place, so the selector matches a superset of its targets.
 */
function specificity( selector: selectorParser.Selector, widen = false ): number[] | undefined {
	const counts = [ 0, 0, 0 ];
	for ( const part of [ ...selector.nodes ] ) {
		if ( part.type === 'pseudo' && widen && ( STATE_PSEUDO.test( part.value.toLowerCase() ) || PSEUDO_ELEMENT.test( part.value.toLowerCase() ) ) ) {
			counts[ PSEUDO_ELEMENT.test( part.value.toLowerCase() ) ? 2 : 1 ]++;
			const prev = part.prev(), next = part.next();
			// A bare state (`nav :focus`) still names an element: keep it as `*`.
			if ( ( ! prev || prev.type === 'combinator' ) && ( ! next || next.type === 'combinator' ) ) part.replaceWith( selectorParser.universal() );
			else part.remove();
			continue;
		}
		if ( part.type === 'id' ) counts[ 0 ]++;
		else if ( part.type === 'class' || part.type === 'attribute' ) counts[ 1 ]++;
		else if ( part.type === 'tag' ) counts[ 2 ]++;
		else if ( part.type === 'pseudo' ) {
			const name = part.value.toLowerCase();
			if ( name === ':where' ) {
				if ( part.nodes.some( argument => specificity( argument, widen ) === undefined ) ) return undefined;
			} else if ( [ ':is', ':not', ':has' ].includes( name ) ) {
				// The most specific argument decides; every argument must be evaluable.
				// Widening inside a negation or relation would narrow the match instead.
				const argumentCounts = part.nodes.map( argument => specificity( argument, widen && name === ':is' ) );
				if ( ! argumentCounts.length || argumentCounts.some( value => value === undefined ) ) return undefined;
				const max = ( argumentCounts as number[][] ).reduce( ( a, b ) => ( a[ 0 ] - b[ 0 ] || a[ 1 ] - b[ 1 ] || a[ 2 ] - b[ 2 ] ) >= 0 ? a : b );
				max.forEach( ( value, index ) => counts[ index ] += value );
			} else if ( STRUCTURAL_PSEUDO.test( name ) && ! / of /i.test( part.toString() ) ) counts[ 1 ]++;
			else return undefined;
		} else if ( ! [ 'universal', 'combinator', 'comment' ].includes( part.type ) ) return undefined;
	}
	return counts;
}

function parseSheet( css: string ): Sheet {
	const sheet: Sheet = { barrier: false, rules: [], fonts: new Map(), keyframes: new Set() };
	try {
		const visit = ( container: Container ) => {
			for ( const node of container.nodes ?? [] ) {
				if ( node.type === 'comment' ) continue;
				if ( node.type === 'atrule' ) {
					const name = node.name.toLowerCase();
					if ( [ 'media', 'supports', 'container' ].includes( name ) ) visit( node );
					else if ( name === 'font-face' ) {
						const family = node.nodes?.find( child => child.type === 'decl' && child.prop.toLowerCase() === 'font-family' );
						if ( family?.type === 'decl' && ! /[\\\\()]/.test( family.value ) ) {
							const name = family.value.replace( /["']/g, '' ).trim().toLowerCase();
							sheet.fonts.set( name, [ ...( sheet.fonts.get( name )?.split( '\n' ) ?? [] ), node.toString().replace( /\s+/g, ' ' ) ].sort().join( '\n' ) );
						}
						else sheet.barrier = true;
					} else if ( /^(?:-webkit-)?keyframes$/.test( name ) && ! /\\\\/.test( node.params ) ) sheet.keyframes.add( node.params.replace( /["']/g, '' ).trim() );
					else sheet.barrier = true;
					continue;
				}
				if ( node.type !== 'rule' ) { sheet.barrier = true; continue; }
				// CSS nesting and other rule-local constructs need cascade context.
				if ( node.nodes.some( child => ! [ 'decl', 'comment' ].includes( child.type ) ) ) sheet.barrier = true;
				const properties = node.nodes.flatMap( child => child.type === 'decl' ? [ propertyFamily( child.prop ) ] : [] );
				const selectors = selectorParser().astSync( node.selector );
				for ( const selector of selectors.nodes ) {
					const text = selector.toString();
					const pseudoElement = selector.nodes.find( part => part.type === 'pseudo' && PSEUDO_ELEMENT.test( ( part.value ?? '' ).toLowerCase() ) )?.value?.replace( /^::?/, '' ).toLowerCase() ?? '';
					const counts = specificity( selector, true );
					const matchSelector = selector.toString().trim();
					sheet.rules.push( { selector: text, properties, specificity: counts?.join( ',' ), matchSelector: counts && matchSelector ? matchSelector : counts ? '*' : undefined, pseudoElement } );
				}
			}
		};
		visit( postcss.parse( css ) );
	} catch { sheet.barrier = true; }
	return sheet;
}

/** One assembly's parse cache; DOM matches are local to the document being reordered. */
export function stylesheetCommutation(): ( a: string | undefined, b: string | undefined, source: CheerioAPI ) => boolean {
	const parsed = new Map<string, Sheet>();
	const sheet = ( css: string ) => {
		if ( ! parsed.has( css ) ) parsed.set( css, parseSheet( css ) );
		return parsed.get( css )!;
	};
	return ( a, b, source ) => {
		// Linked sheets have no captured cascade proof here.
		if ( a === undefined || b === undefined ) return false;
		const left = sheet( a ), right = sheet( b );
		if ( left.barrier || right.barrier || [ ...left.fonts ].some( ( [ name, faces ] ) => right.fonts.has( name ) && right.fonts.get( name ) !== faces ) ||
			[ ...left.keyframes ].some( name => right.keyframes.has( name ) ) ) return false;
		const matches = new Map<Rule, Set<Element> | undefined>();
		const elements = ( rule: Rule ) => {
			if ( ! matches.has( rule ) ) {
				try { matches.set( rule, rule.matchSelector === undefined ? undefined : new Set( source( rule.matchSelector ).toArray() as Element[] ) ); }
				catch { matches.set( rule, undefined ); }
			}
			return matches.get( rule );
		};
		for ( const x of left.rules ) for ( const y of right.rules ) {
			// Ignore importance when proving independence: overestimating conflicts is safe.
			if ( x.pseudoElement !== y.pseudoElement ) continue;
			if ( ! x.properties.some( property => y.properties.includes( property ) || property === 'all' || y.properties.includes( 'all' ) ) ) continue;
			const xs = elements( x ), ys = elements( y );
			if ( ! xs || ! ys ) return false;
			if ( x.specificity === y.specificity && [ ...xs ].some( element => ys.has( element ) ) ) return false;
		}
		return true;
	};
}
