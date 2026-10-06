import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import postcss from 'postcss';
import { scopeCss } from './replicate/css-scope.js';

/** Platform-owned, ordered request-identity rules. No viewport/capability inference. */
export interface DeviceDocumentSelection {
	kind: 'device';
	id: string;
	rules: Array<{ userAgent: string; flags?: string; document: string }>;
	defaultDocument: string;
	/** All declared identities, including ones this run has not captured. */
	documents: string[];
	/** Public provenance and the bounded classifier coverage the adapter claims. */
	evidence: string;
}

export type DocumentSelection = DeviceDocumentSelection | {
	kind: 'width';
	/** An observed same-profile transition, not a geometry or stylesheet width. */
	switchWidth: number;
	evidence: string;
};

export function validateDeviceSelection( selection: DeviceDocumentSelection ): void {
	if ( ! selection.id || ! selection.evidence || new Set( selection.documents ).size !== selection.documents.length ||
		! selection.documents.length || selection.documents.some( key => ! /^[a-z][a-z0-9-]*$/.test( key ) ) ||
		! selection.documents.includes( selection.defaultDocument ) ) throw new Error( 'Invalid device document selection' );
	for ( const rule of selection.rules ) {
		if ( ! selection.documents.includes( rule.document ) || ! /^[im]*$/.test( rule.flags ?? '' ) ) throw new Error( 'Invalid device document rule' );
		new RegExp( rule.userAgent, rule.flags );
	}
}

/** Shares the portable evaluator's semantics with adapter verification. */
export function selectedDocument( selection: DeviceDocumentSelection, userAgent: string ): string {
	validateDeviceSelection( selection );
	return selection.rules.find( rule => new RegExp( rule.userAgent, rule.flags ).test( userAgent ) )?.document ?? selection.defaultDocument;
}

export interface DeviceAssembly {
	html: string;
	selection: DeviceDocumentSelection;
	viewports: Record<string, Record<string, string>>;
	roots: Record<string, { html: Record<string, string>; body: Record<string, string> }>;
	missing: string[];
}

/** display:contents wrappers cannot carry the real body margin or viewport overflow.
 * Keep authored root-only rules on the real roots, under the same device gate.
 */
function rootCss( css: string ): string {
	const root = postcss.parse( css );
	root.walkAtRules( rule => { if ( ! [ 'media', 'supports', 'layer', 'container' ].includes( rule.name ) ) rule.remove(); } );
	root.walkRules( rule => {
		const selectors = rule.selectors.filter( selector => /^(?:html|body|:root)(?![\w-])/.test( selector ) && ! /[>+~\s]/.test( selector ) );
		if ( selectors.length ) rule.selectors = selectors; else rule.remove();
	} );
	return root.toString();
}

/** Preserve each document's cascade and body flags; identity never collapses by tree similarity. */
export function assembleDeviceDocuments( documents: Record<string, string>, selection: DeviceDocumentSelection ): DeviceAssembly {
	validateDeviceSelection( selection );
	const base = documents[ selection.defaultDocument ];
	if ( ! base ) throw new Error( 'Default device document was not captured' );
	const $ = cheerio.load( base );
	$( 'style,link[rel~="stylesheet"],meta[name="viewport"],script' ).remove();
	$( 'html' ).removeAttr( 'style' ).removeAttr( 'class' );
	$( 'body' ).empty().removeAttr( 'class' ).removeAttr( 'style' );
	const viewports: DeviceAssembly['viewports'] = {};
	const roots: DeviceAssembly['roots'] = {};
	for ( const key of selection.documents ) {
		if ( documents[ key ] === undefined ) continue;
		const source = cheerio.load( documents[ key ] );
		const viewport = source( 'meta[name="viewport"]' );
		if ( viewport.length !== 1 || ! viewport.attr( 'content' ) ) throw new Error( `Device document ${ key } has no unique viewport metadata` );
		viewports[ key ] = { name: 'viewport', content: viewport.attr( 'content' )!, ...( viewport.attr( 'id' ) ? { id: viewport.attr( 'id' )! } : {} ) };
		const rootAttributes = ( selector: string ): Record<string, string> => Object.fromEntries(
			Object.entries( ( source( selector )[ 0 ] as Element | undefined )?.attribs ?? {} ).filter( ( [ name ] ) => [ 'class', 'style', 'lang', 'dir' ].includes( name ) )
		);
		roots[ key ] = { html: rootAttributes( 'html' ), body: rootAttributes( 'body' ) };
		const wrapper = $( '<div>' );
		// Retain the existing scope boundary contract for fragments and consumers.
		const body = source( 'body' );
		for ( const [ name, value ] of Object.entries( body[ 0 ]?.attribs ?? {} ) ) wrapper.attr( name, value );
		wrapper.attr( 'data-dla-device-document', key ).attr( 'data-dla-document-scope', '' );
		wrapper.addClass( `data-liberation-${ key }-document` );
		wrapper.html( body.html() ?? '' ).find( 'script,style' ).remove();
		$( 'body' ).append( wrapper );
		const scope = `[data-dla-device-document="${ key }"]`;
		const rootClasses = ( body.attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean );
		for ( const node of source( 'style,link[rel~="stylesheet"]' ).toArray() ) {
			const original = source( node );
			const copy = $( source.html( node ) );
			if ( original.is( 'style' ) ) copy.text( scopeCss( original.text(), { scope, rootClasses } ) + rootCss( original.text() ) );
			copy.attr( 'data-dla-device-style', key ).attr( 'data-dla-source-media', original.attr( 'media' ) ?? 'all' ).attr( 'media', 'not all' );
			$( 'head' ).append( copy );
		}
	}
	// Kept inline by the export's existing data-dla-* style handling.
	const visibility = '[data-dla-device-document]{display:none!important}[data-dla-device-unavailable]{display:none}' +
		Object.keys( viewports ).map( key => `html[data-dla-selected-document="${ key }"] [data-dla-device-document="${ key }"]{display:contents!important}` ).join( '' ) +
		'html[data-dla-document-unavailable] [data-dla-device-unavailable]{display:block!important}';
	$( 'head' ).prepend( $( '<style data-dla-device-visibility>' ).text( visibility ) );
	const missing = selection.documents.filter( key => ! documents[ key ] );
	if ( missing.length ) $( 'body' ).append( '<p data-dla-device-unavailable role="status">This source device document was not captured.</p>' );
	return { html: $.html(), selection, viewports, roots, missing };
}

