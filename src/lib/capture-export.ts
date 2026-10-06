import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { escapeHtmlAttr } from './html-escape.js';
import { allocateCaptureRoutes } from './capture-export-routes.js';
import { sameHttpSite } from './screenshot/same-origin.js';
import { normalizedUrl } from './url/route-key.js';
import {
	indexPortableMediaReferences,
	mediaReferenceMatched,
	planPortableMediaFamilies,
	type PortableMediaCandidate,
} from './portable-media-plan.js';
import { isElementNode, isYuiRuntimeId, YUI_RUNTIME_ID } from './html-nodes.js';
import {
	assembleResponsiveCapture,
	DEFAULT_SWITCH_WIDTH,
	DESKTOP_DOCUMENT_CLASS,
	MOBILE_DOCUMENT_CLASS,
	projectResponsiveIdentityCss,
	routePhoneDocumentFragments,
	type ResponsiveVariantEvidence,
} from './responsive-assembly.js';
import { SectionSpecsStore } from './replicate/section-specs-store.js';
import { MediaStubStore } from './resume-state/index.js';
import {
	failuresAreAbsentDocument,
	isAbsentDocumentRender,
	isSourceCaptureUrl,
} from './screenshot/absent-document.js';
import { selfContainWebsite } from './self-contain.js';
import { wireCapturedDialogs, wireCapturedRouteNavigation } from './static-dialogs.js';
import { wireNativeViewTimelines } from './native-view-timelines.js';
import { rewriteMediaUrls } from './streaming/media-url-rewrite.js';
import {
	INTERACTION_STATES_SCHEMA,
	LEGACY_INTERACTION_STATES_SCHEMA,
	type InteractionStatesReport,
} from './screenshot/interaction-capture.js';
import { SCROLL_STATES_SCHEMA, type ScrollStatesReport } from './screenshot/scroll-state-capture.js';
import { withViewportEntrances } from './viewport-entrances.js';
import {
	type CapturedResourceManifest,
} from './screenshot/resource-capture.js';
import { isSourcePromotion } from './source-cleanup.js';
import { sameOriginPageAnchors } from './screenshot/unscheduled-anchors.js';
import { srcsetCandidates, srcsetReferences } from './srcset.js';
import { resolveDocumentReferences } from './document-resource-base.js';
import { pathWithin } from './portable-assets.js';
import { materializePortableMedia, type FailedPortableMedia } from './portable-media.js';
import { isSrcsetShaped, elementSrcReferences, omitDegenerateReplacements, preparePortableReplacements } from './portable-references.js';
import { materializePortableResources } from './portable-resources.js';
import { collectAssetEvidenceReferences, buildSemanticEvidenceArtifacts, writeCaptureEvidence, UNCAPTURED_ROUTE_REASON, type CaptureFluidEvidence, type SemanticEvidencePage } from './capture-export-evidence.js';
export { CAPTURE_RECEIPT_SCHEMA, SOURCE_PROFILE_SCHEMA, ASSET_EVIDENCE_SCHEMA, CAPTURED_INTERACTIONS_SCHEMA, CAPTURED_SCROLL_STATES_SCHEMA, INDEXED_SEMANTIC_EVIDENCE_SCHEMA } from './capture-export-evidence.js';
import { inspectSourceInteractivity, type SourceInteractivityPage } from './source-interactivity.js';
import { loadHttpExportInput, type HttpExportInput } from './http-export-input.js';
import { loadEmbeddedDocuments, projectEmbeddedRegions, mergeResponsiveEmbeddedRegions } from './embedded-documents.js';
import {
	EXPORT_PUBLICATION_BOUNDARIES,
	exportPublicationBoundary,
	publishExportGeneration,
} from './export-publication.js';

function withoutGeometryIdentities( html: string ): string {
	return html.replace( /\sdata-dla-geometry-id=(?:"[^"]*"|'[^']*')/g, '' );
}

interface CaptureManifestEntry {
	documents?: import('./screenshot/manifest-queue.js').ManifestEntry['documents'];
	nativeViewTimelines?: import('./screenshot/manifest-queue.js').ManifestEntry['nativeViewTimelines'];
	cleanup?: import('./screenshot/manifest-queue.js').ManifestEntry['cleanup'];
	slug?: string;
	html?: string;
	mobileHtml?: string;
	/** Same-origin route the server redirected this URL to; see ManifestEntry. */
	redirectedTo?: string;
	/** Bounded source inspection of a linked route absent from the capture schedule. */
	externalRedirect?: boolean;
	sourceAbsentStatus?: 404 | 410;
	sections?: string;
	interactions?: InteractionStatesReport;
	scrollStates?: ScrollStatesReport;
	/** Responsive learning outcome recorded during capture. */
	fluid?: CaptureFluidEvidence;
	metadata?: {
		openGraph?: Record< string, string >;
	};
}

interface ScreenshotManifest {
	version: 1;
	entries: Record< string, CaptureManifestEntry >;
}

interface ExportCaptureOptions {
	input?: HttpExportInput;
	embeddedDocuments?: boolean;
	outputDir: string;
	sourceUrl: string;
	platform: string;
	title?: string;
	summary: Record< string, unknown >;
	failures: Array< { url: unknown; error: unknown } >;
	discoveryDiagnostics?: Array< { code: string; url: string; reason: string } >;
	/** Overrides the portable media byte budget. */
	limits?: { portableMediaTotalBytes?: number };
}

type MediaCandidate = PortableMediaCandidate;

interface CaptureEntry {
	slug: string;
	url: string;
	htmlPath: string;
	evidenceDocuments: Array< { state: 'desktop' | 'mobile'; html: string } >;
	/** The source served a structurally distinct document under mobile emulation. */
	hasMobileDocument?: boolean;
	/** Receipt evidence for how many responsive variants this route ships and why. */
	responsiveVariants?: ResponsiveVariantEvidence;
	identityHtmlPath?: string;
	sections?: string;
	canonicalUrl?: string;
	jsonLd: string[];
	interactions?: InteractionStatesReport;
	scrollStates?: ScrollStatesReport;
	styleHoistContext: StyleHoistContext;
	sourceInteractivity: SourceInteractivityPage;
}

function isUsableSectionEvidence( sections: unknown ): sections is Record< string, unknown >[] {
	return (
		Array.isArray( sections ) &&
		sections.length > 0 &&
		sections.every(
			( section ) =>
				section !== null &&
				typeof section === 'object' &&
				typeof ( section as Record< string, unknown > ).selector === 'string' &&
				( section as Record< string, unknown > ).selector !== ''
		)
	);
}

function semanticSectionEvidence(
	sections: Record< string, unknown >[]
): Record< string, unknown >[] {
	return sections.map( ( section ) => {
		// These snapshots are reconstruction inputs already represented by the
		// captured page HTML, not semantic evidence. Each may be up to 600 KB.
		const evidence = { ...section };
		delete evidence.sectionHtml;
		delete evidence.styledHtml;
		return evidence;
	} );
}

const MAX_PORTABLE_MEDIA_TOTAL_BYTES = 160 * 1024 * 1024;
const STYLE_HOIST_DIAGNOSTIC_SAMPLE_BYTES = 31 * 1024;
const MAX_DECLARATIVE_FORM_EMBEDS = 32;
const MAX_JSON_LD_SCRIPTS = 16;
const MAX_JSON_LD_SCRIPT_BYTES = 64 * 1024;
const MAX_JSON_LD_TOTAL_BYTES = 256 * 1024;
const VISUAL_IFRAME_EVIDENCE_ATTRIBUTES = {
	src: 'data-dla-visual-iframe-src',
	width: 'data-dla-visual-iframe-width',
	height: 'data-dla-visual-iframe-height',
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
	'title',
	'width',
] );
const HUBSPOT_FORM_HOSTS = new Map( [
	[ 'na1', 'js.hsforms.net' ],
	[ 'eu1', 'js-eu1.hsforms.net' ],
] );

