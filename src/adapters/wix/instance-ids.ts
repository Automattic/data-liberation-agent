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
 */
const INSTANCE_REFERENCE = /\b(comp-[a-z0-9]+)_r_(comp-[a-z0-9]+)/gi;

export function canonicalizeWixInstanceIds( html: string ): string {
	const componentsByInstance = new Map< string, Set< string > >();
	for ( const [ , instance, component ] of html.matchAll( INSTANCE_REFERENCE ) ) {
		const components = componentsByInstance.get( instance! ) ?? new Set< string >();
		components.add( component!.toLowerCase() );
		componentsByInstance.set( instance!, components );
	}
	if ( componentsByInstance.size === 0 ) return html;

	const tokenByInstance = new Map< string, string >();
	const instancesByToken = new Map< string, string[] >();
	for ( const [ instance, components ] of componentsByInstance ) {
		const token = `comp-dla${ fnv1a( [ ...components ].sort().join( ' ' ) ) }`;
		tokenByInstance.set( instance, token );
		instancesByToken.set( token, [ ...( instancesByToken.get( token ) ?? [] ), instance ] );
	}
	// Two instances scoping the same components on one page would collapse into
	// one token and merge rules meant for different elements. Keep such a page
	// exactly as captured rather than guess.
	for ( const instances of instancesByToken.values() ) if ( instances.length > 1 ) return html;

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
