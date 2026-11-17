import { safeCapturedPageHtml } from './captured-page-html.js';
import { collectCapturedRoutes, collectMediaCandidates, collectRouteLinks, type ScreenshotManifest } from './capture-export-collection.js';
import { deferredMediaReferences, linkDeferredMedia, recordMediaLedger } from './media-queue.js';
import { withParsedDocuments } from './parsed-documents.js';
import { type DocumentSelection } from './document-selection.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { WebsiteInventory } from './website-inventory.js';
import { renderRoutePages, projectPortableWebsite } from './capture-export-render.js';
import { materializeSharedStylesheets } from './shared-stylesheets.js';
export { portableInlineStyle } from './shared-stylesheets.js';
import { allocateCaptureRoutes, type RouteDiagnostic } from './capture-export-routes.js';
import { renderSourceData, type SourceDataScript } from './source-data.js';
import { routeInScope, validateRouteScope } from './url/route-scope.js';
import type { SiteRouteScope } from '../platform/types.js';
import { planPortableMediaFamilies } from './portable-media-plan.js';
import { SectionSpecsStore } from './replicate/section-specs-store.js';
import { MediaStubStore } from './resume-state/index.js';
import { COARSE_SWEEP_WIDTHS } from './screenshot/fluid-capture.js';
import {
	type CapturedResourceManifest,
} from './screenshot/resource-capture.js';
import { galleryFrameMediaUrls } from './screenshot/gallery-capture.js';
import { materializePortableMedia } from './portable-media.js';
import { omitDegenerateReplacements, preparePortableReplacements } from './portable-references.js';
import { materializePortableResources } from './portable-resources.js';
import { assetExceedsFileLimit, DEFAULT_MAX_FILE_BYTES, validateMaxFileBytes } from './export-file-limit.js';
import { assetExceedsTotalBudget, emptyExportBudgetExclusions, planExportBudget, redundantRenditionDropped, resolveExportTotalBudget, type DroppableAsset, type ExportBudgetExclusions, type ExportTotalBudget } from './export-total-budget.js';
import { collectAssetEvidenceReferences, buildSemanticEvidenceArtifacts, writeCaptureEvidence, type SemanticEvidencePage } from './capture-export-evidence.js';
export { CAPTURE_RECEIPT_SCHEMA, SOURCE_PROFILE_SCHEMA, ASSET_EVIDENCE_SCHEMA, CAPTURED_INTERACTIONS_SCHEMA, CAPTURED_SCROLL_STATES_SCHEMA, INDEXED_SEMANTIC_EVIDENCE_SCHEMA } from './capture-export-evidence.js';
import { loadHttpExportInput, type HttpExportInput } from './http-export-input.js';
import { loadEmbeddedDocuments, projectEmbeddedRegions } from './embedded-documents.js';
import {
	EXPORT_PUBLICATION_BOUNDARIES,
	exportPublicationBoundary,
	publishExportGeneration,
} from './export-publication.js';
import { extractSharedChrome } from './shared-chrome.js';
import { writeExportBoxTrees } from './export-box-trees.js';

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
		canonicalRouteAliases, portableRedirects, missingRedirectTargets, duplicateSourceData, pathDiagnostics,
	} = allocateCaptureRoutes(
		capturedEntries, options.sourceUrl, redirectAliases,
		// A homepage with no manifest entry (abandoned at its deadline, skipped by
		// the time budget) is explained only by the capture stage's rows.
		[ ...routeCaptureDiagnostics, ...( options.discoveryDiagnostics ?? [] ) ],
		options.canonicalAliases ?? []
	);
	// Like a route_export_failed route, a path-dropped route keeps only its allocation finding.
	const droppedUrls = new Set( pathDiagnostics.map( diagnostic => diagnostic.url ) );
	const keptDiagnostics = routeCaptureDiagnostics.filter( diagnostic => ! droppedUrls.has( diagnostic.url ) );
	routeCaptureDiagnostics.splice( 0, routeCaptureDiagnostics.length, ...keptDiagnostics, ...pathDiagnostics );
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
	const rendered = renderRoutePages( { retainedEntries, websiteDir, resourceReplacements, portableUrlByFamily, mixedSrcsetReferences, portableMediaReplacements, replaceResources, replaceMedia, mediaMetadataPathsBySource: mediaStage.metadataPathsBySource, portablePathsBySource, routePathOf, capturedRouteKeys, absentRouteKeys, omittedRouteKeys, resourceInputKeys, routeScope: options.routeScope, boundaryRoutes, verifiedRouteObservations, sourceRouteLinks, portableServedPaths } );
	unresolvedAnchors.push( ...rendered.unresolvedAnchors );
	routeCaptureDiagnostics.push( ...rendered.diagnostics );
	const { inventory, diagnostics: projectionDiagnostics } = projectPortableWebsite( { websiteDir, stageDir, sourceUrl: options.sourceUrl, responsiveIdentities: rendered.responsiveIdentities, responsiveBodyClassProjections, collapsedBodyClassProjections, sourceHashesByPortablePath: resourceStage.sourceHashesByPortablePath, retainedEntries, routePathOf, interactionPages, scrollStatesPages, structuredContent: options.structuredContent, routes, portableRedirects } );
	routeCaptureDiagnostics.push( ...projectionDiagnostics );
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
	// Box-tree evidence binds the final page bytes and the shared parts they include.
	// The sidecars are website files only; they are deliberately not receipt reports.
	writeExportBoxTrees( outputDir, websiteDir, retainedEntries.flatMap( entry => {
		const sourcePath = capture.entries[ entry.url ]?.html;
		return sourcePath ? [ { sourcePath, mobileSourcePath: capture.entries[ entry.url ]?.mobileHtml, path: routePathOf( entry.url ) } ] : [];
	} ), inventory );
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
