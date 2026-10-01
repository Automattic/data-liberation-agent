import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Page } from 'playwright';
import { PNG } from 'pngjs';
import { observePage, routeSourceMap } from './check.js';
import { readSourceCleanup, type CleanupReport } from '../source-cleanup.js';
import type { LayoutObservation } from './score.js';
import { isRouteDrift } from '../screenshot/document-integrity.js';

export const REFERENCE_WIDTHS = [ 390, 768, 1440 ];
export type FidelityStage = 'capture' | 'materialization' | 'drift';
export interface ReferenceArtifact { path: string; sha256: string }
export interface ReferenceEntry {
	deviceScaleFactor?: number;
	/** Assigned from the exported receipt; absent when no portable route was retained. */
	route?: string;
	sourceUrl: string;
	viewport: number;
	viewportHeight: number;
	device: 'desktop' | 'mobile';
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
	scope: { sourceUrls: string[]; widths: number[]; states: string[]; unknowns: string[] };
	entries: ReferenceEntry[];
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
export function createReferenceCollector( directory: string, sourceUrl: string, sourceUrls: string[] ) {
	const captureId = randomUUID();
	const entries: ReferenceEntry[] = [];
	const store = ( name: string, bytes: string | Buffer ): ReferenceArtifact => {
		const path = `reference/${ captureId }/${ name }`;
		mkdirSync( dirname( join( directory, path ) ), { recursive: true } );
		writeFileSync( join( directory, path ), bytes );
		return { path, sha256: digest( bytes ) };
	};
	return {
		async observe( page: Page, url: string, device: 'desktop' | 'mobile', errors: readonly string[] = [] ): Promise<void> {
			const original = page.viewportSize();
			try {
				for ( const viewport of device === 'mobile' ? [ 390 ] : [ 768, 1440 ] ) {
					const entry: ReferenceEntry = { sourceUrl: url, viewport, viewportHeight: 900, device, state: 'baseline', readiness: { ready: false, reasons: [] } };
					entries.push( entry );
					try {
						await page.setViewportSize( { width: viewport, height: 900 } );
						entry.userAgent = await page.evaluate( () => navigator.userAgent );
						entry.deviceScaleFactor = await page.evaluate( () => window.devicePixelRatio );
						const observation = await observePage( page, url, viewport, 800, null, undefined, undefined, true );
						const cleanup = await readSourceCleanup( page );
						entry.readiness.cleanup = cleanup;
						if ( cleanup.failures.length || cleanup.residual ) entry.readiness.reasons.push( 'source cleanup incomplete' );
						// Freeze the same route identity capture accepts: query/hash
						// renditions do not become different origin/path documents.
						if ( isRouteDrift( page.url(), url ) ) entry.readiness.reasons.push( 'source route drift' );
						const mediaReady = await page.evaluate( () => [ ...document.images ].every( image => {
							const rect = image.getBoundingClientRect();
							return rect.width <= 50 || rect.height <= 50 || ( image.complete && image.naturalWidth > 0 );
						} ) );
						if ( ! mediaReady ) entry.readiness.reasons.push( 'source images pending or failed' );
						entry.readiness.mediaReady = mediaReady;
						entry.readiness.fontsReady = ! observation.typography?.some( text => ! text.loaded );
						if ( ! entry.readiness.fontsReady ) entry.readiness.reasons.push( 'source fonts pending or failed' );
						const stem = `${ digest( url ).slice( 0, 24 ) }-${ viewport }`;
						entry.observation = store( `${ stem }.json`, JSON.stringify( observation ) );
						entry.document = store( `${ stem }.html`, await page.content() );
						entry.screenshot = store( `${ stem }.png`, await page.screenshot( { scale: 'css' } ) );
						entry.readiness.reasons.push( ...errors );
						entry.readiness.ready = entry.readiness.reasons.length === 0;
					} catch ( error ) {
						entry.readiness.reasons.push( String( error ) );
					}
				}
			} finally {
				if ( original ) await page.setViewportSize( original );
			}
		},
		finalize( receiptPath: string ): string {
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
				scope: { sourceUrls: [ ...new Set( [ ...sourceUrls, ...capturedUrls ] ) ], widths: [ ...REFERENCE_WIDTHS ], states: [ 'baseline' ],
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
