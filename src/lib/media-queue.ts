/**
 * Media as its own stage (#1701).
 *
 * Capture records media references it does not download inline (derived
 * template members) in one persisted queue, `media-queue.json`, next to
 * `website/`. Each entry gets a deterministic portable path when it is
 * queued, so the export can reference the file before it exists. The media
 * job runs after the export: it downloads each original once into
 * `deferred-media/` (outside the export generation), links it into
 * `website/`, and records every file that still fails in the capture
 * receipt's loss ledger. A re-run resumes from the queue.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safeFetch } from './media-fetch/safe-fetch.js';
import { portableResourcePath } from './portable-assets.js';
import { resolvedImageOriginal } from './image-assets.js';
import { SourceRequestGovernors, THROTTLE_STATUSES, parseRetryAfter } from './source-request-governor.js';

export const MEDIA_QUEUE_FILE = 'media-queue.json';
export const MEDIA_QUEUE_SCHEMA = 'data-liberation-agent/media-queue/v1';
/** Stable store for downloaded files, outside the replaceable export generation. */
export const DEFERRED_MEDIA_DIR = 'deferred-media';
export const MEDIA_DOWNLOAD_FAILED = 'media_download_failed';

export interface MediaQueueEntry {
	/** The URL the document references. */
	url: string;
	/** The rendition downloaded: the platform's original when it resolves one. */
	originalUrl: string;
	/** Portable path, relative to `website/` and to the output directory's stable store. */
	path: string;
	status: 'pending' | 'done' | 'failed';
	attempts: number;
	lastError?: string;
	httpStatus?: number;
	contentType?: string;
	bytes?: number;
}

export interface MediaQueue {
	schema: typeof MEDIA_QUEUE_SCHEMA;
	entries: MediaQueueEntry[];
}

export interface MediaJobReport {
	queue: string;
	total: number;
	done: number;
	failed: number;
	pending: number;
	downloaded: number;
	failures: Array< { url: string; status?: number; reason: string } >;
}

export interface MediaJobOptions {
	/** Every request goes through these per-origin governors. Default: a fresh set. */
	governors?: SourceRequestGovernors;
	/** Downloads in flight per origin. Default 4. */
	concurrencyPerOrigin?: number;
	/** Requests per file before it is reported failed. Default 4. */
	maxAttempts?: number;
	/** First backoff after a 5xx or transport failure; doubles per attempt. Default 1000 ms. */
	backoffMs?: number;
	/** Longest wait between attempts, `Retry-After` included. Default 60 s. */
	maxWaitMs?: number;
	timeoutMs?: number;
	maxBytes?: number;
	/** Stops the job; the queue is flushed and resumes on the next run. */
	signal?: AbortSignal;
	sleep?: ( ms: number ) => Promise< void >;
	log?: ( message: string ) => void;
}

const queuePath = ( outputDir: string ) => join( outputDir, MEDIA_QUEUE_FILE );

export function readMediaQueue( outputDir: string ): MediaQueue {
	try {
		const queue = JSON.parse( readFileSync( queuePath( outputDir ), 'utf8' ) ) as MediaQueue;
		if ( queue.schema === MEDIA_QUEUE_SCHEMA && Array.isArray( queue.entries ) ) return queue;
	} catch { /* Absent or unreadable: an empty queue. */ }
	return { schema: MEDIA_QUEUE_SCHEMA, entries: [] };
}

function writeAtomic( path: string, content: string | Buffer ): void {
	mkdirSync( dirname( path ), { recursive: true } );
	const temporary = `${ path }.${ process.pid }.tmp`;
	writeFileSync( temporary, content );
	renameSync( temporary, path );
}

function writeMediaQueue( outputDir: string, queue: MediaQueue ): void {
	writeAtomic( queuePath( outputDir ), `${ JSON.stringify( queue, null, 2 ) }\n` );
}

