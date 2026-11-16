import { normalizedDeclarativeFormEmbeds, renderedHtml, safeCapturedPageHtml } from './captured-page-html.js';
import { collectCapturedRoutes, collectMediaCandidates, collectRouteLinks, mediaFamily, mediaDimension, type ScreenshotManifest } from './capture-export-collection.js';
import { WebsiteInventory } from './website-inventory.js';
import { createHash } from 'node:crypto';
import { structuredContentIndex } from './content-index.js';
import { deferredMediaReferences, linkDeferredMedia, recordMediaLedger } from './media-queue.js';
import { ownDocument, withParsedDocuments } from './parsed-documents.js';
import { imageSize } from 'image-size';
import { type DocumentSelection } from './document-selection.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { materializeSharedStylesheets } from './shared-stylesheets.js';
export { portableInlineStyle } from './shared-stylesheets.js';
import { allocateCaptureRoutes, type RouteDiagnostic } from './capture-export-routes.js';
import { projectStylesheet } from './replicate/css-scope.js';
import { MAX_SOURCE_EVIDENCE_SCRIPTS, renderSourceData, sourceEvidenceScript, type SourceDataScript } from './source-data.js';
import { onSiteOrigin } from './screenshot/same-origin.js';
import { normalizedUrl, documentRequestUrl } from './url/route-key.js';
import { OMITTED_ROUTE_REASON } from './route-budget.js';
import { ACTION_URL_REASON, stateChangingAction } from './url/action-url.js';
import { portableFormAction } from './url/form-action.js';
import { routeInScope, scopedRouteKey, validateRouteScope } from './url/route-scope.js';
import type { SiteRouteScope } from '../platform/types.js';
import { planPortableMediaFamilies } from './portable-media-plan.js';
import { isElementNode, isYuiRuntimeId, RUNTIME_ID_TOKEN, YUI_RUNTIME_ID } from './html-nodes.js';
import { projectResponsiveIdentityCss, projectResponsiveSvgCss, projectResponsiveBodyClassCss, projectCollapsedBodyClassCss, routePhoneDocumentFragments } from './responsive-assembly.js';
import { SectionSpecsStore } from './replicate/section-specs-store.js';
import { MediaStubStore } from './resume-state/index.js';
import { selfContainWebsite } from './self-contain.js';
import { COARSE_SWEEP_WIDTHS } from './screenshot/fluid-capture.js';
import { wireCapturedDialogs, wireCapturedRouteNavigation } from './static-dialogs.js';
import { wireCapturedComponents } from './static-components.js';
import { routeComponents, componentReplayStates } from './screenshot/component-states.js';
import { wireNativeViewTimelines } from './native-view-timelines.js';
import { wireNativeControlState } from './native-control-state.js';
import { indexRuntimeIdReferences } from './runtime-id-references.js';
import { rewriteMediaUrls } from './streaming/media-url-rewrite.js';
import { withViewportEntrances } from './viewport-entrances.js';
import {
	type CapturedResourceManifest,
} from './screenshot/resource-capture.js';
import { isSourcePromotion } from './source-cleanup.js';
import { sameOriginPageAnchors } from './screenshot/unscheduled-anchors.js';
import { galleryFrameMediaUrls } from './screenshot/gallery-capture.js';
import { isSrcsetShaped, srcsetCandidates } from './srcset.js';
import { pathWithin } from './portable-assets.js';
import { materializePortableMedia } from './portable-media.js';
import { localizeMetadataImageReferences, omitDegenerateReplacements, preparePortableReplacements } from './portable-references.js';
import { materializePortableResources, projectPortableResourceIntegrity } from './portable-resources.js';
import { assetExceedsFileLimit, DEFAULT_MAX_FILE_BYTES, validateMaxFileBytes } from './export-file-limit.js';
import { assetExceedsTotalBudget, emptyExportBudgetExclusions, planExportBudget, redundantRenditionDropped, resolveExportTotalBudget, type DroppableAsset, type ExportBudgetExclusions, type ExportTotalBudget } from './export-total-budget.js';
import { collectAssetEvidenceReferences, buildSemanticEvidenceArtifacts, writeCaptureEvidence, UNCAPTURED_ROUTE_REASON, type SemanticEvidencePage } from './capture-export-evidence.js';
export { CAPTURE_RECEIPT_SCHEMA, SOURCE_PROFILE_SCHEMA, ASSET_EVIDENCE_SCHEMA, CAPTURED_INTERACTIONS_SCHEMA, CAPTURED_SCROLL_STATES_SCHEMA, INDEXED_SEMANTIC_EVIDENCE_SCHEMA } from './capture-export-evidence.js';
import { loadHttpExportInput, type HttpExportInput } from './http-export-input.js';
import { loadEmbeddedDocuments, projectEmbeddedRegions } from './embedded-documents.js';
import {
	EXPORT_PUBLICATION_BOUNDARIES,
	exportPublicationBoundary,
	publishExportGeneration,
} from './export-publication.js';
import { extractSharedChrome } from './shared-chrome.js';
import { namespaceExportBoxTreeIds, writeExportBoxTrees } from './export-box-trees.js';
import { portableVisualIframeWidth } from './visual-iframe-geometry.js';

