import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { MediaStubStore } from './resume-state/index.js';
import type { CapturedResourceManifest } from './screenshot/resource-capture.js';
import type { ManifestEntry } from './screenshot/manifest-queue.js';
import { buildLayoutGeometryProof, type GeometryCapture } from './screenshot/layout-geometry-proof.js';
import { SOURCE_INTERACTIVITY_SCHEMA, type SourceInteractivityPage } from './source-interactivity.js';
import type { InteractionStatesReport } from './screenshot/interaction-capture.js';
import type { ScrollStatesReport } from './screenshot/scroll-state-capture.js';
import { DESKTOP_DOCUMENT_CLASS, MOBILE_DOCUMENT_CLASS, type ResponsiveVariantEvidence } from './responsive-assembly.js';
import { pathWithin } from './portable-assets.js';
import { dependencyReferences, type PortableDependency } from './portable-references.js';
import { exportPublicationBoundary, EXPORT_PUBLICATION_BOUNDARIES } from './export-publication.js';

export interface CaptureFluidEvidence {
	applied: number;
	unmodelled: number;
	breakpoints: number[];
	canvasFloor?: number | null;
	byKind: Record< string, number >;
}
export interface CaptureDocumentFluidEvidence {
	desktop?: CaptureFluidEvidence;
	mobile?: CaptureFluidEvidence;
}
interface AssetEvidenceEntry {
	url: string;
	evidenceDocuments: Array< { state: 'desktop' | 'mobile'; html: string } >;
}
export interface CaptureEvidenceInput {
	locations: { captureRoot: string; stageRoot: string };
	source: {
		sourceUrl: string;
		routeScope?: import('../platform/types.js').SiteRouteScope;
		platform: string;
		title?: string;
		summary: Record< string, unknown >;
		failures: ReadonlyArray< { url: unknown; error: unknown } >;
		discoveryDiagnostics?: ReadonlyArray< { code: string; url: string; reason: string } >;
	};
	capture: {
		entries: Readonly< Record< string, Pick< ManifestEntry, 'cleanup' | 'redirectedTo' | 'externalRedirect' | 'sourceOutcomes' | 'nativeViewTimelines' > > >;
		absentRoutes: ReadonlySet< string >;
		interactivity: ReadonlyArray< SourceInteractivityPage >;
		http?: { acquisition: unknown; diagnostics: ReadonlyArray< { code: string; url: string; reason: string } > };
		embedded?: { evidence: unknown };
	};
	pages: ReadonlyArray< {
		slug: string;
		url: string;
		routePath: string;
		identityHtmlPath: string;
		hasMobileDocument?: boolean;
	} >;
	routes: {
		retained: ReadonlyArray< { url: string; path: string; responsiveVariants?: ResponsiveVariantEvidence; fluidGeometry?: CaptureDocumentFluidEvidence; accessGate?: import( './access-gate.js' ).AccessGateEvidence } >;
		excluded: ReadonlyArray< string >;
		duplicates: ReadonlyArray< { url: string; canonicalUrl: string; path: string } >;
	};
	states: { interactions: ReadonlyArray< InteractionStatesReport >; scroll: ReadonlyArray< ScrollStatesReport > };
	layout: {
		fluidReports: ReadonlyArray< CaptureFluidEvidence >;
		switchWidths: ReadonlyArray< number >;
		deviceSelections?: ReadonlyArray< { url: string; id: string; documents: string[]; missing: string[]; evidence: string } >;
		widthSelections?: ReadonlyArray< { url: string; kind: 'width'; switchWidth: number; evidence: string } >;
	};
	assets: {
		references: AssetEvidenceReferences;
		stubs: MediaStubStore;
		manifest: CapturedResourceManifest;
		portablePaths: ReadonlyMap< string, string >;
		files: ReadonlyArray< { sourceUrl: string; path: string } >;
		media: {
			selected_count: number;
			selected_bytes: number;
			retained_external_count: number;
			max_bytes: number;
			reserved_bytes: number;
		};
	};
	semantic?: SemanticEvidenceArtifacts;
	diagnostics: {
		capture: ReadonlyArray< { code: string; url: string; reason: string } >;
		dependencies: ReadonlyArray< { url: string; sourceUrl: string; error: string } >;
		media: ReadonlyArray< { url: string; error: string } >;
		anchors: ReadonlyArray< { sourceUrl: string; reason: string; fragment?: string; targetCount?: number; url?: string } >;
		rejectedKeys: ReadonlySet< string >;
		styles: {
			hoistedStylesheets: number;
			diagnostics: ReadonlyArray< { sourceUrl: string; reason: string } >;
			diagnosticCounts: Partial< Record< string, number > >;
			diagnosticsTruncated: boolean;
		};
	};
}
export const CAPTURE_RECEIPT_SCHEMA = 'data-liberation/capture-receipt/v1';
export const SOURCE_PROFILE_SCHEMA = 'data-liberation/source-profile/v1';
export const ASSET_EVIDENCE_SCHEMA = 'data-liberation/asset-evidence/v1';
const MAX_ASSET_EVIDENCE_ASSETS = 10_000;
const MAX_ASSET_EVIDENCE_REFERENCES = 100;
const MAX_ASSET_EVIDENCE_CSS_RESOURCES_PER_ROUTE = 10_000;