function portableRedirectsFile( rules: Array< { from: string; to: string } > ): string {
	const lines = [ ...rules ]
		.filter(
			( rule, index, all ) =>
				rule.from !== '' &&
				rule.to !== '' &&
				rule.from !== rule.to &&
				all.findIndex( ( other ) => other.from === rule.from && other.to === rule.to ) === index
		)
		.sort(
			( left, right ) => left.from.localeCompare( right.from ) || left.to.localeCompare( right.to )
		)
		.map( ( rule ) => `${ rule.from }  ${ rule.to }  301` );
	return lines.length === 0 ? '' : `${ lines.join( '\n' ) }\n`;
}

/**
 * Where a copied document lives in the artifact, and every path the artifact serves.
 *
 * Captured documents move: a site captured at a subpath serves `/docs/intro` from
 * `/intro/index.html`, so a relative href keeps its spelling but loses its meaning.
 * Given this, links that don't land on something the artifact serves are resolved
 * against the source document instead of being left to dangle.
 */
interface PortableLinkContext {
	documentPath: string;
	servedPaths: Set< string >;
}

const PORTABLE_LINK_BASE = 'https://portable.invalid';
const DOCUMENT_LINK_RELATIONS = new Set( [ 'canonical', 'next', 'prev', 'alternate', 'author', 'help', 'license', 'search' ] );
const RESOURCE_LINK_RELATIONS = new Set( [ 'stylesheet', 'icon', 'manifest', 'preload', 'modulepreload', 'prefetch', 'preconnect', 'dns-prefetch' ] );

