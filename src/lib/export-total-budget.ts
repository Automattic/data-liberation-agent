import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, posix } from 'node:path';
import type { RouteDiagnostic } from './capture-export-routes.js';

/**
 * Total budget for what export writes into `website/` (`maxTotalBytes`,
 * `maxFiles`).
 *
 * The defaults are coupled to Static Site Importer's intake bounds for staged
 * archives (`static_site_importer_staged_archive_limits()` in
 * static-site-importer `includes/rest.php`): `max_total_uncompressed_bytes`
 * (250 MiB) and `max_entries` (5000). An archive over either is refused whole
 * at import, so producing one only moves the failure downstream. Change both
 * together, and keep any hosted runner's archive bound at or above these.
 *
 * When the website would exceed the budget, export drops units least-valuable
 * first and reports each one, instead of producing an artifact the importer
 * rejects:
 *
 * 1. Captured assets the entrypoint does not need, fonts last; within that,
 *    largest first, videos before other media at equal size.
 * 2. Non-entry routes, last in route order first.
 *
 * The entrypoint document and every file it references are never dropped.
 * Dropped assets resolve like any uncaptured asset (`asset_exceeds_total_budget`);
 * dropped routes are missing routes (`route_exceeds_total_budget`).
 */
export const DEFAULT_MAX_TOTAL_BYTES = 250 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 5000;

/**
 * Room export leaves for files capture writes into `website/` after export:
 * the homepage preview (`site-preview.png`), `source-findings.json` and
 * promoted motion scripts. Never more than a quarter of the budget.
 */
export const POST_EXPORT_RESERVE = { bytes: 8 * 1024 * 1024, files: 16 } as const;

export const ASSET_EXCEEDS_TOTAL_BUDGET = 'asset_exceeds_total_budget';
export const ROUTE_EXCEEDS_TOTAL_BUDGET = 'route_exceeds_total_budget';

export interface ExportTotalBudget {
	maxTotalBytes: number;
	maxFiles: number;
	/** Bytes and files kept free for files written into `website/` after export. */
	reservedBytes: number;
	reservedFiles: number;
}

/** Units the budget dropped; export leaves them out of the next generation. */
export interface ExportBudgetExclusions {
	/** Source URL -> bytes of the file it was exported as. */
	assets: Map< string, number >;
	/** Route URL -> bytes of its page and the files only it referenced. */
	routes: Map< string, number >;
}

export function emptyExportBudgetExclusions(): ExportBudgetExclusions {
	return { assets: new Map(), routes: new Map() };
}

export function validateMaxTotalBytes( maxTotalBytes: unknown ): void {
	if ( maxTotalBytes !== undefined && ( typeof maxTotalBytes !== 'number' || ! Number.isSafeInteger( maxTotalBytes ) || maxTotalBytes < 1 ) )
		throw new RangeError( 'maxTotalBytes must be a positive integer number of bytes' );
}

export function validateMaxFiles( maxFiles: unknown ): void {
	if ( maxFiles !== undefined && ( typeof maxFiles !== 'number' || ! Number.isSafeInteger( maxFiles ) || maxFiles < 1 ) )
		throw new RangeError( 'maxFiles must be a positive integer number of files' );
}

export function resolveExportTotalBudget( limits: { maxTotalBytes?: number; maxFiles?: number; reservePostExport?: boolean } = {} ): ExportTotalBudget {
	validateMaxTotalBytes( limits.maxTotalBytes );
	validateMaxFiles( limits.maxFiles );
	const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
	const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
	return {
		maxTotalBytes,
		maxFiles,
		reservedBytes: limits.reservePostExport ? Math.min( POST_EXPORT_RESERVE.bytes, Math.floor( maxTotalBytes / 4 ) ) : 0,
		reservedFiles: limits.reservePostExport ? Math.min( POST_EXPORT_RESERVE.files, Math.floor( maxFiles / 4 ) ) : 0,
	};
}

