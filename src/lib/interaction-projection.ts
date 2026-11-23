import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import type { CapturedComponent } from './screenshot/component-states.js';
import type { InteractionStatesReport } from './screenshot/interaction-capture.js';

/** Capture marks every serialized element with its node id; derivation keeps the representative's skeleton ids. */
const NODE_ID = 'data-blocks-engine-node-id';

/**
 * Fields that describe the capture run, not the page's behaviour. `htmlBytes`
 * counts the panel HTML with its per-document capture numbering, which the
 * comparison strips from `html` itself.
 */
const RUN_FIELDS = new Set( [ 'capturedAt', 'sourceUrl', 'coverage', 'reusedFrom', 'htmlBytes' ] );

/** Capture bookkeeping: per-document numbering and probe markers, not page markup. */
const CAPTURE_ATTRIBUTE = /^data-(?:blocks-engine-[\w-]+|lib-(?:visible-before|offscreen-pos|motion-reveal))$/;
const CAPTURE_ATTRIBUTE_MARKUP = / data-(?:blocks-engine-[\w-]+|lib-(?:visible-before|offscreen-pos|motion-reveal))="[^"]*"/g;

/** HTML attributes whose values are element ids. */
const ID_REFERENCE = /\b(?:id|for|aria-controls|aria-labelledby|aria-describedby|aria-owns)=\\"([^\\"]+)\\"/g;

function escapeRegExp( value: string ): string {
	return value.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
}

/** Rename whole-token occurrences of each key in one pass, so renames never chain. */
function renameTokens( json: string, renames: ReadonlyMap< string, string > ): string {
	if ( ! renames.size ) return json;
	const pattern = new RegExp( `(?<![\\w-])(?:${ [ ...renames.keys() ].map( escapeRegExp ).join( '|' ) })(?![\\w-])`, 'g' );
	return json.replace( pattern, token => renames.get( token ) ?? token );
}

function skeletonIds( html: string ): Map< string, string > {
	const $ = cheerio.load( html );
	const ids = new Map< string, string >();
	$( `[id][${ NODE_ID }]` ).each( ( _, element ) => {
		ids.set( $( element ).attr( NODE_ID )!, $( element ).attr( 'id' )! );
	} );
	return ids;
}

function elementChildren( node: AnyNode ): Element[] {
	return 'children' in node ? node.children.filter( ( child ): child is Element => child.type === 'tag' || child.type === 'script' || child.type === 'style' ) : [];
}

function pageAttributes( element: Element ): Record< string, string > {
	return Object.fromEntries( Object.entries( element.attribs ).filter( ( [ name ] ) => ! CAPTURE_ATTRIBUTE.test( name ) ) );
}

/** Element-child paths from `root`, in document order, with their elements. */
function elementPaths( root: Element, path: number[] = [] ): Array< [ number[], Element ] > {
	return [ [ path, root ], ...elementChildren( root ).flatMap( ( child, index ) => elementPaths( child, [ ...path, index ] ) ) ];
}

function atPath( root: Element, path: number[] ): Element | undefined {
	let node: Element | undefined = root;
	for ( const index of path ) node = node ? elementChildren( node )[ index ] : undefined;
	return node;
}

function byId( $: cheerio.CheerioAPI, id: string | undefined ): Element | undefined {
	return id ? $( '[id]' ).filter( ( _, node ) => $( node ).attr( 'id' ) === id ).get( 0 ) as Element | undefined : undefined;
}

/** The capture's positional address: `body > tag:nth-of-type(n) > …`. */
function positionalSelector( element: Element ): string {
	const steps: string[] = [];
	for ( let node = element; node.tagName !== 'body' && node.parent?.type === 'tag'; node = node.parent as Element ) {
		const index = elementChildren( node.parent ).filter( sibling => sibling.tagName === node.tagName ).indexOf( node ) + 1;
		steps.unshift( `${ node.tagName }:nth-of-type(${ index })` );
	}
	return [ 'body', ...steps ].join( ' > ' );
}

/** What makes two elements instances of one widget part. */
function shape( element: Element ): string {
	return [ element.tagName, element.attribs.class, element.attribs.role, element.attribs[ 'data-hook' ] ].join( '|' );
}

/**
 * One observed component state replayed on the member's own markup. The
 * state is serialized source elements (the trigger, then the panel it
 * controls); each is located in the representative's document, and the
 * attributes the state changed there are changed on the member's
 * corresponding element. The member keeps its own content, as its live page
 * would after the same interaction.
 */