function rewriteCapturedRouteLinks(
	html: string,
	documentUrl: string,
	routes: Map< string, string >,
	portable?: PortableLinkContext
): string {
	const $ = cheerio.load( html );
	// Document relations share navigation's route/source resolution. Resource
	// relations keep their asset localization, including alternate stylesheets.
	$( 'a[href],area[href],link[href]' ).each( ( _index, element ) => {
		const link = $( element );
		if ( element.tagName === 'link' ) {
			const relations = ( link.attr( 'rel' ) ?? '' ).toLowerCase().split( /\s+/ );
			if ( relations.some( relation => RESOURCE_LINK_RELATIONS.has( relation ) ) ||
				! relations.some( relation => DOCUMENT_LINK_RELATIONS.has( relation ) ) ) return;
		}
		const href = link.attr( 'href' ) ?? '';
		const absolute = /^(?:https?:)?\/\//i.test( href );
		// Same-document fragments, and schemes such as `mailto:` or `tel:`, mean
		// the same thing wherever the document is served.
		if ( ! absolute && ( ! href.trim() || /^\s*(?:#|[a-z][a-z0-9+.-]*:)/i.test( href ) ) ) return;

		let resolved: URL;
		try {
			resolved = new URL( href, documentUrl );
		} catch {
			return;
		}
		const route = routes.get( normalizedUrl( resolved.href ) );
		if ( route ) {
			link.attr( 'href', `${ route }${ resolved.hash }` );
			return;
		}
		// A captured pathname does not prove an uncaptured query rendition.
		if ( resolved.search ) {
			const base = new URL( resolved.href );
			base.search = '';
			if ( [ ...routes.keys() ].some( key => {
				const captured = new URL( key );
				captured.search = '';
				return normalizedUrl( captured.href ) === normalizedUrl( base.href );
			} ) ) {
				link.attr( 'href', resolved.href );
				return;
			}
		}
		if ( absolute || ! portable ) return;
		// Paths the export itself wrote (routes, localized media and resources)
		// already resolve in the copy.
		try {
			const local = new URL( href, `${ PORTABLE_LINK_BASE }${ portable.documentPath }` );
			if ( portable.servedPaths.has( local.pathname ) ) return;
		} catch {
			return;
		}
		// A relative link to something that was not captured would dangle once
		// the document moves, so point it at the source it was written against.
		if ( /^https?:$/.test( resolved.protocol ) ) link.attr( 'href', resolved.href );
	} );
	return $.html();
}

function renderedHtml( html: string ): string {
	const $ = cheerio.load( html.replace( /<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '' ) );
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
		if (
			/(?:^|;)\s*(?:position\s*:\s*(?:fixed|absolute)|bottom\s*:)/i.test( style ) ||
			( ! isContentInfoLandmark &&
				/(?:account.*app|app.*account|footer|modal|mount|portal|popup|toast)/i.test(
					idAndClass
				) )
		) {
			node.remove();
		}
	} );
	const allLinks = $( 'body a[href]' )
		.map( ( _index, link ) => $( link ).attr( 'href' ) ?? '' )
		.get();
	$( 'body > div,body > nav' ).each( ( _index, element ) => {
		const node = $( element );
		const style = `${ node.attr( 'style' ) ?? '' };${
			node.children().first().attr( 'style' ) ?? ''
		}`;
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

function normalizedDeclarativeFormEmbeds( html: string ): string {
	if ( ! /<div\b[^>]*\bhs-form-frame\b/i.test( html ) ) return html;
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

function openGraphUrl( html: string ): string | undefined {
	return cheerio.load( html )( 'meta[property="og:url"]' ).first().attr( 'content' );
}

function canonicalMetadataUrl( value: unknown, documentUrl: string ): string | undefined {
	if ( typeof value !== 'string' || value.trim() === '' ) return undefined;
	try {
		const resolved = new URL( value, documentUrl );
		if ( resolved.protocol !== 'http:' && resolved.protocol !== 'https:' ) return undefined;
		return resolved.href;
	} catch {
		return undefined;
	}
}

/**
 * A captured header may carry hydration-only widget IDs which change on every
 * route. Share a stable identity only when no retained HTML, script, or style
 * reads the original ID. Rewrite the exact attribute, never the whole document:
 * reserializing a page would change unrelated source markup and SVGs.
 */
export function canonicalizeUnreferencedHeaderIds(
	html: string,
	externalTexts: readonly string[] = []
): string {
	if ( ! YUI_RUNTIME_ID.test( html ) ) return html;
	const $ = cheerio.load( html );
	const header = $( 'header' ).filter( ( _index, node ) =>
		$( node ).find( 'nav' ).length > 0 && $( node ).parents( 'main, article, section' ).length === 0
	).first();
	if ( ! header.length ) return html;
	const rewrites = new Map< string, string >();
	header.find( '[id]' ).each( ( _index, node ) => {
		const id = $( node ).attr( 'id' ) ?? '';
		if ( ! isYuiRuntimeId( id ) || html.split( id ).length !== 2 || externalTexts.some( ( text ) => text.includes( id ) ) ) return;
		const segments: string[] = [];
		let element: Element | null = node;
		while ( element && element !== header[ 0 ] ) {
			let position = 0;
			for ( let sibling = element.prev; sibling; sibling = sibling.prev ) {
				if ( isElementNode( sibling ) && sibling.name === element.name ) position++;
			}
			segments.unshift( `${ element.name }:${ position }` );
			element = element.parent && isElementNode( element.parent ) ? element.parent : null;
		}
		if ( element !== header[ 0 ] ) return;
		const stable = `dla-shared-${ createHash( 'sha256' ).update( segments.join( '/' ) ).digest( 'hex' ).slice( 0, 16 ) }`;
		if ( html.includes( `id="${ stable }"` ) || [ ...rewrites.values() ].includes( stable ) ) return;
		rewrites.set( id, stable );
	} );
	for ( const [ id, stable ] of rewrites ) {
		const escaped = id.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
		html = html.replace( new RegExp( `\\bid(\\s*=\\s*["'])${ escaped }(?=["'])`, 'g' ), ( full ) => full.replace( id, stable ) );
	}
	return html;
}

/** An incomplete reference audit cannot prove an ID is safe to canonicalize. */
function portableTextReferences( websiteDir: string ): Array< { path: string; text: string } > | null {
	const texts: Array< { path: string; text: string } > = [];
	let totalBytes = 0;
	const pending = [ websiteDir ];
	try {
		while ( pending.length ) {
			const directory = pending.pop()!;
			for ( const entry of readdirSync( directory, { withFileTypes: true } ) ) {
				const path = join( directory, entry.name );
				if ( entry.isDirectory() ) {
					pending.push( path );
					continue;
				}
				if ( entry.isSymbolicLink() ) return null;
				if ( ! entry.isFile() || ! /\.(?:css|js|mjs|json|svg|xml|txt|html)$/i.test( entry.name ) ) continue;
				const bytes = statSync( path ).size;
				totalBytes += bytes;
				if ( bytes > 32 * 1024 * 1024 || totalBytes > 128 * 1024 * 1024 ) return null;
				texts.push( { path, text: readFileSync( path, 'utf8' ) } );
			}
		}
	} catch {
		return null;
	}
	return texts;
}

const DESKTOP_CAPTURE_WIDTH = 1440;

/**
 * Use the widest observed source media breakpoint below the desktop capture
 * viewport when fluid capture did not identify a switch. Responsive variants
 * can remain in their mobile layout above 767px; the captured site breakpoints
 * are stronger evidence than assuming the conventional phone/tablet boundary.
 */
function fallbackResponsiveSwitchWidth( outputDir: string ): number | undefined {
	const path = join( outputDir, 'breakpoints.json' );
	if ( ! existsSync( path ) ) return undefined;
	try {
		const data = JSON.parse( readFileSync( path, 'utf8' ) ) as { maxWidth?: unknown };
		if ( ! Array.isArray( data.maxWidth ) ) return undefined;
		const candidates = data.maxWidth.filter(
			( width ): width is number =>
				typeof width === 'number' && Number.isInteger( width ) && width > 0 && width < DESKTOP_CAPTURE_WIDTH
		);
		return candidates.length > 0 ? Math.max( ...candidates ) : undefined;
	} catch {
		return undefined;
	}
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

interface StyleHoistContext {
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

function capturedStyleHoistContext( html: string ): StyleHoistContext {
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
	entry: CaptureEntry,
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


function mediaReferences( sourceUrl: string, siteUrl: string ): string[] {
	const media = new URL( sourceUrl );
	const site = new URL( siteUrl );
	if ( media.origin !== site.origin ) return [ sourceUrl ];
	if ( media.pathname === '/' ) return [ sourceUrl ];
	return [ sourceUrl, `${ media.pathname }${ media.search }` ];
}

function isLocalImageSrc( url: string ): boolean {
	return Boolean( url ) && ! url.startsWith( 'data:' ) && ! /^(?:https?:)?\/\//i.test( url );
}

// The image the copy should show when `src` itself is a srcset list. Prefer a
// candidate that was already localized, and the 1x file when several densities
// were, so the fallback matches the image a 1x display loaded.
function bestBoundImageSrc( value: string ): string | undefined {
	if ( ! isSrcsetShaped( value ) ) return undefined;
	const local = srcsetCandidates( value ).filter( ( candidate ) => isLocalImageSrc( candidate.url ) );
	if ( local.length === 0 ) return undefined;
	const densities = local.filter( ( candidate ) => candidate.density );
	const pool = densities.length > 0 ? densities : local;
	return [ ...pool ].sort( ( left, right ) =>
		densities.length > 0
			? Math.abs( left.size - 1 ) - Math.abs( right.size - 1 ) || left.size - right.size
			: right.size - left.size
	)[ 0 ]?.url;
}

function bindSrcsetShapedImageSrc( html: string ): string {
	return html.replace( /<img\b[^>]*>/gi, ( tag ) => {
		const match = /\ssrc\s*=\s*(["'])([\s\S]*?)\1/i.exec( tag );
		if ( ! match ) return tag;
		const bound = bestBoundImageSrc( match[ 2 ] );
		if ( ! bound ) return tag;
		return tag.replace( match[ 0 ], ` src=${ match[ 1 ] }${ bound }${ match[ 1 ] }` );
	} );
}

function retainedMediaReferenceInventory( entries: CaptureEntry[] ): {
	rendered: Map< string, Set< string > >;
	retained: Map< string, string[] >;
} {
	const pages = new Set(
		entries.flatMap( ( entry ) => {
			try {
				return [ normalizedUrl( entry.url ) ];
			} catch {
				return [];
			}
		} )
	);
	const rendered = new Map< string, Set< string > >();
	const retained = new Map< string, string[] >();
	for ( const entry of entries ) {
		const html = readFileSync( entry.htmlPath, 'utf8' );
		// Both projections classify through one document-local identity map, but
		// preserve their distinct raw spelling and DOM occurrence order.
		const identities = new Map< string, string | undefined >();
		const familyOf = ( reference: string ): string | undefined => {
			const normalized = reference.trim().replace( /&amp;/g, '&' );
			if ( ! normalized ) return undefined;
			if ( ! identities.has( normalized ) ) {
				let family: string | undefined;
				try {
					const resolved = new URL( normalized, entry.url ).href;
					if ( ! pages.has( normalizedUrl( resolved ) ) ) family = mediaFamily( resolved );
				} catch {
					// Malformed browser values have no media family.
				}
				identities.set( normalized, family );
			}
			return identities.get( normalized );
		};
		const references: string[] = [];
		for ( const match of html.matchAll(
			/<(img|source|video|audio)\b[^>]*\ssrc\s*=\s*(["'])([\s\S]*?)\2[^>]*>/gi
		) ) {
			references.push( ...elementSrcReferences( match[ 1 ].toLowerCase(), match[ 3 ] ) );
		}
		for ( const match of html.matchAll(
			/<(?:img|source)\b[^>]*\ssrcset\s*=\s*(["'])([\s\S]*?)\1[^>]*>/gi
		) ) {
			references.push( ...srcsetReferences( match[ 2 ] ) );
		}
		for ( const reference of references ) {
			const family = familyOf( reference );
			if ( family === undefined ) continue;
			const bindings = rendered.get( family ) ?? new Set< string >();
			bindings.add( reference );
			rendered.set( family, bindings );
		}
		const add = ( reference: string ) => {
			const family = familyOf( reference );
			if ( family === undefined ) return;
			const occurrences = retained.get( family ) ?? [];
			occurrences.push( reference.trim().replace( /&amp;/g, '&' ) );
			retained.set( family, occurrences );
		};
		const $ = cheerio.load( html );
		$( 'img,source,video,audio' ).each( ( _index, element ) => {
			const node = $( element );
			const src = node.attr( 'src' );
			const tag = String( node.prop( 'tagName' ) ?? '' ).toLowerCase();
			if ( src ) {
				for ( const reference of elementSrcReferences( tag, src ) ) add( reference );
			}
			const srcset = node.attr( 'srcset' );
			if ( ! srcset ) return;
			for ( const candidate of srcsetReferences( srcset ) ) add( candidate );
		} );
	}
	return { rendered, retained };
}

function mediaFamily( sourceUrl: string ): string {
	const url = new URL( sourceUrl );
	const transformedPath = /^(.*?)\/v1\/(?:fill|fit|crop)\//i.exec( url.pathname )?.[ 1 ];
	if ( transformedPath ) return `${ url.origin }${ transformedPath }`;
	const parameters = [ ...url.searchParams.keys() ];
	return parameters.length > 0 && parameters.every( ( key ) => key === 'w' || key === 'h' )
		? `${ url.origin }${ url.pathname }`
		: sourceUrl;
}

// A captured interaction state carries the HTML of a revealed panel. That HTML
// is serialized from the live DOM, so an image can name the exact CDN rendition
// the runtime chose for the viewport at the moment of capture. That rendition
// may never have been downloaded, but another rendition of the same image was.
// Point such a reference at the portable file for its media family.
function localizeFamilyMediaUrls(
	text: string,
	portableUrlByFamily: Map< string, string >
): string {
	if ( portableUrlByFamily.size === 0 || ! /https?:\/\//i.test( text ) ) return text;
	return text.replace( /https?:\/\/[^\s"'<>)\\]+/gi, ( match ) => {
		try {
			const portable = portableUrlByFamily.get(
				mediaFamily( new URL( match.replace( /&amp;/g, '&' ) ).href )
			);
			return portable ?? match;
		} catch {
			return match;
		}
	} );
}

// A `data-*` attribute that holds one image URL (a runtime's record of the
// image it should load), or a link to the image file, keeps the source CDN
// address after the image itself is localized. Point it at the local file for
// the same picture.
function localizeDataAttributeMedia( html: string, portableUrlByFamily: Map< string, string > ): string {
	if ( portableUrlByFamily.size === 0 ) return html;
	return html.replace(
		/(\s(?:data-[\w-]+|href)\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi,
		( match, prefix: string, quote: string, value: string ) => {
			const local = localizeFamilyMediaUrls( value, portableUrlByFamily );
			return local === value ? match : `${ prefix }${ quote }${ local }${ quote }`;
		}
	);
}

function localizeStringsInPlace( value: unknown, localize: ( text: string ) => string ): void {
	if ( Array.isArray( value ) ) {
		value.forEach( ( item, index ) => {
			if ( typeof item === 'string' ) value[ index ] = localize( item );
			else localizeStringsInPlace( item, localize );
		} );
		return;
	}
	if ( value === null || typeof value !== 'object' ) return;
	const record = value as Record< string, unknown >;
	const htmlBytesBefore =
		typeof record.html === 'string' ? Buffer.byteLength( record.html ) : undefined;
	for ( const [ key, item ] of Object.entries( record ) ) {
		if ( typeof item === 'string' ) record[ key ] = localize( item );
		else localizeStringsInPlace( item, localize );
	}
	// A region records the byte length of its html, and consumers reject a
	// region whose length no longer matches. Keep a matching length matching.
	if ( typeof record.html === 'string' && typeof record.htmlBytes === 'number' && record.htmlBytes === htmlBytesBefore )
		record.htmlBytes = Buffer.byteLength( record.html );
}

function mediaDimension( sourceUrl: string ): number {
	const url = new URL( sourceUrl );
	const finalTransformation = [
		...url.pathname.matchAll( /\/v1\/(?:fill|fit|crop)\/([^/]+)/gi ),
	].at( -1 )?.[ 1 ];
	const pathDimensions = [
		...( finalTransformation ?? url.pathname ).matchAll( /(?:^|[,/])(?:w|h)_(\d+)/gi ),
	].map( ( match ) => Number( match[ 1 ] ) || 0 );
	return Math.max(
		Number( url.searchParams.get( 'w' ) ) || 0,
		Number( url.searchParams.get( 'h' ) ) || 0,
		...pathDimensions
	);
}

function routeMatchesSourceOrigin( url: string, sourceUrl: string ): boolean {
	return sameHttpSite( url, sourceUrl );
}

function capturedResources( outputDir: string ): CapturedResourceManifest {
	const manifestPath = join( outputDir, 'resources', 'manifest.json' );
	if ( ! existsSync( manifestPath ) ) return { version: 1, resources: {}, failures: [] };
	try {
		const manifest = JSON.parse( readFileSync( manifestPath, 'utf8' ) ) as CapturedResourceManifest;
		return manifest.version === 1 && manifest.resources && Array.isArray( manifest.failures )
			? manifest
			: { version: 1, resources: {}, failures: [] };
	} catch {
		return {
			version: 1,
			resources: {},
			failures: [ { url: manifestPath, error: 'captured resource manifest is invalid' } ],
		};
	}
}

function safeCapturedPageHtml( html: string, embeddedSources: ReadonlySet<string> = new Set() ): { html: string; jsonLd: string[] } {
	const $ = cheerio.load( html );
	const jsonLd: string[] = [];
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
						jsonLd.push( JSON.stringify( value ).replace( /<\/script(?=[\t\n\f\r />])/gi, '<\\/script' ) );
					}
				} catch {
					// Invalid JSON-LD is discarded with the source script.
				}
			}
			jsonLdScriptCount++;
		}
		node.remove();
	} );
	if ( jsonLd.length > 0 ) {
		$( 'head' ).append(
			jsonLd.map( ( value ) => `<script type="application/ld+json">${ value }</script>` ).join( '' )
		);
	}
	$( 'iframe' ).each( ( _index, element ) => {
		const node = $( element );
		const embeddedSource = node.attr( 'data-dla-embedded-document' );
		if ( embeddedSource && embeddedSources.has( embeddedSource ) ) {
			const height = Number( node.attr( 'height' ) );
			if ( ! Number.isFinite( height ) || height <= 0 ) { node.remove(); return; }
			for ( const attribute of Object.keys( 'attribs' in element ? element.attribs : {} ) ) {
				if ( ! VISUAL_IFRAME_ATTRIBUTES.has( attribute.toLowerCase() ) && ! [ 'id', 'style', 'aria-label', 'frameborder', 'scrolling', 'allowtransparency' ].includes( attribute.toLowerCase() ) ) node.removeAttr( attribute );
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
		node.attr( 'width', width );
		node.attr( 'height', height );
		node.empty();
	} );
	$( 'meta[http-equiv]' ).each( ( _index, element ) => {
		if ( ( $( element ).attr( 'http-equiv' ) ?? '' ).toLowerCase() === 'refresh' ) {
			$( element ).remove();
		}
	} );
	$( '*' ).each( ( _index, element ) => {
		const node = $( element );
		for ( const [ attribute, rawValue ] of Object.entries(
			'attribs' in element ? element.attribs : {}
		) ) {
			const value = [ ...rawValue ]
				.filter( ( character ) => character.charCodeAt( 0 ) > 0x20 )
				.join( '' )
				.toLowerCase();
			if (
				/^on/i.test( attribute ) ||
				attribute.toLowerCase() === 'srcdoc' ||
				[ 'action', 'formaction' ].includes( attribute.toLowerCase() ) ||
				( [ 'href', 'src', 'xlink:href' ].includes( attribute.toLowerCase() ) &&
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
	return { html: normalizedDeclarativeFormEmbeds( $.html() ), jsonLd };
}

function appendJsonLd( html: string, jsonLd: string[] ): string {
	if ( jsonLd.length === 0 ) return html;
	const $ = cheerio.load( html );
	$( 'head' ).append(
		jsonLd.map( ( value ) => `<script type="application/ld+json">${ value }</script>` ).join( '' )
	);
	return $.html();
}

/**
 * Same-page links in an exported route whose target is missing or ambiguous.
 *
 * The copy has no runtime left to resolve a fragment by scrolling, so a link
 * without exactly one target is a defect. Reported per route rather than
 * thrown, so one broken anchor does not discard an otherwise good capture.
 *
 * Two sources feed this, checked in order so an adapter's own verdict always
 * wins over the generic re-check of the same anchor:
 *
 *  1. `a[data-dla-anchor-fragment]` — anchors a platform's `prepare()` hook
 *     already resolved against its own click runtime (see AGENTS.md — Wix
 *     same-page anchors), carrying an optional `data-dla-anchor-unresolved`
 *     reason straight from that runtime. A marked link naming ANOTHER captured
 *     route resolves against that route's document, so this document's target
 *     count says nothing about it and `checkSelfConsistency` verifies the pair
 *     once every route is written.
 *  2. Every other `a[href="#fragment"]` (or `.../path#fragment` resolving to
 *     THIS document) — ordinary authored same-page links that never went
 *     through adapter resolution at all. A page whose deferred content never
 *     rendered before the snapshot leaves exactly this behind: a nav link to
 *     `#releases` with no `id="releases"` anywhere in the captured document.
 *     Checking every route (not a sample) costs nothing — it is pure
 *     `cheerio`, no browser — so this class of truncation surfaces as a
 *     diagnostic instead of a clean receipt.
 */
function unresolvedCapturedAnchors(
	html: string,
	sourceUrl: string,
	documentPath?: string
): Array< { sourceUrl: string; fragment: string; targetCount: number; reason: string } > {
	const $ = cheerio.load( html );
	const diagnostics = new Map< string, { targetCount: number; reason: string } >();
	let documentUrl: URL | undefined;
	try {
		documentUrl = new URL( sourceUrl );
	} catch {
		documentUrl = undefined;
	}
	const record = ( fragment: string, runtimeReason?: string ) => {
		if ( ! fragment || diagnostics.has( fragment ) ) return;
		const targetCount = $( '[id],a[name]' ).filter(
			( _targetIndex, target ) =>
				$( target ).attr( 'id' ) === fragment || $( target ).attr( 'name' ) === fragment
		).length;
		if ( targetCount !== 1 || runtimeReason ) {
			diagnostics.set( fragment, {
				targetCount,
				reason:
					runtimeReason ??
					( targetCount === 0
						? 'captured fragment target is missing'
						: 'captured fragment target is ambiguous' ),
			} );
		}
	};

	$( 'a[data-dla-anchor-fragment][href]' ).each( ( _index, element ) => {
		const link = $( element );
		const href = link.attr( 'href' );
		if ( ! href ) return;
		let resolved: URL;
		try {
			resolved = new URL( href, sourceUrl );
		} catch {
			return;
		}
		// Same-document only. `documentPath` is this route's own portable
		// spelling, which the rewrite gives same-page anchors — the entrypoint's
		// resolved anchors read `/index.html#fragment`.
		if (
			documentUrl &&
			( resolved.origin !== documentUrl.origin ||
				( resolved.pathname !== documentUrl.pathname &&
					resolved.pathname !== documentPath ) )
		)
			return;
		let fragment: string;
		try {
			fragment = decodeURIComponent( resolved.hash.slice( 1 ) );
		} catch {
			return;
		}
		record( fragment, link.attr( 'data-dla-anchor-unresolved' ) );
	} );

	$( 'a[href]' ).each( ( _index, element ) => {
		const link = $( element );
		if ( link.attr( 'data-dla-anchor-fragment' ) !== undefined ) return; // handled above
		const href = ( link.attr( 'href' ) ?? '' ).trim();
		if ( ! href || href === '#' || ! documentUrl ) return;
		let resolved: URL;
		try {
			resolved = new URL( href, sourceUrl );
		} catch {
			return;
		}
		if ( ! resolved.hash ) return;
		// Same-document only: a fragment link to a DIFFERENT page resolves against
		// that page's own document, not this one — `checkSelfConsistency` covers
		// that cross-route case once every route has been written.
		if ( resolved.origin !== documentUrl.origin || resolved.pathname !== documentUrl.pathname ) return;
		let fragment: string;
		try {
			fragment = decodeURIComponent( resolved.hash.slice( 1 ) );
		} catch {
			return;
		}
		record( fragment );
	} );

	return [ ...diagnostics ].map( ( [ fragment, diagnostic ] ) => ( {
		sourceUrl,
		fragment,
		...diagnostic,
	} ) );
}

/**
 * Same-origin page links in captured HTML whose target was never captured.
 *
 * Checked against the pre-rewrite document so hrefs still resolve on the
 * source origin. The bounded inspection recorded by capture can establish
 * absence or an external redirect; all other missing pages remain blocking.
 */
function uncapturedRouteAnchors(
	html: string,
	sourceUrl: string,
	capturedRoutes: Set< string >,
	absentRoutes: Set< string >
): Array< { sourceUrl: string; url: string; reason: string } > {
	return sameOriginPageAnchors( html, sourceUrl )
		.filter( ( url ) => ! capturedRoutes.has( url ) )
		.map( ( url ) => ( {
		sourceUrl,
		url,
		reason: absentRoutes.has( url ) ? 'target route is absent at source' : UNCAPTURED_ROUTE_REASON,
	} ) );
}

/**
 * Group screenshot-stage failures (goto timeouts, nested-document rejections,
 * etc.) by URL so a route that never produced HTML can report every viewport
 * failure that led there, instead of the receipt just losing the route.
 */
function groupFailureReasonsByUrl(
	failures: Array< { url: unknown; error: unknown } >
): Map< string, string[] > {
	const byUrl = new Map< string, string[] >();
	for ( const failure of failures ) {
		if ( typeof failure.url !== 'string' ) continue;
		const record = failure as Record< string, unknown >;
		const viewport = typeof record.viewport === 'string' ? record.viewport : 'unknown';
		const stage = typeof record.stage === 'string' ? record.stage : 'unknown';
		const error =
			typeof failure.error === 'string'
				? failure.error
				: failure.error === undefined
					? 'unknown error'
					: JSON.stringify( failure.error );
		const list = byUrl.get( failure.url ) ?? [];
		list.push( `${ viewport }/${ stage }: ${ error.split( '\n' )[ 0 ] }` );
		byUrl.set( failure.url, list );
	}
	return byUrl;
}

export function exportWebsiteCapture( options: ExportCaptureOptions ): string {
	const outputDir = resolve( options.outputDir );
	const screenshotManifestPath = join( outputDir, 'screenshots', 'manifest.json' );
	const httpInput = options.input ? loadHttpExportInput( outputDir, options.sourceUrl, options.input ) : undefined;
	const embedded = options.embeddedDocuments ? loadEmbeddedDocuments( outputDir ) : undefined;
	if ( embedded && ! httpInput ) throw new Error( 'Runtime attachments require explicit HTTP input' );
	const embeddedSources = new Set( Object.keys( embedded?.resources ?? {} ) );
	if ( embedded && httpInput && options.input ) {
		const checked = new Set<string>();
		for ( const region of embedded.receipt.regions ) {
			const key = JSON.stringify( [ region.url, region.variant ] );
			if ( checked.has( key ) ) continue;
			checked.add( key );
			const entry = httpInput.entries[ region.url ];
			const path = region.variant === options.input.desktopVariant ? entry?.html : region.variant === options.input.mobileVariant ? entry?.mobileHtml : undefined;
			if ( ! path ) throw new Error( 'Runtime attachment has no corresponding acquired variant' );
			const html = readFileSync( join( outputDir, path ), 'utf8' );
			projectEmbeddedRegions( html, region.url, region.variant, createHash( 'sha256' ).update( html ).digest( 'hex' ), embedded.receipt.regions );
		}
	}
	if ( ! httpInput && ! existsSync( screenshotManifestPath ) ) {
		throw new Error( `Screenshot manifest not found: ${ screenshotManifestPath }` );
	}

	const capture: ScreenshotManifest = httpInput ? { version: 1, entries: httpInput.entries } : JSON.parse(
		readFileSync( screenshotManifestPath, 'utf8' )
	) as ScreenshotManifest;
	if ( capture.version !== 1 || ! capture.entries || typeof capture.entries !== 'object' ) {
		throw new Error( `Invalid screenshot manifest: ${ screenshotManifestPath }` );
	}
	const siteSwitchWidth = httpInput ? undefined : fallbackResponsiveSwitchWidth( outputDir );
	return publishExportGeneration( outputDir, ( stageDir ) => {
		buildExportCapture( options, outputDir, capture, httpInput, embedded, embeddedSources, siteSwitchWidth, stageDir );
	} );
}

function buildExportCapture(
	options: ExportCaptureOptions,
	outputDir: string,
	capture: ScreenshotManifest,
	httpInput: ReturnType< typeof loadHttpExportInput > | undefined,
	embedded: ReturnType< typeof loadEmbeddedDocuments > | undefined,
	embeddedSources: Set< string >,
	siteSwitchWidth: number | undefined,
	stageDir: string,
): void {
	const portableMediaTotalBytesLimit = Math.max(
		0,
		Math.floor( options.limits?.portableMediaTotalBytes ?? MAX_PORTABLE_MEDIA_TOTAL_BYTES )
	);
	const switchWidths: number[] = [];
	const fluidReports: CaptureFluidEvidence[] = [];
	const websiteDir = join( stageDir, 'website' );
	const stagedHtmlDir = join( stageDir, '.capture-export-html' );
	mkdirSync( websiteDir, { recursive: true } );
	mkdirSync( stagedHtmlDir, { recursive: true } );

	const capturedEntries: CaptureEntry[] = [];
	const resourceManifest = capturedResources( outputDir );
	if ( embedded ) Object.assign( resourceManifest.resources, embedded.resources );
	const interactionPages: InteractionStatesReport[] = [];
	const scrollStatesPages: ScrollStatesReport[] = [];
	const excludedRoutes: string[] = [];
	// A route that was discovered and attempted must never disappear from the
	// receipt without a reason. Every screenshot-stage failure (goto timeouts,
	// nested-document rejections, etc.) is grouped by URL here so that a route
	// which never produced HTML gets its own named diagnostic below, extending
	// the same {code,url,reason} shape sitemap discovery already reports
	// rejected leaves through, rather than a parallel reporting mechanism.
	const routeFailureReasons = groupFailureReasonsByUrl( options.failures );
	const routeCaptureDiagnostics: Array< { code: string; url: string; reason: string } > = [];
	const redirectAliases: Array< { url: string; target: string } > = [];
	for ( const [ url, entry ] of Object.entries( capture.entries ) ) {
		if ( ! routeMatchesSourceOrigin( url, options.sourceUrl ) ) {
			excludedRoutes.push( url );
			continue;
		}
		if ( entry.redirectedTo ) {
			redirectAliases.push( { url, target: entry.redirectedTo } );
			continue;
		}
		if ( entry.externalRedirect ) {
			// The source sends this link off-origin. Retain only the fact of the
			// redirect; neither its destination nor its query belongs in the copy.
			excludedRoutes.push( url );
			routeCaptureDiagnostics.push( { code: 'route_external_redirect', url, reason: 'source HTTP redirect to an external origin (destination omitted)' } );
			continue;
		}
		if ( entry.sourceAbsentStatus ) {
			excludedRoutes.push( url );
			routeCaptureDiagnostics.push( { code: 'route_not_found', url, reason: `HTTP ${ entry.sourceAbsentStatus }` } );
			continue;
		}
		if ( ! entry.html ) {
			const reason = routeFailureReasons.get( url )?.join( '; ' )
				?? 'capture completed without producing page HTML';
			if ( failuresAreAbsentDocument( options.failures, url ) ) {
				excludedRoutes.push( url );
				routeCaptureDiagnostics.push( {
					code: 'route_not_found',
					url,
					reason,
				} );
			} else {
				routeCaptureDiagnostics.push( {
					code: 'route_capture_failed',
					url,
					reason,
				} );
			}
			continue;
		}
		const capturedHtmlPath = resolve( outputDir, entry.html );
		if ( ! pathWithin( outputDir, capturedHtmlPath ) || ! existsSync( capturedHtmlPath ) ) {
			routeCaptureDiagnostics.push( {
				code: 'route_capture_failed',
				url,
				reason: `captured HTML file is missing or outside the output directory: ${ entry.html }`,
			} );
			continue;
		}
		const acquiredDesktopHtml = resolveDocumentReferences(
			readFileSync( capturedHtmlPath, 'utf8' ), entry.documents?.desktop?.url ?? url, entry.documents?.desktop?.baseUrl
		);
		let rawDesktopHtml = embedded && options.input ? projectEmbeddedRegions( acquiredDesktopHtml, url, options.input.desktopVariant, createHash( 'sha256' ).update( acquiredDesktopHtml ).digest( 'hex' ), embedded.receipt.regions ) : acquiredDesktopHtml;
		const sourceInteractivity = inspectSourceInteractivity( rawDesktopHtml, url, outputDir, resourceManifest );
		// A client-routed SPA answers every route with HTTP 200 and renders its
		// own not-found screen in JavaScript, so the HTTP-status check above
		// (failuresAreAbsentDocument) never sees it: the entry has HTML, capture
		// succeeded, there is no failure to inspect. Never applied to the source
		// URL itself -- it is known good regardless of what it renders.
		if (
			! isSourceCaptureUrl( url, options.sourceUrl ) &&
			isAbsentDocumentRender( rawDesktopHtml )
		) {
			excludedRoutes.push( url );
			routeCaptureDiagnostics.push( {
				code: 'route_not_found',
				url,
				reason:
					'rendered document is the client-routed not-found screen: a heading of just "404"/"410" on an otherwise thin page',
			} );
			continue;
		}
		const mobileHtmlPath = resolve( outputDir, entry.mobileHtml ?? entry.html.replace( /^html[\\/]/, 'html-mobile/' ) );
		const acquiredMobileHtml =
			( ! httpInput || entry.mobileHtml ) && pathWithin( outputDir, mobileHtmlPath ) && existsSync( mobileHtmlPath )
				? resolveDocumentReferences( readFileSync( mobileHtmlPath, 'utf8' ), entry.documents?.mobile?.url ?? url, entry.documents?.mobile?.baseUrl )
				: undefined;
		let rawMobileHtml = embedded && options.input?.mobileVariant && acquiredMobileHtml !== undefined ? projectEmbeddedRegions( acquiredMobileHtml, url, options.input.mobileVariant, createHash( 'sha256' ).update( acquiredMobileHtml ).digest( 'hex' ), embedded.receipt.regions ) : acquiredMobileHtml;
		const detectedFloor =
			typeof entry.fluid?.canvasFloor === 'number' && entry.fluid.canvasFloor > 0
				? Math.round( entry.fluid.canvasFloor )
				: siteSwitchWidth;
		if ( detectedFloor ) switchWidths.push( detectedFloor );
		if ( entry.fluid ) fluidReports.push( entry.fluid );
		if ( embedded && options.input?.mobileVariant && rawMobileHtml !== undefined ) {
			const pair = mergeResponsiveEmbeddedRegions( { desktop: rawDesktopHtml, mobile: rawMobileHtml, url, desktopVariant: options.input.desktopVariant, mobileVariant: options.input.mobileVariant, receipt: embedded.receipt, switchWidth: detectedFloor ?? DEFAULT_SWITCH_WIDTH, scopeClasses: { desktop: DESKTOP_DOCUMENT_CLASS, mobile: MOBILE_DOCUMENT_CLASS } } );
			rawDesktopHtml = pair.desktop; rawMobileHtml = pair.mobile;
		}
		const desktopHtml = normalizedDeclarativeFormEmbeds( renderedHtml( rawDesktopHtml ) );
		const mobileHtml =
			rawMobileHtml === undefined
				? undefined
				: normalizedDeclarativeFormEmbeds( renderedHtml( rawMobileHtml ) );
		const assembly = assembleResponsiveCapture( {
			rawDesktopHtml,
			rawMobileHtml,
			portableDesktopHtml: desktopHtml,
			portableMobileHtml: mobileHtml,
			switchWidth: detectedFloor,
		} );
		const capturedHtml = assembly.portableNormalization === 'pending'
			? normalizedDeclarativeFormEmbeds( renderedHtml( assembly.html ) )
			: assembly.html;
		// safeCapturedPageHtml removes <base>; record its stylesheet semantics first.
		const styleHoistContext = capturedStyleHoistContext( capturedHtml );
		const sanitized = safeCapturedPageHtml( capturedHtml, embeddedSources );
		const html = sanitized.html;
		const stagedHtmlPath = join( stagedHtmlDir, `${ capturedEntries.length }.html` );
		writeFileSync( stagedHtmlPath, html );
		capturedEntries.push( {
			slug: entry.slug ?? basename( entry.html, '.html' ),
			url,
			htmlPath: stagedHtmlPath,
			evidenceDocuments: [
				{ state: 'desktop', html: desktopHtml },
				...( mobileHtml === undefined ? [] : [ { state: 'mobile' as const, html: mobileHtml } ] ),
			],
			hasMobileDocument: assembly.hasMobileDocument,
			responsiveVariants: assembly.evidence,
			sections: entry.sections,
			canonicalUrl: canonicalMetadataUrl(
				entry.metadata?.openGraph?.[ 'og:url' ] ?? openGraphUrl( html ),
				url
			),
			jsonLd: sanitized.jsonLd,
			interactions: entry.interactions,
			scrollStates: entry.scrollStates,
			styleHoistContext,
			sourceInteractivity,
		} );
		if (
			entry.interactions?.schema === INTERACTION_STATES_SCHEMA ||
			entry.interactions?.schema === LEGACY_INTERACTION_STATES_SCHEMA
		) {
			interactionPages.push( entry.interactions );
		}
		if ( entry.scrollStates?.schema === SCROLL_STATES_SCHEMA && entry.scrollStates.toggles.length > 0 ) {
			scrollStatesPages.push( entry.scrollStates );
		}
	}

	const {
		entrypointUrl, entrypointEntry, routePathOf, retainedEntries, duplicateRoutes,
		canonicalRouteAliases, portableRedirects, missingRedirectTargets, duplicateJsonLd,
	} = allocateCaptureRoutes( capturedEntries, options.sourceUrl, redirectAliases );
	for ( const { claimed, jsonLd } of duplicateJsonLd ) {
		writeFileSync( claimed.htmlPath, appendJsonLd( readFileSync( claimed.htmlPath, 'utf8' ), jsonLd ) );
	}
	routeCaptureDiagnostics.push( ...missingRedirectTargets );
	const desktopSections = httpInput ? new Map() : SectionSpecsStore.load( outputDir );
	const mobileSections = httpInput ? new Map() : SectionSpecsStore.loadMobile( outputDir );
	const semanticPages: SemanticEvidencePage[] = retainedEntries.flatMap( ( entry ) => {
		const desktop = desktopSections.get( entry.url );
		if ( ! isUsableSectionEvidence( desktop ) ) return [];
		const mobile = mobileSections.get( entry.url );
		return [ {
			path: `website/${ routePathOf( entry.url ) }`,
			url: entry.url,
			viewports: {
				desktop: semanticSectionEvidence( desktop ),
				...( isUsableSectionEvidence( mobile )
					? { mobile: semanticSectionEvidence( mobile ) }
					: {} ),
			},
		} ];
	} );
	const semanticEvidence =
		semanticPages.length > 0 ? buildSemanticEvidenceArtifacts( semanticPages ) : undefined;
	const mediaStubs = MediaStubStore.load( outputDir );
	const assetReferenceLocations = collectAssetEvidenceReferences(
		retainedEntries,
		routePathOf,
		resourceManifest,
		outputDir
	);
	const { rendered: renderedMediaReferences, retained: retainedMediaFamilies } =
		retainedMediaReferenceInventory( retainedEntries );
	const mediaFamilies = new Map< string, MediaCandidate[] >();
	const failedMedia: FailedPortableMedia[] = [];
	const capturedPages = new Set(
		[ options.sourceUrl, ...retainedEntries.map( ( entry ) => entry.url ) ].flatMap( ( url ) => {
			try {
				return [ normalizedUrl( url ) ];
			} catch {
				return [];
			}
		} )
	);
	const probeReferences: string[] = [];
	const seenProbeReferences = new Set< string >();
	for ( const [ sourceUrl ] of mediaStubs.list() ) {
		try {
			if ( capturedPages.has( normalizedUrl( sourceUrl ) ) ) continue;
		} catch {
			// Invalid media URLs still flow through mediaReferences().
		}
		for ( const reference of mediaReferences( sourceUrl, options.sourceUrl ) ) {
			if ( seenProbeReferences.has( reference ) ) continue;
			seenProbeReferences.add( reference );
			probeReferences.push( reference );
		}
	}
	const referenceIndex = indexPortableMediaReferences(
		retainedEntries.map( ( entry ) => entry.htmlPath ),
		probeReferences,
	);
	for ( const [ sourceUrl, stub ] of mediaStubs.list() ) {
		try {
			if ( capturedPages.has( normalizedUrl( sourceUrl ) ) ) continue;
		} catch {
			// Invalid media URLs still flow through mediaReferences().
		}
		const references = mediaReferences( sourceUrl, options.sourceUrl );
		const family = mediaFamily( sourceUrl );
		const exactReferences = references.filter( ( reference ) =>
			mediaReferenceMatched( referenceIndex, reference )
		);
		const isReferenced = retainedMediaFamilies.has( family ) || exactReferences.length > 0;
		if ( stub.status === 'error' && isReferenced ) {
			failedMedia.push( { family, sourceUrl, error: stub.error ?? 'media download failed', references } );
			continue;
		}
		if (
			stub.status !== 'success' ||
			! stub.localPath ||
			! existsSync( stub.localPath ) ||
			! isReferenced
		)
			continue;
		const candidate: MediaCandidate = {
			sourceUrl,
			localPath: stub.localPath,
			references: [
				...new Set( [ ...references, ...( renderedMediaReferences.get( family ) ?? [] ) ] ),
			],
			exactReferences,
			bytes: statSync( stub.localPath ).size,
			dimension: mediaDimension( sourceUrl ),
		};
		mediaFamilies.set( family, [ ...( mediaFamilies.get( family ) ?? [] ), candidate ] );
	}
	const portableMediaBudget = portableMediaTotalBytesLimit;
	const portableMediaPlan = planPortableMediaFamilies(
		[ ...mediaFamilies ].map( ( [ family, candidates ] ) => ( { family, candidates } ) ),
		portableMediaBudget,
		entrypointEntry.htmlPath,
	);
	const mediaStage = materializePortableMedia( {
		websiteDir, plan: portableMediaPlan, maxBytes: portableMediaBudget,
		retainedReferences: retainedMediaFamilies, failedMedia,
	} );
	let { mediaReplacements, portablePathsBySource } = mediaStage;
	const { portableUrlByFamily, assetPathsByHash, assetHashesByPath, assets, unresolvedMedia, portableMedia } = mediaStage;

	const resourceStage = materializePortableResources( {
		sourceRoot: outputDir,
		websiteDir,
		entries: retainedEntries,
		resourceManifest,
		mediaReplacements,
		assetPathsByHash,
		assetHashesByPath,
		portablePathsBySource,
		embeddedSources,
		projectEmbeddedHtml: ( html ) => safeCapturedPageHtml( html ).html,
	} );
	mediaReplacements = resourceStage.mediaReplacements;
	portablePathsBySource = resourceStage.portablePathsBySource;
	assets.push( ...resourceStage.assets );
	const { resourceReplacements, unresolvedDependencies, rejectedReplacementKeys } = resourceStage;
	const inlineStyles = new Map< string, Array< { entry: CaptureEntry; css: string; media: string } > >();
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
	const replaceMedia = preparePortableReplacements( mediaReplacements, rejectedReplacementKeys );
	const replaceResources = preparePortableReplacements( resourceReplacements, rejectedReplacementKeys );
	const portableMediaReplacements = omitDegenerateReplacements( mediaReplacements, rejectedReplacementKeys );
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
				sourceUrl: `${ options.sourceUrl }#inline-style-${ contentHash }`,
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

	const routes: Array< { url: string; path: string } > = [];
	const portableRouteLinks = new Map< string, string >();
	for ( const entry of retainedEntries ) {
		const { url } = entry;
		const routePath = routePathOf( url );
		const portablePath = `/${ routePath }`;
		portableRouteLinks.set( normalizedUrl( url ), portablePath );
		routes.push( {
			url,
			path: `website/${ routePath }`,
			...( entry.responsiveVariants ? { responsiveVariants: entry.responsiveVariants } : {} ),
		} );
	}
	for ( const [ aliasKey, routePath ] of canonicalRouteAliases ) {
		if ( portableRouteLinks.has( aliasKey ) ) continue;
		portableRouteLinks.set( aliasKey, `/${ routePath }` );
	}
	for ( const { url, canonicalUrl } of retainedEntries ) {
		if ( ! canonicalUrl ) continue;
		const canonicalKey = normalizedUrl( canonicalUrl );
		if ( portableRouteLinks.has( canonicalKey ) ) continue;
		const routePath = routePathOf( url );
		portableRouteLinks.set( canonicalKey, `/${ routePath }` );
	}

	const portableServedPaths = new Set< string >();
	for ( const path of [
		...portableRouteLinks.values(),
		...mediaReplacements.values(),
		...resourceReplacements.values(),
		...[ ...sharedStyles.values() ].map( ( style ) => style.path ),
	] ) {
		if ( ! path.startsWith( '/' ) ) continue;
		try {
			const pathname = new URL( path, PORTABLE_LINK_BASE ).pathname;
			portableServedPaths.add( pathname );
			if ( pathname.endsWith( '/index.html' ) ) {
				portableServedPaths.add( pathname.slice( 0, -'index.html'.length ) );
				portableServedPaths.add( pathname.slice( 0, -'/index.html'.length ) || '/' );
			}
		} catch {
			// A replacement that is not a URL path serves nothing a link could name.
		}
	}

	const unresolvedAnchors: Array< {
		sourceUrl: string;
		reason: string;
		fragment?: string;
		targetCount?: number;
		url?: string;
	} > = [];
	const capturedRouteKeys = new Set( portableRouteLinks.keys() );
	for ( const [ url, entry ] of Object.entries( capture.entries ) ) {
		if ( entry.externalRedirect ) capturedRouteKeys.add( normalizedUrl( url ) );
	}
	const absentRoutes = new Set( routeCaptureDiagnostics
		.filter( ( diagnostic ) => diagnostic.code === 'route_not_found' )
		.map( ( diagnostic ) => diagnostic.url ) );
	const absentRouteKeys = new Set( [ ...absentRoutes ].map( normalizedUrl ) );
	// A tab for the current route cannot demonstrate a URL change on that page.
	// Reuse only an unambiguous observation of the same navigation group on
	// another captured route (for example Home observed from Services).
	const routeObservations = retainedEntries.flatMap( entry => entry.interactions?.routeNavigation ?? [] );
	const routeDestinations = new Map< string, Set< string > >();
	for ( const route of routeObservations ) {
		const key = JSON.stringify( [ route.siblings, route.label ] );
		const destinations = routeDestinations.get( key ) ?? new Set< string >();
		destinations.add( route.url );
		routeDestinations.set( key, destinations );
	}
	const verifiedRouteObservations = routeObservations.filter( route =>
		portableRouteLinks.has( normalizedUrl( route.url ) ) &&
		routeDestinations.get( JSON.stringify( [ route.siblings, route.label ] ) )?.size === 1
	);
	const responsiveIdentities = { ids: new Map<string,string>(), namedAliases: false };
	// An image captured as a page resource, not as a media stub, still names one
	// picture at several sizes. Let the largest captured size stand for the
	// picture wherever only the picture, not a size, is named.
	const largestResourceByFamily = new Map< string, { portable: string; dimension: number } >();
	for ( const [ resourceUrl, portable ] of resourceReplacements ) {
		if ( ! /^https?:\/\//i.test( resourceUrl ) || ! /\.(?:avif|gif|jpe?g|png|webp)$/i.test( portable ) )
			continue;
		try {
			const family = mediaFamily( resourceUrl );
			if ( family === resourceUrl ) continue;
			const dimension = mediaDimension( resourceUrl );
			if ( dimension > ( largestResourceByFamily.get( family )?.dimension ?? -1 ) )
				largestResourceByFamily.set( family, { portable, dimension } );
		} catch {
			// Not a media URL.
		}
	}
	for ( const [ family, { portable } ] of largestResourceByFamily ) {
		if ( ! portableUrlByFamily.has( family ) ) portableUrlByFamily.set( family, portable );
	}
	// Interaction states are written to interaction-states.json and replayed into
	// the portable pages, so their embedded HTML must name local media too.
	const localizeInteractionMedia = ( text: string ): string =>
		localizeFamilyMediaUrls(
			replaceMedia( text ),
			portableUrlByFamily
		);
	for ( const entry of retainedEntries ) {
		if ( entry.interactions ) localizeStringsInPlace( entry.interactions, localizeInteractionMedia );
	}
	for ( const entry of retainedEntries ) {
		const { url, htmlPath } = entry;
		const routePath = routePathOf( url );
		const destination = join( websiteDir, routePath );
		if ( ! pathWithin( websiteDir, destination ) ) {
			throw new Error( `Captured route escapes the website directory: ${ url }` );
		}
		mkdirSync( dirname( destination ), { recursive: true } );
		const originalHtml = readFileSync( htmlPath, 'utf8' );
		unresolvedAnchors.push( ...uncapturedRouteAnchors( originalHtml, url, capturedRouteKeys, absentRouteKeys ) );
		// Rewrite route links once, after wiring dialogs below. A portable path
		// can also name a source route that was allocated a different filename.
		const identityHtml = bindSrcsetShapedImageSrc(
			localizeDataAttributeMedia(
				replaceResources(
					rewriteMediaUrls(
						originalHtml,
						portableMediaReplacements
					)
				),
				portableUrlByFamily
			)
		);
		const normalizedHtml = routePhoneDocumentFragments(
			rewriteCapturedRouteLinks(
				wireCapturedRouteNavigation(
					wireCapturedDialogs(
						withoutGeometryIdentities( identityHtml ),
						entry.interactions?.states ?? [],
						entry.interactions?.initialDialogs ?? []
					),
					verifiedRouteObservations
				),
				url,
				portableRouteLinks,
				{ documentPath: `/${ routePath }`, servedPaths: portableServedPaths }
			),
			`/${ routePath }`, responsiveIdentities
		);
		unresolvedAnchors.push(
			...unresolvedCapturedAnchors( normalizedHtml, url, `/${ routePath }` )
		);
		writeFileSync( destination, wireNativeViewTimelines( withViewportEntrances( normalizedHtml ) ) );
		entry.identityHtmlPath = `${ htmlPath }.identity`;
		writeFileSync( entry.identityHtmlPath, identityHtml );
	}
	selfContainWebsite( websiteDir );
	// Author identity selectors can live in linked/imported stylesheets, not
	// only inline <style>. Project the localized copies with the same primitive.
	if ( responsiveIdentities.ids.size || responsiveIdentities.namedAliases ) {
		const projectStylesheets = ( directory: string ): void => {
			for ( const entry of readdirSync( directory, { withFileTypes: true } ) ) {
				const path = join( directory, entry.name );
				if ( entry.isDirectory() ) projectStylesheets( path );
				else if ( entry.isFile() && entry.name.endsWith( '.css' ) ) {
					const original = readFileSync( path, 'utf8' );
					const projected = projectResponsiveIdentityCss( original, responsiveIdentities.ids, responsiveIdentities.namedAliases );
					if ( original !== projected ) writeFileSync( path, projected );
				}
			}
		};
		projectStylesheets( websiteDir );
	}
	const portableTexts = portableTextReferences( websiteDir );
	if ( portableTexts ) for ( const entry of retainedEntries ) {
		const path = join( websiteDir, routePathOf( entry.url ) );
		const html = readFileSync( path, 'utf8' );
		const externalTexts = portableTexts.filter( ( item ) => item.path !== path ).map( ( item ) => item.text );
		const stable = canonicalizeUnreferencedHeaderIds( html, externalTexts );
		if ( stable !== html ) writeFileSync( path, stable );
	}
	const redirectsFile = portableRedirectsFile( portableRedirects );
	if ( redirectsFile ) writeFileSync( join( websiteDir, '_redirects' ), redirectsFile );
	exportPublicationBoundary( EXPORT_PUBLICATION_BOUNDARIES.afterHtml );

	writeCaptureEvidence( {
		locations: { captureRoot: outputDir, stageRoot: stageDir },
		source: options,
		capture: {
			entries: capture.entries, absentRoutes,
			interactivity: capturedEntries.map( ( entry ) => entry.sourceInteractivity ),
			http: httpInput, embedded,
		},
		pages: retainedEntries.map( ( entry ) => ( {
			slug: entry.slug, url: entry.url, routePath: routePathOf( entry.url ),
			identityHtmlPath: entry.identityHtmlPath!, hasMobileDocument: entry.hasMobileDocument,
		} ) ),
		routes: { retained: routes, excluded: excludedRoutes, duplicates: duplicateRoutes },
		states: { interactions: interactionPages, scroll: scrollStatesPages },
		layout: { fluidReports, switchWidths },
		assets: {
			references: assetReferenceLocations, stubs: mediaStubs, manifest: resourceManifest,
			portablePaths: portablePathsBySource, files: assets, media: portableMedia,
		},
		semantic: semanticEvidence,
		diagnostics: {
			capture: routeCaptureDiagnostics, dependencies: unresolvedDependencies,
			media: unresolvedMedia, anchors: unresolvedAnchors, rejectedKeys: rejectedReplacementKeys,
			styles: { hoistedStylesheets: stylesheetPaths.size, ...styleHoistDiagnostics },
		},
	} );
}