export function assetExceedsTotalBudget( url: string, bytes: number, budget: ExportTotalBudget ): RouteDiagnostic {
	return {
		code: ASSET_EXCEEDS_TOTAL_BUDGET, url, unit: 'asset', severity: 'warning',
		reason: `captured asset (${ bytes } bytes) dropped to keep the website within the ${ budget.maxTotalBytes }-byte, ${ budget.maxFiles }-file export budget; not written and its references left unresolved`,
		metrics: { bytes, limit: budget.maxTotalBytes, fileLimit: budget.maxFiles },
	};
}

export function routeExceedsTotalBudget( url: string, bytes: number, budget: ExportTotalBudget ): RouteDiagnostic {
	return {
		code: ROUTE_EXCEEDS_TOTAL_BUDGET, url, unit: 'route', severity: 'error',
		reason: `route (${ bytes } bytes) dropped to keep the website within the ${ budget.maxTotalBytes }-byte, ${ budget.maxFiles }-file export budget`,
		metrics: { bytes, limit: budget.maxTotalBytes, fileLimit: budget.maxFiles },
	};
}

export interface WebsiteFile {
	/** Relative to the website root, `/`-separated. */
	path: string;
	bytes: number;
}

/** Every file under `websiteDir`, sorted by path. */
export function measureWebsite( websiteDir: string ): { files: WebsiteFile[]; totalBytes: number } {
	const files: WebsiteFile[] = [];
	const walk = ( directory: string, prefix: string ): void => {
		let entries;
		try {
			entries = readdirSync( directory, { withFileTypes: true } );
		} catch {
			return;
		}
		for ( const entry of entries ) {
			const path = prefix ? `${ prefix }/${ entry.name }` : entry.name;
			if ( entry.isDirectory() ) walk( join( directory, entry.name ), path );
			else if ( entry.isFile() ) files.push( { path, bytes: statSync( join( directory, entry.name ) ).size } );
		}
	};
	walk( websiteDir, '' );
	files.sort( ( a, b ) => compare( a.path, b.path ) );
	return { files, totalBytes: files.reduce( ( sum, file ) => sum + file.bytes, 0 ) };
}

/** A captured asset export can leave out: its file and every source URL exported as it. */
export interface DroppableAsset {
	path: string;
	sourceUrls: string[];
}

export interface ExportBudgetPlanInput {
	websiteDir: string;
	budget: ExportTotalBudget;
	/** The entry document, relative to the website root. */
	entrypointPath: string;
	/** Retained routes in route order, entrypoint included. */
	routes: ReadonlyArray< { url: string; path: string } >;
	assets: ReadonlyArray< DroppableAsset >;
	exclusions: ExportBudgetExclusions;
}

export interface ExportBudgetPlan {
	totalBytes: number;
	files: number;
	withinBudget: boolean;
	/** Exclusions for the next generation; undefined when nothing more can be dropped. */
	next?: ExportBudgetExclusions;
}

const TEXT_EXTENSIONS = new Set( [ '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.webmanifest', '.svg', '.xml', '.txt', '.map' ] );
const FONT_EXTENSIONS = new Set( [ '.woff', '.woff2', '.ttf', '.otf', '.eot' ] );
const VIDEO_EXTENSIONS = new Set( [ '.mp4', '.webm', '.mov', '.m4v', '.ogv', '.avi', '.mkv' ] );
const AUDIO_EXTENSIONS = new Set( [ '.mp3', '.ogg', '.oga', '.wav', '.m4a', '.aac', '.flac' ] );
const IMAGE_EXTENSIONS = new Set( [ '.avif', '.gif', '.jpg', '.jpeg', '.png', '.webp', '.svg', '.ico', '.bmp', '.tif', '.tiff' ] );

const compare = ( a: string, b: string ): number => ( a < b ? -1 : a > b ? 1 : 0 );

