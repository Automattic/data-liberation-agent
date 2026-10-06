import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import { escapeHtmlAttr } from './html-escape.js';
import { preparePortableReplacements } from './portable-references.js';

const STYLE_HOIST_DIAGNOSTIC_SAMPLE_BYTES = 31 * 1024;

export interface SharedStylesheetEntry {
	url: string;
	htmlPath: string;
	styleHoistContext: StyleHoistContext;
}

export interface SharedStylesheetInput {
	entries: readonly SharedStylesheetEntry[];
	websiteDir: string;
	sourceUrl: string;
	mediaReplacements: ReadonlyMap< string, string >;
	resourceReplacements: ReadonlyMap< string, string >;
	rejectedReplacementKeys: Set< string >;
}

export interface SharedStylesheetResult {
	assets: Array< { sourceUrl: string; path: string } >;
	servedPaths: string[];
	diagnostics: BoundedStyleHoistDiagnostics & { hoistedStylesheets: number };
}

export function portableInlineStyle(
	attributes: string,
	css: string
): { key: string; media: string } | undefined {
	// Exported documents carry no executable script, so identifying attributes a
	// source runtime used to track its own style tags (Wix `id`/`data-href`, for
	// example) cannot affect rendering once the style moves to a link. DLA's own
	// `data-dla-*` markers are selected by later export passes and stay inline.
	const significant = attributes.replace(
		/(^|\s)(?:id|class|rel|data-(?!dla-)[\w.:-]+)\s*=\s*(["'])[\s\S]*?\2/gi,
		'$1'
	);
	const mediaMatch = /\bmedia\s*=\s*(["'])(.*?)\1/i.exec( significant );
	const typeCount = ( significant.match( /\btype\s*=/gi ) ?? [] ).length;
	const mediaCount = ( significant.match( /\bmedia\s*=/gi ) ?? [] ).length;
	const unsupportedAttributes = significant
		// Only inert stylesheet attributes may be represented by a link.
		.replace( /\btype\s*=\s*(["'])text\/css\1/gi, '' )
		.replace( /\bmedia\s*=\s*(["']).*?\1/gi, '' )
		.trim();
	return portableInlineStyleValues(
		mediaMatch?.[ 2 ] ?? '',
		typeCount > 1 || mediaCount > 1 || unsupportedAttributes !== '',
		css
	);
}

function portableInlineStyleValues(
	media: string,
	hasUnsupportedAttributes: boolean,
	css: string
): { key: string; media: string } | undefined {
	if ( hasUnsupportedAttributes || css.trim() === '' )
		return undefined;
	// eslint-disable-next-line no-control-regex -- reject unprintable media attributes.
	if ( /[\u0000-\u001f\u007f<>&]/.test( media ) ) return undefined;
	return { key: `${ media }\n${ css }`, media };
}

type StyleHoistReason =
	| 'unsafe_attributes'
	| 'invalid_media'
	| 'empty_style'
	| 'relative_css_url'
	| 'fragment_css_url'
	| 'empty_css_url'
	| 'invalid_css_url'
	| 'css_import'
	| 'document_base'
	| 'content_security_policy';

interface StyleHoistDiagnostic {
	sourceUrl: string;
	reason: StyleHoistReason;
}

interface BoundedStyleHoistDiagnostics {
	diagnostics: StyleHoistDiagnostic[];
	diagnosticCounts: Partial< Record< StyleHoistReason, number > >;
	diagnosticsTruncated: boolean;
}

interface StyleHoistDiagnosticCollector extends BoundedStyleHoistDiagnostics {
	diagnosticBytes: number;
}

export interface StyleHoistContext {
	hasBase: boolean;
	hasContentSecurityPolicy: boolean;
	styleReasons: Array< StyleHoistReason | undefined >;
}

function cssReferenceReason( css: string ): StyleHoistReason | undefined {
	// Current limitation: @import remains inline because it has stylesheet-relative
	// semantics even when its first URL is absolute.
	if ( /@import\b/i.test( css ) ) return 'css_import';
	const urlPattern = /url\(\s*([^)]*?)\s*\)/gi;
	let foundUrl = false;
	let match: RegExpExecArray | null;
	while ( ( match = urlPattern.exec( css ) ) !== null ) {
		foundUrl = true;
		const reference = match[ 1 ].trim().replace( /^(?:["'])|(?:["'])$/g, '' );
		if ( reference === '' ) return 'empty_css_url';
		// Root, data, and absolute URLs retain their meaning at the new CSS path.
		// A fragment resolves against the stylesheet itself, not the document, after a move.
		if ( reference.startsWith( '#' ) ) return 'fragment_css_url';
		if ( reference.startsWith( '/' ) && ! reference.startsWith( '//' ) ) continue;
		// `about:blank` is the unavailable-asset sentinel this export writes for a
		// dependency it could not capture. Like data: and absolute URLs it resolves
		// identically from any base, so it must not disable hoisting for every
		// document that lost an asset.
		if ( /^(?:data:|https?:|about:blank\b)/i.test( reference ) ) continue;
		if ( /^[a-z][a-z0-9+.-]*:/i.test( reference ) ) return 'invalid_css_url';
		return 'relative_css_url';
	}
	if ( ! foundUrl && /url\s*\(/i.test( css ) ) return 'invalid_css_url';
}

function hasEffectiveBase( html: string ): boolean {
	for ( const match of html.matchAll( /<base\b[^>]*>/gi ) ) {
		const attributes = /\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]*)))?/g;
		let attribute: RegExpExecArray | null;
		while ( ( attribute = attributes.exec( match[ 0 ] ) ) !== null ) {
			if ( attribute[ 1 ].toLowerCase() === 'href' && ( attribute[ 2 ] ?? attribute[ 3 ] ?? attribute[ 4 ] ?? '' ).trim() !== '' ) return true;
		}
	}
	return false;
}

export function capturedStyleHoistContext( html: string ): StyleHoistContext {
	const styleReasons: Array< StyleHoistReason | undefined > = [];
	for ( const match of html.matchAll( /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi ) )
		styleReasons.push( cssReferenceReason( match[ 1 ] ) );
	return {
		// These deliberately broad scans only disable hoisting. Avoid building a second
		// DOM for every captured document, which exceeds the constrained export heap.
		hasBase: hasEffectiveBase( html ),
		hasContentSecurityPolicy:
			/<meta\b(?=[^>]*\bhttp-equiv\b)[^>]*\bcontent-security-policy\b/i.test( html ),
		styleReasons,
	};
}

function styleHoistReason(
	entry: SharedStylesheetEntry,
	styleIndex: number,
	attributes: string,
	css: string
): StyleHoistReason | undefined {
	if ( entry.styleHoistContext.hasBase ) return 'document_base';
	if ( entry.styleHoistContext.hasContentSecurityPolicy ) return 'content_security_policy';
	const sourceReason = entry.styleHoistContext.styleReasons[ styleIndex ];
	if ( sourceReason ) return sourceReason;
	if ( css.trim() === '' ) return 'empty_style';
	const style = portableInlineStyle( attributes, css );
	if ( style ) return cssReferenceReason( css );
	const media = /\bmedia\s*=\s*(["'])(.*?)\1/i.exec( attributes )?.[ 2 ] ?? '';
	// eslint-disable-next-line no-control-regex -- reject unprintable media attributes.
	return /[\u0000-\u001f\u007f<>&]/.test( media ) ? 'invalid_media' : 'unsafe_attributes';
}

function createStyleHoistDiagnosticCollector(): StyleHoistDiagnosticCollector {
	return { diagnostics: [], diagnosticCounts: {}, diagnosticsTruncated: false, diagnosticBytes: 0 };
}

function recordStyleHoistDiagnostic(
	collector: StyleHoistDiagnosticCollector,
	diagnostic: StyleHoistDiagnostic
): void {
	collector.diagnosticCounts[ diagnostic.reason ] =
		( collector.diagnosticCounts[ diagnostic.reason ] ?? 0 ) + 1;
	const bytes = Buffer.byteLength( JSON.stringify( diagnostic ) );
	const separator = collector.diagnostics.length === 0 ? 0 : 1;
	// Leave room for the aggregate counts and object syntax without repeatedly serializing samples.
	if ( collector.diagnosticBytes + separator + bytes > STYLE_HOIST_DIAGNOSTIC_SAMPLE_BYTES ) {
		collector.diagnosticsTruncated = true;
		return;
	}
	collector.diagnostics.push( diagnostic );
	collector.diagnosticBytes += separator + bytes;
}


/** Localize shared inline styles and rewrite only private staged page documents. */
export function materializeSharedStylesheets( input: SharedStylesheetInput ): SharedStylesheetResult {
	const { entries: retainedEntries, websiteDir, sourceUrl, mediaReplacements, resourceReplacements, rejectedReplacementKeys } = input;
	const assets: SharedStylesheetResult[ 'assets' ] = [];
	const inlineStyles = new Map< string, Array< { entry: SharedStylesheetEntry; css: string; media: string } > >();
	const styleHoistDiagnostics = createStyleHoistDiagnosticCollector();
	for ( const entry of retainedEntries ) {
		const html = readFileSync( entry.htmlPath, 'utf8' );
		let styleIndex = 0;
		for ( const match of html.matchAll( /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi ) ) {
			const reason = styleHoistReason( entry, styleIndex++, match[ 1 ], match[ 2 ] );
			const style = portableInlineStyle( match[ 1 ], match[ 2 ] );
			if ( reason || !style ) {
				recordStyleHoistDiagnostic( styleHoistDiagnostics, {
					sourceUrl: entry.url,
					reason: reason ?? 'unsafe_attributes',
				} );
				continue;
			}
			const occurrences = inlineStyles.get( style.key ) ?? [];
			occurrences.push( {
				entry,
				css: match[ 2 ],
				media: style.media,
			} );
			inlineStyles.set( style.key, occurrences );
		}
	}
	const sharedStyles = new Map< string, { path: string; media: string } >();
	const stylesheetPaths = new Map< string, string >();
	const styleReplacements = new Map( [ ...mediaReplacements, ...resourceReplacements ] );
	// Resource discovery and fallback promotion are complete; these maps are
	// stable for the remaining styles, interaction strings and page projection.
	const replaceStyleResources = preparePortableReplacements( styleReplacements, rejectedReplacementKeys );
	for ( const [ key, occurrences ] of [ ...inlineStyles ].sort( ( left, right ) =>
		left[ 0 ].localeCompare( right[ 0 ] )
	) ) {
		if ( new Set( occurrences.map( ( occurrence ) => occurrence.entry.htmlPath ) ).size < 2 ) continue;
		const style = occurrences[ 0 ];
		// Hoisted styles leave the HTML rewrite path, so localize them before writing.
		const css = replaceStyleResources( style.css );
		const contentHash = createHash( 'sha256' ).update( css ).digest( 'hex' );
		const relativePath = stylesheetPaths.get( contentHash ) ?? `assets/css/capture-${ contentHash }.css`;
		const destination = join( websiteDir, relativePath );
		if ( ! stylesheetPaths.has( contentHash ) ) {
			mkdirSync( dirname( destination ), { recursive: true } );
			writeFileSync( destination, css );
			assets.push( {
				sourceUrl: `${ sourceUrl }#inline-style-${ contentHash }`,
				path: `website/${ relativePath }`,
			} );
			stylesheetPaths.set( contentHash, relativePath );
		}
		sharedStyles.set( key, { path: `/${ relativePath }`, media: style.media } );
	}
	if ( sharedStyles.size > 0 ) {
		for ( const entry of retainedEntries ) {
			const $ = cheerio.load( readFileSync( entry.htmlPath, 'utf8' ) );
			$( 'style' ).each( ( _index, element ) => {
				const attributes = 'attribs' in element ? element.attribs : {};
				const style = portableInlineStyle(
					Object.entries( attributes )
						.map( ( [ name, value ] ) => ` ${ name }="${ escapeHtmlAttr( value ?? '' ) }"` )
						.join( '' ),
					$( element ).html() ?? ''
				);
				const shared = style ? sharedStyles.get( style.key ) : undefined;
				if ( ! style || ! shared ) return;
				const link = $( '<link>' ).attr( { rel: 'stylesheet', href: shared.path } );
				if ( shared.media ) link.attr( 'media', shared.media );
				$( element ).replaceWith( link );
			} );
			writeFileSync( entry.htmlPath, $.html() );
		}
	}

	return {
		assets,
		servedPaths: [ ...sharedStyles.values() ].map( ( style ) => style.path ),
		diagnostics: {
			hoistedStylesheets: stylesheetPaths.size,
			diagnostics: styleHoistDiagnostics.diagnostics,
			diagnosticCounts: styleHoistDiagnostics.diagnosticCounts,
			diagnosticsTruncated: styleHoistDiagnostics.diagnosticsTruncated,
		},
	};
}
