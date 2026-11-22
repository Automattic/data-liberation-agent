import postcss, { type ChildNode, type Container } from 'postcss';

/**
 * A site served from a rolling deploy can hand one route's two device
 * documents different builds of the same component stylesheet: the class
 * names differ (a content hash, a renamed modifier) while every rule they
 * select is the same rule. Kept as they are, the documents disagree on class
 * tokens no rendering depends on, and the responsive collapse projects
 * per-device class swaps onto that route alone.
 *
 * The renames are proven, not inferred from a naming scheme: each phone-only
 * token is paired with the desktop-only token whose rules are its rules
 * (other paired tokens standing in for each other), and the pairing stands
 * only when renaming makes the phone document's rules for every paired token
 * exactly the desktop document's rules for their counterparts. A token no rule
 * selects pairs only by its position in a class list the proven renames
 * already make identical.
 */
export function buildEquivalentClassRenames( desktopHtml: string, mobileHtml: string ): Map< string, string > {
	const desktopLists = classLists( desktopHtml );
	const mobileLists = classLists( mobileHtml );
	// A token only a stylesheet names (a state the capture did not render) is
	// renamed with its build too.
	const desktopTokens = new Set( [ ...desktopLists.flat(), ...styleClassTokens( desktopHtml ) ] );
	const mobileTokens = new Set( [ ...mobileLists.flat(), ...styleClassTokens( mobileHtml ) ] );
	const desktopOnly = new Set( [ ...desktopTokens ].filter( token => ! mobileTokens.has( token ) ) );
	const mobileOnly = new Set( [ ...mobileTokens ].filter( token => ! desktopTokens.has( token ) ) );
	if ( ! desktopOnly.size || ! mobileOnly.size ) return new Map();
	const desktopRules = rulesSelecting( desktopHtml, desktopOnly );
	const mobileRules = rulesSelecting( mobileHtml, mobileOnly );
	if ( ! desktopRules || ! mobileRules ) return new Map();

	const fingerprint = ( token: string, rules: ReadonlyMap< string, string[] >, candidates: ReadonlySet< string > ) =>
		JSON.stringify( ( rules.get( token ) ?? [] ).map( rule => renameTokens( rule, name => name === token ? '\u00a7' : candidates.has( name ) ? '\u00a4' : name ) ).sort() );
	const byFingerprint = new Map< string, string[] >();
	for ( const token of desktopOnly ) {
		if ( ! desktopRules.get( token )?.length ) continue;
		const key = fingerprint( token, desktopRules, desktopOnly );
		byFingerprint.set( key, [ ...( byFingerprint.get( key ) ?? [] ), token ] );
	}
	const renames = new Map< string, string >();
	const claimed = new Map< string, number >();
	for ( const token of mobileOnly ) {
		if ( ! mobileRules.get( token )?.length ) continue;
		const matches = byFingerprint.get( fingerprint( token, mobileRules, mobileOnly ) );
		if ( matches?.length !== 1 ) continue;
		renames.set( token, matches[ 0 ]! );
		claimed.set( matches[ 0 ]!, ( claimed.get( matches[ 0 ]! ) ?? 0 ) + 1 );
	}
	// Two phone tokens claiming one desktop token are not a rename.
	for ( const [ token, target ] of renames ) if ( claimed.get( target )! > 1 ) renames.delete( token );
	if ( ! renames.size ) return renames;
	// The proof, per stylesheet (tokens joined by sharing a rule): the renamed
	// phone rules for its paired tokens are exactly the desktop rules for their
	// counterparts. A stylesheet whose rules changed between builds keeps its
	// names.
	const group = new Map< string, string >();
	const find = ( token: string ): string => {
		const parent = group.get( token ) ?? token;
		if ( parent === token ) return token;
		const root = find( parent );
		group.set( token, root );
		return root;
	};
	for ( const rules of mobileRules.values() ) {
		for ( const rule of rules ) {
			const named = [ ...rule.matchAll( CLASS_SELECTOR ) ].map( match => match[ 1 ]! ).filter( name => renames.has( name ) );
			for ( const name of named.slice( 1 ) ) group.set( find( name ), find( named[ 0 ]! ) );
		}
	}
	const groups = new Map< string, string[] >();
	for ( const token of renames.keys() ) groups.set( find( token ), [ ...( groups.get( find( token ) ) ?? [] ), token ] );
	const ruleSet = ( rules: ReadonlyMap< string, string[] >, tokens: readonly string[], rename: ( name: string ) => string ) =>
		JSON.stringify( [ ...new Set( tokens.flatMap( token => rules.get( token ) ?? [] ).map( rule => renameTokens( rule, rename ) ) ) ].sort() );
	const markup = new Set( mobileLists.flat() );
	const proven = new Map< string, string >();
	for ( const tokens of groups.values() ) {
		// Equal rules alone do not make two names one class; the group must
		// style an element the phone document renders.
		if ( ! tokens.some( token => markup.has( token ) ) ) continue;
		if ( ruleSet( mobileRules, tokens, name => renames.get( name ) ?? name ) !== ruleSet( desktopRules, tokens.map( token => renames.get( token )! ), name => name ) ) continue;
		for ( const token of tokens ) proven.set( token, renames.get( token )! );
	}
	if ( ! proven.size ) return proven;

	// A rule-free token sits beside proven ones: aligned with a desktop class
	// list the proven renames make equal at every other position.
	const ruleless = ( token: string, rules: ReadonlyMap< string, string[] > ) => ! rules.get( token )?.length;
	const desktopKeys = new Map< string, string[][] >();
	for ( const list of desktopLists ) {
		const key = String( list.length );
		desktopKeys.set( key, [ ...( desktopKeys.get( key ) ?? [] ), list ] );
	}
	const positional = new Map< string, Set< string > >();
	for ( const list of mobileLists ) {
		const renamed = list.map( token => proven.get( token ) ?? token );
		if ( ! list.some( token => proven.has( token ) ) ) continue;
		const open = renamed.flatMap( ( token, index ) => mobileOnly.has( token ) && ruleless( token, mobileRules ) ? [ index ] : [] );
		if ( ! open.length ) continue;
		for ( const candidate of desktopKeys.get( String( list.length ) ) ?? [] ) {
			const aligned = candidate.every( ( token, index ) => open.includes( index )
				? desktopOnly.has( token ) && ruleless( token, desktopRules )
				: token === renamed[ index ] );
			if ( ! aligned ) continue;
			for ( const index of open ) positional.set( renamed[ index ]!, new Set( [ ...( positional.get( renamed[ index ]! ) ?? [] ), candidate[ index ]! ] ) );
		}
	}
	const targets = new Set( proven.values() );
	for ( const [ token, candidates ] of positional ) {
		const [ target ] = [ ...candidates ];
		if ( candidates.size === 1 && ! targets.has( target! ) ) {
			proven.set( token, target! );
			targets.add( target! );
		}
	}

	return proven;
}