/** A deterministic portable path for an original URL; the extension comes from the URL, or from the response when the URL has none. */
export function deferredMediaPath( originalUrl: string ): string {
	const url = new URL( originalUrl );
	const hash = createHash( 'sha256' ).update( originalUrl ).digest( 'hex' ).slice( 0, 16 );
	let segment = url.pathname.split( '/' ).filter( Boolean ).at( -1 ) ?? '';
	try { segment = decodeURIComponent( segment ); } catch { /* Keep the raw segment. */ }
	const extension = /\.[a-z0-9]{2,5}$/i.exec( segment )?.[ 0 ] ?? '';
	const stem = segment.slice( 0, segment.length - extension.length ).replace( /[^A-Za-z0-9_-]+/g, '-' ).replace( /^-+|-+$/g, '' ).slice( 0, 80 ) || 'media';
	return `${ DEFERRED_MEDIA_DIR }/${ hash }/${ stem }${ extension.toLowerCase() }`;
}

/** Queue media references; returns how many were new. */
export function enqueueMedia( outputDir: string, urls: Iterable< string >, resolveOriginal?: ( url: string ) => string | undefined ): number {
	const queue = readMediaQueue( outputDir );
	const known = new Set( queue.entries.map( entry => entry.url ) );
	let added = 0;
	for ( const url of urls ) {
		if ( known.has( url ) || ! /^https?:/i.test( url ) ) continue;
		known.add( url );
		const originalUrl = resolvedImageOriginal( url, resolveOriginal );
		// A rendition of an original already queued shares its file.
		const sibling = queue.entries.find( entry => entry.originalUrl === originalUrl );
		queue.entries.push( { url, originalUrl, path: sibling?.path ?? deferredMediaPath( originalUrl ), status: sibling?.status === 'done' ? 'done' : 'pending', attempts: 0 } );
		added++;
	}
	if ( added ) writeMediaQueue( outputDir, queue );
	return added;
}

/** Referenced URL → portable URL, for the export. */
export function deferredMediaReferences( outputDir: string ): Map< string, string > {
	return new Map( readMediaQueue( outputDir ).entries.map( entry => [ entry.url, `/${ entry.path }` ] ) );
}

function linkIntoWebsite( outputDir: string, path: string ): void {
	const websiteDir = join( outputDir, 'website' );
	const source = join( outputDir, path );
	const target = join( websiteDir, path );
	if ( ! existsSync( websiteDir ) || ! existsSync( source ) || existsSync( target ) ) return;
	mkdirSync( dirname( target ), { recursive: true } );
	try { linkSync( source, target ); } catch { copyFileSync( source, target ); }
}

/** Link every completed file into the current `website/` generation (after each export). */
export function linkDeferredMedia( outputDir: string ): void {
	for ( const path of new Set( readMediaQueue( outputDir ).entries.filter( entry => entry.status === 'done' ).map( entry => entry.path ) ) ) linkIntoWebsite( outputDir, path );
}

/** Rewrite exported HTML references from provisional extensionless paths to their final names. */
function renameWebsiteReferences( outputDir: string, renames: ReadonlyMap< string, string > ): void {
	if ( ! renames.size ) return;
	const visit = ( directory: string ): void => {
		if ( ! existsSync( directory ) ) return;
		for ( const entry of readdirSync( directory, { withFileTypes: true } ) ) {
			const path = join( directory, entry.name );
			if ( entry.isDirectory() ) { if ( entry.name !== DEFERRED_MEDIA_DIR ) visit( path ); continue; }
			if ( ! entry.name.endsWith( '.html' ) ) continue;
			const html = readFileSync( path, 'utf8' );
			const next = html.replace( new RegExp( `/${ DEFERRED_MEDIA_DIR }/[0-9a-f]{16}/[A-Za-z0-9_-]+(?![A-Za-z0-9._-])`, 'g' ), reference => renames.get( reference ) ?? reference );
			if ( next !== html ) writeFileSync( path, next );
		}
	};
	visit( join( outputDir, 'website' ) );
}

