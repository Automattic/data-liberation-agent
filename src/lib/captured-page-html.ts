import * as cheerio from 'cheerio';
import { ownDocument } from './parsed-documents.js';
import { MAX_SOURCE_EVIDENCE_SCRIPTS, renderSourceData, sourceEvidenceScript, type SourceDataScript } from './source-data.js';
import { isSourcePromotion } from './source-cleanup.js';
import { portableFormAction } from './url/form-action.js';
import { portableVisualIframeWidth } from './visual-iframe-geometry.js';

/** Captured page HTML preparation shared by route collection and export rendering. */
const MAX_DECLARATIVE_FORM_EMBEDS = 32;

const MAX_JSON_LD_SCRIPTS = 16;

const MAX_JSON_LD_SCRIPT_BYTES = 64 * 1024;

const MAX_JSON_LD_TOTAL_BYTES = 256 * 1024;

const VISUAL_IFRAME_EVIDENCE_ATTRIBUTES = {
	src: 'data-blocks-engine-capture-visual-iframe-src',
	width: 'data-blocks-engine-capture-visual-iframe-width',
	height: 'data-blocks-engine-capture-visual-iframe-height',
};

const VISUAL_IFRAME_ATTRIBUTES = new Set( [
	'allow',
	'allowfullscreen',
	'class',
	'height',
	'loading',
	'referrerpolicy',
	'sandbox',
	'src',
	'style',
	'title',
	'width',
] );

const HUBSPOT_FORM_HOSTS = new Map( [
	[ 'na1', 'js.hsforms.net' ],
	[ 'eu1', 'js-eu1.hsforms.net' ],
] );