/** Shared by the parser-time html/body overlays, without a host-specific contract.
 * CSSOM parsing preserves priorities, custom-property case and shorthand semantics.
 * Only names owned by some captured source root can be removed/replaced.
 */
const ROOT_OVERLAY_RUNTIME = `function overlayRoot(node,roots,kind,key){
var selected=roots[key]&&roots[key][kind];if(!selected)return;
var parser=document.createElement('div');
Object.keys(roots).forEach(function(id){var attrs=roots[id][kind];
(attrs.class||'').split(/\\s+/).filter(Boolean).forEach(function(token){node.classList.remove(token);});
parser.style.cssText=attrs.style||'';
for(var i=0;i<parser.style.length;i++)node.style.removeProperty(parser.style.item(i));
['lang','dir'].forEach(function(name){if(Object.prototype.hasOwnProperty.call(attrs,name))node.removeAttribute(name);});
});
(selected.class||'').split(/\\s+/).filter(Boolean).forEach(function(token){node.classList.add(token);});
parser.style.cssText=selected.style||'';
for(var i=0;i<parser.style.length;i++){var property=parser.style.item(i);node.style.setProperty(property,parser.style.getPropertyValue(property),parser.style.getPropertyPriority(property));}
['lang','dir'].forEach(function(name){if(Object.prototype.hasOwnProperty.call(selected,name))node.setAttribute(name,selected[name]);});
}`;

/** Inject AFTER source-script sanitization. Synchronous head execution precedes body parsing. */
export function installDeviceSelection( html: string, assembly: Omit<DeviceAssembly, 'html'> ): string {
	const $ = cheerio.load( html );
	const config = JSON.stringify( { selection: assembly.selection, viewports: assembly.viewports, roots: assembly.roots } ).replace( /</g, '\\u003c' );
	const bootstrap = `(function(){${ ROOT_OVERLAY_RUNTIME }var c=${ config },s=c.selection,ua=navigator.userAgent,key=s.defaultDocument;for(var i=0;i<s.rules.length;i++){var r=s.rules[i];if(new RegExp(r.userAgent,r.flags||'').test(ua)){key=r.document;break;}}var root=document.documentElement;root.setAttribute('data-dla-selected-document',key);var vp=c.viewports[key],meta=document.querySelector('meta[data-dla-selected-viewport]');meta.removeAttribute('content');meta.removeAttribute('id');if(vp){overlayRoot(root,c.roots,'html',key);Object.keys(vp).forEach(function(k){meta.setAttribute(k,vp[k]);});root.removeAttribute('data-dla-document-unavailable');}else{root.setAttribute('data-dla-document-unavailable',key);}})();`;
	// The generated bytes are UTF-8; keep the encoding declaration within the
	// first 1024 bytes rather than putting a large predicate/config in front of it.
	$( 'meta[charset]' ).remove();
	$( 'meta[name="viewport"]' ).remove();
	$( 'head' ).prepend( `<meta charset="utf-8"><meta name="viewport" data-dla-selected-viewport><script data-dla-device-selection>${ bootstrap }</script>` );
	// Activating a formerly nonmatching link at the end of head is not render
	// blocking: Chromium can paint the right tree with fallback typography. Emit
	// the selected link through the active parser, with its authored media already
	// set. Keep the inert original for the existing URL localization pass.
	$( '[data-dla-device-style]' ).after( `<script data-dla-device-styles>(function(){var node=document.currentScript.previousElementSibling,key=document.documentElement.getAttribute('data-dla-selected-document');if(node.getAttribute('data-dla-device-style')!==key)return;var copy=node.cloneNode(true);copy.setAttribute('media',node.getAttribute('data-dla-source-media'));copy.removeAttribute('data-dla-device-style');document.write(copy.outerHTML);})();</script>` );
	const roots = JSON.stringify( assembly.roots ).replace( /</g, '\\u003c' );
	$( 'body' ).prepend( `<script data-dla-device-body>(function(){${ ROOT_OVERLAY_RUNTIME }var roots=${ roots },key=document.documentElement.getAttribute('data-dla-selected-document');overlayRoot(document.body,roots,'body',key);})();</script>` );
	return $.html();
}