export const CAPTURED_INTERACTIONS_SCHEMA = 'data-liberation/captured-interactions/v1';
export const CAPTURED_SCROLL_STATES_SCHEMA = 'data-liberation/captured-scroll-states/v1';
/** Indexed semantic evidence sidecar schema. */
export const INDEXED_SEMANTIC_EVIDENCE_SCHEMA = 'data-liberation/captured-semantic-evidence/v2';
const MAX_SEMANTIC_EVIDENCE_FILE_BYTES = 10 * 1024 * 1024;

export type SemanticEvidencePage = {
	path: string;
	url: string;
	viewports: Record< string, Record< string, unknown >[] >;
};

export interface SemanticEvidenceArtifacts {
	index: { path: string; content: string };
	shards: Array< { path: string; content: string; pageCount: number }>;
}

export function buildSemanticEvidenceArtifacts( pages: SemanticEvidencePage[] ): SemanticEvidenceArtifacts {
	const shards: SemanticEvidenceArtifacts[ 'shards' ] = [];
	let shardPages: SemanticEvidencePage[] = [];
	const shardContent = ( candidates: SemanticEvidencePage[] ) =>
		`${ JSON.stringify( { schema: INDEXED_SEMANTIC_EVIDENCE_SCHEMA, pages: candidates } ) }\n`;
	for ( const page of pages ) {
		const single = shardContent( [ page ] );
		if ( Buffer.byteLength( single ) > MAX_SEMANTIC_EVIDENCE_FILE_BYTES )
			throw new Error(
				`Semantic evidence page "${ page.path }" exceeds sidecar file limit: ${ Buffer.byteLength( single ) } bytes.`
			);
		const candidate = shardContent( [ ...shardPages, page ] );
		if ( shardPages.length > 0 && Buffer.byteLength( candidate ) > MAX_SEMANTIC_EVIDENCE_FILE_BYTES ) {
			shards.push( {
				path: `semantic-evidence/shard-${ String( shards.length + 1 ).padStart( 4, '0' ) }.json`,
				content: shardContent( shardPages ),
				pageCount: shardPages.length,
			} );
			shardPages = [ page ];
		} else shardPages.push( page );
	}
	if ( shardPages.length > 0 )
		shards.push( {
			path: `semantic-evidence/shard-${ String( shards.length + 1 ).padStart( 4, '0' ) }.json`,
			content: shardContent( shardPages ),
			pageCount: shardPages.length,
		} );
	const index = {
		path: 'semantic-evidence.index.json',
		content: `${ JSON.stringify( {
			schema: INDEXED_SEMANTIC_EVIDENCE_SCHEMA,
			page_count: pages.length,
			shards: shards.map( ( shard ) => ( { path: shard.path, page_count: shard.pageCount } ) ),
		} ) }\n`,
	};
	if ( Buffer.byteLength( index.content ) > MAX_SEMANTIC_EVIDENCE_FILE_BYTES )
		throw new Error( `Semantic evidence index exceeds sidecar file limit: ${ Buffer.byteLength( index.content ) } bytes.` );
	return { index, shards };
}

