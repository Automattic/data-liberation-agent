import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Page } from 'playwright';
import { PNG } from 'pngjs';
import { observePage, routeSourceMap } from './check.js';
import { cleanupPolicy, readSourceCleanup, type CleanupReport } from '../source-cleanup.js';
import type { LayoutObservation } from './score.js';
import { isRouteDrift, navigationDocumentUrl } from '../screenshot/document-integrity.js';
import { applyCaptureRemovals } from '../screenshot/apply-removals.js';
import type { CleanupPolicy } from '../source-cleanup.js';
import { captureViewportScreenshot } from './viewport-screenshot.js';
import { navigateSourceDocument, storeExternalBoundary, boundaryIdentity, type ExternalBoundary } from '../source-navigation.js';
import { lockMainFrameNavigation } from '../screenshot/screenshotter.js';
import { replayBrowserIdentity, type CaptureProfile } from '../screenshot/capture-profiles.js';
import { observeViewportEntrances, collectViewportEntranceStartup } from '../viewport-entrances.js';

export interface ReferenceCollectorOptions {
	routeScope?: import('../../platform/types.js').SiteRouteScope;
	publicUrlsOnly?: boolean;
	cleanupPolicy?: CleanupPolicy;
	removeSelectors?: string[];
	prepareCapture?: ( page: Page, ctx: { url: string; viewport: string } ) => Promise<void>;
}

export const REFERENCE_WIDTHS = [ 390, 768, 1440 ];
export type FidelityStage = 'capture' | 'materialization' | 'drift';
export interface ReferenceArtifact { path: string; sha256: string }
export interface ReferenceEntry {
	/** An observed boundary is not a rendered local-document cell. */
	outcome?: ExternalBoundary;
	/** Named source document/profile identity; absent on older width-only evidence. */
	profile?: string;
	context?: CaptureProfile['context'];
	viewportMeta?: string;
	deviceScaleFactor?: number;
	browserProfile?: Readonly<{ isMobile: boolean; hasTouch: boolean }>;
	/** Assigned from the exported receipt; absent when no portable route was retained. */
	route?: string;
	sourceUrl: string;
	viewport: number;
	viewportHeight: number;
	device: string;
	userAgent?: string;
	state: string;
	readiness: { ready: boolean; reasons: string[]; cleanup?: CleanupReport; mediaReady?: boolean; fontsReady?: boolean };
	observation?: ReferenceArtifact;
	screenshot?: ReferenceArtifact;
	document?: ReferenceArtifact;
}
export interface FidelityReference {
	schema: 'data-liberation/fidelity-reference/v1';
	captureId: string;
	sourceUrl: string;
	createdAt: string;
	receipt: ReferenceArtifact;
	capture: ReferenceArtifact[];
	scope: { sourceUrls: string[]; widths: number[]; states: string[]; unknowns: string[]; cells?: ReferenceCell[] };
	entries: ReferenceEntry[];
}
export interface ReferenceCell {
	sourceUrl: string;
	profile: string;
	viewport: number;
	state: string;
}
export function digest( bytes: string | Buffer ): string {
	return createHash( 'sha256' ).update( bytes ).digest( 'hex' );
}

/** Paths in evidence are relative, confined to the run, and verified before use. */
export function readReferenceArtifact( directory: string, artifact: ReferenceArtifact ): Buffer {
	const root = resolve( directory );
	const path = resolve( root, artifact.path );
	if ( ! path.startsWith( `${ root }${ sep }` ) ) throw new Error( 'Reference path escapes run directory' );
	const bytes = readFileSync( path );
	if ( digest( bytes ) !== artifact.sha256 ) throw new Error( `Reference digest mismatch: ${ artifact.path }` );
	return bytes;
}

