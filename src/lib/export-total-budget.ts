import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, posix } from 'node:path';
import type { RouteDiagnostic } from './capture-export-routes.js';
import { imageSetSites, isSrcsetShaped, srcsetCandidates } from './srcset.js';

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
 * 1. Redundant srcset renditions: an asset that is one candidate in a srcset
 *    (img/source `srcset`, `data-srcset`, a srcset-shaped `src`, or an
 *    `image-set()` list) where another candidate of that list is retained.
 *    Each list keeps the rendition its element's `src` uses (when it is a
 *    candidate) and otherwise prefers the widest candidate at or under 2048px;
 *    a dropped rendition is removed from every srcset that retains another
 *    candidate, so pages never show it as a missing image.
 * 2. Captured assets the entrypoint does not need, fonts last; within that,
 *    largest first, videos before other media at equal size.
 * 3. Non-entry routes, last in route order first.
 *
 * The entrypoint document and every file it references are never dropped.
 * Dropped assets resolve like any uncaptured asset (`asset_exceeds_total_budget`);
 * dropped renditions are reported (`redundant_rendition_dropped`) and their
 * references rewritten away; dropped routes are missing routes
 * (`route_exceeds_total_budget`).
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
export const REDUNDANT_RENDITION_DROPPED = 'redundant_rendition_dropped';

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
	/** Source URL -> bytes of a redundant srcset rendition; export removes its references from every srcset that retains another candidate. */
	renditions: Map< string, number >;
}

