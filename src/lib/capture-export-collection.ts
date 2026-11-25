import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as cheerio from 'cheerio';
import { imageSize } from 'image-size';
import { readAssets, type AssetRecord } from './image-assets.js';
import { readDocument } from './parsed-documents.js';
import { canonicalLinkHref, entrypointCanonicalHost, rebaseCanonicalUrl } from './route-aliases.js';
import { assembleDeviceDocuments, installDeviceSelection, type DocumentSelection } from './document-selection.js';
import type { AccessGateEvidence } from './access-gate.js';
import { capturedStyleHoistContext, type StyleHoistContext } from './shared-stylesheets.js';
import type { RouteDiagnostic } from './capture-export-routes.js';
import { IntegrityError, isIntegrityError } from './failure-class.js';
import type { SourceDataScript } from './source-data.js';
import { sameHttpSite } from './screenshot/same-origin.js';
import { normalizedUrl, documentRequestUrl } from './url/route-key.js';
import { budgetOmittedRoutes } from './capture-usability.js';
import { routeInScope } from './url/route-scope.js';
import type { SiteRouteScope, StructuredContentSource, StructuredContentEntry } from '../platform/types.js';
import { indexPortableMediaReferences, mediaReferenceMatched, type PortableMediaCandidate } from './portable-media-plan.js';
import { assembleResponsiveCapture, DEFAULT_SWITCH_WIDTH, DESKTOP_DOCUMENT_CLASS, MOBILE_DOCUMENT_CLASS, responsiveMovedBodyClasses, type ResponsiveVariantEvidence } from './responsive-assembly.js';
import { MediaStubStore } from './resume-state/index.js';
import { failuresAreAbsentDocument, isAbsentDocumentRender, isEmptyDocumentRender, isSourceCaptureUrl } from './screenshot/absent-document.js';
import { INTERACTION_STATES_SCHEMA, LEGACY_INTERACTION_STATES_SCHEMA, type InteractionStatesReport } from './screenshot/interaction-capture.js';
import { SCROLL_STATES_SCHEMA, type ScrollStatesReport } from './screenshot/scroll-state-capture.js';
import type { CapturedResourceManifest } from './screenshot/resource-capture.js';
import { galleryFrameMediaUrls } from './screenshot/gallery-capture.js';
import { NON_DOCUMENT_URL } from './screenshot/linked-frontier.js';
import { srcsetReferences } from './srcset.js';
import { declaredFragmentTargets, resolveDocumentReferences, type DocumentReferenceOptions } from './document-resource-base.js';
import { pathWithin } from './portable-assets.js';
import type { FailedPortableMedia } from './portable-media.js';
import { elementSrcReferences } from './portable-references.js';
import { assertPageWithinFileLimit, assetExceedsFileLimit } from './export-file-limit.js';
import { routeExceedsTotalBudget, type ExportBudgetExclusions, type ExportTotalBudget } from './export-total-budget.js';
import type { CaptureFluidEvidence, CaptureDocumentFluidEvidence } from './capture-export-evidence.js';
import { inspectSourceInteractivity, type SourceInteractivityPage } from './source-interactivity.js';
import type { HttpExportInput } from './http-export-input.js';
import { projectEmbeddedRegions, projectRuntimePresentation, mergeResponsiveEmbeddedRegions, loadEmbeddedDocuments } from './embedded-documents.js';
import { lowerScriptedLinks } from './screenshot/scripted-links.js';
import { MIDDLE_PROFILE_ID, type MiddleLayout, type DeviceMode } from './screenshot/device-mode.js';
import { withoutPlatformDefaultIcons } from './platform-default-icons.js';
import { structuredContentIndex } from './content-index.js';
import { normalizedDeclarativeFormEmbeds, renderedHtml, safeCapturedPageHtml } from './captured-page-html.js';

export interface CaptureManifestEntry {
	documents?: import('./screenshot/manifest-queue.js').ManifestEntry['documents'];
	profiles?: import('./screenshot/manifest-queue.js').ManifestEntry['profiles'];
	nativeViewTimelines?: import('./screenshot/manifest-queue.js').ManifestEntry['nativeViewTimelines'];
	scriptedLinks?: import('./screenshot/manifest-queue.js').ManifestEntry['scriptedLinks'];
	blockLosses?: import('./screenshot/manifest-queue.js').ManifestEntry['blockLosses'];
	cleanup?: import('./screenshot/manifest-queue.js').ManifestEntry['cleanup'];
	accessGate?: AccessGateEvidence;
	slug?: string;
	html?: string;
	mobileHtml?: string;
	/** Same-origin route the server redirected this URL to; see ManifestEntry. */
	redirectedTo?: string;
	/** The phone identity was sent to this same-site route; the route ships its desktop document only. */
	phoneSentTo?: string;
	/** Bounded source inspection of a linked route absent from the capture schedule. */
	externalRedirect?: boolean;
	sourceOutcomes?: import('./source-navigation.js').ExternalBoundary[];
	sourceAbsentStatus?: 404 | 410;
	sections?: string;
	interactions?: InteractionStatesReport;
	scrollStates?: ScrollStatesReport;
	/** Responsive learning outcome recorded during capture. */
	fluid?: CaptureFluidEvidence;
	fluidMobile?: CaptureFluidEvidence;
	deviceMode?: import('./screenshot/device-mode.js').RouteDeviceDecision;
	metadata?: {
		openGraph?: Record< string, string >;
	};
}

export interface ScreenshotManifest {
	version: 1;
	entries: Record< string, CaptureManifestEntry >;
}

type MediaCandidate = PortableMediaCandidate;

export interface CaptureEntry {
	slug: string;
	url: string;
	htmlPath: string;
	evidenceDocuments: Array< { state: 'desktop' | 'mobile'; html: string } >;
	/** The source served a structurally distinct document under mobile emulation. */
	hasMobileDocument?: boolean;
	/** Receipt evidence for how many responsive variants this route ships and why. */
	responsiveVariants?: ResponsiveVariantEvidence;
	documentSelection?: { kind: 'device'; id: string; documents: string[]; missing: string[]; evidence: string } | { kind: 'width'; switchWidth: number; evidence: string };
	fluidGeometry?: CaptureDocumentFluidEvidence;
	/** Captured as a placeholder for a provider-gated route (see access-gate.ts). */
	accessGate?: AccessGateEvidence;
	identityHtmlPath?: string;
	sections?: string;
	canonicalUrl?: string;
	canonicalLinkUrl?: string;
	sourceData: SourceDataScript[];
	interactions?: InteractionStatesReport;
	scrollStates?: ScrollStatesReport;
	styleHoistContext: StyleHoistContext;
	sourceInteractivity: SourceInteractivityPage;
}

function phoneResponsiveSwitchWidth( entry: CaptureManifestEntry, stylesheetWidth: number | undefined ): number | undefined {
	const width = entry.profiles?.mobile?.viewport.width;
	if ( ! width ) return stylesheetWidth;
	const fluid = entry.fluidMobile;
	const responsive = fluid && fluid.applied > 0 &&
		fluid.sampledWidths?.some( sampled => sampled > width ) &&
		Object.entries( fluid.byKind ).some( ( [ kind, count ] ) =>
			count > 0 && ! [ 'constant', 'breakpoint', 'viewport-height' ].includes( kind ) );
	return responsive ? stylesheetWidth : Math.min( width, stylesheetWidth ?? width );
}

function mediaReferences( sourceUrl: string, siteUrl: string ): string[] {
	const media = new URL( sourceUrl );
	const site = new URL( siteUrl );
	if ( media.origin !== site.origin ) return [ sourceUrl ];
	if ( media.pathname === '/' ) return [ sourceUrl ];
	return [ sourceUrl, `${ media.pathname }${ media.search }` ];
}