export function renderedHtml( html: string ): string {
	const $ = ownDocument( html.replace( /<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '' ) );
	$( 'img[src],img[srcset]' ).each( ( _index, element ) => {
		const node = $( element );
		const source = `${ node.attr( 'src' ) ?? '' },${ node.attr( 'srcset' ) ?? '' }`;
		const alignment = /(?:^|[,/])al_(tl|tc|tr|bl|bc|br|t|b|l|c|r)(?=[,/]|$)/i
			.exec( source )?.[ 1 ]
			?.toLowerCase();
		if ( ! alignment ) return;
		const positions: Record< string, string > = {
			tl: 'left top',
			tc: 'center top',
			tr: 'right top',
			bl: 'left bottom',
			bc: 'center bottom',
			br: 'right bottom',
			t: 'center top',
			b: 'center bottom',
			l: 'left center',
			c: 'center center',
			r: 'right center',
		};
		const style = node.attr( 'style' ) ?? '';
		if ( /(?:^|;)\s*object-position\s*:/i.test( style ) ) return;
		const prefix = style.trim() ? style.trim().replace( /;?$/, ';' ) : '';
		node.attr( 'style', `${ prefix }object-position:${ positions[ alignment ] }` );
	} );
	$( '*' ).each( ( _index, element ) => {
		const node = $( element );
		const style = node.attr( 'style' ) ?? '';
		if ( ! /(?:^|;)\s*position\s*:\s*fixed\s*!important/i.test( style ) ) return;
		const text = node.text().replace( /\s+/g, ' ' ).trim();
		const links = node
			.find( 'a[href]' )
			.map( ( _i, link ) => $( link ).attr( 'href' ) ?? '' )
			.get()
			.join( ' ' );
		if (!isSourcePromotion(`${text} ${links}`))
			return;
		const height = /(?:^|;)\s*height\s*:\s*(\d+(?:\.\d+)?)px\s*!important/i.exec( style )?.[ 1 ];
		const bodyStyle = $( 'body' ).attr( 'style' ) ?? '';
		if (
			height &&
			new RegExp( `(?:^|;)\\s*padding-bottom\\s*:\\s*${ height }px\\s*!important`, 'i' ).test(
				bodyStyle
			)
		) {
			$( 'body' ).attr(
				'style',
				bodyStyle
					.replace(
						new RegExp( `(?:^|;)\\s*padding-bottom\\s*:\\s*${ height }px\\s*!important`, 'i' ),
						''
					)
					.replace( /^\s*;|;\s*$/g, '' )
					.trim()
			);
		}
		node.remove();
	} );
	$( 'div,section,aside,footer' ).each( ( _index, element ) => {
		const node = $( element );
		const rendered = node.clone();
		rendered.find( 'script,style,noscript' ).remove();
		if (
			rendered.find( 'img,video,audio,iframe,form,input,button,a[href]' ).length > 0 ||
			rendered.text().trim() !== ''
		)
			return;
		if ( node.parents( 'main,article' ).length > 0 ) return;
		const style = node.attr( 'style' ) ?? '';
		const idAndClass = `${ node.attr( 'id' ) ?? '' } ${ node.attr( 'class' ) ?? '' }`;
		// A site footer is authored page structure, not runtime scaffolding, and
		// it is routinely built from empty boxes that carry their band's height
		// and background in CSS. Matching the name `footer` alone deleted that
		// landmark and collapsed the band it reserved. Judge a landmark by where
		// it sits instead: a detached overlay still matches the style test below.
		const isContentInfoLandmark =
			node.is( 'footer' ) ||
			/(?:^|\s)contentinfo(?:\s|$)/i.test( node.attr( 'role' ) ?? '' );
		// A token names an overlay role (`ReactModalPortal`, `site-footer`);
		// a state or behavior token (`has-popup`, `is-modal-open`) does not.
		const namesScaffoldingRole = idAndClass
			.split( /\s+/ )
			.some(
				( token ) =>
					! /^(?:has|is)-/i.test( token ) &&
					/(?:account.*app|app.*account|footer|modal|mount|portal|popup|toast)/i.test( token )
			);
		if (
			/(?:^|;)\s*(?:position\s*:\s*(?:fixed|absolute)|bottom\s*:)/i.test( style ) ||
			( ! isContentInfoLandmark && namesScaffoldingRole )
		) {
			node.remove();
		}
	} );
	const allLinks = $( 'body a[href]' )
		.map( ( _index, link ) => $( link ).attr( 'href' ) ?? '' )
		.get();
	$( 'body > div,body > nav' ).each( ( _index, element ) => {
		const node = $( element );
		// A hidden first child (e.g. a sprite or runtime mount) does not
		// make its siblings, including the site's header, hidden replicas.
		const style = node.attr( 'style' ) ?? '';
		const links = node
			.find( 'a[href]' )
			.map( ( _i, link ) => $( link ).attr( 'href' ) ?? '' )
			.get();
		if ( links.length === 0 || ! /(?:^|;)\s*display\s*:\s*none/i.test( style ) ) return;
		if (
			links.every( ( href ) => allLinks.filter( ( candidate ) => candidate === href ).length > 1 )
		)
			node.remove();
	} );
	return $.html();
}

export function normalizedDeclarativeFormEmbeds( html: string ): string {
	// Most documents have no frame marker. Check that necessary condition
	// before scanning and backtracking through every div's attributes.
	if ( ! /hs-form-frame/i.test( html ) || ! /<div\b[^>]*\bhs-form-frame\b/i.test( html ) ) return html;
	const $ = cheerio.load( html );
	let retained = 0;
	$( 'div.hs-form-frame' ).each( ( _index, element ) => {
		const frame = $( element );
		frame.find( 'iframe' ).remove();
		if ( retained >= MAX_DECLARATIVE_FORM_EMBEDS ) return;

		const portalId = frame.attr( 'data-portal-id' ) ?? '';
		const formId = ( frame.attr( 'data-form-id' ) ?? '' ).toLowerCase();
		const region = ( frame.attr( 'data-region' ) ?? '' ).toLowerCase();
		const host = HUBSPOT_FORM_HOSTS.get( region );
		if (
			! host ||
			! /^\d{1,20}$/.test( portalId ) ||
			! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test( formId )
		)
			return;

		frame.append(
			`<iframe src="https://${ host }/forms/embed/v2/?portalId=${ portalId }&amp;formId=${ formId }&amp;region=${ region }" title="HubSpot form" loading="lazy"></iframe>`
		);
		retained++;
	} );
	return $.html();
}

