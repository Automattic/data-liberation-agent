import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import postcss from 'postcss';
import { parseSelectorList, projectStylesheet, scopeCss, type UnparseableStylesheetSink } from './replicate/css-scope.js';
import { IntegrityError } from './failure-class.js';

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
		! selection.documents.includes( selection.defaultDocument ) ) throw new IntegrityError( 'Invalid device document selection' );
	for ( const rule of selection.rules ) {
		if ( ! selection.documents.includes( rule.document ) || ! /^[im]*$/.test( rule.flags ?? '' ) ) throw new IntegrityError( 'Invalid device document rule' );
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
function rootCss( css: string, bodyClasses: readonly string[] ): string {
	const root = postcss.parse( css );
	root.walkAtRules( rule => { if ( ! [ 'media', 'supports', 'layer', 'container' ].includes( rule.name ) ) rule.remove(); } );
	root.walkRules( rule => {
		// Every kept selector names a root element or, unescaped, a source body class.
		const text = rule.selector;
		if ( ! /html|body|:root|\\/.test( text ) && ! bodyClasses.some( name => text.includes( name ) ) ) { rule.remove(); return; }
		let invalid = false;
		const selectors = rule.selectors.flatMap( selector => {
			if ( /^(?:html|body|:root)(?![\w-])/.test( selector ) && ! /[>+~\s]/.test( selector ) ) return [ selector ];
			// Class-only body rules already match the scoped display:contents
			// wrapper, but its box cannot carry margins, padding or viewport paint.
			// Copy only the compound onto the real body, retaining specificity and
			// conditional/cascade order without making descendants into roots.
			// Only a class-only compound can qualify; skip parsing anything else.
			if ( ! bodyClasses.length || ! selector.startsWith( '.' ) ) return [];
			const parsed = parseSelectorList( selector );
			// Browsers drop a rule whose selector list is invalid.
			if ( ! parsed ) { invalid = true; return []; }
			const compound = parsed.first;
			return compound?.nodes.length && compound.nodes.every( node => node.type === 'class' ) &&
				compound.nodes.some( node => node.type === 'class' && bodyClasses.includes( node.value ) )
				? [ `:where(body)${ selector }` ] : [];
		} );
		if ( selectors.length && ! invalid ) rule.selectors = selectors; else rule.remove();
	} );
	return root.toString();
}

/** Preserve each document's cascade and body flags; identity never collapses by tree similarity. */
export function assembleDeviceDocuments( documents: Record<string, string>, selection: DeviceDocumentSelection, onUnparseable?: UnparseableStylesheetSink ): DeviceAssembly {
	validateDeviceSelection( selection );
	const base = documents[ selection.defaultDocument ];
	if ( ! base ) throw new Error( 'Default device document was not captured' );
	const $ = cheerio.load( base );
	$( 'style,link[rel~="stylesheet"],meta[name="viewport"],script:not([type="application/ld+json"])' ).remove();
	$( 'html' ).removeAttr( 'style' ).removeAttr( 'class' );
	$( 'body' ).empty().removeAttr( 'class' ).removeAttr( 'style' );
	const head = $( 'head' );
	const viewports: DeviceAssembly['viewports'] = {};
	const roots: DeviceAssembly['roots'] = {};
	const sentinelScope = '[data-blocks-engine-capture-device-document="projection-sentinel"]';
	const sheets: Array<{ identity?: string; keys: string[]; copy: ReturnType<typeof $>; css?: string; rootClasses: string[]; rootProjection?: string }> = [];
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
		wrapper.attr( 'data-blocks-engine-capture-device-document', key ).attr( 'data-blocks-engine-capture-document-scope', '' );
		wrapper.addClass( `data-blocks-engine-capture-${ key }-document` );
		wrapper.html( body.html() ?? '' ).find( 'script,style' ).remove();
		$( 'body' ).append( wrapper );
		let previous: ( typeof sheets )[number] | undefined;
		const rootClasses = ( body.attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean );
		for ( const node of source( 'style,link[rel~="stylesheet"]' ).toArray() ) {
			const original = source( node );
			const css = original.is( 'style' ) ? original.text() : undefined;
			const media = original.attr( 'media' ) ?? 'all';
			const projection = css === undefined ? undefined : projectStylesheet( () => ( {
				scoped: scopeCss( css, { scope: sentinelScope, rootClasses } ),
				roots: rootCss( css, rootClasses ),
			} ), onUnparseable );
			if ( css !== undefined && projection === undefined ) continue;
			const identity = projection === undefined ? undefined : JSON.stringify( [ projection.scoped + projection.roots, media ] );
			const after = previous ? sheets.indexOf( previous ) + 1 : 0;
			// Never coalesce two occurrences from the same document, or move a
			// sheet before that document's preceding sheet (including links).
			const existing = identity === undefined ? undefined : sheets.slice( after ).find( sheet => sheet.identity === identity && ! sheet.keys.includes( key ) );
			if ( existing ) {
				existing.keys.push( key );
				previous = existing;
				continue;
			}
			const copy = css === undefined ? $( source.html( node ) ) : $( '<style>' );
			if ( css !== undefined ) for ( const [ name, value ] of Object.entries( ( node as Element ).attribs ) ) copy.attr( name, value );
			copy.attr( 'data-blocks-engine-capture-device-style', key ).attr( 'data-blocks-engine-capture-source-media', media ).attr( 'media', 'not all' );
			previous = { identity, keys: [ key ], copy, css, rootClasses, rootProjection: projection?.roots };
			sheets.splice( after, 0, previous );
		}
	}
	for ( const sheet of sheets ) {
		if ( sheet.css !== undefined ) {
			const scope = sheet.keys.map( key => `[data-blocks-engine-capture-device-document="${ key }"]` ).join( ',' );
			// Re-project once per emitted entry rather than replacing sentinel text
			// that could also occur in authored CSS. Root projection is scope-independent.
			const css = projectStylesheet( () => scopeCss( sheet.css!, { scope, rootClasses: sheet.rootClasses } ) + sheet.rootProjection!, onUnparseable );
			if ( css === undefined ) continue;
			sheet.copy.text( css );
		}
		head.append( sheet.copy.attr( 'data-blocks-engine-capture-device-style', sheet.keys.join( ' ' ) ) );
	}
	// Kept inline by the export's existing data-blocks-engine-capture-* style handling.
	// The selection runtime is what sets data-blocks-engine-capture-selected-document, and it only
	// runs where scripts do. A consumer that renders this markup without it — the
	// block editor canvas is the one that matters — would otherwise keep every
	// device document at display:none and show nothing at all, so the default
	// document stands in until the runtime names one.
	const visibility = '[data-blocks-engine-capture-device-document]{display:none!important}[data-blocks-engine-capture-device-unavailable]{display:none}' +
		`html:not([data-blocks-engine-capture-selected-document]) [data-blocks-engine-capture-device-document="${ selection.defaultDocument }"]{display:contents!important}` +
		Object.keys( viewports ).map( key => `html[data-blocks-engine-capture-selected-document="${ key }"] [data-blocks-engine-capture-device-document="${ key }"]{display:contents!important}` ).join( '' ) +
		'html[data-blocks-engine-capture-document-unavailable] [data-blocks-engine-capture-device-unavailable]{display:block!important}';
	head.prepend( $( '<style data-blocks-engine-capture-device-visibility>' ).text( visibility ) );
	const missing = selection.documents.filter( key => ! documents[ key ] );
	if ( missing.length ) $( 'body' ).append( '<p data-blocks-engine-capture-device-unavailable role="status">This source device document was not captured.</p>' );
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
	const bootstrap = `(function(){${ ROOT_OVERLAY_RUNTIME }var c=${ config },s=c.selection,ua=navigator.userAgent,key=s.defaultDocument;for(var i=0;i<s.rules.length;i++){var r=s.rules[i];if(new RegExp(r.userAgent,r.flags||'').test(ua)){key=r.document;break;}}var root=document.documentElement;root.setAttribute('data-blocks-engine-capture-selected-document',key);var vp=c.viewports[key],meta=document.querySelector('meta[data-blocks-engine-capture-selected-viewport]');meta.removeAttribute('content');meta.removeAttribute('id');if(vp){overlayRoot(root,c.roots,'html',key);Object.keys(vp).forEach(function(k){meta.setAttribute(k,vp[k]);});root.removeAttribute('data-blocks-engine-capture-document-unavailable');}else{root.setAttribute('data-blocks-engine-capture-document-unavailable',key);}var styles=document.querySelectorAll('[data-blocks-engine-capture-device-style]');for(var j=0;j<styles.length;j++){var node=styles[j];if(node.getAttribute('data-blocks-engine-capture-device-style').split(/\\s+/).indexOf(key)===-1)continue;var copy=node.cloneNode(true);copy.setAttribute('media',node.getAttribute('data-blocks-engine-capture-source-media'));copy.removeAttribute('data-blocks-engine-capture-device-style');copy.setAttribute('blocking','render');node.after(copy);}})();`;
	// The generated bytes are UTF-8; keep the encoding declaration within the
	// first 1024 bytes rather than putting a large predicate/config in front of it.
	$( 'meta[charset]' ).remove();
	$( 'meta[name="viewport"]' ).remove();
	$( 'head' ).prepend( '<meta charset="utf-8"><meta name="viewport" data-blocks-engine-capture-selected-viewport>' );
	// One runtime per document, parsed after every declared device style and
	// before <body>. It activates the selected identity's styles in document
	// order beside their inert declarations, which keep their localized URLs.
	// Changing media on a pending link is not render blocking; a clone inserted
	// with blocking=render while the body is still null is.
	const runtime = `<script data-blocks-engine-capture-device-selection>${ bootstrap }</script>`;
	const declared = $( 'head [data-blocks-engine-capture-device-style]' ).last();
	if ( declared.length ) declared.after( runtime ); else $( 'head' ).append( runtime );
	const roots = JSON.stringify( assembly.roots ).replace( /</g, '\\u003c' );
	$( 'body' ).prepend( `<script data-blocks-engine-capture-device-body>(function(){${ ROOT_OVERLAY_RUNTIME }var roots=${ roots },key=document.documentElement.getAttribute('data-blocks-engine-capture-selected-document');overlayRoot(document.body,roots,'body',key);})();</script>` );
	return $.html();
}