function retainedMediaReferenceInventory( entries: CaptureEntry[] ): {
	rendered: Map< string, Set< string > >;
	retained: Map< string, string[] >;
	dimensions: Map< string, number >;
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
	const dimensions = new Map< string, number >();
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
		const $ = readDocument( html );
		$( 'img,source,video,audio' ).each( ( _index, element ) => {
			const node = $( element );
			const src = node.attr( 'src' );
			// Use authored/serialized pixel geometry when present; never infer
			// rendered size from the CDN rendition's intrinsic dimensions.
			const edge = ( name: string ): number => {
				const inline = new RegExp( `(?:^|;)\\s*${ name }\\s*:\\s*([\\d.]+)px(?:\\s*!important)?\\s*(?:;|$)`, 'i' ).exec( node.attr( 'style' ) ?? '' );
				const value = inline?.[ 1 ] ?? node.attr( name ) ?? '';
				return /^\d+(?:\.\d+)?$/.test( value ) ? Number( value ) : 0;
			};
			const dimension = Math.max( edge( 'width' ), edge( 'height' ) );
			const family = src && familyOf( src );
			if ( family && dimension > 0 ) dimensions.set( family, Math.max( dimensions.get( family ) ?? 0, dimension ) );
			const tag = String( node.prop( 'tagName' ) ?? '' ).toLowerCase();
			if ( src ) {
				for ( const reference of elementSrcReferences( tag, src ) ) add( reference );
			}
			const srcset = node.attr( 'srcset' );
			if ( ! srcset ) return;
			for ( const candidate of srcsetReferences( srcset ) ) add( candidate );
		} );
	}
	return { rendered, retained, dimensions };
}

export function mediaFamily( sourceUrl: string ): string {
	const url = new URL( sourceUrl );
	const transformedPath = /^(.*?)\/v1\/(?:fill|fit|crop)\//i.exec( url.pathname )?.[ 1 ];
	if ( transformedPath ) return `${ url.origin }${ transformedPath }`;
	// WordPress rendition suffixes describe the same uploaded photograph.
	const photoPath = url.pathname.replace( /(?:-(?:\d+x\d+|scaled(?:-\d+)?))+(?=\.[^.\/]+$)/i, '' );
	if ( photoPath !== url.pathname && ! url.search ) return `${ url.origin }${ photoPath }`;
	const parameters = [ ...url.searchParams.keys() ];
	return parameters.length > 0 && parameters.every( ( key ) => key === 'w' || key === 'h' )
		? `${ url.origin }${ url.pathname }`
		: sourceUrl;
}