interface AssetEvidenceReference {
	route: string;
	path: string;
	document: 'desktop' | 'mobile' | 'css';
	reference: string;
}

interface AssetEvidenceRecord {
	id: string;
	sourceUrl: string;
	outcome: 'successful' | 'failed' | 'unknown';
	retrieval: 'retrieved' | 'failed' | 'unknown';
	portable: 'included' | 'excluded' | 'not-included';
	path?: string;
	portableAssetId?: string;
	error?: string;
	referenceCount: number;
	referencesTruncated: boolean;
	references: AssetEvidenceReference[];
}

export interface AssetEvidenceReferences {
	locations: Map< string, { count: number; references: AssetEvidenceReference[] } >;
	assetCount: number;
	assetCountExact: boolean;
	totalReferenceCount: number;
	documentCount: number;
	cssResourcesTruncated: boolean;
}

export function collectAssetEvidenceReferences(
	entries: ReadonlyArray< AssetEvidenceEntry >,
	routePathOf: ( url: string ) => string,
	resourceManifest: CapturedResourceManifest,
	outputDir: string
): AssetEvidenceReferences {
	const locations = new Map< string, { count: number; references: AssetEvidenceReference[] } >();
	let assetCount = 0;
	let assetCountExact = true;
	let totalReferenceCount = 0;
	let documentCount = 0;
	let cssResourcesTruncated = false;
	const add = ( dependency: PortableDependency, location: AssetEvidenceReference ) => {
		totalReferenceCount++;
		let indexed = locations.get( dependency.url );
		if ( !indexed ) {
			if ( locations.size >= MAX_ASSET_EVIDENCE_ASSETS ) {
				// Further URLs are deliberately not indexed: their identity would require an unbounded set.
				assetCountExact = false;
				assetCount = MAX_ASSET_EVIDENCE_ASSETS + 1;
				return;
			}
			indexed = { count: 0, references: [] };
			locations.set( dependency.url, indexed );
			assetCount++;
		}
		indexed.count++;
		if ( indexed.references.length < MAX_ASSET_EVIDENCE_REFERENCES ) indexed.references.push( location );
	};
	for ( const entry of entries ) {
		const path = `website/${ routePathOf( entry.url ) }`;
		const visitedCss = new Set< string >();
		const visit = ( dependency: PortableDependency, document: AssetEvidenceReference[ 'document' ] ) => {
			add( dependency, { route: entry.url, path, document, reference: dependency.reference } );
			if ( visitedCss.size >= MAX_ASSET_EVIDENCE_CSS_RESOURCES_PER_ROUTE ) {
				cssResourcesTruncated = true;
				return;
			}
			if ( visitedCss.has( dependency.url ) ) return;
			const resource = resourceManifest.resources[ dependency.url ];
			if ( !resource || !/text\/css/i.test( resource.contentType ) ) return;
			const resourcePath = resolve( outputDir, resource.path );
			if ( !pathWithin( outputDir, resourcePath ) || !existsSync( resourcePath ) ) return;
			visitedCss.add( dependency.url );
			for ( const nested of dependencyReferences( readFileSync( resourcePath, 'utf8' ), dependency.url, true ) )
				visit( nested, 'css' );
		};
		for ( const source of entry.evidenceDocuments ) {
			documentCount++;
			for ( const dependency of dependencyReferences( source.html, entry.url ) ) visit( dependency, source.state );
		}
	}
	return { locations, assetCount, assetCountExact, totalReferenceCount, documentCount, cssResourcesTruncated };
}

