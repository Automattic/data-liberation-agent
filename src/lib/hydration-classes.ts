import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import postcss from 'postcss';

/**
 * Pre-hydration class tokens (#2273). Server HTML can ship state classes such
 * as `main#page.loading` that site CSS hides until the source runtime removes
 * them. A browser-captured route shows which tokens the runtime removes; an
 * HTTP-acquired document never ran that runtime, so it would export hidden.
 *
 * A rule names one removed token and the element identity it was learned on:
 * a unique id, or a tag plus a class the element keeps. Rules are site-wide,
 * not per template, and a token is never a rule for an identity on which any
 * captured document keeps it.
 */
export type HydrationClassRule = { token: string } & ( { id: string } | { tag: string; stableClass: string } );

interface ElementIdentity { tag: string; id?: string; classes: Set< string >; path: string }

function identity( element: Element ): ElementIdentity {
	const tags: string[] = [];
	for ( let node: Element | null = element; node && node.type === 'tag'; node = node.parent as Element | null ) tags.unshift( node.name );
	return { tag: element.name, id: element.attribs.id || undefined, classes: new Set( ( element.attribs.class ?? '' ).split( /\s+/ ).filter( Boolean ) ), path: tags.join( '>' ) };
}

function identities( html: string ): ElementIdentity[] {
	const $ = cheerio.load( html );
	return $( '[id], [class]' ).toArray().filter( ( node ): node is Element => node.type === 'tag' ).map( identity );
}

function uniqueIds( nodes: readonly ElementIdentity[] ): Map< string, ElementIdentity > {
	const counts = new Map< string, number >();
	for ( const node of nodes ) if ( node.id ) counts.set( node.id, ( counts.get( node.id ) ?? 0 ) + 1 );
	return new Map( nodes.filter( node => node.id && counts.get( node.id ) === 1 ).map( node => [ node.id!, node ] ) );
}

function matches( rule: HydrationClassRule, node: ElementIdentity ): boolean {
	return 'id' in rule ? node.id === rule.id : node.tag === rule.tag && node.classes.has( rule.stableClass );
}

/** Learn removed tokens from browser-captured routes: server HTML against the captured DOM. */
export function learnHydrationClassRules( pairs: ReadonlyArray< { server: string; captured: string } > ): HydrationClassRule[] {
	const rules = new Map< string, HydrationClassRule >();
	const add = ( rule: HydrationClassRule ) => rules.set( JSON.stringify( rule ), rule );
	const captured = pairs.map( pair => identities( pair.captured ) );
	pairs.forEach( ( pair, index ) => {
		const after = captured[ index ]!;
		const afterIds = uniqueIds( after );
		const byPath = new Map< string, ElementIdentity[] >();
		for ( const node of after ) {
			const group = byPath.get( node.path );
			if ( group ) group.push( node );
			else byPath.set( node.path, [ node ] );
		}
		const before = identities( pair.server );
		const beforeIds = uniqueIds( before );
		for ( const node of before ) {
			// Unique-id pairing: the same element, whatever its classes became.
			const paired = node.id && beforeIds.get( node.id ) === node ? afterIds.get( node.id ) : undefined;
			for ( const token of node.classes ) {
				if ( paired ) {
					if ( paired.classes.has( token ) ) continue;
					add( { id: paired.id!, token } );
					for ( const stableClass of node.classes ) if ( paired.classes.has( stableClass ) ) add( { tag: node.tag, stableClass, token } );
					continue;
				}
				// Tag-path pairing: an element on the same path keeps every other class.
				const stable = [ ...node.classes ].filter( name => name !== token );
				if ( stable.length && ( byPath.get( node.path ) ?? [] ).some( other => ! other.classes.has( token ) && stable.every( name => other.classes.has( name ) ) ) ) {
					for ( const stableClass of stable ) add( { tag: node.tag, stableClass, token } );
				}
			}
		}
	} );
	return [ ...rules.values() ].filter( rule => ! captured.some( nodes => nodes.some( node => node.classes.has( rule.token ) && matches( rule, node ) ) ) );
}

/** Remove matching tokens by editing only the affected `class` attributes. */
export function applyHydrationClassRules( html: string, rules: readonly HydrationClassRule[] ): { html: string; removed: string[] } {
	if ( ! rules.length ) return { html, removed: [] };
	const $ = cheerio.load( html, { sourceCodeLocationInfo: true } );
	const edits: Array< { start: number; end: number; text: string } > = [];
	const removed = new Set< string >();
	for ( const element of $( '[class]' ).toArray() ) {
		if ( element.type !== 'tag' ) continue;
		const node = identity( element );
		const drop = new Set( rules.filter( rule => node.classes.has( rule.token ) && matches( rule, node ) ).map( rule => rule.token ) );
		const location = ( element.sourceCodeLocation as { attrs?: Record< string, { startOffset: number; endOffset: number } > } | null | undefined )?.attrs?.class;
		if ( ! drop.size || ! location ) continue;
		for ( const token of drop ) removed.add( token );
		const kept = [ ...node.classes ].filter( token => ! drop.has( token ) ).join( ' ' ).replace( /&/g, '&amp;' ).replace( /"/g, '&quot;' );
		edits.push( { start: location.startOffset, end: location.endOffset, text: `class="${ kept }"` } );
	}
	let result = html;
	for ( const edit of edits.sort( ( a, b ) => b.start - a.start ) ) result = result.slice( 0, edit.start ) + edit.text + result.slice( edit.end );
	return { html: result, removed: [ ...removed ] };
}

/** Top-level selectors that name a class and hide what they match. */
export function hidingSelectors( css: string ): string[] {
	let root: postcss.Root;
	try {
		root = postcss.parse( css );
	} catch {
		return [];
	}
	return root.nodes.flatMap( node => node.type === 'rule' && node.nodes.some( declaration => declaration.type === 'decl' && (
		( declaration.prop === 'opacity' && /^0(?:\.0*)?%?$/.test( declaration.value.trim() ) ) ||
		( declaration.prop === 'visibility' && declaration.value.trim() === 'hidden' ) ||
		( declaration.prop === 'display' && declaration.value.trim() === 'none' )
	) ) ? node.selectors.filter( selector => /\.-?[_a-zA-Z]/.test( selector ) ) : [] );
}

/** The hiding selector that matches the document's main content or one of its ancestors. */
export function hiddenMainContent( html: string, stylesheetSelectors: readonly string[] ): string | undefined {
	const $ = cheerio.load( html );
	const main = $( 'main, [role="main"]' ).first();
	if ( ! main.length ) return undefined;
	const inline = $( 'style' ).toArray().flatMap( style => hidingSelectors( $( style ).text() ) );
	const chain = main.add( main.parents() );
	return [ ...inline, ...stylesheetSelectors ].find( selector => {
		try {
			return chain.is( selector );
		} catch {
			return false;
		}
	} );
}
