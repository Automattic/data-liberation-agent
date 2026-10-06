import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findAdapter } from '../adapters/index.js';
import type { PlatformAdapter } from '../types.js';
import { detect } from './detect-platform/index.js';
import { downloadMedia } from './media-fetch/media.js';
import { safeFetch } from './media-fetch/safe-fetch.js';
import { downloadSectionMedia } from './replicate/download-section-media.js';
import { SectionSpecsStore } from './replicate/section-specs-store.js';
import { MediaStubStore } from './resume-state/index.js';

export interface CaptureProgress {
	unit?: 'routes' | 'documents';
	phase: 'discovering' | 'capturing' | 'media' | 'finalizing' | 'complete';
	current?: number;
	total?: number;
	url?: string;
	elapsedMs?: number;
	phaseElapsedMs?: number;
}

export interface CaptureOptions {
	/** Opt-in source-only review capture; browser rendering remains the default. */
	acquisition?: 'browser' | 'http';
	http?: import('./capture-http.js').HttpCaptureOptions;
	url: string;
	outputDir: string;
	resume?: boolean;
	captureImages?: boolean;
	/** Learn responsive sizing by sweeping widths instead of freezing one. */
	learnFluid?: boolean;
	/**
	 * Fail closed when the capture is incomplete. Default is false: a partial
	 * site is still written and returned with `complete: false`. Programmatic
	 * callers that used to guard on `routesFailed > 0` should check `complete`
	 * instead, or pass `strict: true` to reject.
	 */
	strict?: boolean;
	onProgress?: ( progress: CaptureProgress ) => void;
}

export interface UnresolvedAnchor {
	sourceUrl: string;
	reason: string;
	fragment?: string;
	targetCount?: number;
	url?: string;
}

export interface CaptureResult {
	captureReceiptPath: string;
	outputDir: string;
	summary: {
		routesDiscovered: number;
		routesCaptured: number;
		routesSkipped: number;
		routesFailed: number;
		durationMs: number;
		complete: boolean;
	};
	complete: boolean;
	failures: Array< { url: unknown; error: unknown } >;
	discoveryDiagnostics: Array< { code: string; url: string; reason: string } >;
	unresolvedAnchors: UnresolvedAnchor[];
	provenance: { provider: string; platform: string };
}

export interface CaptureDependencies {
	findAdapter( platform: string ): PlatformAdapter | null;
}

export class UnsupportedCapturePlatformError extends Error {}

export class IncompleteCaptureError extends Error {
	readonly result: CaptureResult;

	constructor( result: CaptureResult ) {
		super( 'Capture is incomplete' );
		this.name = 'IncompleteCaptureError';
		this.result = result;
	}
}

const defaultDependencies: CaptureDependencies = { findAdapter };

interface CaptureInventory {
	siteMeta?: { title?: string };
	urls?: Array< { url: string; type: string } >;
	diagnostics?: Array< { code: string; url: string; reason: string } >;
}

function captureRouteKey( url: string ): string {
	const route = new URL( url );
	route.hash = '';
	route.search = '';
	route.pathname = route.pathname.replace( /\/$/, '' ) || '/';
	return route.href;
}

export async function downloadCaptureSectionMedia(
	outputDir: string,
	urls: string[]
): Promise< number > {
	const pageRoutes = new Set(
		urls.flatMap( ( url ) => {
			try {
				return [ captureRouteKey( url ) ];
			} catch {
				return [];
			}
		} )
	);
	const sectionUrls: string[] = [];
	for ( const store of [
		SectionSpecsStore.load( outputDir ),
		SectionSpecsStore.loadMobile( outputDir ),
	] ) {
		for ( const url of urls ) {
			for ( const section of store.get( url ) ?? [] ) {
				for ( const image of [
					...( section.images ?? [] ),
					...( section.cells ?? [] ).flatMap( ( cell ) => ( cell.image ? [ cell.image ] : [] ) ),
				] ) {
					const mediaUrl = ( image.sourceUrl || image.url || '' ).trim();
					if ( ! mediaUrl ) continue;
					try {
						if ( pageRoutes.has( captureRouteKey( mediaUrl ) ) ) continue;
					} catch {
						// Invalid media URLs are dropped by downloadSectionMedia.
					}
					sectionUrls.push( mediaUrl );
				}
			}
		}
	}

	const stubs = MediaStubStore.load( outputDir );
	const mediaDir = join( outputDir, 'media' );
	const seenNames = new Map< string, number >();
	const { downloaded } = await downloadSectionMedia( {
		srcUrls: sectionUrls,
		isAlreadyDone: ( url ) => ! stubs.shouldAttempt( url ),
		download: async ( url ) => {
			const result = await downloadMedia( url, mediaDir, seenNames );
			if ( result.error ) stubs.markFailure( url, result.error );
			return result.localPath;
		},
		onSuccess: ( url, localPath ) => stubs.markSuccess( url, localPath ),
	} );
	stubs.flush();
	return downloaded;
}