function replayState( html: string, rep: cheerio.CheerioAPI, repRoot: Element, member: cheerio.CheerioAPI, memberRoot: Element ): string | undefined {
	const state = cheerio.load( html, null, false );
	const replayed: string[] = [];
	for ( const [ index, observed ] of elementChildren( state.root()[ 0 ]! ).entries() ) {
		const controlled = index > 0 && observed.attribs.id !== undefined && observed.attribs.id === repRoot.attribs[ 'aria-controls' ];
		const source = index === 0 ? repRoot : byId( rep, observed.attribs.id );
		const node = source?.attribs[ NODE_ID ];
		const target = index === 0 ? memberRoot : controlled ? byId( member, memberRoot.attribs[ 'aria-controls' ] ) : node ? member( `[${ NODE_ID }="${ node }"]` ).get( 0 ) as Element | undefined : undefined;
		if ( ! source || ! target ) return undefined;
		const clone = cheerio.load( member.html( target ), null, false );
		const cloneRoot = elementChildren( clone.root()[ 0 ]! )[ 0 ]!;
		for ( const [ path, before ] of elementPaths( source ) ) {
			const after = atPath( observed, path );
			if ( ! after || after.tagName !== before.tagName ) return undefined;
			const from = pageAttributes( before );
			const to = pageAttributes( after );
			if ( JSON.stringify( from ) === JSON.stringify( to ) ) continue;
			const element = atPath( cloneRoot, path );
			if ( ! element || element.tagName !== before.tagName ) return undefined;
			for ( const name of Object.keys( from ) ) if ( ! ( name in to ) ) delete element.attribs[ name ];
			for ( const [ name, value ] of Object.entries( to ) ) if ( from[ name ] !== value ) element.attribs[ name ] = value;
		}
		replayed.push( clone.html() );
	}
	return replayed.join( '' );
}

/**
 * Replayed states carry the member's markup only: the probe evidence a state
 * was observed with describes the representative's control, and export reads
 * it solely to keep gallery carousels, which do not replay.
 */
function replayComponent( component: CapturedComponent, rep: cheerio.CheerioAPI, repRoot: Element, member: cheerio.CheerioAPI, memberRoot: Element, selector: string ): CapturedComponent | undefined {
	if ( component.states.some( state => state.evidence?.gallery ) ) return undefined;
	const states = component.states.map( state => state.html ? replayState( state.html, rep, repRoot, member, memberRoot ) : state.html );
	if ( states.some( html => html === undefined ) ) return undefined;
	const readdressed = selector === component.selector ? component : JSON.parse( renameTokens( JSON.stringify( component ), new Map( [ [ component.selector, selector ] ] ) ) ) as CapturedComponent;
	return { ...readdressed, states: component.states.map( ( state, index ) => ( { id: state.id, html: states[ index ]! } ) ) };
}

/** An element and the region it controls, without capture bookkeeping. */
function pageMarkup( $: cheerio.CheerioAPI, root: Element ): string {
	return [ root, byId( $, root.attribs[ 'aria-controls' ] ) ].map( element => element ? $.html( element ).replace( CAPTURE_ATTRIBUTE_MARKUP, '' ) : '' ).join( '' );
}

/**
 * The representative's components as they hold on the member. A component
 * the member shares verbatim keeps the representative's evidence; one whose
 * markup the member changed replays its states on the member's markup. A
 * component inside the member's own content (an FAQ accordion in a post
 * body) is one instance of a widget the member may repeat a different number
 * of times: every member instance of the same widget part replays the
 * representative's corresponding instance, addressed where it sits in the
 * member's document.
 */
function projectComponents( components: readonly CapturedComponent[], rep: cheerio.CheerioAPI, member: cheerio.CheerioAPI ): CapturedComponent[] {
	const projected: CapturedComponent[] = [];
	const widgets = new Map< string, Array< { component: CapturedComponent; root: Element } > >();
	for ( const component of components ) {
		let root: Element | undefined;
		try {
			root = component.status === 'captured' ? rep( component.selector ).get( 0 ) as Element | undefined : undefined;
		} catch {
			root = undefined;
		}
		if ( ! root ) {
			projected.push( component );
			continue;
		}
		const node = root.attribs[ NODE_ID ];
		const memberRoot = node ? member( `[${ NODE_ID }="${ node }"]` ).get( 0 ) as Element | undefined : undefined;
		if ( memberRoot ) {
			const kept = pageMarkup( rep, root ) === pageMarkup( member, memberRoot ) ? component : replayComponent( component, rep, root, member, memberRoot, component.selector );
			if ( kept ) projected.push( kept );
			continue;
		}
		if ( positionalSelector( root ) !== component.selector ) continue;
		const key = `${ component.kind } ${ shape( root ) }`;
		widgets.set( key, [ ...( widgets.get( key ) ?? [] ), { component, root } ] );
	}
	for ( const instances of widgets.values() ) {
		// The nearest skeleton ancestor bounds where the member's instances are.
		const anchor = rep( instances[ 0 ]!.root ).parents( `[${ NODE_ID }]` ).toArray().map( node => member( `[${ NODE_ID }="${ ( node as Element ).attribs[ NODE_ID ] }"]` ).get( 0 ) ).find( Boolean );
		if ( ! anchor ) continue;
		const key = shape( instances[ 0 ]!.root );
		member( anchor ).find( '*' ).toArray().filter( element => shape( element as Element ) === key ).forEach( ( element, index ) => {
			const { component, root } = instances[ Math.min( index, instances.length - 1 ) ]!;
			const replayed = replayComponent( component, rep, root, member, element as Element, positionalSelector( element as Element ) );
			if ( replayed ) projected.push( replayed );
		} );
	}
	return projected;
}

