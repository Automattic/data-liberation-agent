import * as cheerio from 'cheerio';

/**
 * Wix repeats every repeater/section component under a page-specific instance
 * prefix — `<page instance>_r_<component>` — in element ids, class names and the
 * page's own stylesheet selectors. The same header therefore serializes with a
 * different prefix on every route (`comp-mmrdjhyq_r_comp-mb7ogqqn` on one page,
 * `comp-mmrdivkt_r_comp-mb7ogqqn` on the next), so identical chrome can never be
 * recognized as shared.
 *
 * The prefix carries no meaning in a static copy: it only namespaces runtime
 * instances. Replace each prefix with a stable token derived from the set of
 * components it scopes, applied uniformly to markup and `<style>` selectors so
 * every rule still reaches the element it styled. Two routes whose instance
 * scopes the same components get the same token; distinct scopes on one page
 * stay distinct.
 *
 * Markup captured from a page, such as an opened dialog, takes the names of
 * its `document`: a fragment holds only some of an instance's components, and
 * named on its own it would no longer match the page CSS that styles it.
 *
 * An instance already named by this canonicalization keeps its name. Export
 * applies the hook before splitting shared inline styles into linked files;
 * subsequent calls must preserve names already used by external rules.
 */

// A hyphen is a boundary too: Wix derives ids such as img-comp-X_r_comp-Y.
const INSTANCE_REFERENCE = /(?<![a-z0-9])(comp-[a-z0-9]+)_r_(comp-[a-z0-9]+)/gi;
const CANONICAL_INSTANCE = /^comp-dla[0-9a-f]{8}$/i;

export function canonicalizeWixInstanceIds( html: string, document: string = html ): string {
	const page = documentInstances( document );
	const tokenByInstance = new Map( page.tokens );
	if ( document !== html ) {
		for ( const [ instance, token ] of instanceTokens( html ) ) if ( ! tokenByInstance.has( instance ) ) tokenByInstance.set( instance, token );
	}
	if ( tokenByInstance.size === 0 ) return html;
	// Two instances scoping the same components on one page would collapse into
	// one token and merge rules meant for different elements. Keep such a page
	// exactly as captured rather than guess.
	if ( new Set( tokenByInstance.values() ).size !== tokenByInstance.size ) return html;
	const named = document === html ? page.named : new Set( [ ...page.named, ...namedInstances( html ) ] );
	if ( [ ...tokenByInstance.values() ].some( token => named.has( token ) ) ) return html;

	// The instance element carries the bare instance id too (`id="<instance>"`,
	// `<instance>-container`), and the page stylesheet targets it, so every
	// whole-token occurrence (including Wix's img-, portal- and bgMedia_ derived ids and their
	// selectors/references) is rewritten, not only the
	// `_r_` references. A longer id that merely starts with it is left alone.
	const instancePattern = new RegExp(
		`(?<![a-z0-9])(${ [ ...tokenByInstance.keys() ].map( escapeRegExp ).join( '|' ) })(?![a-z0-9])`,
		'gi'
	);
	return html.replace( instancePattern, ( match ) => tokenByInstance.get( match ) ?? match );
}

/**
 * Captured fragments are canonicalized against their page document, once per
 * string in an interaction report: thousands of calls in a row with the same
 * multi-megabyte document. Derive each document's names once, not per call.
 */
function lastResult< T >( derive: ( text: string ) => T ): ( text: string ) => T {
	let last: { text: string; value: T } | undefined;
	return text => {
		if ( last?.text !== text ) last = { text, value: derive( text ) };
		return last.value;
	};
}

const documentInstances = lastResult( document => ( { tokens: instanceTokens( document ), named: namedInstances( document ) } ) );
const canonicalDocument = lastResult( document => canonicalizeWixInstanceIds( document ) );
const documentFormControlTokens = lastResult( formControlTokens );

function namedInstances( html: string ): Set< string > {
	return new Set( [ ...html.matchAll( INSTANCE_REFERENCE ) ].map( ( [ , instance ] ) => instance!.toLowerCase() ).filter( instance => CANONICAL_INSTANCE.test( instance ) ) );
}