export function emptyExportBudgetExclusions(): ExportBudgetExclusions {
	return { assets: new Map(), routes: new Map(), renditions: new Map() };
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

export function redundantRenditionDropped( url: string, bytes: number, budget: ExportTotalBudget ): RouteDiagnostic {
	return {
		code: REDUNDANT_RENDITION_DROPPED, url, unit: 'asset', severity: 'warning',
		reason: `redundant srcset rendition (${ bytes } bytes) dropped to keep the website within the ${ budget.maxTotalBytes }-byte, ${ budget.maxFiles }-file export budget; removed from its srcset and every other retained candidate still resolves`,
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

/** Width candidates at or under this size stay in the site the budget keeps; wider renditions are droppable. */
const RETAINED_RENDITION_WIDTH_LIMIT = 2048;
const RENDITION_SCAN_EXTENSIONS = new Set( [ '.html', '.htm', '.css' ] );
const SRCSET_ATTRIBUTE_GLOBAL = /\s(?:data-)?srcset\s*=\s*(?:"([\s\S]*?)"|'([\s\S]*?)')/gi;
const IMG_SOURCE_ATTRIBUTE = /\ssrc\s*=\s*(?:"([\s\S]*?)"|'([\s\S]*?)')/i;

/** One rendered candidate list (srcset attribute, shaped src, or image-set). */
interface RenditionCandidateList {
	/** Raw candidate references, in authored order, with the written path when the reference names a file now in `website/`. */
	candidates: Array< { path?: string; size: number; density: boolean } >;
	/** Written paths this list must retain because its element names them outside the list (e.g. an img src). */
	forcedPaths: string[];
}

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
 * Redundant srcset renditions the budget drops before any unique asset.
 *
 * A rendition is redundant when it is a candidate of some srcset or image-set
 * list that retains another written candidate even without it, is an asset
 * export can leave out, and is never named outside a candidate list: its
 * references are removed from every list on the next build while the site
 * keeps rendering from the retained rendition. Each list keeps the written
 * candidate its element's `src` names (when that is one) and otherwise
 * prefers the widest width candidate at or under 2048px, falling back to the
 * highest density and then the smallest oversized width.
 */
function redundantRenditionDrops( input: ExportBudgetPlanInput, filesByPath: ReadonlyMap< string, WebsiteFile >, websiteDir: string ): Array< { path: string; bytes: number; sourceUrls: string[] } > {
	const droppableByPath = new Map( input.assets.map( asset => [ asset.path, asset ] ) );
	const scanned: Array< { lists: RenditionCandidateList[]; remainder: string } > = [];
	for ( const [ path ] of filesByPath ) {
		if ( ! RENDITION_SCAN_EXTENSIONS.has( extname( path ).toLowerCase() ) ) continue;
		let content: string;
		try {
			content = readFileSync( join( websiteDir, path ), 'utf8' );
		} catch {
			continue;
		}
		const lists: RenditionCandidateList[] = [];
		const spans: Array< [ number, number ] > = [];
		const candidatesOf = ( url: string ) => ( { path: resolveRenditionPath( url, path, filesByPath ), size: 1, density: false } );
		if ( extname( path ).toLowerCase() === '.css' ) {
			for ( const site of imageSetSites( content ) ) {
				spans.push( [ site.start, site.end ] );
				if ( site.urls.length >= 2 ) lists.push( { candidates: site.urls.map( candidatesOf ), forcedPaths: [] } );
			}
		} else {
			// A lazy loader can name the whole width list in `src` itself; an
			// ordinary src is a reference whose rendition stays written.
			for ( const match of content.matchAll( /<(?:img|source)\b[^>]*>/gi ) ) {
				const tag = match[ 0 ];
				const tagOffset = match.index!;
				const src = /^<img\b/i.test( tag ) ? attributeSpan( IMG_SOURCE_ATTRIBUTE, tag ) : undefined;
				let forcedPaths: string[] = [];
				if ( src && src.value ) {
					if ( isSrcsetShaped( src.value ) ) {
						spans.push( [ tagOffset + src.start, tagOffset + src.start + src.value.length ] );
						lists.push( { candidates: srcsetCandidates( src.value ).map( candidate => ( { ...candidatesOf( candidate.url ), size: candidate.size, density: candidate.density } ) ), forcedPaths: [] } );
					} else {
						const sourcePath = resolveRenditionPath( src.value, path, filesByPath );
						if ( sourcePath ) forcedPaths = [ sourcePath ];
					}
				}
				for ( const attribute of tag.matchAll( SRCSET_ATTRIBUTE_GLOBAL ) ) {
					const value = attribute[ 1 ] ?? attribute[ 2 ] ?? '';
					if ( ! value ) continue;
					spans.push( [ tagOffset + attribute.index! + attribute[ 0 ].length - 1 - value.length, tagOffset + attribute.index! + attribute[ 0 ].length - 1 ] );
					lists.push( { candidates: srcsetCandidates( value ).map( candidate => ( { ...candidatesOf( candidate.url ), size: candidate.size, density: candidate.density } ) ), forcedPaths } );
				}
			}
			for ( const site of imageSetSites( content ) ) {
				spans.push( [ site.start, site.end ] );
				if ( site.urls.length >= 2 ) lists.push( { candidates: site.urls.map( candidatesOf ), forcedPaths: [] } );
			}
		}
		if ( lists.length === 0 ) continue;
		scanned.push( { lists, remainder: withoutSpans( content, spans ) } );
	}
	if ( scanned.length === 0 ) return [];

	const redundantHere = new Set< string >();
	const retainedSomewhere = new Set< string >();
	for ( const { lists } of scanned ) {
		for ( const list of lists ) {
			const written = list.candidates.filter( ( candidate ): candidate is typeof candidate & Required< Pick< typeof candidate, 'path' > > => candidate.path !== undefined );
			const retainedPaths = new Set( list.forcedPaths.filter( path => written.some( candidate => candidate.path === path ) ) );
			const keep = ( candidates: Array< ( typeof written )[ number ] > ): string | undefined =>
				[ ...candidates ].sort( ( a, b ) => b.size - a.size || compare( a.path, b.path ) )[ 0 ]?.path;
			const widthed = written.filter( candidate => ! candidate.density && candidate.size <= RETAINED_RENDITION_WIDTH_LIMIT );
			const pick = widthed.length
				? keep( widthed )
				: keep( written.filter( candidate => candidate.density ) ) ?? keep( written.filter( candidate => candidate.size > RETAINED_RENDITION_WIDTH_LIMIT ) );
			if ( pick ) retainedPaths.add( pick );
			for ( const { path } of written ) {
				if ( retainedPaths.has( path ) ) retainedSomewhere.add( path );
				else if ( retainedPaths.size ) redundantHere.add( path );
			}
		}
	}
	return [ ...redundantHere ]
		.filter( path =>
			! retainedSomewhere.has( path ) &&
			droppableByPath.has( path ) &&
			filesByPath.has( path ) &&
			! scanned.some( file => file.remainder.includes( posix.basename( path ) ) )
		)
		.map( path => ( { path, bytes: filesByPath.get( path )!.bytes, sourceUrls: [ ...droppableByPath.get( path )!.sourceUrls ].sort( compare ) } ) )
		.sort( ( a, b ) => b.bytes - a.bytes || compare( a.path, b.path ) );
}

/** An HTML attribute value matched in a tag: the raw value and its start offset in the tag text. */
function attributeSpan( pattern: RegExp, tag: string ): { value: string; start: number } | undefined {
	const match = pattern.exec( tag );
	if ( ! match ) return undefined;
	const value = match[ 1 ] ?? match[ 2 ] ?? '';
	return { value, start: match.index + match[ 0 ].length - 1 - value.length };
}

/** File content with every byte range in `spans` cut out. */
function withoutSpans( content: string, spans: ReadonlyArray< [ number, number ] > ): string {
	const sorted = [ ...spans ].sort( ( a, b ) => a[ 0 ] - b[ 0 ] );
	let result = '';
	let offset = 0;
	for ( const [ start, end ] of sorted ) {
		if ( start < offset ) continue;
		result += content.slice( offset, start );
		offset = end;
	}
	return result + content.slice( offset );
}

/** The written file a rendered candidate reference names, relative to its document or stylesheet. */
function resolveRenditionPath( rawUrl: string, file: string, filesByPath: ReadonlyMap< string, WebsiteFile > ): string | undefined {
	const reference = rawUrl.replace( /&amp;/g, '&' ).trim();
	if ( ! reference || reference.startsWith( '#' ) || /^[a-z][a-z0-9+.-]*:/i.test( reference ) ) return undefined;
	const pathname = ( reference.split( '#' )[ 0 ] ?? '' ).split( '?' )[ 0 ] ?? '';
	if ( ! pathname || pathname === '/' ) return undefined;
	// Root-relative references resolve from the website root, others from the referring file.
	const base = pathname.startsWith( '/' ) ? '' : posix.dirname( file );
	for ( const candidate of [ pathname, decodeURIComponentSafe( pathname ) ] ) {
		const resolved = posix.normalize( posix.join( base, candidate.replace( /^\/+/, '' ) ) );
		if ( filesByPath.has( resolved ) ) return resolved;
	}
	return undefined;
}

function decodeURIComponentSafe( value: string ): string {
	try {
		return decodeURIComponent( value );
	} catch {
		return value;
	}
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
	const next: ExportBudgetExclusions = { assets: new Map( input.exclusions.assets ), routes: new Map( input.exclusions.routes ), renditions: new Map( input.exclusions.renditions ) };
	let progressed = false;
	const satisfied = () => excessBytes <= 0 && excessFiles <= 0;

	// Redundant renditions go before any unique asset: removing one from its
	// srcset leaves the element rendering from a retained rendition, never a
	// missing image.
	const renditionDroppedPaths = new Set< string >();
	if ( ! satisfied() ) {
		for ( const { path, bytes, sourceUrls } of redundantRenditionDrops( input, files, websiteDir ) ) {
			if ( satisfied() ) break;
			for ( const url of sourceUrls ) next.renditions.set( url, bytes );
			renditionDroppedPaths.add( path );
			excessBytes -= bytes;
			excessFiles -= 1;
			progressed = true;
		}
	}

	const assets = input.assets
		.filter( asset => files.has( asset.path ) && ! entryNeeds.has( asset.path ) && asset.sourceUrls.some( url => ! next.assets.has( url ) && ! next.renditions.has( url ) ) )
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
				if ( elsewhere.has( path ) || droppedPaths.has( path ) || renditionDroppedPaths.has( path ) ) continue;
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