function assetEvidence(
	references: AssetEvidenceReferences,
	mediaStubs: MediaStubStore,
	resourceManifest: CapturedResourceManifest,
	portablePaths: ReadonlyMap< string, string >,
	outputDir: string,
	portableRoot: string = outputDir,
): {
	assetCount: number;
	assetCountExact: boolean;
	totalReferenceCount: number;
	assetsTruncated: boolean;
	assets: AssetEvidenceRecord[];
} {
	const sortedUrls = [ ...references.locations.keys() ].sort( ( left, right ) => left.localeCompare( right ) );
	const records = sortedUrls.map( ( url ) => {
		const stub = mediaStubs.get( url );
		const resource = resourceManifest.resources[ url ];
		const path = portablePaths.get( url );
		const included = path !== undefined && existsSync( resolve( portableRoot, path ) );
		const resourcePath = resource ? resolve( outputDir, resource.path ) : undefined;
		const retrieved = resourcePath
			? pathWithin( outputDir, resourcePath ) && existsSync( resourcePath )
			: stub?.status === 'success' && stub.localPath !== undefined && existsSync( stub.localPath );
		const reportedSuccess = resource !== undefined || stub?.status === 'success';
		const failure =
			resourceManifest.failures.find( ( candidate ) => candidate.url === url )?.error ??
			( stub?.status === 'error' ? stub.error : undefined ) ??
			( reportedSuccess && !retrieved
				? 'captured asset file is unavailable'
				: retrieved && !included
				? 'retrieved asset was not included in the portable website'
				: undefined );
		const retrieval: AssetEvidenceRecord[ 'retrieval' ] = retrieved
			? 'retrieved'
			: resourceManifest.failures.some( ( candidate ) => candidate.url === url ) || stub?.status === 'error'
			? 'failed'
			: 'unknown';
		const outcome: AssetEvidenceRecord[ 'outcome' ] = included ? 'successful' : failure ? 'failed' : 'unknown';
		const portable: AssetEvidenceRecord[ 'portable' ] = included
			? 'included'
			: retrieval === 'retrieved'
			? 'excluded'
			: 'not-included';
		const indexed = references.locations.get( url )!;
		const locations = indexed.references.sort(
			( left, right ) =>
				left.route.localeCompare( right.route ) ||
				left.document.localeCompare( right.document ) ||
				left.reference.localeCompare( right.reference )
		);
		return {
			id: url,
			sourceUrl: url,
			outcome,
			retrieval,
			portable,
			...( included && path ? { path, portableAssetId: path } : {} ),
			...( outcome === 'failed' ? { error: failure } : {} ),
			referenceCount: indexed.count,
			referencesTruncated: indexed.count > MAX_ASSET_EVIDENCE_REFERENCES,
			references: locations,
		};
	} );
	return {
		assetCount: references.assetCount,
		assetCountExact: references.assetCountExact,
		totalReferenceCount: references.totalReferenceCount,
		assetsTruncated: !references.assetCountExact,
		assets: records,
	};
}

export const UNCAPTURED_ROUTE_REASON = 'target route was not captured';