/**
 * The representative's interaction report as it holds on a document derived
 * from it. Derivation keeps the representative's skeleton nodes; where one
 * now carries the member's own id (a per-post control id), every reference to
 * the representative's id in the report names the member's id instead, and
 * components inside member markup replay their states on it.
 */
export function projectInteractionReport( repHtml: string, derivedHtml: string, report: InteractionStatesReport | undefined ): InteractionStatesReport | undefined {
	if ( ! report ) return undefined;
	const derived = skeletonIds( derivedHtml );
	const renames = new Map< string, string >();
	for ( const [ node, id ] of skeletonIds( repHtml ) ) {
		const memberId = derived.get( node );
		if ( memberId !== undefined && memberId !== id ) renames.set( id, memberId );
	}
	const projected = renames.size ? JSON.parse( renameTokens( JSON.stringify( report ), renames ) ) as InteractionStatesReport : report;
	if ( ! projected.components?.length ) return projected;
	const rep = cheerio.load( repHtml );
	const member = cheerio.load( derivedHtml );
	return { ...projected, components: projectComponents( projected.components, rep, member ) };
}

/**
 * One evidence item as export reads it. Ids referenced from serialized HTML
 * are numbered by first appearance: runtimes mint fresh ones on every load
 * (`collapsible-list-body-…`), and only which elements refer to each other
 * is behaviour.
 */
function canonical( item: unknown ): string {
	const json = JSON.stringify( item, ( key, value ) => {
		if ( RUN_FIELDS.has( key ) ) return undefined;
		return typeof value === 'string' ? value.replace( CAPTURE_ATTRIBUTE_MARKUP, '' ) : value;
	} );
	const refs = new Map< string, string >();
	for ( const [ , value ] of json.matchAll( ID_REFERENCE ) ) {
		for ( const id of value!.split( /\s+/ ) ) if ( id && ! refs.has( id ) ) refs.set( id, `ref-${ refs.size }` );
	}
	return renameTokens( json, refs );
}

function describe( item: string ): string {
	const parsed = JSON.parse( item ) as { kind?: string; selector?: string; trigger?: { label?: string; selector?: string } };
	return parsed.trigger?.label || parsed.trigger?.selector || `${ parsed.kind ?? 'item' } ${ parsed.selector ?? '' }`.trim();
}

/**
 * Why a projected report differs from the member's own capture, comparing the
 * evidence export replays: captured states, captured components' states and
 * transitions, initially open dialogs and route navigation. Undefined when
 * they agree.
 */
export function interactionReportMismatch( projected: InteractionStatesReport | undefined, captured: InteractionStatesReport | undefined ): string | undefined {
	const evidence = ( report: InteractionStatesReport | undefined ): Record< string, string[] > => ( {
		states: ( report?.states ?? [] ).filter( state => state.status === 'captured' ).map( canonical ).sort(),
		components: ( report?.components ?? [] ).filter( component => component.status === 'captured' ).map( component => canonical( { ...component, states: component.states.map( state => ( { id: state.id, html: state.html } ) ) } ) ).sort(),
		'initial dialogs': ( report?.initialDialogs ?? [] ).map( canonical ).sort(),
		'route navigation': ( report?.routeNavigation ?? [] ).map( canonical ).sort(),
	} );
	const expected = evidence( projected );
	const actual = evidence( captured );
	for ( const [ kind, items ] of Object.entries( expected ) ) {
		const capturedItems = actual[ kind ]!;
		const projectedOnly = items.filter( item => ! capturedItems.includes( item ) );
		const capturedOnly = capturedItems.filter( item => ! items.includes( item ) );
		if ( ! projectedOnly.length && ! capturedOnly.length && items.length === capturedItems.length ) continue;
		const named = capturedOnly.length ? `captured-only "${ describe( capturedOnly[ 0 ]! ) }"` : projectedOnly.length ? `projected-only "${ describe( projectedOnly[ 0 ]! ) }"` : 'duplicate items';
		return `${ kind }: ${ items.length } projected, ${ capturedItems.length } captured (${ named })`;
	}
	return undefined;
}