/** Rename class tokens in class attributes and in style-block selectors. */
export function renameClassTokensInDocument( html: string, renames: ReadonlyMap< string, string > ): string {
	if ( ! renames.size ) return html;
	const rename = ( name: string ) => renames.get( name ) ?? name;
	return html
		.replace( /(\sclass\s*=\s*)(["'])([^"']*)\2/gi, ( _match, prefix: string, quote: string, value: string ) =>
			`${ prefix }${ quote }${ value.split( /(\s+)/ ).map( part => /^\s*$/.test( part ) ? part : rename( part ) ).join( '' ) }${ quote }` )
		.replace( /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, ( _match, open: string, css: string, close: string ) => `${ open }${ renameTokens( css, rename ) }${ close }` );
}

const CLASS_SELECTOR = /\.(-?[_a-zA-Z][\w-]*)/g;

function renameTokens( css: string, rename: ( name: string ) => string ): string {
	return css.replace( CLASS_SELECTOR, ( match, name: string ) => {
		const renamed = rename( name );
		return renamed === name ? match : `.${ renamed }`;
	} );
}

function styleClassTokens( html: string ): string[] {
	return [ ...html.matchAll( /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi ) ].flatMap( match =>
		[ ...match[ 1 ]!.replace( /\{[^{}]*\}/g, '{}' ).matchAll( CLASS_SELECTOR ) ].map( found => found[ 1 ]! ) );
}

function classLists( html: string ): string[][] {
	return [ ...html.matchAll( /\sclass\s*=\s*(["'])([^"']*)\1/gi ) ].map( match => match[ 2 ]!.split( /\s+/ ).filter( Boolean ) );
}

/**
 * Every style rule whose selector names one of the tokens, keyed by token and
 * serialized with its enclosing at-rule preludes. Undefined when a stylesheet
 * cannot be parsed, so nothing is renamed on partial evidence.
 */
function rulesSelecting( html: string, tokens: ReadonlySet< string > ): Map< string, string[] > | undefined {
	const rules = new Map< string, string[] >();
	const visit = ( container: Container< ChildNode >, context: string ) => {
		container.each( node => {
			if ( node.type === 'rule' ) {
				const named = [ ...node.selector.matchAll( CLASS_SELECTOR ) ].map( match => match[ 1 ]! ).filter( name => tokens.has( name ) );
				if ( ! named.length ) return;
				const text = `${ context }${ node.selector.replace( /\s+/g, ' ' ).trim() }{${ node.nodes.map( child => child.toString().trim() ).join( ';' ) }}`;
				for ( const name of new Set( named ) ) rules.set( name, [ ...( rules.get( name ) ?? [] ), text ] );
			} else if ( node.type === 'atrule' && node.nodes ) {
				visit( node, `${ context }@${ node.name } ${ node.params.replace( /\s+/g, ' ' ).trim() }{` );
			}
		} );
	};
	try {
		for ( const match of html.matchAll( /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi ) ) visit( postcss.parse( match[ 1 ]! ), '' );
	} catch {
		return undefined;
	}
	return rules;
}
