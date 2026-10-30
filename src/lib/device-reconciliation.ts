import * as cheerio from 'cheerio';
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

/** Every pairing starts from the unmodified default, never from another
 * device's union. Absence in one pair must not erase another device's nodes.
 */
export function reconcileDeviceDocuments( documents: Record<string, string>, selection: DeviceDocumentSelection ) {
	const base = cheerio.load( documents[ selection.defaultDocument ] );
	base( 'body *' ).each( ( index, node ) => { base( node ).attr( NODE, String( index ) ); } );
	const original = base.html();
	const merged = cheerio.load( original );
	const reconciled = new Set<string>();
	const devices: DeviceReconciliationEvidence['devices'] = {};
	for ( const key of selection.documents ) {
		if ( key === selection.defaultDocument || ! documents[ key ] ) continue;
		let reason = 'Device body is unavailable';
		const pair = identitySubsetMerge( original, documents[ key ], undefined, key, failure => { reason = failure; } );
		if ( ! pair ) {
			devices[ key ] = { outcome: 'dual-structural', reason };
			continue;
		}
		if ( pair.divergedComponents && cheerio.load( documents[ key ] )( 'link[rel~="stylesheet"]' ).length ) {
			devices[ key ] = { outcome: 'dual-structural', reason: 'Divergent component ids require rewriting a linked stylesheet; native selector cascade retained as a separate document' };
			continue;
		}
		reconciled.add( key );
		devices[ key ] = { outcome: 'collapsed-identity-subset', matchedNodes: pair.matchedNodes, desktopOnlyElements: pair.desktopOnlyElements, mobileOnlyElements: pair.mobileOnlyElements, projectedElements: pair.projectedElements, divergedComponents: pair.divergedComponents };
		const $ = cheerio.load( `<body>${ pair.body }</body>` );
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
