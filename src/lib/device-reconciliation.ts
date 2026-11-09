import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { mergeViewportEntranceStates, VIEWPORT_ENTRANCE_ATTRIBUTE } from './viewport-entrances.js';
import { identitySubsetMerge } from './responsive-assembly.js';
import type { DeviceDocumentSelection } from './document-selection.js';
import { RESPONSIVE_DESKTOP_ONLY_CLASS, RESPONSIVE_MOBILE_ONLY_CLASS } from './viewport-correspondence.js';

const NODE = 'data-blocks-engine-capture-reconcile-node';
const ONLY = 'data-blocks-engine-capture-device-only';
const HIDE = 'data-blocks-engine-capture-device-hide';
const INLINE = 'data-blocks-engine-capture-device-inline';

export interface DeviceReconciliationEvidence {
	outcome: 'collapsed-identity-subset' | 'dual-structural';
	reason: string;
	devices: Record<string, { outcome: 'collapsed-identity-subset' | 'dual-structural'; reason?: string; matchedNodes?: number; desktopOnlyElements?: number; mobileOnlyElements?: number; projectedElements?: number; divergedComponents?: number }>;
}

/** Reads a linked stylesheet's captured text by its href; undefined when it was not captured. */
export type LinkedStylesheetReader = ( href: string ) => string | undefined;

/**
 * Whether linked stylesheets can address a device copy of a divergent
 * component. Linked sheets stay references, so the ids the copy is renamed
 * to cannot be added to their selectors. The copy keeps the source cascade
 * only when every linked sheet was captured and none selects a renamed id.
 */
function linkedStylesheetsSelectRenamedIds( html: string, renamed: ReadonlySet<string>, read: LinkedStylesheetReader | undefined ): boolean {
	const $ = cheerio.load( html );
	return $( 'link[rel~="stylesheet"]' ).toArray().some( link => {
		const css = read?.( $( link ).attr( 'href' ) ?? '' );
		if ( css === undefined ) return true;
		let selects = false;
		try {
			postcss.parse( css ).walk( node => {
				if ( node.type === 'atrule' && node.name.toLowerCase() === 'import' ) selects = true;
				if ( node.type !== 'rule' ) return;
				selectorParser( selectors => {
					selectors.walkIds( id => { if ( renamed.has( id.value ) ) selects = true; } );
					// Only an exact id match is proven not to reach the renamed copy.
					selectors.walkAttributes( attribute => {
						if ( attribute.attribute.toLowerCase() === 'id' && ( attribute.operator !== '=' || renamed.has( attribute.value ?? '' ) ) ) selects = true;
					} );
				} ).processSync( node.selector );
			} );
		} catch {
			return true;
		}
		return selects;
	} );
}

const ANCHOR_MARKER = '[data-blocks-engine-capture-anchor-target][data-blocks-engine-capture-anchor-source-id]';
export const RESPONSIVE_FRAGMENT = 'data-blocks-engine-capture-responsive-fragment';

/**
 * Anchor markers the capture inserted where a device's runtime scroll landed,
 * keyed by fragment. They are capture evidence, not source components: each
 * device can land a fragment in a different section.
 */
function anchorMarkers( $: cheerio.CheerioAPI ): Map<string, { node: Element; section: string }> {
	const markers = new Map<string, { node: Element; section: string }>();
	$( ANCHOR_MARKER ).each( ( _i, node ) => {
		const fragment = $( node ).attr( 'data-blocks-engine-capture-anchor-target' )!;
		if ( $( node ).attr( 'id' ) === fragment ) markers.set( fragment, { node, section: $( node ).attr( 'data-blocks-engine-capture-anchor-source-id' )! } );
	} );
	return markers;
}

/** Every pairing starts from the unmodified default, never from another
 * device's union. Absence in one pair must not erase another device's nodes.
 */