/** Project matching receipt and evidence into the private generation after rendering. */
export function writeCaptureEvidence( input: CaptureEvidenceInput ): string {
	const outputDir = input.locations.captureRoot;
	const stageDir = input.locations.stageRoot;
	const websiteDir = join( stageDir, 'website' );
	const options = input.source;
	const capture = { entries: input.capture.entries };
	const absentRoutes = input.capture.absentRoutes;
	const httpInput = input.capture.http;
	const embedded = input.capture.embedded;
	const capturedInteractivity = input.capture.interactivity;
	const retainedEntries = input.pages;
	const routes = input.routes.retained;
	const excludedRoutes = input.routes.excluded;
	const duplicateRoutes = input.routes.duplicates;
	const interactionPages = input.states.interactions;
	const scrollStatesPages = input.states.scroll;
	const { fluidReports, switchWidths } = input.layout;
	const assetReferenceLocations = input.assets.references;
	const mediaStubs = input.assets.stubs;
	const resourceManifest = input.assets.manifest;
	const portablePathsBySource = input.assets.portablePaths;
	const assets = input.assets.files;
	const portableMedia = input.assets.media;
	const semanticEvidence = input.semantic;
	const routeCaptureDiagnostics = input.diagnostics.capture;
	const unresolvedDependencies = input.diagnostics.dependencies;
	const unresolvedMedia = input.diagnostics.media;
	const unresolvedAnchors = input.diagnostics.anchors;
	const rejectedReplacementKeys = input.diagnostics.rejectedKeys;
	const styleHoistDiagnostics = input.diagnostics.styles;
	const geometryCaptureOmissions: Record< string, number > = {};
	const geometryInputs = function* () {
		for ( const entry of [ ...retainedEntries ].sort( ( left, right ) =>
			left.url.localeCompare( right.url )
		) ) {
			const observations: GeometryCapture[ 'observations' ] = [];
			for ( const viewport of [ 'desktop', 'mobile' ] ) {
				const path = join( outputDir, 'layout-geometry', `${ entry.slug }.${ viewport }.json` );
				if ( httpInput || ! existsSync( path ) ) {
					geometryCaptureOmissions[ 'capture_missing' ] =
						( geometryCaptureOmissions[ 'capture_missing' ] ?? 0 ) + 1;
					continue;
				}
				try {
					const capture = JSON.parse( readFileSync( path, 'utf8' ) ) as GeometryCapture;
					if (
						capture.schema !== 'data-liberation/layout-geometry-capture/v1' ||
						! Array.isArray( capture.observations )
					) {
						throw new Error( 'schema_invalid' );
					}
					observations.push( ...capture.observations );
					for ( const [ code, count ] of Object.entries( capture.omissions ?? {} ) )
						geometryCaptureOmissions[ code ] = ( geometryCaptureOmissions[ code ] ?? 0 ) + count;
				} catch {
					geometryCaptureOmissions[ 'capture_invalid' ] =
						( geometryCaptureOmissions[ 'capture_invalid' ] ?? 0 ) + 1;
				}
			}
			const routePath = entry.routePath;
			const html = readFileSync( join( websiteDir, routePath ), 'utf8' );
			yield {
				sourcePath: `website/${ routePath }`,
				html,
				identityHtml: readFileSync( entry.identityHtmlPath, 'utf8' ),
				observations,
			};
		}
	};
	const geometry = buildLayoutGeometryProof( geometryInputs );
	const geometryReport = {
		...geometry.report,
		capture_omissions: geometryCaptureOmissions,
	};
	writeFileSync(
		join( stageDir, 'layout-geometry-report.json' ),
		`${ JSON.stringify( geometryReport, null, 2 ) }\n`
	);
	exportPublicationBoundary( EXPORT_PUBLICATION_BOUNDARIES.sidecarWrite );
	if ( geometry.proof )
		writeFileSync(
			join( stageDir, 'layout-geometry-proof.json' ),
			`${ JSON.stringify( geometry.proof, null, 2 ) }\n`
		);

	const interactionStates = interactionPages.flatMap( ( page ) => page.states );
	const initialDialogs = interactionPages.flatMap( ( page ) => page.initialDialogs ?? [] );
	const interactionSummary = {
		candidate_count: interactionStates.length,
		captured_count: interactionStates.filter( ( state ) => state.status === 'captured' ).length,
		no_dialog_count: interactionStates.filter( ( state ) => state.status === 'no-dialog' ).length,
		click_failed_count: interactionStates.filter( ( state ) => state.status === 'click-failed' )
			.length,
		truncated_count: interactionStates.filter(
			( state ) =>
				state.status === 'captured' &&
				( state.dialog?.htmlTruncated || state.choiceGroup?.transition.htmlTruncated )
		).length,
		ancestor_state_unverified_count: interactionStates.filter( state => state.dialog?.ancestorState?.status === 'unverified' ).length,
		initial_dialog_count: initialDialogs.length,
		initial_captured_count: initialDialogs.filter( ( state ) => state.status === 'captured' ).length,
		initial_dismissal_verified_count: initialDialogs.filter(
			( state ) => state.dismissal?.verified
		).length,
	};
	const unreproducedMotion = capturedInteractivity
		.filter( ( page ) => page.status === 'unreproduced' );
	const sourceInteractivity = unreproducedMotion.length ? {
		schema: SOURCE_INTERACTIVITY_SCHEMA,
		path: 'source-interactivity.json',
		unreproduced_route_count: unreproducedMotion.length,
	} : undefined;
	if ( sourceInteractivity ) writeFileSync(
		join( stageDir, sourceInteractivity.path ),
		`${ JSON.stringify( { schema: SOURCE_INTERACTIVITY_SCHEMA, pages: unreproducedMotion }, null, 2 ) }\n`
	);
	if ( semanticEvidence ) {
		writeFileSync( join( stageDir, semanticEvidence.index.path ), semanticEvidence.index.content );
		for ( const shard of semanticEvidence.shards ) {
			const path = join( stageDir, shard.path );
			mkdirSync( dirname( path ), { recursive: true } );
			writeFileSync( path, shard.content );
		}
	}
	if ( interactionPages.length > 0 ) {
		writeFileSync(
			join( stageDir, 'interaction-states.json' ),
			`${ JSON.stringify(
				{
					schema: CAPTURED_INTERACTIONS_SCHEMA,
					pages: interactionPages,
					totals: interactionSummary,
				},
				null,
				2
			) }\n`
		);
	}
	const scrollStatesSummary = {
		page_count: scrollStatesPages.length,
		toggle_count: scrollStatesPages.reduce( ( total, page ) => total + page.toggles.length, 0 ),
	};
	if ( scrollStatesPages.length > 0 ) {
		writeFileSync(
			join( stageDir, 'scroll-states.json' ),
			`${ JSON.stringify(
				{
					schema: CAPTURED_SCROLL_STATES_SCHEMA,
					pages: scrollStatesPages,
					totals: scrollStatesSummary,
				},
				null,
				2
			) }\n`
		);
	}

	// --- source profile -------------------------------------------------------
	// What the source actually does, measured rather than assumed: whether it
	// serves one document or one per device, whether its geometry is authored or
	// written by a runtime, and where it changes behavior. Downstream stages
	// consume this instead of hardcoding viewports and breakpoints.
	const routesWithMobile = retainedEntries.filter( ( entry ) => entry.hasMobileDocument ).length;
	const { deviceSelections = [], widthSelections = [] } = input.layout;
	const learnedApplied = fluidReports.reduce( ( total, report ) => total + report.applied, 0 );
	const learnedFrozen = fluidReports.reduce( ( total, report ) => total + report.unmodelled, 0 );
	const observedBreakpoints = [
		...new Set( fluidReports.flatMap( ( report ) => report.breakpoints ) ),
	].sort( ( a, b ) => a - b );
	const sourceProfile = {
		schema: SOURCE_PROFILE_SCHEMA,
		variants: routesWithMobile > 0 ? 'per-device' : 'single',
		documentsPerRoute: Math.max( routesWithMobile > 0 ? 2 : 1, ...deviceSelections.map( row => row.documents.length - row.missing.length ) ),
		documentSelection: deviceSelections.length || widthSelections.length ? {
			kind: deviceSelections.length ? widthSelections.length ? 'mixed' : 'device' : 'width',
			routes: [ ...deviceSelections.map( row => ( { kind: 'device', ...row } ) ), ...widthSelections ],
		} : undefined,
		geometry:
			httpInput ? 'unverified' : learnedApplied > 0 && learnedFrozen > 0
				? 'mixed'
				: learnedApplied > 0
				? 'runtime-written'
				: 'declarative',
		switchWidth: switchWidths.length > 0 ? Math.max( ...switchWidths ) : null,
		switchWidthSource: deviceSelections.length && ! switchWidths.length ? 'not-applicable' : widthSelections.length === switchWidths.length && widthSelections.length > 0 ? 'observed' : switchWidths.length > 0 ? 'detected' : 'default',
		breakpoints: observedBreakpoints,
		learned: { applied: learnedApplied, frozen: learnedFrozen, routes: routes.filter( entry => entry.fluidGeometry ).length, documents: fluidReports.length },
	};
	writeFileSync(
		join( stageDir, 'source-profile.json' ),
		`${ JSON.stringify( sourceProfile, null, 2 ) }\n`
	);
	const assetEvidenceReport = assetEvidence(
		assetReferenceLocations,
		mediaStubs,
		resourceManifest,
		portablePathsBySource,
		outputDir,
		stageDir,
	);
	writeFileSync(
		join( stageDir, 'asset-evidence.json' ),
		`${ JSON.stringify(
			{
				schema: ASSET_EVIDENCE_SCHEMA,
				assetCount: assetEvidenceReport.assetCount,
				assetCountExact: assetEvidenceReport.assetCountExact,
				totalReferenceCount: assetEvidenceReport.totalReferenceCount,
				assetsTruncated: assetEvidenceReport.assetsTruncated,
				referenceLimit: MAX_ASSET_EVIDENCE_REFERENCES,
				coverage: {
					retainedRouteCount: retainedEntries.length,
					documentCount: assetReferenceLocations.documentCount,
					assetLimit: MAX_ASSET_EVIDENCE_ASSETS,
					assetSelection: 'first reachable source URLs in retained route traversal',
					cssTraversal: 'reachable captured CSS resources only',
					cssResourcesPerRouteLimit: MAX_ASSET_EVIDENCE_CSS_RESOURCES_PER_ROUTE,
					cssResourcesTruncated: assetReferenceLocations.cssResourcesTruncated,
				},
				assets: assetEvidenceReport.assets,
			},
			null,
			2
		) }\n`
	);

	// Merge capture-time route diagnostics (this route never produced HTML) with
	// discovery-time diagnostics (this route was rejected before capture even
	// started, e.g. a same-origin sitemap leaf) into one reported list — every
	// route the source advertised is now either in `routes` or named here with
	// a reason, never just missing.
	const linkedPageCoveragePath = join( outputDir, 'linked-page-coverage.json' );
	const linkedPageCoverage = existsSync( linkedPageCoveragePath ) ? JSON.parse( readFileSync( linkedPageCoveragePath, 'utf8' ) ) as import( './screenshot/types.js' ).ScreenshotResult['linkedPageCoverage'] : undefined;
	const discoveryDiagnostics = [
		...( options.discoveryDiagnostics ?? [] ),
		...( linkedPageCoverage?.diagnostics ?? [] ).filter( row => ! options.discoveryDiagnostics?.some( prior => prior.code === row.code && prior.url === row.url && prior.reason === row.reason ) ),
		...( httpInput?.diagnostics ?? [] ),
		...routeCaptureDiagnostics,
	];

	const receiptPath = join( stageDir, 'capture-receipt.json' );
	// Only proven source-absent routes lack a document requiring cleanup.
	// Keep every other attempted route in the audit, even if it lost its HTML.
	const cleanupPages = Object.entries(capture.entries)
		.filter(([url, entry]) => !absentRoutes.has(url) && !entry.redirectedTo && !entry.externalRedirect)
		.map(([url, entry]) => ({ url, ...entry.cleanup }));
	const recordedPolicy = cleanupPages.find((page) => page.policy)?.policy;
	const cleanup = recordedPolicy ? {
		policy: recordedPolicy,
		evidencePath: 'cleanup-evidence.json',
		complete: cleanupPages.every((page) => page.policy && JSON.stringify(page.policy) === JSON.stringify(recordedPolicy) &&
			page.reports?.length && page.reports.every((report) => report.failures.length === 0 && report.residual === 0)),
	} : undefined;
	if (cleanup) writeFileSync(join(stageDir, 'cleanup-evidence.json'), JSON.stringify({ schema: recordedPolicy!.schema, pages: cleanupPages }, null, 2));
	const complete =
		! httpInput && Number( options.summary.routesFailed ?? 0 ) === 0 &&
		! discoveryDiagnostics.some( diagnostic => diagnostic.code === 'linked_page_budget_exhausted' || diagnostic.code === 'linked_page_outcome_unproven' ) &&
		! unresolvedAnchors.some( ( anchor ) => anchor.reason === UNCAPTURED_ROUTE_REASON );
	const nativePages = Object.entries( capture.entries ).filter( ([ , entry ]) => entry.nativeViewTimelines ).map( ([ url, entry ]) => ({ url, profiles: entry.nativeViewTimelines }) );
	const nativeViewTimelines = nativePages.length ? {
		schema: 'data-liberation/native-view-timelines/v1',
		pages: nativePages,
		binding: { targetEffectsAttribute: 'data-dla-native-effects', nodeIdentityAttribute: 'data-dla-native-node', profileAttribute: 'data-dla-native-profile', documentScopeAttribute: 'data-dla-document-scope' },
		verification: 'source-observed; portable motion parity requires browser verification',
	} : undefined;

	writeFileSync(
		receiptPath,
		`${ JSON.stringify(
			{
				schema: CAPTURE_RECEIPT_SCHEMA,
				...( httpInput ? { acquisition: httpInput.acquisition } : {} ),
				...( embedded ? { embeddedDocuments: embedded.evidence } : {} ),
				...(cleanup ? { cleanup } : {}),
				websiteRoot: 'website',
				entrypoint: 'website/index.html',
				source: { url: options.sourceUrl, platform: options.platform, ...(options.routeScope ? { routeScope: options.routeScope } : {}) },
				...( options.title ? { title: options.title } : {} ),
				// Declares the class tokens this capture tool uses to mark one side
				// of a desktop/mobile document pair inside one exported page, so a
				// generic consumer can recognize them as a document-scope boundary
				// without hardcoding this tool's naming convention.
				document_scope_classes: [ ...new Set( [ DESKTOP_DOCUMENT_CLASS, MOBILE_DOCUMENT_CLASS,
					...deviceSelections.flatMap( row => row.documents.filter( key => ! row.missing.includes( key ) ).map( key => `data-liberation-${ key }-document` ) ),
				] ) ],
				routes,
				assets,
				assetEvidence: { path: 'asset-evidence.json', schema: ASSET_EVIDENCE_SCHEMA },
				portableMedia,
				interactions: interactionSummary,
				...(sourceInteractivity ? { sourceInteractivity } : {}),
				scrollStates: scrollStatesSummary,
				layoutGeometry: geometryReport,
				...( nativeViewTimelines ? { nativeViewTimelines } : {} ),
				sourceProfile,
				excludedRoutes,
				sourceOutcomes: Object.values( capture.entries ).filter( entry => entry.externalRedirect ).flatMap( entry => entry.sourceOutcomes ?? [] ),
				duplicateRoutes,
				...( linkedPageCoverage ? { linkedPageCoverage } : {} ),
				discoveryDiagnostics,
				summary: { ...options.summary, complete },
			},
			null,
			2
		) }\n`
	);
	writeFileSync(
		join( stageDir, 'diagnostics.json' ),
		`${ JSON.stringify(
			{
				schema: 'data-liberation/capture-diagnostics/v1',
				complete,
				...( linkedPageCoverage ? { linkedPageCoverage } : {} ),
				failures: options.failures,
				discoveryDiagnostics,
				resourceFailures: resourceManifest.failures,
				unresolvedDependencies,
				unresolvedMedia: [
					...unresolvedMedia,
					...[ ...rejectedReplacementKeys ].map( ( source ) => ( {
						url: source,
						error: 'skipped degenerate replacement key',
					} ) ),
				],
				unresolvedAnchors,
				portableMedia,
				interactions: interactionSummary,
				...(sourceInteractivity ? { sourceInteractivity } : {}),
				scrollStates: scrollStatesSummary,
				interactionFailures: interactionStates.filter( ( state ) => state.status !== 'captured' ),
				...( nativeViewTimelines ? { nativeViewTimelines } : {} ),
				excludedRoutes,
				duplicateRoutes,
				styleHoist: {
					hoistedStylesheets: input.diagnostics.styles.hoistedStylesheets,
					diagnostics: styleHoistDiagnostics.diagnostics,
					diagnosticCounts: styleHoistDiagnostics.diagnosticCounts,
					diagnosticsTruncated: styleHoistDiagnostics.diagnosticsTruncated,
				},
			},
			null,
			2
		) }\n`
	);
	return receiptPath;
}
