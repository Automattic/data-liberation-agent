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
 */
const INSTANCE_REFERENCE = /\b(comp-[a-z0-9]+)_r_(comp-[a-z0-9]+)/gi;

export function canonicalizeWixInstanceIds( html: string, document: string = html ): string {
	const tokenByInstance = new Map( instanceTokens( document ) );
	if ( document !== html ) {
		for ( const [ instance, token ] of instanceTokens( html ) ) if ( ! tokenByInstance.has( instance ) ) tokenByInstance.set( instance, token );
	}
	if ( tokenByInstance.size === 0 ) return html;
	// Two instances scoping the same components on one page would collapse into
	// one token and merge rules meant for different elements. Keep such a page
	// exactly as captured rather than guess.
	if ( new Set( tokenByInstance.values() ).size !== tokenByInstance.size ) return html;

	// The instance element carries the bare instance id too (`id="<instance>"`,
	// `<instance>-container`), and the page stylesheet targets it, so every
	// whole-token occurrence of an instance id is rewritten, not only the
	// `_r_` references. A longer id that merely starts with it is left alone.
	const instancePattern = new RegExp(
		`(?<![a-z0-9_-])(${ [ ...tokenByInstance.keys() ].map( escapeRegExp ).join( '|' ) })(?![a-z0-9])`,
		'gi'
	);
	return html.replace( instancePattern, ( match ) => tokenByInstance.get( match ) ?? match );
}

function instanceTokens( html: string ): Map< string, string > {
	const componentsByInstance = new Map< string, Set< string > >();
	for ( const [ , instance, component ] of html.matchAll( INSTANCE_REFERENCE ) ) {
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
	const tokenById = formControlTokens( document );
	if ( ! tokenById ) return html;
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
	return canonicalizeWixFormControlIds( canonicalizeWixInstanceIds( html, document ), canonicalizeWixInstanceIds( document ) );
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