export function reconcileDeviceDocuments( documents: Record<string, string>, selection: DeviceDocumentSelection, readLinkedStylesheet?: LinkedStylesheetReader ) {
	const base = cheerio.load( documents[ selection.defaultDocument ] );
	base( 'body *' ).each( ( index, node ) => { base( node ).attr( NODE, String( index ) ); } );
	const original = base.html();
	const merged = cheerio.load( original );
	const reconciled = new Set<string>();
	const devices: DeviceReconciliationEvidence['devices'] = {};
	for ( const key of selection.documents ) {
		if ( key === selection.defaultDocument || ! documents[ key ] ) continue;
		let reason = 'Device body is unavailable';
		// A marker the device landed in another section would read as a
		// re-nested component. Pair without it and place it per device below.
		const device = cheerio.load( documents[ key ] );
		const defaultMarkers = anchorMarkers( base );
		const relocated = [ ...anchorMarkers( device ) ].filter( ( [ fragment, marker ] ) => {
			const section = defaultMarkers.get( fragment )?.section;
			return section !== undefined && section !== marker.section;
		} );
		for ( const [ , marker ] of relocated ) device( marker.node ).remove();
		const pair = identitySubsetMerge( original, relocated.length ? device.html() : documents[ key ], undefined, key, failure => { reason = failure; }, selection.defaultDocument );
		if ( ! pair ) {
			devices[ key ] = { outcome: 'dual-structural', reason };
			continue;
		}
		const suffix = `--data-blocks-engine-capture-${ key }`;
		const renamed = new Set( cheerio.load( `<body>${ pair.body }</body>` )( `[id$="${ suffix }"]` ).toArray().map( node => node.attribs.id.slice( 0, -suffix.length ) ) );
		if ( pair.divergedComponents && [ documents[ selection.defaultDocument ], documents[ key ] ].some( html => linkedStylesheetsSelectRenamedIds( html, renamed, readLinkedStylesheet ) ) ) {
			devices[ key ] = { outcome: 'dual-structural', reason: 'Divergent component ids require rewriting a linked stylesheet; native selector cascade retained as a separate document' };
			continue;
		}
		const $ = cheerio.load( `<body>${ pair.body }</body>` );
		const entrances = new Map<string, string>();
		let incompatibleEntrance = false;
		$( `[${ NODE }]` ).filter( ( _i, node ) => $( node ).closest( `.${ RESPONSIVE_MOBILE_ONLY_CLASS }` ).length === 0 ).each( ( _i, node ) => {
			const source = $( node );
			const id = source.attr( NODE )!;
			const target = merged( `[${ NODE }="${ id }"]` );
			const left = target.attr( VIEWPORT_ENTRANCE_ATTRIBUTE ), right = source.attr( VIEWPORT_ENTRANCE_ATTRIBUTE );
			if ( left === undefined && right === undefined ) return;
			const scope = { left: [ selection.defaultDocument, ...reconciled ], right: [ selection.defaultDocument, key ], all: selection.documents };
			const state = mergeViewportEntranceStates( left, right, scope );
			if ( state === undefined ) incompatibleEntrance = true;
			else entrances.set( id, state );
		} );
		if ( incompatibleEntrance ) {
			devices[ key ] = { outcome: 'dual-structural', reason: 'Viewport entrance evidence conflicts with an already reconciled device' };
			continue;
		}
		const landing = ( section: string ) => merged( `[${ NODE }]` ).filter( ( _i, node ) => merged( node ).attr( 'id' ) === section );
		if ( relocated.some( ( [ , marker ] ) => landing( marker.section ).length !== 1 ) ) {
			devices[ key ] = { outcome: 'dual-structural', reason: 'Device anchor landing section is not a shared component' };
			continue;
		}
		// Each device keeps its own landing; the fragment resolver scrolls to
		// whichever copy renders.
		for ( const [ fragment, marker ] of relocated ) {
			const defaultMarker = merged( `[${ NODE }]` ).filter( ( _i, node ) => merged( node ).attr( 'id' ) === fragment && merged( node ).is( ANCHOR_MARKER ) );
			// The pair already hides it on this device: without the marker it was default-only.
			defaultMarker.attr( RESPONSIVE_FRAGMENT, fragment );
			const copy = device( marker.node ).clone().attr( 'id', `${ fragment }--data-blocks-engine-capture-${ key }` ).attr( ONLY, key ).attr( RESPONSIVE_FRAGMENT, fragment );
			landing( marker.section ).prepend( device.html( copy ) );
		}
		reconciled.add( key );
		devices[ key ] = { outcome: 'collapsed-identity-subset', matchedNodes: pair.matchedNodes, desktopOnlyElements: pair.desktopOnlyElements, mobileOnlyElements: pair.mobileOnlyElements, projectedElements: pair.projectedElements, divergedComponents: pair.divergedComponents };
		// Variant clones inherit source markers; only their default-side copies
		// may update the shared tree. New islands are inserted at their pair's
		// actual parent and order, including re-parented components.
		$( `.${ RESPONSIVE_MOBILE_ONLY_CLASS }` ).each( ( _i, node ) => {
			$( node ).attr( ONLY, key ).removeAttr( NODE ).find( `[${ NODE }]` ).removeAttr( NODE );
		} );
		$( `[${ NODE }]` ).each( ( _i, node ) => {
			const source = $( node );
			const target = merged( `[${ NODE }="${ source.attr( NODE ) }"]` );
			if ( source.hasClass( RESPONSIVE_DESKTOP_ONLY_CLASS ) ) {
				target.attr( HIDE, [ target.attr( HIDE ), key ].filter( Boolean ).join( ' ' ) );
			}
			const entrance = entrances.get( source.attr( NODE )! );
			if ( entrance !== undefined ) target.attr( VIEWPORT_ENTRANCE_ATTRIBUTE, entrance );
			if ( source.attr( INLINE ) ) {
				target.attr( INLINE, JSON.stringify( { ...JSON.parse( target.attr( INLINE ) ?? '{}' ), ...JSON.parse( source.attr( INLINE )! ) } ) );
			}
		} );
		$( `[${ ONLY }]` ).filter( ( _i, node ) => $( node ).parents( `[${ ONLY }]` ).length === 0 ).each( ( _i, node ) => {
			const island = $( node );
			island.removeClass( RESPONSIVE_MOBILE_ONLY_CLASS ).find( `.${ RESPONSIVE_MOBILE_ONLY_CLASS }` ).removeClass( RESPONSIVE_MOBILE_ONLY_CLASS );
			const parentId = island.parent().attr( NODE );
			const parent = parentId === undefined ? merged( 'body' ) : merged( `[${ NODE }="${ parentId }"]` );
			const next = island.nextAll( `[${ NODE }]` ).first().attr( NODE );
			if ( next !== undefined ) parent.children( `[${ NODE }="${ next }"]` ).before( $.html( island ) );
			else parent.append( $.html( island ) );
		} );
	}
	merged( `[${ NODE }]` ).removeAttr( NODE );
	const evidence: DeviceReconciliationEvidence = {
		outcome: reconciled.size ? 'collapsed-identity-subset' : 'dual-structural',
		reason: reconciled.size ? 'Stable identities reconciled under source-owned device selection' : Object.values( devices )[ 0 ]?.reason ?? 'No non-default device document captured',
		devices,
	};
	return { body: merged( 'body' ).html() ?? '', reconciled, evidence };
}

/** Same selected-document predicate as wrapper visibility, including editor fallback. */
export function deviceGate( key: string, defaultDocument: string ): string {
	return `html[data-blocks-engine-capture-selected-document="${ key }"]${ key === defaultDocument ? ',html:not([data-blocks-engine-capture-selected-document])' : '' }`;
}

export function deviceIslandCss( keys: string[], defaultDocument: string ): string {
	return keys.map( key => deviceGate( key, defaultDocument ).split( ',' ).map( gate =>
		`${ gate } [${ ONLY }]:not([${ ONLY }="${ key }"]),${ gate } [${ HIDE }~="${ key }"]{display:none!important}`
	).join( '' ) ).join( '' );
}