export function safeCapturedPageHtml( html: string, embeddedSources: ReadonlySet<string> = new Set(), pageUrl?: string ): { html: string; sourceData: SourceDataScript[]; diagnostics: Array<{ code: string; reason: string }> } {
	const $ = cheerio.load( html );
	// Relative form actions resolve against the document base, which is removed below.
	const baseUrl = documentBaseUrl( $( 'base[href]' ).first().attr( 'href' ), pageUrl );
	const sourceData: SourceDataScript[] = [];
	const diagnostics: Array<{ code: string; reason: string }> = [];
	let sourceEvidenceScriptCount = 0;
	let jsonLdScriptCount = 0;
	let jsonLdSourceBytes = 0;
	// Preserve rendered structure and author CSS, but never ship executable provider runtime.
	$( 'script,noscript,object,embed,base' ).each( ( _index, element ) => {
		const node = $( element );
		if ( element.name === 'script' && /^application\/ld\+json(?:\s*;|\s*$)/i.test( node.attr( 'type' ) ?? '' ) ) {
			const source = node.text();
			const bytes = Buffer.byteLength( source );
			if (
				jsonLdScriptCount < MAX_JSON_LD_SCRIPTS &&
				bytes <= MAX_JSON_LD_SCRIPT_BYTES &&
				jsonLdSourceBytes + bytes <= MAX_JSON_LD_TOTAL_BYTES
			) {
				jsonLdSourceBytes += bytes;
				try {
					const value: unknown = JSON.parse( source );
					if ( value !== null && typeof value === 'object' ) {
						// Keep JSON-LD inert even when a source string contains an escaped end tag.
						sourceData.push( { type: 'application/ld+json', json: JSON.stringify( value ).replace( /<\/script(?=[\t\n\f\r />])/gi, '<\\/script' ) } );
					}
				} catch {
					// Invalid JSON-LD is discarded with the source script.
				}
			}
			jsonLdScriptCount++;
		}
		if ( element.name === 'script' && /^application\/json(?:\s*;|\s*$)/i.test( node.attr( 'type' ) ?? '' ) && node.attr( 'data-blocks-engine-capture-source-evidence' ) !== undefined ) {
			const evidence = sourceEvidenceScript( node.text(), node.attr( 'data-blocks-engine-capture-source-evidence' ) ?? '' );
			if ( evidence && sourceEvidenceScriptCount < MAX_SOURCE_EVIDENCE_SCRIPTS ) sourceData.push( evidence );
			else diagnostics.push( { code: 'source_evidence_unproven', reason: 'An inert source evidence script was invalid or exceeded its bounded retention contract.' } );
			sourceEvidenceScriptCount++;
		}
		node.remove();
	} );
	if ( sourceData.length > 0 ) {
		$( 'head' ).append( renderSourceData( sourceData ) );
	}
	$( 'iframe' ).each( ( _index, element ) => {
		const node = $( element );
		const embeddedSource = node.attr( 'data-blocks-engine-capture-embedded-document' );
		if ( embeddedSource && embeddedSources.has( embeddedSource ) ) {
			const height = Number( node.attr( 'height' ) );
			if ( ! Number.isFinite( height ) || height <= 0 ) { node.remove(); return; }
			for ( const attribute of Object.keys( 'attribs' in element ? element.attribs : {} ) ) {
				if ( ! VISUAL_IFRAME_ATTRIBUTES.has( attribute.toLowerCase() ) && ! [ 'id', 'aria-label', 'frameborder', 'scrolling', 'allowtransparency' ].includes( attribute.toLowerCase() ) ) node.removeAttr( attribute );
			}
			node.attr( 'src', embeddedSource );
			node.attr( 'sandbox', 'allow-same-origin' );
			node.empty();
			return;
		}
		const source = node.attr( VISUAL_IFRAME_EVIDENCE_ATTRIBUTES.src ) ?? '';
		const width = node.attr( VISUAL_IFRAME_EVIDENCE_ATTRIBUTES.width ) ?? '';
		const height = node.attr( VISUAL_IFRAME_EVIDENCE_ATTRIBUTES.height ) ?? '';
		let safeSource = false;
		try {
			const url = new URL( source );
			safeSource = url.protocol === 'https:' && url.hostname !== '';
		} catch {
			// Unattested and malformed iframe sources are not portable.
		}
		if ( ! safeSource || ! /^[1-9]\d*$/.test( width ) || ! /^[1-9]\d*$/.test( height ) ) {
			node.remove();
			return;
		}

		for ( const attribute of Object.keys( 'attribs' in element ? element.attribs : {} ) ) {
			if ( ! VISUAL_IFRAME_ATTRIBUTES.has( attribute.toLowerCase() ) ) {
				node.removeAttr( attribute );
			}
		}
		node.attr( 'src', source );
		node.attr( 'width', portableVisualIframeWidth( node.attr( 'width' ), width ) );
		node.attr( 'height', height );
		node.empty();
	} );
	$( 'meta[http-equiv]' ).each( ( _index, element ) => {
		if ( ( $( element ).attr( 'http-equiv' ) ?? '' ).toLowerCase() === 'refresh' ) {
			$( element ).remove();
		}
	} );
	const formActionDiagnostics = new Map< string, { code: string; reason: string } >();
	$( '*' ).each( ( _index, element ) => {
		const node = $( element );
		for ( const [ attribute, rawValue ] of Object.entries(
			'attribs' in element ? element.attribs : {}
		) ) {
			const value = [ ...rawValue ]
				.filter( ( character ) => character.charCodeAt( 0 ) > 0x20 )
				.join( '' )
				.toLowerCase();
			if ( 'name' in element && submissionUrlAttribute( element.name, attribute ) ) {
				const portable = portableFormAction( attribute.toLowerCase(), rawValue, baseUrl, pageUrl );
				if ( portable.value === undefined ) node.removeAttr( attribute );
				else node.attr( attribute, portable.value );
				if ( portable.diagnostic ) formActionDiagnostics.set( `${ portable.diagnostic.code }\0${ portable.diagnostic.reason }`, portable.diagnostic );
				continue;
			}
			if (
				/^on/i.test( attribute ) ||
				attribute.toLowerCase() === 'srcdoc' ||
				( [ 'href', 'src', 'xlink:href', 'action', 'formaction' ].includes( attribute.toLowerCase() ) &&
					/^(?:javascript|vbscript|data:text\/html)/.test( value ) ) ||
				( attribute.toLowerCase() === 'style' &&
					/(?:expression\s*\(|-moz-binding|url\s*\(\s*["']?\s*(?:javascript|vbscript|data:text\/html))/i.test(
						rawValue
					) )
			) {
				node.removeAttr( attribute );
			}
		}
	} );
	$( 'link' ).each( ( _index, element ) => {
		const node = $( element );
		const rel = ( node.attr( 'rel' ) ?? '' ).toLowerCase().split( /\s+/ );
		const as = ( node.attr( 'as' ) ?? '' ).toLowerCase();
		if (
			rel.includes( 'modulepreload' ) ||
			( rel.includes( 'preload' ) && [ 'script', 'fetch' ].includes( as ) )
		)
			node.remove();
	} );
	diagnostics.push( ...formActionDiagnostics.values() );
	return { html: normalizedDeclarativeFormEmbeds( $.html() ), sourceData, diagnostics };
}

/** `action` on a form and `formaction` on a submitter; elsewhere they are inert, like a widget's `action="like"`. */
function submissionUrlAttribute( element: string, attribute: string ): boolean {
	const name = attribute.toLowerCase();
	return ( name === 'action' && element.toLowerCase() === 'form' ) || ( name === 'formaction' && [ 'button', 'input' ].includes( element.toLowerCase() ) );
}

function documentBaseUrl( href: string | undefined, pageUrl: string | undefined ): string | undefined {
	if ( href === undefined ) return pageUrl;
	try {
		return new URL( href.trim(), pageUrl ).href;
	} catch {
		return pageUrl;
	}
}