/** Fonts are dropped last; among the rest, videos before audio before images before other files at equal size. */
function assetRank( path: string ): { font: number; kind: number } {
	const extension = extname( path ).toLowerCase();
	if ( FONT_EXTENSIONS.has( extension ) ) return { font: 1, kind: 0 };
	return { font: 0, kind: VIDEO_EXTENSIONS.has( extension ) ? 0 : AUDIO_EXTENSIONS.has( extension ) ? 1 : IMAGE_EXTENSIONS.has( extension ) ? 2 : 3 };
}

/** File names a text file mentions, raw and percent-decoded. */
function referencedNames( text: string ): Set< string > {
	const names = new Set< string >();
	for ( const match of text.matchAll( /[\w%~.+@!$-]+\.[A-Za-z0-9]{1,12}/g ) ) {
		names.add( match[ 0 ] );
		if ( match[ 0 ].includes( '%' ) ) {
			try {
				names.add( decodeURIComponent( match[ 0 ] ) );
			} catch {
				// A malformed escape names only its raw form.
			}
		}
	}
	return names;
}

/**
 * Files reachable from `root` through text files that name them. Matching is
 * by file name, so it can only over-include: a file another file might load is
 * never treated as unreferenced. Other route documents are links, not
 * dependencies, so the walk does not enter them.
 */
function referenceClosure( root: string, files: ReadonlyMap< string, WebsiteFile >, websiteDir: string, byName: ReadonlyMap< string, string[] >, namesOf: Map< string, Set< string > >, routePaths: ReadonlySet< string > ): Set< string > {
	const reached = new Set< string >();
	const queue = files.has( root ) ? [ root ] : [];
	for ( const path of queue ) reached.add( path );
	while ( queue.length ) {
		const path = queue.shift()!;
		if ( ! TEXT_EXTENSIONS.has( extname( path ).toLowerCase() ) ) continue;
		let names = namesOf.get( path );
		if ( ! names ) {
			names = referencedNames( readFileSync( join( websiteDir, path ), 'utf8' ) );
			namesOf.set( path, names );
		}
		for ( const name of names ) {
			for ( const target of byName.get( name ) ?? [] ) {
				if ( reached.has( target ) || routePaths.has( target ) ) continue;
				reached.add( target );
				queue.push( target );
			}
		}
	}
	return reached;
}

/**
 * Measure a built website against the budget and, when it is over, choose the
 * next units to drop. Deterministic: the same website and exclusions give the
 * same plan.
 */