/** A single capture invocation owns this collector. Resume never invents evidence for skipped sessions. */
export function createReferenceCollector( directory: string, sourceUrl: string, sourceUrls: string[], options: ReferenceCollectorOptions = {} ) {
	const captureId = randomUUID();
	const entries: ReferenceEntry[] = [];
	const cells = new Map<string, ReferenceCell>();
	const declare = ( url: string, profile: CaptureProfile ): void => {
		for ( const viewport of profile.referenceWidths ?? ( profile.id === 'mobile' ? [ 390 ] : profile.id === 'desktop' ? [ 768, 1440 ] : [ profile.width ] ) ) {
			const cell = { sourceUrl: url, profile: profile.id, viewport, state: 'baseline' };
			cells.set( JSON.stringify( cell ), cell );
		}
	};
	const store = ( name: string, bytes: string | Buffer ): ReferenceArtifact => {
		const path = `reference/${ captureId }/${ name }`;
		mkdirSync( dirname( join( directory, path ) ), { recursive: true } );
		writeFileSync( join( directory, path ), bytes );
		return { path, sha256: digest( bytes ) };
	};
	return {
		declare,
		requireUrls( urls: string[] ): void { sourceUrls = [ ...new Set( [ ...sourceUrls, ...urls ] ) ]; },
		async observe( page: Page, url: string, device: string, errors: readonly string[] = [], browserProfile?: ReferenceEntry['browserProfile'], profile?: CaptureProfile, expectedBoundary?: ExternalBoundary ): Promise<void> {
			const recipe = profile ?? { id: device, width: page.viewportSize()?.width ?? 1440, height: 900 };
			declare( url, recipe );
			for ( const cell of [ ...cells.values() ].filter( cell => cell.sourceUrl === url && cell.profile === device ) ) {
					const viewport = cell.viewport;
					const identity = profile?.context ? replayBrowserIdentity( profile.context ) : undefined;
					const entry: ReferenceEntry = { sourceUrl: url, viewport, viewportHeight: 900, device, profile: device, context: identity, state: 'baseline', readiness: { ready: false, reasons: [] } };
					entries.push( entry );
					let referencePage: Page | undefined;
					let referenceContext: import('playwright').BrowserContext | undefined;
					const runtimeError = ( error: Error ) => entry.readiness.reasons.push( `source runtime error: ${ error.message }` );
					const rendererCrash = () => entry.readiness.reasons.push( 'source renderer crashed' );
					let releaseNavigation: (() => Promise<void>) | undefined;
					let navigationUrl = url;
					try {
						const sourceContext = page.context();
						const browser = typeof sourceContext.browser === 'function' ? sourceContext.browser() : null;
						if ( identity?.screen && ! browser ) throw new Error( 'Preset screen replay requires a source browser context' );
						if ( identity?.screen && browser ) {
							// Page.setViewportSize resets screen even on an explicitly screened
							// device context. Construct at the target viewport to preserve the
							// resolved preset. Session state stays runtime-only, never in entry.
							referenceContext = await browser.newContext( { ...identity, viewport: { width: viewport, height: 900 },
								storageState: await sourceContext.storageState(), ignoreHTTPSErrors: true,
							} );
							await referenceContext.addInitScript( "if(typeof globalThis.__name==='undefined')globalThis.__name=function(fn){return fn;};" );
							referencePage = await referenceContext.newPage();
						} else {
							// Without an explicit screen, each width is an independent navigation
							// in the source context. Resizing a page that has crossed breakpoints or
							// scrolled can preserve runtime/header state that a fresh visitor does
							// not have, making the reference describe a different pose than capture.
							// browser.newPage() creates a convenience-owned context that cannot
							// open sibling pages; keep that unit-test/one-off path compatible.
							try {
								referencePage = await page.context().newPage();
							} catch {
								// Convenience-owned contexts (browser.newPage()) cannot open a
								// sibling page. Their callers already own the source page, so retain
								// compatibility; capture's normal browser.newContext() path is fresh.
								referencePage = page;
							}
							await referencePage.setViewportSize( { width: viewport, height: 900 } );
						}
						if (expectedBoundary) {
							const navigation = await navigateSourceDocument(referencePage, url, {publicUrlsOnly: options.publicUrlsOnly, routeScope: options.routeScope ?? expectedBoundary.routeScope});
							if (!navigation.boundary || !browserProfile) throw new Error('Reference external boundary or browser profile unproven');
							entry.outcome = storeExternalBoundary(directory, navigation.boundary, viewport, browserProfile);
							if (boundaryIdentity(entry.outcome) !== boundaryIdentity(expectedBoundary)) throw new Error('Reference external outcome disagrees with capture');
							entry.browserProfile = browserProfile;
							entry.readiness.reasons.push(...errors);
							entry.readiness.ready = entry.readiness.reasons.length === 0;
							continue;
						}
						referencePage.on( 'pageerror', runtimeError );
						referencePage.on( 'crash', rendererCrash );
						await referencePage.addInitScript( observeViewportEntrances );
						if ( url !== 'about:blank' ) {
							const navigation = options.routeScope ? await navigateSourceDocument( referencePage, url, { publicUrlsOnly: options.publicUrlsOnly, routeScope: options.routeScope } ) : undefined;
							if ( navigation?.boundary || navigation?.redirectedTo ) throw new Error( 'Reference document changed its route ownership or identity' );
							const response = navigation ? navigation.response : await referencePage.goto( url, { waitUntil: 'load', timeout: 60_000 } );
							if ( response && ! response.ok() ) throw new Error( `Reference navigation HTTP ${ response.status() }` );
							navigationUrl = navigationDocumentUrl( url, response?.url() ?? url, Boolean( response?.request().redirectedFrom() ) );
						}
						releaseNavigation = await lockMainFrameNavigation(referencePage, () => entry.readiness.reasons.push('source route drift'), true);
						entry.userAgent = await referencePage.evaluate( () => navigator.userAgent );
						entry.deviceScaleFactor = await referencePage.evaluate( () => window.devicePixelRatio );
						entry.browserProfile = browserProfile;
						if ( ! browserProfile ) entry.readiness.reasons.push( 'source browser profile unproven' );
						const observation = await observePage( referencePage, url, viewport, 0, null, options.cleanupPolicy ?? cleanupPolicy(), async () => {
							await applyCaptureRemovals( referencePage!, { removeSelectors: options.removeSelectors, prepare: options.prepareCapture, ctx: { url, viewport: device } } );
						}, true, referencePage === page );
						const cleanup = await readSourceCleanup( referencePage );
						entry.readiness.cleanup = cleanup;
						if ( cleanup.failures.length || cleanup.residual ) entry.readiness.reasons.push( 'source cleanup incomplete' );
						// Freeze the same route identity capture accepts: query/hash
						// renditions do not become different origin/path documents.
						if ( isRouteDrift( referencePage.url(), navigationUrl ) ) entry.readiness.reasons.push( 'source route drift' );
						const mediaReady = await referencePage.evaluate( () => [ ...document.images ].every( image => {
							const rect = image.getBoundingClientRect();
							return rect.width <= 50 || rect.height <= 50 || ( image.complete && image.naturalWidth > 0 );
						} ) );
						if ( ! mediaReady ) entry.readiness.reasons.push( 'source images pending or failed' );
						entry.readiness.mediaReady = mediaReady;
						entry.readiness.fontsReady = ! observation.typography?.some( text => ! text.loaded );
						if ( ! entry.readiness.fontsReady ) entry.readiness.reasons.push( 'source fonts pending or failed' );
						const stem = `${ digest( url ).slice( 0, 24 ) }-${ digest( device ).slice( 0, 12 ) }-${ viewport }`;
						entry.viewportMeta = await referencePage.evaluate( () => document.querySelector( 'meta[name="viewport"]' )?.getAttribute( 'content' ) ?? undefined );
						entry.observation = store( `${ stem }.json`, JSON.stringify( observation ) );
						entry.document = store( `${ stem }.html`, await referencePage.content() );
						entry.screenshot = store( `${ stem }.png`, await captureViewportScreenshot( referencePage ) );
						await collectViewportEntranceStartup( referencePage, page );
						entry.readiness.reasons.push( ...errors );
						entry.readiness.ready = entry.readiness.reasons.length === 0;
					} catch ( error ) {
						entry.readiness.reasons.push( String( error ) );
					} finally {
						await releaseNavigation?.();
						referencePage?.off( 'pageerror', runtimeError );
						referencePage?.off( 'crash', rendererCrash );
						if ( referencePage && referencePage !== page ) await referencePage.close().catch( () => {} );
						await referenceContext?.close().catch( () => {} );
					}
				}
		},
		finalize( receiptPath: string ): string {
			const coveragePath = join(directory, 'linked-page-coverage.json');
			if (existsSync(coveragePath)) {
				const coverage = JSON.parse(readFileSync(coveragePath, 'utf8')) as {requiredUrls: string[]};
				sourceUrls = [...new Set([...sourceUrls, ...coverage.requiredUrls])];
			}
			const receiptBytes = readFileSync( receiptPath );
			const receipt = JSON.parse( receiptBytes.toString() );
			const files: ReferenceArtifact[] = [];
			const walk = ( path: string ): void => {
				for ( const item of readdirSync( path, { withFileTypes: true } ) ) {
					const file = join( path, item.name );
					if ( item.isDirectory() ) walk( file );
					else if ( item.isFile() ) files.push( { path: relative( directory, file ), sha256: digest( readFileSync( file ) ) } );
				}
			};
			if ( existsSync( join( directory, 'website' ) ) ) walk( join( directory, 'website' ) );
			const routes = routeSourceMap( receipt );
			const capturedUrls = [ ...routes.values() ];
			for ( const entry of entries ) entry.route = [ ...routes ].find( ( [ , url ] ) => url === entry.sourceUrl )?.[0];
			const manifest: FidelityReference = {
				schema: 'data-liberation/fidelity-reference/v1', captureId, sourceUrl, createdAt: new Date().toISOString(),
				receipt: { path: relative( directory, receiptPath ), sha256: digest( receiptBytes ) }, capture: files,
				scope: { sourceUrls: [ ...new Set( [ ...sourceUrls, ...capturedUrls ] ) ], widths: cells.size ? [ ...new Set( [ ...cells.values() ].map( cell => cell.viewport ) ) ].sort( ( a, b ) => a - b ) : [ ...REFERENCE_WIDTHS ], states: [ 'baseline' ], cells: [ ...cells.values() ],
					unknowns: [ 'Interaction states are not frozen; baseline scope excludes dialogs, zoom, and motion.', 'Readiness is bounded to settled layout, cleanup and decoded images; asynchronous application work may remain.' ] },
				entries,
			};
			const path = join( directory, 'fidelity-reference.json' );
			writeFileSync( path, `${ JSON.stringify( manifest, null, 2 ) }\n` );
			return path;
		},
	};
}

export function readFrozenObservation( directory: string, entry: ReferenceEntry ): { observation: LayoutObservation; png: Buffer } {
	const readiness = entry.readiness;
	if ( ! readiness.ready || readiness.reasons.length || ! readiness.mediaReady || ! readiness.fontsReady || ! readiness.cleanup || readiness.cleanup.failures.length || readiness.cleanup.residual || ! entry.observation || ! entry.screenshot || ! entry.document ) throw new Error( `Source evidence unready: ${ readiness.reasons.join( ', ' ) }` );
	readReferenceArtifact( directory, entry.document );
	const observation = JSON.parse( readReferenceArtifact( directory, entry.observation ).toString() ) as LayoutObservation;
	if ( observation.viewport !== entry.viewport ) throw new Error( 'Source observation viewport mismatch' );
	const png = readReferenceArtifact( directory, entry.screenshot );
	const dimensions = PNG.sync.read( png );
	if ( entry.viewportHeight !== 900 || dimensions.width !== entry.viewport || dimensions.height !== entry.viewportHeight ) throw new Error( 'Source screenshot viewport mismatch' );
	return { observation, png };
}