export async function captureWebsite(
	options: CaptureOptions,
	dependencies: CaptureDependencies = defaultDependencies
): Promise< CaptureResult > {
	if ( options.acquisition !== undefined && ! [ 'browser', 'http' ].includes( options.acquisition ) ) throw new Error( 'Unknown capture acquisition mode' );
	if ( options.acquisition === 'http' ) ( await import( './capture-http.js' ) ).validateHttpCaptureOptions( options );
	else if ( options.http !== undefined ) throw new Error( 'HTTP capture options require HTTP acquisition' );
	const { onProgress } = options;
	const startedAt = Date.now();
	let phase = '';
	let phaseStartedAt = startedAt;
	const progress = ( event: CaptureProgress ): void => {
		const now = Date.now();
		if ( event.phase !== phase ) {
			phase = event.phase;
			phaseStartedAt = now;
		}
		const timedEvent = {
			...event,
			elapsedMs: now - startedAt,
			phaseElapsedMs: now - phaseStartedAt,
		};
		onProgress?.( timedEvent );
	};

	const response = await safeFetch( options.url, { timeoutMs: 10_000 } );
	const sourceUrl = response.finalUrl;
	const outputDir = options.outputDir;
	const detection = await detect( sourceUrl );
	const adapter = dependencies.findAdapter( detection.platform );
	if ( ! adapter )
		throw new UnsupportedCapturePlatformError(
			`No adapter available for platform: ${ detection.platform }`
		);
	if ( options.acquisition === 'http' && ! adapter.acquisition ) throw new UnsupportedCapturePlatformError( `Platform ${ adapter.id } has no HTTP acquisition profile` );

	progress( { phase: 'discovering', url: sourceUrl } );
	const inventory = ( await adapter.discover( sourceUrl, {
		outputDir,
		resume: options.resume === true,
	} ) ) as CaptureInventory;
	process.stderr.write( `[timing] discovery ${ Date.now() - phaseStartedAt }ms\n` );
	const sourceRoute = captureRouteKey( sourceUrl );
	const urls = [
		sourceUrl,
		...( inventory.urls ?? [] )
			.map( ( entry ) => entry.url )
			.filter( ( url ) => captureRouteKey( url ) !== sourceRoute ),
	];
	progress( { phase: 'capturing', current: 0, total: urls.length } );
	if ( options.acquisition === 'http' ) {
		const result = await ( await import( './capture-http.js' ) ).captureHttpWebsite( { options, sourceUrl, platform: adapter, urls, startedAt, progress, title: inventory.siteMeta?.title, discoveryDiagnostics: inventory.diagnostics ?? [] } );
		if ( options.strict && ! result.complete ) throw new IncompleteCaptureError( result );
		return result;
	}

	const { captureScreenshots } = await import( './screenshot/screenshotter.js' );
	const { createReferenceCollector } = await import( './fidelity/reference.js' );
	const reference = createReferenceCollector( outputDir, sourceUrl, urls, {
		cleanupPolicy: ( await import( './source-cleanup.js' ) ).cleanupPolicy( adapter.liberation?.cleanupRules ),
		removeSelectors: adapter.liberation?.removeSelectors,
		prepareCapture: adapter.liberation?.prepare,
	} );
	const screenshotResult = await captureScreenshots( {
		urls,
		outputDir,
		primaryUrl: sourceUrl,
		captureImages: options.captureImages === true,
		learnFluid: options.learnFluid !== false,
		force: options.resume !== true,
		removeSelectors: adapter.liberation?.removeSelectors,
		cleanupPolicy: (await import('./source-cleanup.js')).cleanupPolicy(adapter.liberation?.cleanupRules),
		prepareCapture: adapter.liberation?.prepare,
		resolveClientRedirect: adapter.liberation?.resolveClientRedirect,
		beforeSerialize: adapter.liberation?.beforeSerialize,
		observeSource: reference.observe,
		...( adapter.liberation?.canonicalizeHtml
			? { canonicalizeHtml: adapter.liberation.canonicalizeHtml.bind( adapter.liberation ) }
			: {} ),
		...( adapter.liberation?.responsiveImages
			? { collectResponsiveImages: adapter.liberation.responsiveImages.bind( adapter.liberation ) }
			: {} ),
		publicUrlsOnly: true,
		onProgress: ( current, total, url ) => progress( { phase: 'capturing', current, total, url } ),
	} );
	process.stderr.write(
		`[timing] browser-capture ${ screenshotResult.durationMs }ms (${ screenshotResult.captured } captured, ${ screenshotResult.failed } failed)\n`
	);
	progress( { phase: 'media', current: screenshotResult.captured, total: urls.length } );
	const mediaStartedAt = Date.now();
	const downloadedSectionMedia = await downloadCaptureSectionMedia( outputDir, screenshotResult.urls );
	process.stderr.write(
		`[timing] section-media ${ Date.now() - mediaStartedAt }ms (${ downloadedSectionMedia } downloaded)\n`
	);

	const exportStartedAt = Date.now();
	progress( { phase: 'finalizing', current: screenshotResult.captured, total: urls.length } );
	const failuresPath = join( outputDir, 'screenshots', 'failures.json' );
	const failures = existsSync( failuresPath )
		? ( JSON.parse( readFileSync( failuresPath, 'utf8' ) ) as Array< {
				url: unknown;
				error: unknown;
		  } > )
		: [];
	const summary = {
		routesDiscovered: urls.length,
		routesCaptured: screenshotResult.captured,
		routesSkipped: screenshotResult.skipped,
		routesFailed: screenshotResult.failed,
		durationMs: screenshotResult.durationMs,
	};
	const { exportWebsiteCapture } = await import( './capture-export.js' );
	const captureReceiptPath = exportWebsiteCapture( {
		outputDir,
		sourceUrl,
		platform: detection.platform,
		title: inventory.siteMeta?.title,
		summary,
		failures,
		discoveryDiagnostics: inventory.diagnostics ?? [],
	} );
	process.stderr.write( `[timing] export ${ Date.now() - exportStartedAt }ms\n` );
	const previewStartedAt = Date.now();
	// A portable homepage preview is a deliverable, not optional capture evidence.
	// Its failure must not turn an otherwise usable website into a failed capture.
	const { captureSitePreview } = await import( './site-preview.js' );
	let preview;
	try {
		preview = { status: 'captured', ...await captureSitePreview( join( outputDir, 'website' ) ) };
	} catch ( error ) {
		preview = { status: 'failed', reason: error instanceof Error ? error.message : String( error ) };
	}
	const receipt = JSON.parse( readFileSync( captureReceiptPath, 'utf8' ) );
	receipt.preview = preview;
	writeFileSync( captureReceiptPath, `${ JSON.stringify( receipt, null, 2 ) }\n` );
	process.stderr.write( `[timing] homepage-preview ${ Date.now() - previewStartedAt }ms\n` );
	const unresolvedAnchors = readUnresolvedAnchors( outputDir );
	// Diagnosed dynamic pages need causal evidence, not an author-authored site
	// recipe. Discovery remains explicit untranslated evidence until a portable
	// implementation passes the independent source fidelity gate.
	await ( await import( './behavior-discovery.js' ) ).discoverCapturedBehavior( outputDir );
	reference.finalize( captureReceiptPath );
	const complete =
		summary.routesFailed === 0 &&
		unresolvedAnchors.every( ( anchor ) => anchor.reason !== 'target route was not captured' );
	const result: CaptureResult = {
		captureReceiptPath,
		outputDir,
		summary: { ...summary, complete },
		complete,
		failures,
		discoveryDiagnostics: inventory.diagnostics ?? [],
		unresolvedAnchors,
		provenance: { provider: 'data-liberation/browser-capture', platform: detection.platform },
	};
	progress( { phase: 'complete', current: urls.length, total: urls.length } );
	if ( options.strict && ! complete ) throw new IncompleteCaptureError( result );
	return result;
}

function readUnresolvedAnchors( outputDir: string ): UnresolvedAnchor[] {
	const diagnosticsPath = join( outputDir, 'diagnostics.json' );
	if ( ! existsSync( diagnosticsPath ) ) return [];
	try {
		const diagnostics = JSON.parse( readFileSync( diagnosticsPath, 'utf8' ) ) as {
			unresolvedAnchors?: UnresolvedAnchor[];
		};
		return Array.isArray( diagnostics.unresolvedAnchors ) ? diagnostics.unresolvedAnchors : [];
	} catch {
		return [];
	}
}