export function mediaDimension( sourceUrl: string ): number {
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

function openGraphUrl( html: string ): string | undefined {
	return readDocument( html )( 'meta[property="og:url"]' ).first().attr( 'content' );
}

function canonicalMetadataUrl( value: unknown, documentUrl: string, routeScope?: SiteRouteScope, sourceUrl = documentUrl, aliasHost?: string ): string | undefined {
	if ( typeof value !== 'string' || value.trim() === '' ) return undefined;
	try {
		const resolved = rebaseCanonicalUrl( new URL( value, documentUrl ), sourceUrl, aliasHost );
		if ( resolved.protocol !== 'http:' && resolved.protocol !== 'https:' ) return undefined;
		if ( !routeInScope( resolved.href, routeScope ) ) return undefined;
		return resolved.href;
	} catch {
		return undefined;
	}
}


export interface CapturedRoutes {
 capturedEntries: CaptureEntry[]; interactionPages: InteractionStatesReport[]; scrollStatesPages: ScrollStatesReport[]; excludedRoutes: string[]; diagnostics: RouteDiagnostic[];
 redirectAliases: Array<{ url: string; target: string }>; switchWidths: number[];
 deviceSelections: Array<{ url: string; id: string; documents: string[]; missing: string[]; evidence: string }>;
 widthSelections: Array<{ url: string; kind: 'width'; switchWidth: number; evidence: string }>; fluidReports: CaptureFluidEvidence[];
 responsiveBodyClassProjections: Map<string, { moved: ReadonlyMap<string, string>; documentClasses?: readonly string[] }>;
 collapsedBodyClassProjections: Map<string, { moved: Map<string, string>; aliases: Map<string, string>; width: number }>;
}
export interface MediaCandidates {
 mediaFamilies: Map<string, MediaCandidate[]>; failedMedia: FailedPortableMedia[]; mixedSrcsetReferences: Map<string, Set<string>>; diagnostics: RouteDiagnostic[];
 interactionMediaFamilies: Set<string>; interactionMediaReferences: Map<string, Set<string>>; probeReferences: string[]; retainedMediaFamilies: Map<string, string[]>;
 imageAssets: AssetRecord[]; referencedImageAssets: Set<AssetRecord>; imageByUrl: Map<string, AssetRecord>;
}
export interface RouteLinks {
 routes: Array<{ url: string; path: string; accessGate?: AccessGateEvidence }>; sourceRouteLinks: Map<string, string>; portableServedPaths: Set<string>;
 unresolvedAnchors: Array<{ sourceUrl: string; reason: string; fragment?: string; targetCount?: number; url?: string }>;
 boundaryRoutes: Set<string>; capturedRouteKeys: Set<string>; absentRoutes: Set<string>; absentRouteKeys: Set<string>; omittedRouteKeys: Set<string>; resourceInputKeys: Set<string>;
 verifiedRouteObservations: NonNullable<InteractionStatesReport['routeNavigation']>;
}
/**
 * Answers which captured route documents declare a fragment, so a fragment-only
 * link that a `<base>` sends to another captured document can be checked against
 * that document. Each document is parsed only when a link names it.
 */
export function capturedDocumentReferences( entries: ScreenshotManifest['entries'], outputDir: string ): DocumentReferenceOptions {
	const paths = new Map< string, string >();
	for ( const [ url, entry ] of Object.entries( entries ) ) {
		if ( ! entry.html || entry.redirectedTo || entry.sourceAbsentStatus ) continue;
		const path = resolve( outputDir, entry.html );
		if ( ! pathWithin( outputDir, path ) ) continue;
		for ( const documentUrl of [ url, entry.documents?.desktop?.url ] ) {
			if ( documentUrl && ! paths.has( normalizedUrl( documentUrl ) ) ) paths.set( normalizedUrl( documentUrl ), path );
		}
	}
	const targets = new Map< string, Set< string > | undefined >();
	return {
		fragmentDeclaredAt( documentUrl, fragment ) {
			const key = normalizedUrl( documentUrl );
			if ( ! targets.has( key ) ) {
				const path = paths.get( key );
				targets.set( key, path && existsSync( path ) ? declaredFragmentTargets( cheerio.load( readFileSync( path, 'utf8' ) ) ) : undefined );
			}
			return targets.get( key )?.has( fragment );
		},
	};
}

/** What one route contributes to the export; plain data, so it can cross a worker boundary. */
export interface CollectedRoute {
	diagnostics: RouteDiagnostic[];
	excluded?: boolean;
	redirectAlias?: { url: string; target: string };
	switchWidths: number[];
	deviceSelections: CapturedRoutes['deviceSelections'];
	widthSelections: CapturedRoutes['widthSelections'];
	fluidReports: CaptureFluidEvidence[];
	entry?: CaptureEntry;
	responsiveProjection?: [ string, { moved: ReadonlyMap<string, string>; documentClasses?: readonly string[] } ];
	collapsedProjection?: [ string, { moved: Map<string, string>; aliases: Map<string, string>; width: number } ];
}

/** A route collection that failed: an integrity failure fails the export, any other drops the route. */
export interface FailedRouteCollection { failed: { message: string; integrity: boolean } }

export interface RouteCollectionContext {
	sourceUrl: string; routeScope?: SiteRouteScope; failures: Array<{ url: unknown; error: unknown }>; structuredEntries?: StructuredContentEntry[];
	deviceMode?: DeviceMode; input?: HttpExportInput; resolveDocumentSelection?: ( documents: Readonly<Record<string, string>> ) => DocumentSelection | undefined;
	outputDir: string; embedded: ReturnType<typeof loadEmbeddedDocuments> | undefined; embeddedSources: Set<string>; hasHttpInput: boolean; siteSwitchWidth: number | undefined; phoneSwitchWidth: number | undefined;
	resourceManifest: CapturedResourceManifest; routeFailureReasons: Map<string, Array<{ profile: string; reason: string }>>; maxFileBytes: number; canonicalHost: string | undefined; documentReferences: DocumentReferenceOptions;
}

/** The host the entrypoint names itself by, which canonical metadata on every route is rebased onto. */
export function captureCanonicalHost( entries: ScreenshotManifest['entries'], sourceUrl: string, outputDir: string ): string | undefined {
	const homepage = Object.entries( entries ).find( ( [ url ] ) => isSourceCaptureUrl( url, sourceUrl ) )?.[ 1 ];
	if ( ! homepage?.html ) return undefined;
	const path = resolve( outputDir, homepage.html );
	if ( ! pathWithin( outputDir, path ) || ! existsSync( path ) ) return undefined;
	return entrypointCanonicalHost( sourceUrl, readFileSync( path, 'utf8' ), homepage.metadata?.openGraph?.[ 'og:url' ] );
}

/**
 * Turn one manifest entry into its export contribution. Each route reads only
 * its own documents and the shared context, so routes collect independently;
 * `stageHtml` stores the assembled page and returns its path.
 */
export function collectCapturedRoute( url: string, entry: CaptureManifestEntry, context: RouteCollectionContext, stageHtml: ( html: string ) => string ): CollectedRoute {
	const { sourceUrl, routeScope, failures, structuredEntries, deviceMode: siteDeviceMode, input, resolveDocumentSelection, outputDir, embedded, embeddedSources, hasHttpInput, siteSwitchWidth, phoneSwitchWidth, resourceManifest, routeFailureReasons, maxFileBytes, canonicalHost, documentReferences } = context;
	const result: CollectedRoute = { diagnostics: [], switchWidths: [], deviceSelections: [], widthSelections: [], fluidReports: [] };
	if ( ! routeMatchesSourceOrigin( url, sourceUrl ) || !routeInScope( url, routeScope ) ) {
		result.excluded = true;
		return result;
	}
	// Capture treats a redirect as an alias, and schedules its target, only
	// when the route recorded no failure. A route whose passes disagreed
	// (one saved the page, another was redirected) is a failed capture:
	// it is reported with its recorded reasons below, like any route
	// without HTML, not as a redirect to a target nobody scheduled.
	if ( entry.redirectedTo && ! routeFailureReasons.has( url ) ) {
		if ( !routeInScope( entry.redirectedTo, routeScope ) ) {
			result.excluded = true;
			result.diagnostics.push( { code: 'route_external_redirect', url, reason: 'source redirect outside the adapter-owned site route scope' } );
			return result;
		}
		result.redirectAlias = { url, target: entry.redirectedTo };
		return result;
	}
	if ( entry.externalRedirect ) {
		// The source sends this link outside the site. Retain only the fact of the
		// redirect; neither its destination nor its query belongs in the copy.
		result.excluded = true;
		const tenantBoundary = entry.sourceOutcomes?.some( outcome => outcome.routeScope && outcome.target.origin === new URL(url).origin );
		result.diagnostics.push( { code: 'route_external_redirect', url, reason: tenantBoundary
			? 'source initial-document redirect outside the adapter-owned site route scope (destination not fetched)'
			: 'source initial-document redirect to an external origin (destination not fetched)' } );
		return result;
	}
	if ( entry.sourceAbsentStatus ) {
		result.excluded = true;
		result.diagnostics.push( { code: 'route_not_found', url, reason: `HTTP ${ entry.sourceAbsentStatus }` } );
		return result;
	}
	if ( ! entry.html || entry.redirectedTo ) {
		const reason = routeFailureReasons.get( url )?.map( failure => failure.reason ).join( '; ' )
			?? 'capture completed without producing page HTML';
		if ( failuresAreAbsentDocument( failures, url ) ) {
			result.excluded = true;
			result.diagnostics.push( {
				code: 'route_not_found',
				url,
				reason,
			} );
		} else {
			result.diagnostics.push( {
				code: 'route_capture_failed',
				url,
				reason,
			} );
		}
		return result;
	}
	const capturedHtmlPath = resolve( outputDir, entry.html );
	if ( ! pathWithin( outputDir, capturedHtmlPath ) || ! existsSync( capturedHtmlPath ) ) {
		result.diagnostics.push( {
			code: 'route_capture_failed',
			url,
			reason: `captured HTML file is missing or outside the output directory: ${ entry.html }`,
		} );
		return result;
	}
	for ( const profile of Object.values( entry.profiles ?? {} ) ) {
		for ( const diagnostic of profile.diagnostics ?? [] ) {
			if ( diagnostic.code === 'device_document_incomplete' || diagnostic.code === 'source_mobile_redirect' || diagnostic.code === 'box_tree_unproven' ) result.diagnostics.push( { ...diagnostic, url } );
		}
	}
	const acquiredDesktopHtml = readFileSync(capturedHtmlPath, 'utf8');
	const desktopHash = createHash('sha256').update(acquiredDesktopHtml).digest('hex');
	let rawDesktopHtml = embedded && input ? projectRuntimePresentation(projectEmbeddedRegions(acquiredDesktopHtml, url, input.desktopVariant, desktopHash, embedded.receipt.regions), url, input.desktopVariant, desktopHash, embedded.receipt) : acquiredDesktopHtml;
	rawDesktopHtml = resolveDocumentReferences(rawDesktopHtml, entry.documents?.desktop?.url ?? url, entry.documents?.desktop?.baseUrl, documentReferences);
	// A builder's own logo is not the site's icon; owner-uploaded icons stay.
	rawDesktopHtml = withoutPlatformDefaultIcons(rawDesktopHtml, entry.documents?.desktop?.url ?? url);
	// Each profile's scripted links take the destinations observed in that profile.
	rawDesktopHtml = lowerScriptedLinks(rawDesktopHtml, entry.scriptedLinks?.desktop);
	const sourceInteractivity = inspectSourceInteractivity( rawDesktopHtml, url, outputDir, resourceManifest );
	// A client-routed SPA answers every route with HTTP 200 and renders its
	// own not-found screen in JavaScript, so the HTTP-status check above
	// (failuresAreAbsentDocument) never sees it: the entry has HTML, capture
	// succeeded, there is no failure to inspect. Never applied to the source
	// URL itself -- it is known good regardless of what it renders.
	if ( ! isSourceCaptureUrl( url, sourceUrl ) ) {
		// An empty rendered body (no text, no content-bearing element) is
		// the same signal in its barest form: the app answered the route
		// with nothing at all.
		const absentRenderReason = isAbsentDocumentRender( rawDesktopHtml )
			? 'rendered document is the client-routed not-found screen: a heading of just "404"/"410" on an otherwise thin page'
			: isEmptyDocumentRender( rawDesktopHtml )
				? 'rendered document is empty'
				: undefined;
		if ( absentRenderReason ) {
			result.excluded = true;
			result.diagnostics.push( {
				code: 'route_not_found',
				url,
				reason: absentRenderReason,
			} );
			return result;
		}
	}
	if ( entry.phoneSentTo ) result.diagnostics.push( { code: 'phone_redirect_desktop_only', url, unit: 'profile', profile: 'mobile', severity: 'warning', reason: `The phone identity is sent to ${ entry.phoneSentTo } while desktop renders this route; the route ships its desktop document, reflowed at phone widths` } );
	const mobileHtmlPath = resolve( outputDir, entry.mobileHtml ?? entry.html.replace( /^html[\\/]/, 'html-mobile/' ) );
	// A route whose phone identity was sent elsewhere has no phone document,
	// even if an earlier run left one at the conventional path.
	const acquiredMobileHtml =
		! entry.phoneSentTo && ( siteDeviceMode === 'reflow-only' || hasHttpInput ? Boolean( entry.mobileHtml ) : true ) && pathWithin( outputDir, mobileHtmlPath ) && existsSync( mobileHtmlPath )
			? readFileSync( mobileHtmlPath, 'utf8' )
			: undefined;
	const mobileHash = acquiredMobileHtml === undefined ? undefined : createHash('sha256').update(acquiredMobileHtml).digest('hex');
	let rawMobileHtml = embedded && input?.mobileVariant && acquiredMobileHtml !== undefined ? projectRuntimePresentation(projectEmbeddedRegions(acquiredMobileHtml, url, input.mobileVariant, mobileHash!, embedded.receipt.regions), url, input.mobileVariant, mobileHash!, embedded.receipt) : acquiredMobileHtml;
	if (rawMobileHtml !== undefined) rawMobileHtml = withoutPlatformDefaultIcons(resolveDocumentReferences(rawMobileHtml, entry.documents?.mobile?.url ?? url, entry.documents?.mobile?.baseUrl, documentReferences), entry.documents?.mobile?.url ?? url);
	if (rawMobileHtml !== undefined) rawMobileHtml = lowerScriptedLinks(rawMobileHtml, entry.scriptedLinks?.mobile);
	const sourceDocuments: Record<string, string> = { desktop: rawDesktopHtml, ...( rawMobileHtml === undefined ? {} : { mobile: rawMobileHtml } ) };
	for ( const [ key, profile ] of Object.entries( entry.profiles ?? {} ) ) {
		if ( key === 'desktop' || key === 'mobile' || ! profile.html ) continue;
		const path = resolve( outputDir, profile.html );
		if ( ! pathWithin( outputDir, path ) || ! existsSync( path ) ) throw new IntegrityError( `Device document is missing or outside capture: ${ key }` );
		const documentUrl = entry.documents?.[ key ];
		sourceDocuments[ key ] = lowerScriptedLinks( withoutPlatformDefaultIcons( resolveDocumentReferences( readFileSync( path, 'utf8' ), documentUrl?.url ?? url, documentUrl?.baseUrl, documentReferences ), documentUrl?.url ?? url ), entry.scriptedLinks?.[ key ] );
	}
	const selection = resolveDocumentSelection?.( sourceDocuments );
	if ( selection?.kind === 'width' ) {
		if ( ! Number.isInteger( selection.switchWidth ) || selection.switchWidth <= 0 || ! selection.evidence ) throw new IntegrityError( 'Invalid observed document switch' );
		result.widthSelections.push( { url, ...selection } );
	}
	const deviceMode = entry.deviceMode;
	const detectedFloor =
		selection?.kind === 'device' ? undefined : selection?.kind === 'width' ? selection.switchWidth : entry.deviceMode?.switchWidth !== undefined ? entry.deviceMode.switchWidth : deviceMode?.mode === 'dual' && deviceMode.serverHtml === 'different'
			? phoneSwitchWidth ?? entry.profiles?.mobile?.viewport.width
			: typeof entry.fluid?.canvasFloor === 'number' && entry.fluid.canvasFloor > 0
			? Math.round( entry.fluid.canvasFloor )
			: phoneResponsiveSwitchWidth( entry, siteSwitchWidth );
	if ( detectedFloor ) result.switchWidths.push( detectedFloor );
	// A source that selects a third layout by width (#1379): a bounded range
	// with its captured document ships as the middle document; otherwise
	// the copy serves the desktop document there and says so.
	const middle = entry.deviceMode?.switchWidth === detectedFloor
		? entry.deviceMode?.middleLayout ?? ( entry.deviceMode as { uncapturedLayout?: MiddleLayout } | undefined )?.uncapturedLayout
		: undefined;
	const rawMiddleHtml = middle?.maxWidth !== undefined && selection?.kind !== 'device' && rawMobileHtml !== undefined
		? sourceDocuments[ MIDDLE_PROFILE_ID ]
		: undefined;
	if ( middle && rawMiddleHtml === undefined ) result.diagnostics.push( {
		code: 'responsive_layout_uncaptured', url, unit: 'profile', severity: 'warning',
		reason: `source renders a third layout, neither the phone nor the desktop document, from ${ middle.minWidth }px${ middle.maxWidth === undefined ? '' : ` to ${ middle.maxWidth }px` }; the copy serves the desktop document there`,
		metrics: { minWidth: middle.minWidth, ...( middle.maxWidth === undefined ? {} : { maxWidth: middle.maxWidth } ) },
	} );
	if ( entry.fluid ) result.fluidReports.push( entry.fluid );
	if ( entry.fluidMobile ) result.fluidReports.push( entry.fluidMobile );
	if ( selection?.kind !== 'device' && embedded && input?.mobileVariant && rawMobileHtml !== undefined ) {
		const pair = mergeResponsiveEmbeddedRegions( { desktop: rawDesktopHtml, mobile: rawMobileHtml, url, desktopVariant: input.desktopVariant, mobileVariant: input.mobileVariant, receipt: embedded.receipt, switchWidth: detectedFloor ?? DEFAULT_SWITCH_WIDTH, scopeClasses: { desktop: DESKTOP_DOCUMENT_CLASS, mobile: MOBILE_DOCUMENT_CLASS } } );
		rawDesktopHtml = pair.desktop; rawMobileHtml = pair.mobile;
	}
	// Evidence and assembly normalize the same source documents. Keep one
	// result per exact input within this route, without retaining parser trees
	// or carrying document state into the next route.
	const normalizedDocuments = new Map< string, string >();
	const portableDocument = ( html: string ): string => {
		let normalized = normalizedDocuments.get( html );
		if ( normalized === undefined ) {
			normalized = normalizedDeclarativeFormEmbeds( renderedHtml( html ) );
			normalizedDocuments.set( html, normalized );
		}
		return normalized;
	};
	const desktopHtml = portableDocument( rawDesktopHtml );
	const mobileHtml =
		rawMobileHtml === undefined
			? undefined
			: portableDocument( rawMobileHtml );
	const readCapturedStylesheet = ( href: string ): string | undefined => {
		let resource;
		try { resource = resourceManifest.resources[ new URL( href, url ).href ]; } catch { return undefined; }
		if ( ! resource?.contentType.startsWith( 'text/css' ) ) return undefined;
		const path = resolve( outputDir, resource.path );
		return pathWithin( outputDir, path ) && existsSync( path ) ? readFileSync( path, 'utf8' ) : undefined;
	};
	const onUnparseableStylesheet = ( reason: string ): void => {
		result.diagnostics.push( { code: 'stylesheet_unparseable', url, reason, unit: 'stylesheet', severity: 'warning' } );
	};
	const deviceAssembly = selection?.kind === 'device' ? assembleDeviceDocuments(
		Object.fromEntries( Object.entries( sourceDocuments ).map( ( [ key, html ] ) => [ key, portableDocument( html ) ] ) ), selection, onUnparseableStylesheet, readCapturedStylesheet
	) : undefined;
	if ( deviceAssembly ) {
		result.deviceSelections.push( { url, id: deviceAssembly.selection.id, documents: deviceAssembly.selection.documents, missing: deviceAssembly.missing, evidence: deviceAssembly.selection.evidence } );
		for ( const key of deviceAssembly.missing ) result.diagnostics.push( { code: 'device_document_uncaptured', url, reason: `Source identity ${ key } has no captured document; portable runtime reports unavailable instead of selecting another identity` } );
	}
	const assembly = deviceAssembly ? {
		html: deviceAssembly.html, hasMobileDocument: 'mobile' in sourceDocuments, portableNormalization: 'applied' as const,
		evidence: { variants: Object.keys( deviceAssembly.viewports ).length, ...deviceAssembly.evidence! },
	} : assembleResponsiveCapture( {
		rawDesktopHtml,
		rawMobileHtml,
		portableDesktopHtml: desktopHtml,
		portableMobileHtml: mobileHtml,
		switchWidth: detectedFloor,
		...( rawMiddleHtml === undefined || middle?.maxWidth === undefined ? {} : {
			portableMiddleHtml: [ { html: portableDocument( rawMiddleHtml ), minWidth: middle.minWidth, maxWidth: middle.maxWidth } ],
		} ),
		onUnparseableStylesheet,
	} );
	if ( assembly.hasMobileDocument && ! deviceAssembly ) {
		const $ = cheerio.load( assembly.html );
		const classes = ( scope: string ) => ( $( `.${ scope }` ).first().attr( 'class' ) ?? '' ).split( /\s+/ ).filter( token => token && token !== scope );
		// Middle width-range documents (#1379) are further wrappers whose
		// tokens move the same way; linked styles must reach every wrapper.
		const middleClasses = $( '[data-blocks-engine-capture-document-scope]' ).toArray()
			.flatMap( node => ( $( node ).attr( 'class' ) ?? '' ).split( /\s+/ ) )
			.filter( token => /^data-blocks-engine-capture-middle(?:-\d+)?-document$/.test( token ) );
		const documentClasses = middleClasses.length ? [ DESKTOP_DOCUMENT_CLASS, MOBILE_DOCUMENT_CLASS, ...middleClasses ] : undefined;
		const tokenSets = ( documentClasses ?? [ DESKTOP_DOCUMENT_CLASS, MOBILE_DOCUMENT_CLASS ] ).map( scope => ( { scope, tokens: classes( scope ) } ) );
		const moved = documentClasses
			? new Map( tokenSets.flatMap( ( { scope, tokens } ) => tokens.filter( token => ! tokenSets.every( other => other.tokens.includes( token ) ) ).map( token => [ token, scope ] as const ) ).reverse() )
			: responsiveMovedBodyClasses( classes( DESKTOP_DOCUMENT_CLASS ), classes( MOBILE_DOCUMENT_CLASS ) );
		if ( moved.size ) result.responsiveProjection = [ JSON.stringify( [ [ ...moved ], documentClasses ] ), { moved, documentClasses } ];
	}
	if ( !assembly.hasMobileDocument && assembly.evidence?.outcome === 'collapsed-identity-subset' && rawMobileHtml ) {
		const classes = ( html: string ) => ( cheerio.load( html )( 'body' ).attr( 'class' ) ?? '' ).split( /\s+/ ).filter( Boolean );
		const moved = responsiveMovedBodyClasses( classes( rawDesktopHtml ), classes( rawMobileHtml ) );
		const aliases = new Map( [ ...moved ].filter( ( [ , scope ] ) => scope === MOBILE_DOCUMENT_CLASS ).map( ( [ token ] ) => [ token, `data-blocks-engine-capture-responsive-class-${ createHash( 'sha256' ).update( token ).digest( 'hex' ).slice( 0, 12 ) }` ] ) );
		if ( moved.size ) result.collapsedProjection = [ JSON.stringify( [ ...moved ] ), { moved, aliases, width: detectedFloor ?? DEFAULT_SWITCH_WIDTH } ];
	}
	const capturedHtml = assembly.portableNormalization === 'pending'
		? portableDocument( assembly.html )
		: assembly.html;
	normalizedDocuments.clear();
	// safeCapturedPageHtml removes <base>; record its stylesheet semantics first.
	const styleHoistContext = capturedStyleHoistContext( capturedHtml );
	const sanitized = safeCapturedPageHtml( capturedHtml, embeddedSources, url );
        result.diagnostics.push( ...sanitized.diagnostics.map( diagnostic => ( { ...diagnostic, url } ) ) );
        const html = deviceAssembly ? installDeviceSelection( sanitized.html, deviceAssembly ) : sanitized.html;
	assertPageWithinFileLimit( html, maxFileBytes );
	// A route whose HTML was saved is captured even when a stage failed on it.
	// A declared capture profile (a manifest profile record, or a viewport a
	// stage failed in) without its document stays a profile-level loss; the
	// remaining stage failures only degrade the route.
	const stageFailures = routeFailureReasons.get( url ) ?? [];
	const uncapturedProfiles = [ ...new Set( [ ...Object.keys( entry.profiles ?? {} ), ...stageFailures.map( failure => failure.profile ) ] ) ]
		.filter( profile => profile !== 'all' && profile !== 'unknown' && ! ( profile in sourceDocuments ) );
	for ( const profile of uncapturedProfiles ) {
		const reasons = stageFailures.filter( failure => failure.profile === profile ).map( failure => failure.reason );
		result.diagnostics.push( { code: 'route_profile_uncaptured', url, reason: reasons.join( '; ' ) || `declared capture profile ${ profile } produced no document`, unit: 'profile', severity: 'error', profile } );
	}
	const degraded = stageFailures.filter( failure => ! uncapturedProfiles.includes( failure.profile ) );
	if ( degraded.length ) result.diagnostics.push( { code: 'route_capture_degraded', url, reason: degraded.map( failure => failure.reason ).join( '; ' ), unit: 'route', severity: 'warning', metrics: { failedStages: degraded.length } } );
	// Evidence blocks capture lost while it still saved the page.
	for ( const loss of entry.blockLosses ?? [] ) result.diagnostics.push( { ...loss, url } );
	result.entry = {
		slug: structuredEntries?.find( feed => normalizedUrl( feed.permalink ) === normalizedUrl( url ) )?.slug ?? entry.slug ?? basename( entry.html, '.html' ),
		url,
		htmlPath: stageHtml( html ),
		evidenceDocuments: [
			{ state: 'desktop', html: desktopHtml },
			...( mobileHtml === undefined ? [] : [ { state: 'mobile' as const, html: mobileHtml } ] ),
		],
		hasMobileDocument: assembly.hasMobileDocument,
		responsiveVariants: assembly.evidence,
		documentSelection: deviceAssembly ? { kind: 'device', id: deviceAssembly.selection.id, documents: deviceAssembly.selection.documents, missing: deviceAssembly.missing, evidence: deviceAssembly.selection.evidence } : selection?.kind === 'width' ? selection : undefined,
		...( entry.fluid || entry.fluidMobile ? { fluidGeometry: { desktop: entry.fluid, mobile: entry.fluidMobile } } : {} ),
		...( entry.accessGate ? { accessGate: entry.accessGate } : {} ),
		sections: entry.sections,
		canonicalLinkUrl: canonicalMetadataUrl( canonicalLinkHref( desktopHtml, url ), url, routeScope, sourceUrl, canonicalHost ),
		canonicalUrl: canonicalMetadataUrl( entry.metadata?.openGraph?.[ 'og:url' ] ?? openGraphUrl( html ), url, routeScope, sourceUrl, canonicalHost ),
		sourceData: sanitized.sourceData,
		interactions: entry.interactions,
		scrollStates: entry.scrollStates,
		styleHoistContext,
		sourceInteractivity,
	};
	return result;
}

/** Collect a route, reporting a failure as data so a worker can return it. */
export function tryCollectCapturedRoute( url: string, entry: CaptureManifestEntry, context: RouteCollectionContext, stageHtml: ( html: string ) => string ): CollectedRoute | FailedRouteCollection {
	try {
		return collectCapturedRoute( url, entry, context, stageHtml );
	} catch ( error ) {
		return { failed: { message: ( error as Error ).message, integrity: isIntegrityError( error ) } };
	}
}

export function collectCapturedRoutes( { entries, sourceUrl, routeScope, failures, structuredEntries, deviceMode, input, resolveDocumentSelection, outputDir, embedded, embeddedSources, hasHttpInput, siteSwitchWidth, phoneSwitchWidth, stagedHtmlDir, resourceManifest, routeFailureReasons, maxFileBytes, budget, exclusions, precollected }: {
 entries: ScreenshotManifest['entries']; sourceUrl: string; routeScope?: SiteRouteScope; failures: Array<{ url: unknown; error: unknown }>; structuredEntries?: StructuredContentEntry[];
 deviceMode?: DeviceMode; input?: HttpExportInput; resolveDocumentSelection?: ( documents: Readonly<Record<string, string>> ) => DocumentSelection | undefined;
 outputDir: string; embedded: ReturnType<typeof loadEmbeddedDocuments> | undefined; embeddedSources: Set<string>; hasHttpInput: boolean; siteSwitchWidth: number | undefined; phoneSwitchWidth: number | undefined;
 stagedHtmlDir: string; resourceManifest: CapturedResourceManifest; routeFailureReasons: Map<string, Array<{ profile: string; reason: string }>>; maxFileBytes: number; budget: ExportTotalBudget; exclusions: ExportBudgetExclusions;
 /** Routes already collected (in parallel, see capture-export-parallel.ts), by manifest URL. */
 precollected?: ReadonlyMap<string, CollectedRoute | FailedRouteCollection>;
} ): CapturedRoutes {
	const switchWidths: number[] = [];
	const deviceSelections: CapturedRoutes['deviceSelections'] = [];
	const widthSelections: CapturedRoutes['widthSelections'] = [];
	const fluidReports: CaptureFluidEvidence[] = [];
	const capturedEntries: CaptureEntry[] = [];
	const interactionPages: InteractionStatesReport[] = [];
	const scrollStatesPages: ScrollStatesReport[] = [];
	const excludedRoutes: string[] = [];
	const routeCaptureDiagnostics: RouteDiagnostic[] = [];
	const redirectAliases: Array< { url: string; target: string } > = [];
	const context: RouteCollectionContext = { sourceUrl, routeScope, failures, structuredEntries, deviceMode, input, resolveDocumentSelection, outputDir, embedded, embeddedSources, hasHttpInput, siteSwitchWidth, phoneSwitchWidth, resourceManifest, routeFailureReasons, maxFileBytes,
		canonicalHost: captureCanonicalHost( entries, sourceUrl, outputDir ), documentReferences: capturedDocumentReferences( entries, outputDir ) };
	const responsiveBodyClassProjections: CapturedRoutes['responsiveBodyClassProjections'] = new Map();
	const collapsedBodyClassProjections: CapturedRoutes['collapsedBodyClassProjections'] = new Map();
	for ( const [ url, entry ] of Object.entries( entries ) ) {
		// The total budget only ever drops a route an earlier build exported, never the entrypoint.
		const budgetDropped = exclusions.routes.get( url );
		if ( budgetDropped !== undefined && ! isSourceCaptureUrl( url, sourceUrl ) ) {
			routeCaptureDiagnostics.push( routeExceedsTotalBudget( url, budgetDropped, budget ) );
			continue;
		}
		// Every staged page is this build's own copy: later stages rewrite it.
		const stageHtml = ( html: string ): string => {
			const path = join( stagedHtmlDir, `${ capturedEntries.length }.html` );
			writeFileSync( path, html );
			return path;
		};
		const ready = precollected?.get( url );
		let route: CollectedRoute | FailedRouteCollection;
		try {
			route = ready ?? collectCapturedRoute( url, entry, context, stageHtml );
		} catch ( error ) {
			if ( isIntegrityError( error ) ) throw error; // failure-class: integrity
			route = { failed: { message: ( error as Error ).message, integrity: false } };
		}
		// One route's non-integrity failure drops that route, not the capture. Integrity
		// errors still fail closed; a dropped entrypoint fails when routes are allocated.
		if ( 'failed' in route ) {
			if ( route.failed.integrity ) throw new IntegrityError( route.failed.message ); // failure-class: integrity
			// The dropped route keeps only its route_export_failed row.
			routeCaptureDiagnostics.push( { code: 'route_export_failed', url, reason: route.failed.message, unit: 'route', severity: 'error' } );
			continue;
		}
		routeCaptureDiagnostics.push( ...route.diagnostics );
		if ( route.excluded ) excludedRoutes.push( url );
		if ( route.redirectAlias ) redirectAliases.push( route.redirectAlias );
		switchWidths.push( ...route.switchWidths );
		deviceSelections.push( ...route.deviceSelections );
		widthSelections.push( ...route.widthSelections );
		fluidReports.push( ...route.fluidReports );
		if ( route.responsiveProjection ) responsiveBodyClassProjections.set( ...route.responsiveProjection );
		if ( route.collapsedProjection ) collapsedBodyClassProjections.set( ...route.collapsedProjection );
		if ( ! route.entry ) continue;
		capturedEntries.push( ready ? { ...route.entry, htmlPath: stageHtml( readFileSync( route.entry.htmlPath, 'utf8' ) ) } : route.entry );
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

	return { capturedEntries, interactionPages, scrollStatesPages, excludedRoutes, redirectAliases, switchWidths, deviceSelections, widthSelections, fluidReports, responsiveBodyClassProjections, collapsedBodyClassProjections, diagnostics: routeCaptureDiagnostics };
}

export function collectMediaCandidates( { retainedEntries, outputDir, sourceUrl: siteUrl, mediaStubs, exclusions, maxFileBytes, catalogImages = [] }: {
 retainedEntries: CaptureEntry[]; outputDir: string; sourceUrl: string; mediaStubs: MediaStubStore; exclusions: ExportBudgetExclusions; maxFileBytes: number; catalogImages?: string[];
} ): MediaCandidates {
	const routeCaptureDiagnostics: RouteDiagnostic[] = [];
	const { rendered: renderedMediaReferences, retained: retainedMediaFamilies, dimensions: renderedMediaDimensions } =
		retainedMediaReferenceInventory( retainedEntries );
	for (const url of catalogImages) {
		const family = mediaFamily(url);
		retainedMediaFamilies.set(family, [...new Set([...(retainedMediaFamilies.get(family) ?? []), url])]);
	}
	const imageAssets = readAssets( outputDir );
	const imageByUrl = new Map( imageAssets.flatMap( record => record.source_urls.map( url => [ url, record ] as const ) ) );
	const seenImageAssets = new Set<AssetRecord>();
	const mediaFamilies = new Map< string, MediaCandidate[] >();
	// Only mixed families need descriptor pruning; original-only families keep
	// their existing collapse behavior. Values identify the selected source URLs.
	const mixedSrcsetReferences = new Map< string, Set< string > >();
	const failedMedia: FailedPortableMedia[] = [];
	const referencedImageAssets = new Set<AssetRecord>();
	const capturedPages = new Set(
		[ siteUrl, ...retainedEntries.map( ( entry ) => entry.url ) ].flatMap( ( url ) => {
			try {
				return [ normalizedUrl( url ) ];
			} catch {
				return [];
			}
		} )
	);
	const interactionMediaFamilies = new Set< string >();
	const interactionMediaReferences = new Map< string, Set< string > >();
	for ( const entry of retainedEntries ) {
		for ( const reference of galleryFrameMediaUrls( entry.interactions?.states ?? [], entry.url, entry.interactions?.components ) ) {
			const family = mediaFamily( reference );
			interactionMediaFamilies.add( family );
			const references = interactionMediaReferences.get( family ) ?? new Set< string >();
			references.add( reference );
			interactionMediaReferences.set( family, references );
		}
	}
	const probeReferences: string[] = [];
	const seenProbeReferences = new Set< string >();
	for ( const [ sourceUrl ] of mediaStubs.list() ) {
		try {
			if ( capturedPages.has( normalizedUrl( sourceUrl ) ) ) continue;
		} catch {
			// Invalid media URLs still flow through mediaReferences().
		}
		for ( const reference of mediaReferences( sourceUrl, siteUrl ) ) {
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
		// A rendition the budget dropped is skipped: build stripped it from every
		// srcset that retains another candidate, so nothing references it here.
		if ( exclusions.renditions.has( sourceUrl ) ) continue;
		const imageAsset = imageByUrl.get( sourceUrl );
		const references = imageAsset ? [ ...new Set( imageAsset.source_urls.flatMap( url => mediaReferences( url, siteUrl ) ) ) ] : mediaReferences( sourceUrl, siteUrl );
		const family = imageAsset && imageAsset.kind !== 'image' ? imageAsset.resolved_original : mediaFamily( imageAsset?.original?.source_url ?? sourceUrl );
		const exactReferences = references.filter( ( reference ) =>
			referenceIndex.indexed.has( reference ) && mediaReferenceMatched( referenceIndex, reference )
		);
		// A stylesheet reference counts like a page reference: theme CSS paints the image.
		const isReferenced = ( imageAsset?.kind === 'font' && imageAsset.references.length > 0 ) || imageAsset?.references.some( reference => reference.kind === 'CSS' ) || retainedMediaFamilies.has( family ) || imageAsset?.source_urls.some( url => catalogImages.includes( url ) ) || interactionMediaFamilies.has( family ) || exactReferences.length > 0;
		if ( imageAsset && seenImageAssets.has( imageAsset ) ) continue;
		if ( imageAsset && isReferenced ) {
			seenImageAssets.add( imageAsset );
			referencedImageAssets.add( imageAsset );
		}
		if ( ( stub.status === 'error' || ( imageAsset && ! imageAsset.original ) ) && isReferenced ) {
			failedMedia.push( { family, sourceUrl, nonImage: imageAsset?.kind !== undefined && imageAsset.kind !== 'image', error: stub.error ?? 'media download failed', references } );
			continue;
		}
		const localPath = imageAsset?.local_path ?? stub.localPath;
		if ( isReferenced && stub.status === 'success' && ( ! localPath || ! existsSync( localPath ) ) ) {
			failedMedia.push( { family, sourceUrl, nonImage: imageAsset?.kind !== undefined && imageAsset.kind !== 'image', error: localPath ? 'verified resource file is missing from disk' : 'verified resource has no local file path', references } );
			continue;
		}
		if (
			stub.status !== 'success' ||
			! localPath ||
			! existsSync( localPath ) ||
			! isReferenced
		)
			continue;
		const bytes = statSync( localPath ).size;
		if ( exclusions.assets.has( sourceUrl ) ) {
			failedMedia.push( { family, sourceUrl, nonImage: imageAsset?.kind !== undefined && imageAsset.kind !== 'image', error: 'removed because the website exceeds the total export budget', references } );
			continue;
		}
		if ( bytes > maxFileBytes ) {
			routeCaptureDiagnostics.push( assetExceedsFileLimit( sourceUrl, bytes, maxFileBytes ) );
			failedMedia.push( { family, sourceUrl, nonImage: imageAsset?.kind !== undefined && imageAsset.kind !== 'image', error: 'removed because media exceeds the per-file export limit', references } );
			continue;
		}
		const candidate: MediaCandidate = {
			sourceUrl: imageAsset?.original?.source_url ?? sourceUrl,
			...( imageAsset ? { imageAsset } : {} ),
			localPath,
			references: [
				...new Set( [ ...references, ...( renderedMediaReferences.get( family ) ?? [] ) ] ),
			],
			exactReferences: [ ...exactReferences, ...( interactionMediaReferences.get( family ) ?? [] ) ],
			...( interactionMediaReferences.has( family ) ? { galleryFrame: true } : {} ),
			bytes,
			renderedDimension: Math.max( renderedMediaDimensions.get( family ) ?? 0,
				...( imageAsset?.source_urls ?? [] ).map( url => renderedMediaDimensions.get( mediaFamily( url ) ) ?? 0 ) ),
			dimension: imageAsset?.original ? Math.max( imageAsset.original.width ?? 0, imageAsset.original.height ?? 0 ) : mediaDimension( sourceUrl ),
		};
		// Inventory aliases describe one picture, not necessarily one file. Keep
		// independently captured srcset bytes instead of rewriting every alias to
		// the verified representative (notably same-path ?width=N CDN URLs).
		// The URL serialized by each profile owns its captured bytes, even for
		// same-aspect resizes: natural dimensions can be part of the layout.
		const capturedRenditions: MediaCandidate[] = [];
		const selectedReferences = new Set( mediaReferences( candidate.sourceUrl, siteUrl ) );
		if ( imageAsset && ( ! imageAsset.kind || imageAsset.kind === 'image' ) && imageAsset.original ) {
			for ( const url of imageAsset.source_urls ) {
				if ( url === candidate.sourceUrl || exclusions.renditions.has( url ) || exclusions.assets.has( url ) ) continue;
				const rendition = imageAsset.renditions?.find( record => record.original?.source_url === url );
				if ( ! rendition?.original || ! rendition.local_path ) continue;
				const path = resolve( outputDir, rendition.local_path );
				if ( ! pathWithin( outputDir, path ) || ! existsSync( path ) ) continue;
				const renditionContent = readFileSync( path );
				const hash = createHash( 'sha256' ).update( renditionContent ).digest( 'hex' );
				if ( hash === imageAsset.original.sha256 ) {
					for ( const reference of mediaReferences( url, siteUrl ) ) selectedReferences.add( reference );
					continue;
				}
				// A same-size re-encode can still use the verified original (for
				// example, an opaque proxy of an alpha-preserving original).
				try {
					const { width, height } = imageSize( renditionContent );
					if ( width === imageAsset.original.width && height === imageAsset.original.height ) {
						for ( const reference of mediaReferences( url, siteUrl ) ) selectedReferences.add( reference );
						continue;
					}
				} catch {
					// Unknown dimensions cannot prove a same-size substitution.
				}
				const renditionReferences = mediaReferences( url, siteUrl );
				const exact = renditionReferences.filter( reference => referenceIndex.indexed.has( reference ) && mediaReferenceMatched( referenceIndex, reference ) );
				if ( ! exact.length ) continue;
				const renditionBytes = statSync( path ).size;
				if ( renditionBytes > maxFileBytes ) continue;
				candidate.references = candidate.references.filter( reference => ! renditionReferences.includes( reference ) );
				candidate.exactReferences = candidate.exactReferences.filter( reference => ! renditionReferences.includes( reference ) );
				for ( const reference of renditionReferences ) selectedReferences.add( reference );
				capturedRenditions.push( {
					sourceUrl: url, localPath: path, imageAsset: rendition, references: renditionReferences, exactReferences: exact,
					bytes: renditionBytes, dimension: imageAsset.rendition_widths?.[ url ] ?? mediaDimension( url ),
					renderedDimension: candidate.renderedDimension,
				} );
			}
		}
		if ( capturedRenditions.some( rendition => ! rendition.budgetFallback ) ) {
			for ( const reference of references ) mixedSrcsetReferences.set( reference, selectedReferences );
		}
		const smaller: MediaCandidate[] = ( imageAsset?.renditions ?? [] ).flatMap( rendition => {
			if ( ! rendition.original || ! rendition.local_path || ! existsSync( rendition.local_path ) ) return [];
			const renditionBytes = statSync( rendition.local_path ).size;
			const dimension = Math.max( rendition.original.width ?? 0, rendition.original.height ?? 0 );
			if ( renditionBytes >= bytes || renditionBytes > maxFileBytes || dimension >= candidate.dimension ) return [];
			return [ { ...candidate, sourceUrl: rendition.original.source_url, localPath: rendition.local_path,
				bytes: renditionBytes, dimension,
				references: rendition.source_urls.flatMap( url => mediaReferences( url, siteUrl ) ),
				imageAsset: rendition,
			} ];
		} );
		mediaFamilies.set( family, [ ...( mediaFamilies.get( family ) ?? [] ), candidate, ...capturedRenditions, ...smaller ] );
	}
	return { mediaFamilies, failedMedia, mixedSrcsetReferences, interactionMediaFamilies, interactionMediaReferences, probeReferences, retainedMediaFamilies, imageAssets, referencedImageAssets, imageByUrl, diagnostics: routeCaptureDiagnostics };
}

export function collectRouteLinks( { retainedEntries, routePathOf, structuredContent, sourceUrl, canonicalRouteAliases, mediaReplacements, resourceReplacements, downloadedMedia = [], stylesheetServedPaths, entries, routeCaptureDiagnostics, outputDir, discoveryDiagnostics, unresolvedDependencies, preCaptureAliases = [] }: {
 retainedEntries: CaptureEntry[]; routePathOf: ( url: string ) => string; structuredContent?: { source: StructuredContentSource; entries: StructuredContentEntry[] }; sourceUrl: string; canonicalRouteAliases: ReadonlyMap<string, string>;
 mediaReplacements: ReadonlyMap<string, string>; resourceReplacements: ReadonlyMap<string, string>;
 /** Source URLs the capture downloaded as media, whether or not export shipped them. */
 downloadedMedia?: readonly string[]; stylesheetServedPaths: readonly string[]; entries: ScreenshotManifest['entries']; routeCaptureDiagnostics: readonly RouteDiagnostic[];
 outputDir: string; discoveryDiagnostics?: Array<{ code: string; url: string; reason: string }>; unresolvedDependencies: ReadonlyArray<{ url: string }>;
	preCaptureAliases?: ReadonlyArray<{ url: string; canonicalUrl: string }>;
} ): RouteLinks {
	const routes: Array< { url: string; path: string; accessGate?: AccessGateEvidence } > = [];
	const portableRouteLinks = new Map< string, string >();
	for ( const entry of retainedEntries ) {
		const { url } = entry;
		const routePath = routePathOf( url );
		const portablePath = `/${ routePath }`;
		portableRouteLinks.set( documentRequestUrl( url ), portablePath );
		routes.push( {
			url,
			path: `website/${ routePath }`,
			...( entry.responsiveVariants ? { responsiveVariants: entry.responsiveVariants } : {} ),
			...( entry.documentSelection ? { documentSelection: entry.documentSelection } : {} ),
			...( entry.fluidGeometry ? { fluidGeometry: entry.fluidGeometry } : {} ),
			...( entry.accessGate ? { accessGate: entry.accessGate } : {} ),
		} );
	}
	if ( structuredContent?.entries.length ) {
		const { source, entries } = structuredContent;
		for ( const term of structuredContentIndex( entries, routes, source, sourceUrl ).terms ) {
			portableRouteLinks.set( documentRequestUrl( term.sourceUrl ), term.path );
		}
	}
	for ( const [ aliasKey, routePath ] of canonicalRouteAliases ) {
		if ( portableRouteLinks.has( aliasKey ) ) continue;
		portableRouteLinks.set( aliasKey, `/${ routePath }` );
	}
	for ( const { url, canonicalUrl } of retainedEntries ) {
		if ( ! canonicalUrl ) continue;
		const canonicalKey = documentRequestUrl( canonicalUrl );
		if ( portableRouteLinks.has( canonicalKey ) ) continue;
		const routePath = routePathOf( url );
		portableRouteLinks.set( canonicalKey, `/${ routePath }` );
	}
	// Exact request addresses take precedence; link rewriting also resolves
	// uncaptured slash spellings through the shared discovery identity.
	const sourceRouteLinks = portableRouteLinks;

	const portableServedPaths = new Set< string >();
	for ( const path of [
		...portableRouteLinks.values(),
		...mediaReplacements.values(),
		...resourceReplacements.values(),
		...stylesheetServedPaths,
	] ) {
		if ( ! path.startsWith( '/' ) ) continue;
		try {
			const pathname = new URL( path, 'https://portable.invalid' ).pathname;
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
	const boundaryRoutes = new Set<string>();
	const capturedRouteKeys = new Set( sourceRouteLinks.keys() );
	for ( const [ url, entry ] of Object.entries( entries ) ) {
		if ( entry.externalRedirect ) {
			capturedRouteKeys.add( documentRequestUrl( url ) );
			boundaryRoutes.add( documentRequestUrl( url ) );
		}
	}
	const absentRoutes = new Set( routeCaptureDiagnostics
		.filter( ( diagnostic ) => diagnostic.code === 'route_not_found' )
		.map( ( diagnostic ) => diagnostic.url ) );
	const absentRouteKeys = new Set( [ ...absentRoutes ].map( documentRequestUrl ) );
	// Budget omissions arrive from the caller's initial selection and from the
	// linked frontier once the same budget was spent.
	const linkedCoveragePath = join( outputDir, 'linked-page-coverage.json' );
	const linkedCoverageDiagnostics = existsSync( linkedCoveragePath )
		? ( JSON.parse( readFileSync( linkedCoveragePath, 'utf8' ) ) as { diagnostics?: Array< { code?: unknown; url?: unknown } > } ).diagnostics ?? []
		: [];
	const omittedRouteKeys = new Set( budgetOmittedRoutes( [ ...( discoveryDiagnostics ?? [] ), ...linkedCoverageDiagnostics ] ).map( documentRequestUrl ) );
	// A link to a canonical alias is a link to its canonical route, omitted when that route was.
	for ( const { url, canonicalUrl } of preCaptureAliases ) if ( omittedRouteKeys.has( documentRequestUrl( canonicalUrl ) ) ) omittedRouteKeys.add( documentRequestUrl( url ) );
	// A link to a non-document resource is not a missing page: the capture
	// downloaded it as media, or discovery already classified it as a resource.
	const nonDocumentUrls = [ ...( discoveryDiagnostics ?? [] ), ...linkedCoverageDiagnostics ]
		.flatMap( row => row.code === NON_DOCUMENT_URL && typeof row.url === 'string' ? [ row.url ] : [] );
	const resourceInputKeys = new Set([
		...resourceReplacements.keys(), ...mediaReplacements.keys(),
		...unresolvedDependencies.map(row => row.url), ...downloadedMedia, ...nonDocumentUrls,
	].flatMap(url => {
		try { return [documentRequestUrl(url)]; }
		catch { return []; } // Raw replacement strings can be relative references.
	}));
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
		portableRouteLinks.has( documentRequestUrl( route.url ) ) &&
		routeDestinations.get( JSON.stringify( [ route.siblings, route.label ] ) )?.size === 1
	);
	return { routes, sourceRouteLinks, portableServedPaths, unresolvedAnchors, boundaryRoutes, capturedRouteKeys, absentRoutes, absentRouteKeys, omittedRouteKeys, resourceInputKeys, verifiedRouteObservations };
}