function instanceTokens( html: string ): Map< string, string > {
	const componentsByInstance = new Map< string, Set< string > >();
	// Styles may contain dead selectors, and may already be linked on another
	// route. Only rendered markup defines the scope's identity.
	const $ = cheerio.load( html );
	const references = $( '[id], [class]' ).toArray().map( element =>
		`${ $( element ).attr( 'id' ) ?? '' } ${ $( element ).attr( 'class' ) ?? '' }`
	).join( ' ' );
	for ( const [ , instance, component ] of references.matchAll( INSTANCE_REFERENCE ) ) {
		if ( CANONICAL_INSTANCE.test( instance! ) ) continue;
		const components = componentsByInstance.get( instance! ) ?? new Set< string >();
		components.add( component!.toLowerCase() );
		componentsByInstance.set( instance!, components );
	}
	return new Map( [ ...componentsByInstance ].map( ( [ instance, components ] ) => [ instance, `comp-dla${ fnv1a( [ ...components ].sort().join( ' ' ) ) }` ] ) );
}

/**
 * Wix form controls take ids from a render-order counter (`checkbox-23` on one
 * route, `checkbox-5` on the next, `checkbox-17` in the same route's phone
 * capture), so the same consent checkbox never matches itself across pages or
 * viewports. Its identity is the form field it belongs to: rename each counter
 * id after the nearest enclosing field hook and its position within that field,
 * and rewrite every whole-token reference to it. A fragment takes the names
 * of its `document`, which holds the fields.
 */
const FORM_CONTROL_COUNTER = /(?<![a-z0-9_-])(checkbox-\d+)(?![a-z0-9_-])/gi;
const FORM_CONTROL_ID = /\sid=(["'])(checkbox-\d+)\1/gi;
const FORM_FIELD_HOOK = /data-hook=(["'])(form-field-[^"']+)\1/gi;

export function canonicalizeWixFormControlIds( html: string, document: string = html ): string {
	const documentTokens = documentFormControlTokens( document );
	if ( ! documentTokens ) return html;
	const tokenById = new Map( documentTokens );
	if ( document !== html ) {
		const own = formControlTokens( html );
		for ( const [ id, token ] of own ?? [] ) if ( ! tokenById.has( id ) ) tokenById.set( id, token );
	}
	if ( tokenById.size === 0 ) return html;
	if ( new Set( tokenById.values() ).size !== tokenById.size ) return html;
	return html.replace( FORM_CONTROL_COUNTER, ( match ) => tokenById.get( match ) ?? match );
}

/** Counter id → field-derived token, or undefined when a control cannot be named. */
function formControlTokens( html: string ): Map< string, string > | undefined {
	const fields: Array< { offset: number; hook: string } > = [];
	for ( const match of html.matchAll( FORM_FIELD_HOOK ) ) fields.push( { offset: match.index ?? 0, hook: match[ 2 ]! } );
	const tokenById = new Map< string, string >();
	const slots = new Map< string, number >();
	for ( const match of html.matchAll( FORM_CONTROL_ID ) ) {
		const id = match[ 2 ]!;
		if ( tokenById.has( id ) ) return undefined;
		const offset = match.index ?? 0;
		let hook = '';
		for ( const field of fields ) if ( field.offset < offset ) hook = field.hook;
		// A control outside any field has nothing stable to be named after.
		if ( hook === '' ) return undefined;
		const slot = ( slots.get( hook ) ?? 0 ) + 1;
		slots.set( hook, slot );
		tokenById.set( id, `checkbox-dla${ fnv1a( `${ hook }\0${ slot }` ) }` );
	}
	return tokenById;
}

/** Every Wix runtime-id canonicalization a captured document, or markup captured from it, needs. */
export function canonicalizeWixCapturedHtml( html: string, document: string = html ): string {
	return canonicalizeWixFormControlIds( canonicalizeWixInstanceIds( html, document ), canonicalDocument( document ) );
}

function escapeRegExp( text: string ): string {
	return text.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
}

/** 32-bit FNV-1a, hex. Stable across runs and platforms; collisions are guarded above. */
function fnv1a( text: string ): string {
	let hash = 0x811c9dc5;
	for ( let index = 0; index < text.length; index++ ) {
		hash ^= text.charCodeAt( index );
		hash = Math.imul( hash, 0x01000193 ) >>> 0;
	}
	return hash.toString( 16 ).padStart( 8, '0' );
}