export function planExportBudget( input: ExportBudgetPlanInput ): ExportBudgetPlan {
	const { budget, websiteDir } = input;
	const measured = measureWebsite( websiteDir );
	const byteLimit = Math.max( 0, budget.maxTotalBytes - budget.reservedBytes );
	const fileLimit = Math.max( 0, budget.maxFiles - budget.reservedFiles );
	let excessBytes = measured.totalBytes - byteLimit;
	let excessFiles = measured.files.length - fileLimit;
	const result = { totalBytes: measured.totalBytes, files: measured.files.length };
	if ( excessBytes <= 0 && excessFiles <= 0 ) return { ...result, withinBudget: true };

	const files = new Map( measured.files.map( file => [ file.path, file ] ) );
	const byName = new Map< string, string[] >();
	for ( const { path } of measured.files ) {
		const name = posix.basename( path );
		byName.set( name, [ ...( byName.get( name ) ?? [] ), path ] );
	}
	const namesOf = new Map< string, Set< string > >();
	const routePaths = new Set( input.routes.map( route => route.path ) );
	const entryNeeds = referenceClosure( input.entrypointPath, files, websiteDir, byName, namesOf, routePaths );
	const next: ExportBudgetExclusions = { assets: new Map( input.exclusions.assets ), routes: new Map( input.exclusions.routes ) };
	let progressed = false;
	const satisfied = () => excessBytes <= 0 && excessFiles <= 0;

	const assets = input.assets
		.filter( asset => files.has( asset.path ) && ! entryNeeds.has( asset.path ) && asset.sourceUrls.some( url => ! next.assets.has( url ) ) )
		.map( asset => ( { ...asset, bytes: files.get( asset.path )!.bytes, rank: assetRank( asset.path ) } ) )
		.sort( ( a, b ) => a.rank.font - b.rank.font || b.bytes - a.bytes || a.rank.kind - b.rank.kind || compare( a.path, b.path ) );
	const droppedPaths = new Set< string >();
	for ( const asset of assets ) {
		if ( satisfied() ) break;
		for ( const url of asset.sourceUrls ) next.assets.set( url, asset.bytes );
		droppedPaths.add( asset.path );
		excessBytes -= asset.bytes;
		excessFiles -= 1;
		progressed = true;
	}

	if ( ! satisfied() ) {
		const entrypoint = input.routes.find( route => route.path === input.entrypointPath );
		const remaining = input.routes.filter( route => route !== entrypoint && files.has( route.path ) && ! next.routes.has( route.url ) );
		const closures = new Map( input.routes.filter( route => files.has( route.path ) ).map( route => [ route.url, referenceClosure( route.path, files, websiteDir, byName, namesOf, routePaths ) ] ) );
		const kept = new Set( input.routes.filter( route => files.has( route.path ) && ! next.routes.has( route.url ) ).map( route => route.url ) );
		// Last in route order is lowest priority.
		for ( const route of [ ...remaining ].reverse() ) {
			if ( satisfied() ) break;
			kept.delete( route.url );
			const elsewhere = new Set< string >();
			for ( const url of kept ) for ( const path of closures.get( url ) ?? [] ) elsewhere.add( path );
			let bytes = 0;
			let count = 0;
			for ( const path of closures.get( route.url ) ?? [] ) {
				if ( elsewhere.has( path ) || droppedPaths.has( path ) ) continue;
				droppedPaths.add( path );
				bytes += files.get( path )!.bytes;
				count += 1;
			}
			next.routes.set( route.url, bytes );
			excessBytes -= bytes;
			excessFiles -= count;
			progressed = true;
		}
	}
	return { ...result, withinBudget: false, ...( progressed ? { next } : {} ) };
}

/**
 * After every file is in `website/` (export, homepage preview, source findings,
 * motion), measure it once more and record the final size in the receipt's
 * `exportBudget`, so the receipt states what the artifact actually weighs.
 */
export function recordFinalWebsiteSize( outputDir: string, captureReceiptPath: string ): void {
	const receipt = JSON.parse( readFileSync( captureReceiptPath, 'utf8' ) ) as { exportBudget?: { maxTotalBytes: number; maxFiles: number } & Record< string, unknown > };
	if ( ! receipt.exportBudget ) return;
	const { files, totalBytes } = measureWebsite( join( outputDir, 'website' ) );
	const withinBudget = totalBytes <= receipt.exportBudget.maxTotalBytes && files.length <= receipt.exportBudget.maxFiles;
	receipt.exportBudget.final = { totalBytes, files: files.length, withinBudget };
	writeFileSync( captureReceiptPath, `${ JSON.stringify( receipt, null, 2 ) }\n` );
	if ( ! withinBudget ) process.stderr.write( `[budget] website is ${ totalBytes } bytes in ${ files.length } files, over the ${ receipt.exportBudget.maxTotalBytes }-byte, ${ receipt.exportBudget.maxFiles }-file export budget\n` );
}

/** Export limits a capture caller passed, plus room for what capture writes into `website/` after export. */
export function captureExportLimits( options: { maxFileBytes?: number; maxTotalBytes?: number; maxFiles?: number } ): { maxFileBytes?: number; maxTotalBytes?: number; maxFiles?: number; reservePostExport: true } {
	return {
		...( options.maxFileBytes !== undefined ? { maxFileBytes: options.maxFileBytes } : {} ),
		...( options.maxTotalBytes !== undefined ? { maxTotalBytes: options.maxTotalBytes } : {} ),
		...( options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {} ),
		reservePostExport: true,
	};
}