/** Strip correspondence used only during capture, before HTML is encoded as replay state. */
function withoutCaptureBookkeeping( html: string ): string {
	return html.replace( /\sdata-blocks-engine-capture-(?:geometry-id|initial-node)=(?:"[^"]*"|'[^']*')/g, '' );
}

export interface ExportLimits {
	/** Overrides the portable media byte budget. */
	portableMediaTotalBytes?: number;
	/** Largest file written into `website/`; default `DEFAULT_MAX_FILE_BYTES`. See export-file-limit.ts. */
	maxFileBytes?: number;
	/** Most bytes written into `website/`; default `DEFAULT_MAX_TOTAL_BYTES`. See export-total-budget.ts. */
	maxTotalBytes?: number;
	/** Most files written into `website/`; default `DEFAULT_MAX_FILES`. See export-total-budget.ts. */
	maxFiles?: number;
	/**
	 * Keep `POST_EXPORT_RESERVE` of the budget free for files the caller writes
	 * into `website/` after export (homepage preview, source findings, motion).
	 */
	reservePostExport?: boolean;
}

/** What one build of the export generation produced, for the total budget. */
interface ExportBuild {
	inventory: WebsiteInventory;
	entrypointPath: string;
	routes: Array< { url: string; path: string } >;
	assets: DroppableAsset[];
}

interface ExportCaptureOptions {
	/** Adapter structured content (#1701): entry slugs, term archives, content index and redirects. */
	structuredContent?: { source: import('../platform/types.js').StructuredContentSource; entries: import('../platform/types.js').StructuredContentEntry[] };
	routeScope?: SiteRouteScope;
	resolveDocumentSelection?: ( documents: Readonly<Record<string, string>> ) => DocumentSelection | undefined;
	input?: HttpExportInput;
	embeddedDocuments?: boolean;
	/**
	 * `reflow-only`: the site's phone view is CSS reflow of the desktop document
	 * (see `screenshot/device-mode.ts`). Only routes whose own phone check kept
	 * them dual have a phone document, named by their manifest `mobileHtml`;
	 * every other route ships its desktop document alone, and no `html-mobile/`
	 * fallback path is read.
	 */
	deviceMode?: import( './screenshot/device-mode.js' ).DeviceMode;
	outputDir: string;
	sourceUrl: string;
	platform: string;
	title?: string;
	summary: Record< string, unknown >;
	failures: Array< { url: unknown; error: unknown } >;
	discoveryDiagnostics?: Array< { code: string; url: string; reason: string } >;
	/** Routes skipped before capture because their rel=canonical is another inventory route; reported exactly as collapsed duplicates (#835). */
	canonicalAliases?: ReadonlyArray< import( './route-aliases.js' ).CanonicalRouteAlias >;
	limits?: ExportLimits;
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
	routeScope?: SiteRouteScope;
	/** Selectable-set tab keys per captured document, keyed by `documentRequestUrl`. */
	tabKeysByRoute?: Map< string, Set< string > >;
	boundaryRoutes?: Set<string>;
}

/**
 * The stable key a tab library gives a tab trigger, which the source uses as
 * the value of a `?tab=` style deep link. Radix names triggers
 * `radix-<scope>-trigger-<value>`; the value is what its links carry.
 */
export function tabKeyOfTrigger( trigger: { role?: string; id?: string } ): string | undefined {
	if ( trigger.role !== 'tab' || ! trigger.id ) return undefined;
	return /^radix-.+?-trigger-([A-Za-z0-9_-]+)$/.exec( trigger.id )?.[ 1 ];
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
	rewriteRouteLinksIn( $, documentUrl, routes, portable );
	// Replay state serializes markup the runtime swaps in: a shared dropdown
	// root's per-trigger opened panel, and a reused panel's resting and opened
	// snapshots. Its links were written against the same document and must
	// resolve as the live panel's own do; otherwise the swapped-in menu opens
	// onto source links, and identical shared chrome differs route by route.
	const rewriteFragment = ( html: unknown ): unknown => {
		if ( typeof html !== 'string' ) return html;
		const fragment = cheerio.load( html, null, false );
		rewriteRouteLinksIn( fragment, documentUrl, routes, portable );
		return fragment.html();
	};
	const rewriteState = ( attribute: string, rewrite: ( state: Record< string, unknown > ) => Record< string, unknown > ) => {
		$( `[${ attribute }]` ).each( ( _index, element ) => {
			let state: unknown;
			try {
				state = JSON.parse( $( element ).attr( attribute ) ?? '' );
			} catch {
				return;
			}
			if ( state && typeof state === 'object' ) $( element ).attr( attribute, JSON.stringify( rewrite( state as Record< string, unknown > ) ) );
		} );
	};
	rewriteState( 'data-blocks-engine-capture-dialog-panel-state', state => ( { ...state, html: rewriteFragment( state.html ) } ) );
	rewriteState( 'data-blocks-engine-capture-existing-panel', snapshot => Object.fromEntries( Object.entries( snapshot ).map( ( [ key, phase ] ) => [
		key,
		phase && typeof phase === 'object' && 'html' in phase ? { ...phase, html: rewriteFragment( ( phase as { html: unknown } ).html ) } : phase,
	] ) ) );
	return $.html();
}

function rewriteRouteLinksIn(
	$: cheerio.CheerioAPI,
	documentUrl: string,
	routes: Map< string, string >,
	portable?: PortableLinkContext
): void {
	const comparisonRoutes = new Map([...routes].map(([url, path]) => [normalizedUrl(url), path]));
	// Document relations share navigation's route/source resolution. Resource
	// relations keep their asset localization, including alternate stylesheets.
	$( 'a[href],area[href],link[href],option[value]' ).each( ( _index, element ) => {
		const link = $( element );
		if ( element.tagName === 'link' ) {
			const relations = ( link.attr( 'rel' ) ?? '' ).toLowerCase().split( /\s+/ );
			if ( relations.some( relation => RESOURCE_LINK_RELATIONS.has( relation ) ) ||
				! relations.some( relation => DOCUMENT_LINK_RELATIONS.has( relation ) ) ) return;
		}
		const isOption = element.tagName === 'option';
		const attribute = isOption ? 'value' : 'href';
		const href = link.attr( attribute ) ?? '';
		// Options also carry application tokens. Only URL-shaped values participate,
		// and only a captured route match below may change them.
		if ( isOption && ! /^(?:https?:\/\/|\/)/i.test( href ) ) return;
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
		// Routes are keyed by the address they were captured at, usually the
		// capture origin. An uncaptured scheme or `www` variant of this site
		// names the same route on that origin.
		const onCaptureOrigin = onSiteOrigin( resolved, documentUrl );
		if ( onCaptureOrigin && ! routes.has( scopedRouteKey( resolved.href, portable?.routeScope ) ) ) resolved = onCaptureOrigin;
		// A platform link can share the origin and even the portable pathname,
		// yet belong to a different site. Preserve its authored destination.
		if ( !routeInScope( resolved.href, portable?.routeScope ) ) {
			// Preserve external authored URLs verbatim (URL#href would add a
			// trailing slash to an origin-only address), while resolving relative
			// links that fall outside an adapter's route scope as before.
			if ( absolute || isOption ) return;
			link.attr( 'href', resolved.href );
			return;
		}
		const route = routes.get( scopedRouteKey( resolved.href, portable?.routeScope ) );
		if ( route ) {
			link.attr( attribute, route.includes('#') ? route : `${ route }${ resolved.hash }` );
			return;
		}
		if ( isOption ) return;
		// Discovery folds slash variants. Exact captured addresses above still
		// take precedence for older inventories containing both spellings.
		if (portable?.boundaryRoutes?.has(documentRequestUrl(resolved.href))) {
			link.attr(attribute, resolved.href);
			return;
		}
		const slashRoute = comparisonRoutes.get(normalizedUrl(resolved.href));
		if (slashRoute) {
			link.attr(attribute, slashRoute.includes('#') ? slashRoute : `${slashRoute}${resolved.hash}`);
			return;
		}
		// A query that names one of the target page's own tabs selects a tab on
		// that captured page; it is not a different document.
		if ( resolved.search && portable?.tabKeysByRoute ) {
			const base = new URL( resolved.href );
			base.search = '';
			const baseKey = documentRequestUrl( base.href );
			const values = [ ...resolved.searchParams.values() ];
			const baseRoute = routes.get( baseKey );
			if ( baseRoute && values.length === 1 && portable.tabKeysByRoute.get( baseKey )?.has( values[ 0 ] ) ) {
				link.attr( 'href', `${ baseRoute }${ resolved.search }${ resolved.hash }` );
				return;
			}
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
}



/**
 * Builder runtimes write hydration IDs (`yui_3_17_2_1_<load time>_<n>`) that
 * name one page load, not a component. The same footer, form or popup then
 * differs on every route, so nothing downstream can share it. Rename each such
 * ID after its structural position, counted from the nearest ancestor with an
 * authored ID (or the document root), and rename its in-document references
 * with it. An ID that another retained file reads keeps its name. Exact
 * attribute and token rewrites keep unrelated source markup and SVGs intact.
 *
 * @return The rewritten document and the old-to-new ID map, so route evidence
 *         that names these IDs can follow.
 */
export function canonicalizeUnreferencedRuntimeIds(
	html: string,
	isExternallyReferenced: ( id: string ) => boolean = () => false
): { html: string; ids: Map< string, string > } {
	const ids = new Map< string, string >();
	if ( ! YUI_RUNTIME_ID.test( html ) ) return { html, ids };
	const $ = cheerio.load( html );
	const declared = new Map< string, number >();
	$( '[id]' ).each( ( _index, node ) => {
		const id = $( node ).attr( 'id' ) ?? '';
		declared.set( id, ( declared.get( id ) ?? 0 ) + 1 );
	} );
	const taken = new Set( declared.keys() );
	$( '[id]' ).each( ( _index, node ) => {
		const id = $( node ).attr( 'id' ) ?? '';
		if ( ! isYuiRuntimeId( id ) || declared.get( id ) !== 1 || isExternallyReferenced( id ) ) return;
		const segments: string[] = [];
		let element: Element | null = node;
		while ( element ) {
			let position = 0;
			for ( let sibling = element.prev; sibling; sibling = sibling.prev ) {
				if ( isElementNode( sibling ) && sibling.name === element.name ) position++;
			}
			segments.unshift( `${ element.name }:${ position }` );
			const parent: Element | null = element.parent && isElementNode( element.parent ) ? element.parent : null;
			const anchor = parent && ! [ 'html', 'body' ].includes( parent.name ) ? parent.attribs.id ?? '' : '';
			if ( anchor && ! isYuiRuntimeId( anchor ) ) {
				segments.unshift( `#${ anchor }` );
				break;
			}
			element = parent;
		}
		const stable = `data-blocks-engine-capture-shared-${ createHash( 'sha256' ).update( segments.join( '/' ) ).digest( 'hex' ).slice( 0, 16 ) }`;
		if ( taken.has( stable ) ) return;
		taken.add( stable );
		ids.set( id, stable );
	} );
	return { html: renameIdTokens( html, ids ), ids };
}

/** Rename whole ID tokens only: `yui_…_35` must not touch `yui_…_351`. */
export function renameIdTokens( text: string, ids: ReadonlyMap< string, string > ): string {
	if ( ! ids.size ) return text;
	const pattern = new RegExp( `${ RUNTIME_ID_TOKEN.source }`, 'g' );
	return text.replace( pattern, ( token ) => ids.get( token ) ?? token );
}

const DESKTOP_CAPTURE_WIDTH = 1440;

/**
 * Legacy width-only export fallback. These are stylesheet geometry boundaries,
 * not evidence of a device switch. A source-owned device or observed width
 * contract, or a route check's probed switch, bypasses this guess. The phone
 * document's own geometry evidence further bounds this fallback below.
 */
function fallbackResponsiveSwitchWidth( outputDir: string, belowWidth = DESKTOP_CAPTURE_WIDTH ): number | undefined {
	const path = join( outputDir, 'breakpoints.json' );
	if ( ! existsSync( path ) ) return undefined;
	try {
		const data = JSON.parse( readFileSync( path, 'utf8' ) ) as { maxWidth?: unknown };
		if ( ! Array.isArray( data.maxWidth ) ) return undefined;
		const candidates = data.maxWidth.filter(
			( width ): width is number =>
				typeof width === 'number' && Number.isInteger( width ) && width > 0 && width < belowWidth
		);
		return candidates.length > 0 ? Math.max( ...candidates ) : undefined;
	} catch {
		return undefined;
	}
}


/** A fixed phone document has no evidence supporting a tablet-width fallback. */
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

// A captured interaction state carries the HTML of a revealed panel. That HTML
// is serialized from the live DOM, so an image can name the exact CDN rendition
// the runtime chose for the viewport at the moment of capture. That rendition
// may never have been downloaded, but another rendition of the same image was.
// Point such a reference at the portable file for its media family.
function localizeFamilyMediaUrls(
	text: string,
	portableUrlByFamily: Map< string, string >
): string {
	if ( portableUrlByFamily.size === 0 || ! /\/\//.test( text ) ) return text;
	// Serialized markup keeps an author's protocol-relative `//host/path` as
	// written; it names the same media as its https spelling.
	return text.replace( /(?:https?:\/\/|(?<=^|[\s"'=(,])\/\/)[^\s"'<>)\\]+/gi, ( match ) => {
		try {
			const portable = portableUrlByFamily.get(
				mediaFamily( new URL( match.replace( /&amp;/g, '&' ), 'https://protocol-relative.invalid/' ).href )
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




function appendSourceData( html: string, sourceData: SourceDataScript[] ): string {
	if ( sourceData.length === 0 ) return html;
	const $ = cheerio.load( html );
	$( 'head' ).append( renderSourceData( sourceData ) );
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
 *  1. `a[data-blocks-engine-capture-anchor-fragment]` — anchors a platform's `prepare()` hook
 *     already resolved against its own click runtime (see AGENTS.md — Wix
 *     same-page anchors), carrying an optional `data-blocks-engine-capture-anchor-unresolved`
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

	$( 'a[data-blocks-engine-capture-anchor-fragment][href]' ).each( ( _index, element ) => {
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
		record( fragment, link.attr( 'data-blocks-engine-capture-anchor-unresolved' ) );
	} );

	$( 'a[href]' ).each( ( _index, element ) => {
		const link = $( element );
		if ( link.attr( 'data-blocks-engine-capture-anchor-fragment' ) !== undefined ) return; // handled above
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
 * absence or an external redirect, the route budget names the routes it left
 * out on purpose, and action URLs are never pages; all other missing pages
 * remain blocking.
 */
function uncapturedRouteAnchors(
	html: string,
	sourceUrl: string,
	capturedRoutes: Set< string >,
	absentRoutes: Set< string >,
	omittedRoutes: Set< string >,
	resourceInputs: Set< string >,
	routeScope?: SiteRouteScope,
	boundaryRoutes: Set<string> = new Set()
): Array< { sourceUrl: string; url: string; reason: string } > {
	const capturedIdentities = new Set([...capturedRoutes].filter(url => !boundaryRoutes.has(url)).map(normalizedUrl));
	return sameOriginPageAnchors( html, sourceUrl )
		.filter( url => routeInScope( url, routeScope ) )
		.map( url => scopedRouteKey( url, routeScope ) )
		.filter( ( url ) => ! capturedRoutes.has(url) && ! capturedIdentities.has( normalizedUrl( url ) ) )
		// Resource-owned links already have localization or explicit acquisition
		// diagnostics. Avoid duplicating those as missing HTML, without changing
		// the independent required frontier or its frozen outcome obligations.
		.filter( ( url ) => ! resourceInputs.has( url ) )
		.map( ( url ) => ( {
		sourceUrl,
		url,
		reason: absentRoutes.has( url ) ? 'target route is absent at source' : omittedRoutes.has( url ) ? OMITTED_ROUTE_REASON : stateChangingAction( url ) ? ACTION_URL_REASON : UNCAPTURED_ROUTE_REASON,
	} ) );
}

/**
 * Group screenshot-stage failures (goto timeouts, nested-document rejections,
 * etc.) by URL so a route that never produced HTML can report every viewport
 * failure that led there, instead of the receipt just losing the route. Each
 * reason keeps the capture profile (viewport) it failed in.
 */
function groupFailureReasonsByUrl(
	failures: Array< { url: unknown; error: unknown } >
): Map< string, Array< { profile: string; reason: string } > > {
	const byUrl = new Map< string, Array< { profile: string; reason: string } > >();
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
		list.push( { profile: viewport, reason: `${ viewport }/${ stage }: ${ error.split( '\n' )[ 0 ] }` } );
		byUrl.set( failure.url, list );
	}
	return byUrl;
}

export function exportWebsiteCapture( options: ExportCaptureOptions ): string {
	if ( options.routeScope ) {
		validateRouteScope( options.routeScope );
		if ( !routeInScope( options.sourceUrl, options.routeScope ) ) throw new Error( 'Source URL is outside its adapter route scope' );
	}
	const outputDir = resolve( options.outputDir );
	const screenshotManifestPath = join( outputDir, 'screenshots', 'manifest.json' );
	const httpInput = options.input ? loadHttpExportInput( outputDir, options.sourceUrl, options.input ) : undefined;
	const embedded = options.embeddedDocuments ? loadEmbeddedDocuments( outputDir ) : undefined;
	if ( embedded && ! httpInput ) throw new Error( 'Runtime attachments require explicit HTTP input' );
	const embeddedSources = new Set( Object.keys( embedded?.resources ?? {} ) );
	if ( embedded && httpInput && options.input ) {
		httpInput.diagnostics = httpInput.diagnostics.filter( diagnostic => {
			if ( diagnostic.code !== 'http_browser_region_unobserved' ) return true;
			return ! embedded.receipt.coverage?.some( coverage =>
				coverage.url === diagnostic.url &&
				diagnostic.reason.startsWith( `${ coverage.variant }: ${ coverage.selector }:` ) &&
				coverage.expectedNodes > 0 &&
				coverage.projectedIndices.length === coverage.expectedNodes
			);
		} );
		const projected = new Set<string>();
		for (const region of embedded.receipt.regions) {
			const key = JSON.stringify([region.url, region.variant, region.selector]);
			if (!projected.has(key)) httpInput.diagnostics.push({ code: 'http_runtime_region_projected', url: region.url, reason: `${region.variant}: ${region.selector}: observed at ${region.viewport?.width}px; rendering and interactions remain unverified` });
			projected.add(key);
		}
		for (const unresolved of embedded.receipt.unresolved ?? []) httpInput.diagnostics.push({ code: 'http_runtime_projection_unresolved', url: unresolved.url, reason: `${unresolved.variant}: ${unresolved.reason}` });
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
	// The third coarse sample is tablet. UA-selected phone documents must not
	// inherit desktop stylesheet boundaries, even when their geometry is fluid.
	const phoneSwitchWidth = httpInput ? undefined : fallbackResponsiveSwitchWidth( outputDir, COARSE_SWEEP_WIDTHS[ 2 ] );
	const budget = resolveExportTotalBudget( options.limits );
	// Build mutates manifest entries in place; a rebuild starts from the source.
	const pristineEntries = JSON.stringify( capture.entries );
	const receiptPath = publishExportGeneration( outputDir, ( stageDir ) => {
		let exclusions = emptyExportBudgetExclusions();
		for ( let pass = 1; ; pass++ ) {
			if ( pass > 1 ) {
				for ( const name of readdirSync( stageDir ) ) rmSync( join( stageDir, name ), { recursive: true, force: true } );
				capture.entries = JSON.parse( pristineEntries ) as ScreenshotManifest[ 'entries' ];
				if ( httpInput ) httpInput.entries = capture.entries as typeof httpInput.entries;
			}
			const built = withParsedDocuments( () => buildExportCapture( options, outputDir, capture, httpInput, embedded, embeddedSources, siteSwitchWidth, phoneSwitchWidth, stageDir, budget, exclusions ) );
			const plan = planExportBudget( { websiteDir: join( stageDir, 'website' ), budget, ...built, exclusions } );
			if ( plan.withinBudget || ! plan.next ) {
				recordExportBudget( stageDir, budget, plan, exclusions, pass );
				break;
			}
			exclusions = plan.next;
		}
	} );
	// Queued media lives outside the generation; relink what has landed (#1701).
	linkDeferredMedia( outputDir );
	recordMediaLedger( outputDir );
	return receiptPath;
}

/** Add the total budget outcome to the staged receipt and the log. */
function recordExportBudget( stageDir: string, budget: ExportTotalBudget, plan: { totalBytes: number; files: number; withinBudget: boolean }, exclusions: ExportBudgetExclusions, passes: number ): void {
	const exportBudget = {
		maxTotalBytes: budget.maxTotalBytes, maxFiles: budget.maxFiles,
		reservedBytes: budget.reservedBytes, reservedFiles: budget.reservedFiles,
		totalBytes: plan.totalBytes, files: plan.files, withinBudget: plan.withinBudget,
		droppedAssets: exclusions.assets.size, droppedRenditions: exclusions.renditions.size, droppedRoutes: exclusions.routes.size, passes,
	};
	const receiptPath = join( stageDir, 'capture-receipt.json' );
	const receipt = JSON.parse( readFileSync( receiptPath, 'utf8' ) ) as Record< string, unknown >;
	receipt.exportBudget = exportBudget;
	writeFileSync( receiptPath, `${ JSON.stringify( receipt, null, 2 ) }\n` );
	if ( exclusions.assets.size || exclusions.renditions.size || exclusions.routes.size || ! plan.withinBudget )
		process.stderr.write( `[budget] export website ${ plan.totalBytes } bytes in ${ plan.files } files (budget ${ budget.maxTotalBytes } bytes, ${ budget.maxFiles } files, ${ budget.reservedBytes } bytes reserved): dropped ${ exclusions.assets.size } assets, ${ exclusions.renditions.size } redundant renditions and ${ exclusions.routes.size } routes${ plan.withinBudget ? '' : '; entrypoint and its dependencies alone exceed the budget' }\n` );
}

function buildExportCapture(
	options: ExportCaptureOptions,
	outputDir: string,
	capture: ScreenshotManifest,
	httpInput: ReturnType< typeof loadHttpExportInput > | undefined,
	embedded: ReturnType< typeof loadEmbeddedDocuments > | undefined,
	embeddedSources: Set< string >,
	siteSwitchWidth: number | undefined,
	phoneSwitchWidth: number | undefined,
	stageDir: string,
	budget: ExportTotalBudget,
	exclusions: ExportBudgetExclusions,
): ExportBuild {
	// An explicit run budget (`--max-total-bytes`) is the single budget: media
	// may spend all of it, and the export total budget still bounds the site.
	const portableMediaTotalBytesLimit = Math.max(
		0,
		Math.floor( options.limits?.portableMediaTotalBytes ?? (
			options.limits?.maxTotalBytes !== undefined ? budget.maxTotalBytes - budget.reservedBytes : MAX_PORTABLE_MEDIA_TOTAL_BYTES
		) )
	);
	validateMaxFileBytes( options.limits?.maxFileBytes );
	const maxFileBytes = options.limits?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const websiteDir = join( stageDir, 'website' );
	const stagedHtmlDir = join( stageDir, '.capture-export-html' );
	mkdirSync( websiteDir, { recursive: true } );
	mkdirSync( stagedHtmlDir, { recursive: true } );

	const resourceManifest = capturedResources( outputDir );
	if ( embedded ) Object.assign( resourceManifest.resources, embedded.resources );
	// A route that was discovered and attempted must never disappear from the
	// receipt without a reason. Every screenshot-stage failure (goto timeouts,
	// nested-document rejections, etc.) is grouped by URL here so that a route
	// which never produced HTML gets its own named diagnostic below, extending
	// the same {code,url,reason} shape sitemap discovery already reports
	// rejected leaves through, rather than a parallel reporting mechanism.
	const routeFailureReasons = groupFailureReasonsByUrl( options.failures );
	const routeCaptureDiagnostics: RouteDiagnostic[] = [];
	const { capturedEntries, interactionPages, scrollStatesPages, excludedRoutes, redirectAliases, switchWidths, deviceSelections, widthSelections, fluidReports, responsiveBodyClassProjections, collapsedBodyClassProjections, diagnostics: capturedRouteDiagnostics } = collectCapturedRoutes( { entries: capture.entries, sourceUrl: options.sourceUrl, routeScope: options.routeScope, failures: options.failures, structuredEntries: options.structuredContent?.entries, deviceMode: options.deviceMode, input: options.input, resolveDocumentSelection: options.resolveDocumentSelection, outputDir, embedded, embeddedSources, hasHttpInput: Boolean( httpInput ), siteSwitchWidth, phoneSwitchWidth, stagedHtmlDir, resourceManifest, routeFailureReasons, maxFileBytes, budget, exclusions } );
	routeCaptureDiagnostics.push( ...capturedRouteDiagnostics );

	const {
		entrypointUrl, entrypointEntry, routePathOf, retainedEntries, duplicateRoutes,
		canonicalRouteAliases, portableRedirects, missingRedirectTargets, duplicateSourceData, pathCollisions,
	} = allocateCaptureRoutes(
		capturedEntries, options.sourceUrl, redirectAliases,
		// A homepage with no manifest entry (abandoned at its deadline, skipped by
		// the time budget) is explained only by the capture stage's rows.
		[ ...routeCaptureDiagnostics, ...( options.discoveryDiagnostics ?? [] ) ],
		options.canonicalAliases ?? []
	);
	// Like a route_export_failed route, a colliding route keeps only its route_path_collision row.
	const collidedUrls = new Set( pathCollisions.map( collision => collision.url ) );
	const keptDiagnostics = routeCaptureDiagnostics.filter( diagnostic => ! collidedUrls.has( diagnostic.url ) );
	routeCaptureDiagnostics.splice( 0, routeCaptureDiagnostics.length, ...keptDiagnostics, ...pathCollisions );
	for ( const { claimed, sourceData } of duplicateSourceData ) {
		writeFileSync( claimed.htmlPath, appendSourceData( readFileSync( claimed.htmlPath, 'utf8' ), sourceData ) );
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
	// Component-only lazy media is evidence even when absent from the initial route.
	for (const entry of retainedEntries) for (const reference of galleryFrameMediaUrls(entry.interactions?.states ?? [], entry.url, entry.interactions?.components)) {
		const indexed = assetReferenceLocations.locations.get(reference);
		if (indexed) continue;
		assetReferenceLocations.locations.set(reference, { count: 1, references: [{ route: entry.url, path: routePathOf(entry.url), document: 'component', reference }] });
		assetReferenceLocations.assetCount++;
		assetReferenceLocations.totalReferenceCount++;
	}
	// The bounded asset index is the last consumer of the normalized source
	// pair. Release every private pair, including unretained route aliases,
	// before rendering and building the portable/identity geometry indexes.
	for ( const entry of capturedEntries ) entry.evidenceDocuments.length = 0;
	const { mediaFamilies, failedMedia, mixedSrcsetReferences, interactionMediaReferences, retainedMediaFamilies, referencedImageAssets, imageByUrl, diagnostics: mediaCandidateDiagnostics } = collectMediaCandidates( { retainedEntries, outputDir, sourceUrl: options.sourceUrl, mediaStubs, exclusions, maxFileBytes } );
	routeCaptureDiagnostics.push( ...mediaCandidateDiagnostics );
	const portableMediaBudget = portableMediaTotalBytesLimit;
	const portableMediaPlan = planPortableMediaFamilies(
		[ ...mediaFamilies ].map( ( [ family, candidates ] ) => ( { family, candidates } ) ),
		portableMediaBudget,
		entrypointEntry.htmlPath,
	);
	const retainedReferences = new Map( retainedMediaFamilies );
	for ( const [ family, references ] of interactionMediaReferences ) {
		retainedReferences.set( family, [ ...new Set( [ ...( retainedReferences.get( family ) ?? [] ), ...references ] ) ] );
	}
	const mediaStage = materializePortableMedia( {
		websiteDir, plan: portableMediaPlan, maxBytes: portableMediaBudget,
		retainedReferences, failedMedia,
	} );
	let { mediaReplacements, portablePathsBySource } = mediaStage;
	// `assets` below grows with resources and stylesheets; keep what media wrote.
	const mediaAssetPaths = mediaStage.assets.map( asset => asset.path );
	const { portableUrlByFamily, assetPathsByHash, assetHashesByPath, assets, unresolvedMedia, portableMedia } = mediaStage;

	const resourceStage = materializePortableResources( {
		sourceRoot: outputDir,
		imageUrls: new Set( imageByUrl.keys() ),
		websiteDir,
		entries: retainedEntries,
		resourceManifest,
		mediaReplacements,
		assetPathsByHash,
		assetHashesByPath,
		portablePathsBySource,
		embeddedSources,
		maxFileBytes,
		excludedResources: exclusions.assets,
		excludedRenditions: exclusions.renditions,
		projectEmbeddedHtml: ( html ) => safeCapturedPageHtml( html ).html,
		deferredMedia: deferredMediaReferences( outputDir ),
	} );
	for ( const { url, bytes } of resourceStage.oversizedResources ) routeCaptureDiagnostics.push( assetExceedsFileLimit( url, bytes, maxFileBytes ) );
	// Every asset the budget dropped is reported, including one no retained page reaches any more.
	for ( const [ url, bytes ] of exclusions.assets ) routeCaptureDiagnostics.push( assetExceedsTotalBudget( url, bytes, budget ) );
	// Redundant renditions the budget retired are reported like other budget losses.
	for ( const [ url, bytes ] of exclusions.renditions ) routeCaptureDiagnostics.push( redundantRenditionDropped( url, bytes, budget ) );
	mediaReplacements = resourceStage.mediaReplacements;
	portablePathsBySource = resourceStage.portablePathsBySource;
	const unresolvedMediaReasons = new Map( unresolvedMedia.map( ( { url, error } ) => [ url, error ] ) );
	// Acquisition inventories every captured document, including discarded route
	// aliases. Only uses retained by candidate collection can be export failures.
	for ( const record of referencedImageAssets ) {
		if ( ! record.original || ! portablePathsBySource.has( record.original.source_url ) ) routeCaptureDiagnostics.push( { code: ! record.kind || record.kind === 'image' ? 'image_resource_unresolved' : 'asset_resource_unresolved', url: record.source_urls[ 0 ], reason: unresolvedMediaReasons.get( record.original?.source_url ?? record.resolved_original ) ?? record.source_urls.map( url => unresolvedMediaReasons.get( url ) ).find( Boolean ) ?? record.error ?? 'Verified resource original could not be exported within the portable limits', unit: 'asset', severity: 'error' } );
	}
	assets.push( ...resourceStage.assets );
	const { resourceReplacements, unresolvedDependencies, rejectedReplacementKeys } = resourceStage;
	const stylesheetStage = materializeSharedStylesheets( {
		entries: retainedEntries, websiteDir, sourceUrl: options.sourceUrl,
		mediaReplacements, resourceReplacements, rejectedReplacementKeys,
	} );
	assets.push( ...stylesheetStage.assets );
	const replaceMedia = preparePortableReplacements( mediaReplacements, rejectedReplacementKeys );
	const replaceResources = preparePortableReplacements( resourceReplacements, rejectedReplacementKeys );
	const portableMediaReplacements = omitDegenerateReplacements( mediaReplacements, rejectedReplacementKeys );

	const { routes, sourceRouteLinks, portableServedPaths, unresolvedAnchors, boundaryRoutes, capturedRouteKeys, absentRoutes, absentRouteKeys, omittedRouteKeys, resourceInputKeys, verifiedRouteObservations } = collectRouteLinks( { retainedEntries, routePathOf, structuredContent: options.structuredContent, sourceUrl: options.sourceUrl, canonicalRouteAliases, mediaReplacements, resourceReplacements, stylesheetServedPaths: stylesheetStage.servedPaths, entries: capture.entries, routeCaptureDiagnostics, outputDir, discoveryDiagnostics: options.discoveryDiagnostics, unresolvedDependencies } );
	const responsiveIdentities = { ids: new Map<string, string | string[]>(), namedAliases: false, svgIds: new Set<string>() };
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
	// the portable pages, so clean their embedded HTML before replay wiring encodes
	// it in JSON attributes/scripts. Keep runtime contract attributes intact.
	const intrinsicWidths = new Map< string, number | undefined >();
	const truthfulMixedSrcsets = ( html: string ): string => html.replace(
		/(\s(?:data-)?srcset\s*=\s*)(["'])([\s\S]*?)\2/gi,
		( attribute, prefix: string, quote: string, value: string ) => {
			const candidates = srcsetCandidates( value.replace( /&amp;/g, '&' ) );
			if ( ! candidates.some( candidate => mixedSrcsetReferences.has( candidate.url ) ) ||
				candidates.some( candidate => candidate.density || candidate.size <= 1 ) ) return attribute;
			const seen = new Set< string >();
			const retained = candidates.flatMap( candidate => {
				const selected = mixedSrcsetReferences.get( candidate.url );
				if ( selected && ! selected.has( candidate.url ) ) return [];
				const local = portableMediaReplacements.get( candidate.url );
				const identity = local ?? candidate.url;
				if ( seen.has( identity ) ) return [];
				seen.add( identity );
				let descriptor = `${ candidate.size }${ candidate.density ? 'x' : 'w' }`;
				if ( selected && local?.startsWith( '/media/' ) && ! candidate.density ) {
					if ( ! intrinsicWidths.has( local ) ) {
						try {
							intrinsicWidths.set( local, imageSize( readFileSync( join( websiteDir, local ) ) ).width );
						} catch {
							// Unsupported image formats retain their captured width evidence.
							intrinsicWidths.set( local, undefined );
						}
					}
					const width = intrinsicWidths.get( local );
					if ( width && Math.abs( width - parseFloat( descriptor ) ) > 0.5 ) descriptor = `${ width }w`;
				}
				return [ `${ candidate.url }${ descriptor ? ` ${ descriptor }` : '' }` ];
			} );
			return `${ prefix }${ quote }${ retained.join( ', ' ).replace( /&/g, '&amp;' ) }${ quote }`;
		}
	);
	const localizeInteractionMedia = ( text: string, documentUrl: string ): string =>
		localizeFamilyMediaUrls(
			withoutCaptureBookkeeping( replaceResources( replaceMedia( text ), documentUrl ) ),
			portableUrlByFamily
		);
	for ( const entry of retainedEntries ) {
		if ( entry.interactions ) localizeStringsInPlace( entry.interactions, text => localizeInteractionMedia( text, entry.url ) );
	}
	// Give every selectable-set tab trigger its source key, so a consumer can
	// match `?tab=<key>` links and select the tab without knowing the platform.
	const tabKeysByRoute = new Map< string, Set< string > >();
	for ( const entry of retainedEntries ) {
		for ( const state of entry.interactions?.states ?? [] ) {
			if ( state.kind !== 'selectable-set' ) continue;
			const key = tabKeyOfTrigger( state.trigger );
			if ( ! key ) continue;
			( state.trigger as { tabKey?: string } ).tabKey = key;
			const routeKey = documentRequestUrl( entry.url );
			tabKeysByRoute.set( routeKey, ( tabKeysByRoute.get( routeKey ) ?? new Set() ).add( key ) );
		}
	}
	const metadataPathsBySource = new Map( [ ...mediaStage.metadataPathsBySource, ...portablePathsBySource ] );
	for ( const entry of retainedEntries ) {
		const { url, htmlPath } = entry;
		const routePath = routePathOf( url );
		const destination = join( websiteDir, routePath );
		if ( ! pathWithin( websiteDir, destination ) ) {
			throw new Error( `Captured route escapes the website directory: ${ url }` );
		}
		mkdirSync( dirname( destination ), { recursive: true } );
		const originalHtml = readFileSync( htmlPath, 'utf8' );
		unresolvedAnchors.push( ...uncapturedRouteAnchors( originalHtml, url, capturedRouteKeys, absentRouteKeys, omittedRouteKeys, resourceInputKeys, options.routeScope, boundaryRoutes ) );
		// Rewrite route links once, after wiring dialogs below. A portable path
		// can also name a source route that was allocated a different filename.
		const identityHtml = localizeMetadataImageReferences( originalHtml, url, metadataPathsBySource, content => bindSrcsetShapedImageSrc(
			localizeDataAttributeMedia(
				replaceResources(
					rewriteMediaUrls(
						truthfulMixedSrcsets( content ),
						portableMediaReplacements
					),
					url
				),
				portableUrlByFamily
			)
		) );
		const normalizedHtml = routePhoneDocumentFragments(
			rewriteCapturedRouteLinks(
				wireCapturedRouteNavigation(
					wireCapturedDialogs(
						wireCapturedComponents( withoutCaptureBookkeeping( identityHtml ), entry.interactions ? routeComponents( entry.interactions ) : [] ),
						entry.interactions ? componentReplayStates( routeComponents( entry.interactions ) ) : [],
						entry.interactions?.initialDialogs ?? []
					),
					verifiedRouteObservations
				),
				url,
				sourceRouteLinks,
				{ documentPath: `/${ routePath }`, servedPaths: portableServedPaths, routeScope: options.routeScope, tabKeysByRoute, boundaryRoutes }
			),
			`/${ routePath }`, responsiveIdentities,
			reason => routeCaptureDiagnostics.push( { code: 'stylesheet_unparseable', url, reason, unit: 'stylesheet', severity: 'warning', path: `website/${ routePath }` } )
		);
		unresolvedAnchors.push(
			...unresolvedCapturedAnchors( normalizedHtml, url, `/${ routePath }` )
		);
		writeFileSync( destination, namespaceExportBoxTreeIds( wireNativeControlState( wireNativeViewTimelines( withViewportEntrances( normalizedHtml ) ) ) ) );
		entry.identityHtmlPath = `${ htmlPath }.identity`;
		writeFileSync( entry.identityHtmlPath, identityHtml );
	}
	const inventory = new WebsiteInventory( websiteDir );
	selfContainWebsite( websiteDir, inventory );
	// Author identity selectors can live in linked/imported stylesheets, not
	// only inline <style>. Project the localized copies with the same primitive.
	if ( responsiveIdentities.ids.size || responsiveIdentities.namedAliases || responsiveIdentities.svgIds.size || responsiveBodyClassProjections.size || collapsedBodyClassProjections.size ) {
		for ( const file of inventory.traversalFiles ) {
			if ( file.isSymlink || ! file.path.endsWith( '.css' ) ) continue;
			const path = join( websiteDir, file.path );
			const original = readFileSync( path, 'utf8' );
			const projected = projectStylesheet(
				() => {
					let css = projectResponsiveIdentityCss( projectResponsiveSvgCss( original, responsiveIdentities.svgIds ), responsiveIdentities.ids, responsiveIdentities.namedAliases );
					for ( const { moved, documentClasses } of responsiveBodyClassProjections.values() ) css = projectResponsiveBodyClassCss( css, moved, true, documentClasses );
					for ( const { moved, aliases, width } of collapsedBodyClassProjections.values() ) css = projectCollapsedBodyClassCss( css, moved, aliases, width );
					return css;
				},
				reason => routeCaptureDiagnostics.push( { code: 'stylesheet_unparseable', url: options.sourceUrl, reason, unit: 'stylesheet', severity: 'warning', path: relative( stageDir, path ).replace( /\\/g, '/' ) } )
			);
			if ( projected !== undefined && original !== projected ) {
				writeFileSync( path, projected );
				inventory.add( file.path );
			}
		}
	}
	projectPortableResourceIntegrity( websiteDir, resourceStage.sourceHashesByPortablePath, inventory );
	const portableTexts = inventory.textReferences();
	const externallyReferenced = portableTexts && indexRuntimeIdReferences( portableTexts );
	if ( portableTexts && externallyReferenced ) for ( const entry of retainedEntries ) {
		const path = join( websiteDir, routePathOf( entry.url ) );
		const html = readFileSync( path, 'utf8' );
		const stable = canonicalizeUnreferencedRuntimeIds( html, id => externallyReferenced( id, path ) );
		if ( ! stable.ids.size ) continue;
		writeFileSync( path, stable.html );
		inventory.add( routePathOf( entry.url ) );
		// Interaction evidence names the same elements; keep it in step.
		const interactions = interactionPages.indexOf( entry.interactions! );
		if ( interactions >= 0 ) interactionPages[ interactions ] = JSON.parse( renameIdTokens( JSON.stringify( interactionPages[ interactions ] ), stable.ids ) );
		const scroll = scrollStatesPages.indexOf( entry.scrollStates! );
		if ( scroll >= 0 ) scrollStatesPages[ scroll ] = JSON.parse( renameIdTokens( JSON.stringify( scrollStatesPages[ scroll ] ), stable.ids ) );
	}
	if ( options.structuredContent?.entries.length ) {
		const { source, entries } = options.structuredContent;
		const content = structuredContentIndex( entries, routes, source, options.sourceUrl );
		for ( const term of content.terms ) {
			if ( routes.some( route => route.url === term.sourceUrl ) ) continue;
			const page = cheerio.load( '<!doctype html><html><head><meta charset="utf-8"><title></title></head><body><main><h1></h1><ul></ul></main></body></html>' );
			page( 'title, h1' ).text( term.name );
			for ( const post of content.posts.filter( post => post.terms.includes( term.name ) ) ) {
				const item = page( '<li><a></a></li>' );
				item.find( 'a' ).attr( 'href', post.path ).text( post.title );
				page( 'ul' ).append( item );
			}
			const file = join( websiteDir, term.path );
			if ( existsSync( file ) ) continue; // Never replace a captured resource.
			mkdirSync( dirname( file ), { recursive: true } );
			writeFileSync( file, page.html() );
			inventory.add( relative( websiteDir, file ).replace( /\\/g, '/' ) );
			routes.push( { url: term.sourceUrl, path: `website${ term.path }` } );
		}
		writeFileSync( join( websiteDir, 'content-index.json' ), JSON.stringify( content, null, 2 ) );
		inventory.add( 'content-index.json' );
		for ( const redirect of content.redirects ) {
			const from = new URL( redirect.from ).pathname;
			if ( from !== redirect.to && ! portableRedirects.some( rule => rule.from === from ) ) portableRedirects.push( { from, to: redirect.to } );
		}
	}
	const redirectsFile = portableRedirectsFile( portableRedirects );
	if ( redirectsFile ) {
		writeFileSync( join( websiteDir, '_redirects' ), redirectsFile );
		inventory.add( '_redirects' );
	}
	exportPublicationBoundary( EXPORT_PUBLICATION_BOUNDARIES.afterHtml );

	writeCaptureEvidence( {
		inventory,
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
		routes: { retained: routes, links: sourceRouteLinks, excluded: excludedRoutes, duplicates: duplicateRoutes },
		states: { interactions: interactionPages, scroll: scrollStatesPages },
		layout: { fluidReports, switchWidths, deviceSelections, widthSelections },
		assets: {
			references: assetReferenceLocations, stubs: mediaStubs, manifest: resourceManifest,
			portablePaths: portablePathsBySource, files: assets, media: portableMedia,
		},
		semantic: semanticEvidence,
		diagnostics: {
			capture: routeCaptureDiagnostics, dependencies: unresolvedDependencies,
			media: unresolvedMedia, anchors: unresolvedAnchors, rejectedKeys: rejectedReplacementKeys,
			styles: stylesheetStage.diagnostics,
		},
	} );
	// Evidence describes expanded bytes. Compact afterwards in the same publication.
	extractSharedChrome( websiteDir, routes.map( route => route.path.replace( /^website\//, '' ) ), inventory );
	const boxReports = writeExportBoxTrees( outputDir, websiteDir, retainedEntries.flatMap( entry => {
		const sourcePath = capture.entries[ entry.url ]?.html;
		return sourcePath ? [ { sourcePath, mobileSourcePath: capture.entries[ entry.url ]?.mobileHtml, middleSourcePath: capture.entries[ entry.url ]?.profiles?.middle?.html, path: routePathOf( entry.url ) } ] : [];
	} ), inventory );
	if ( boxReports.length ) {
		const receiptPath = join( stageDir, 'capture-receipt.json' );
		const receipt = JSON.parse( readFileSync( receiptPath, 'utf8' ) );
		receipt.reports = [ ...receipt.reports, ...boxReports ].sort();
		writeFileSync( receiptPath, `${ JSON.stringify( receipt, null, 2 ) }\n` );
	}
	// Media and page resources are the assets export can leave out; generated
	// stylesheets and sidecars only shrink with the routes that need them.
	const droppable = new Map< string, string[] >();
	const droppablePaths = new Set( [ ...mediaAssetPaths, ...resourceStage.assets.map( asset => asset.path ) ] );
	for ( const [ sourceUrl, path ] of portablePathsBySource ) {
		if ( droppablePaths.has( path ) ) droppable.set( path, [ ...( droppable.get( path ) ?? [] ), sourceUrl ] );
	}
	const websiteRelative = ( path: string ) => path.replace( /^website\//, '' );
	return {
		inventory,
		entrypointPath: routePathOf( entrypointUrl ).replace( /\\/g, '/' ),
		routes: routes.map( route => ( { url: route.url, path: websiteRelative( route.path ) } ) ),
		assets: [ ...droppable ].map( ( [ path, sourceUrls ] ) => ( { path: websiteRelative( path ), sourceUrls: sourceUrls.sort() } ) ).sort( ( a, b ) => ( a.path < b.path ? -1 : a.path > b.path ? 1 : 0 ) ),
	};
}