/** Write the queue outcome into the capture receipt: a `media` summary and one loss row per failed file. */
export function recordMediaLedger( outputDir: string, report: MediaJobReport = summarize( readMediaQueue( outputDir ), 0 ) ): void {
	const receiptPath = join( outputDir, 'capture-receipt.json' );
	if ( ! existsSync( receiptPath ) || ! report.total ) return;
	const receipt = JSON.parse( readFileSync( receiptPath, 'utf8' ) ) as { media?: unknown; discoveryDiagnostics?: Array< { code: string } > };
	const { downloaded: _downloaded, ...media } = report;
	receipt.media = media;
	receipt.discoveryDiagnostics = [
		...( receipt.discoveryDiagnostics ?? [] ).filter( row => row.code !== MEDIA_DOWNLOAD_FAILED ),
		...report.failures.map( failure => ( {
			code: MEDIA_DOWNLOAD_FAILED, url: failure.url, reason: failure.reason, unit: 'asset', severity: 'error',
			...( failure.status ? { metrics: { status: failure.status } } : {} ),
		} ) ),
	];
	writeAtomic( receiptPath, `${ JSON.stringify( receipt, null, 2 ) }\n` );
}

function summarize( queue: MediaQueue, downloaded: number ): MediaJobReport {
	const count = ( status: MediaQueueEntry[ 'status' ] ) => queue.entries.filter( entry => entry.status === status ).length;
	return {
		queue: MEDIA_QUEUE_FILE, total: queue.entries.length, done: count( 'done' ), failed: count( 'failed' ), pending: count( 'pending' ), downloaded,
		failures: queue.entries.filter( entry => entry.status === 'failed' ).map( entry => ( {
			url: entry.url, ...( entry.httpStatus ? { status: entry.httpStatus } : {} ), reason: entry.lastError ?? 'download failed',
		} ) ),
	};
}

const MEDIA_CONTENT_TYPE = /^(?:image|video|audio)\/|^application\/octet-stream|^$/i;

/**
 * Download every pending or failed queue entry. Requests go through the
 * source request governors; 429/503 wait for `Retry-After`, other 5xx and
 * transport failures back off exponentially, both bounded by `maxAttempts`.
 */
export async function runMediaQueue( outputDir: string, options: MediaJobOptions = {} ): Promise< MediaJobReport > {
	const queue = readMediaQueue( outputDir );
	const governors = options.governors ?? new SourceRequestGovernors();
	const maxAttempts = options.maxAttempts ?? 4;
	const backoffMs = options.backoffMs ?? 1000;
	const maxWaitMs = options.maxWaitMs ?? 60_000;
	const sleep = options.sleep ?? ( ( ms: number ) => new Promise< void >( resolve => setTimeout( resolve, ms ) ) );
	const signal = options.signal;
	const renames = new Map< string, string >();
	let downloaded = 0;
	let flushedAt = Date.now();
	const flush = ( force = false ) => {
		if ( ! force && Date.now() - flushedAt < 2000 ) return;
		writeMediaQueue( outputDir, queue );
		flushedAt = Date.now();
	};

	// One download per file: renditions sharing an original share its entries.
	const groups = new Map< string, MediaQueueEntry[] >();
	for ( const entry of queue.entries ) groups.set( entry.path, [ ...( groups.get( entry.path ) ?? [] ), entry ] );
	const work: MediaQueueEntry[][] = [];
	for ( const entries of groups.values() ) {
		// Stored files are complete (written atomically), including one stored just before an interruption.
		if ( existsSync( join( outputDir, entries[ 0 ]!.path ) ) ) { for ( const entry of entries ) entry.status = 'done'; continue; }
		work.push( entries );
	}

	const download = async ( entries: MediaQueueEntry[] ): Promise< void > => {
		const first = entries[ 0 ]!;
		const update = ( patch: Partial< MediaQueueEntry > ) => { for ( const entry of entries ) Object.assign( entry, patch ); };
		const candidates = [ ...new Set( [ first.originalUrl, first.url ] ) ];
		let lastError = 'download failed';
		let lastStatus: number | undefined;
		for ( const candidate of candidates ) {
			let retryable = false;
			for ( let attempt = 1; attempt <= maxAttempts; attempt++ ) {
				if ( signal?.aborted ) return;
				update( { attempts: first.attempts + 1 } );
				let wait = Math.min( maxWaitMs, backoffMs * 2 ** ( attempt - 1 ) );
				try {
					const response = await safeFetch( candidate, { governors, category: 'asset-original', timeoutMs: options.timeoutMs ?? 60_000, maxBytes: options.maxBytes ?? 100 * 1024 * 1024, ...( signal ? { signal } : {} ) } );
					lastStatus = response.status;
					const contentType = ( response.headers.get( 'content-type' ) ?? '' ).split( ';', 1 )[ 0 ]!.trim().toLowerCase();
					if ( response.status >= 200 && response.status < 300 && response.body.length > 0 && MEDIA_CONTENT_TYPE.test( contentType ) ) {
						const path = /\.[a-z0-9]{2,5}$/i.test( first.path ) ? first.path : portableResourcePath( first.path, contentType ) ?? first.path;
						if ( path !== first.path ) renames.set( `/${ first.path }`, `/${ path }` );
						writeAtomic( join( outputDir, path ), response.body );
						linkIntoWebsite( outputDir, path );
						update( { path, status: 'done', contentType, bytes: response.body.length, httpStatus: response.status, lastError: undefined } );
						downloaded++;
						return;
					}
					if ( response.status >= 200 && response.status < 300 ) {
						lastError = response.body.length ? `unsupported content type ${ contentType || 'unknown' }` : 'empty response body';
						retryable = false;
					} else {
						lastError = `HTTP ${ response.status }`;
						retryable = response.status === 408 || THROTTLE_STATUSES.has( response.status ) || response.status >= 500;
						const retryAfter = response.headers.get( 'retry-after' );
						if ( retryAfter !== null || THROTTLE_STATUSES.has( response.status ) ) wait = parseRetryAfter( retryAfter, { fallbackMs: wait, maxMs: maxWaitMs } );
					}
				} catch ( error ) {
					if ( signal?.aborted ) return;
					lastError = error instanceof Error ? error.message : String( error );
					lastStatus = undefined;
					retryable = ! /ssrf|exceeds max|blocked/i.test( `${ error instanceof Error ? error.name : '' } ${ lastError }` );
				}
				if ( ! retryable || attempt === maxAttempts ) break;
				await sleep( wait );
			}
			// Exhausted retries are final; a refused original (4xx) falls back to the referenced rendition.
			if ( retryable ) break;
		}
		update( { status: 'failed', lastError, httpStatus: lastStatus } );
		flush();
	};

	const byOrigin = new Map< string, MediaQueueEntry[][] >();
	for ( const entries of work ) {
		const origin = new URL( entries[ 0 ]!.originalUrl ).origin;
		byOrigin.set( origin, [ ...( byOrigin.get( origin ) ?? [] ), entries ] );
	}
	const concurrency = Math.max( 1, options.concurrencyPerOrigin ?? 4 );
	try {
		await Promise.all( [ ...byOrigin.values() ].map( pending => Promise.all( Array.from( { length: Math.min( concurrency, pending.length ) }, async () => {
			for ( let next = pending.shift(); next && ! signal?.aborted; next = pending.shift() ) {
				await download( next );
				flush();
			}
		} ) ) ) );
	} finally {
		flush( true );
		renameWebsiteReferences( outputDir, renames );
	}
	const report = summarize( queue, downloaded );
	recordMediaLedger( outputDir, report );
	options.log?.( `[media] ${ report.done }/${ report.total } stored (${ downloaded } downloaded), ${ report.failed } failed, ${ report.pending } pending` );
	return report;
}
