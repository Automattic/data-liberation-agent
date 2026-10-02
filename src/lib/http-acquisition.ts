import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpAcquisitionProfile, RuntimeRegionRequirement } from '../platform/acquisition.js';
import { mapPool } from './concurrency.js';
import { safeFetch, assertPublicHttpUrl, SsrfBlockedError, BodyTooLargeError } from './media-fetch/safe-fetch.js';
import { isRouteDrift } from './screenshot/document-integrity.js';
import { validateOutputDir } from './screenshot/output-layout.js';
import * as cheerio from 'cheerio';
import { normalizeCssUrlEscapes } from './css-url-escapes.js';

export interface AcquiredHttpDocument {
	url: string;
	variant: string;
	status: 'acquired' | 'browser_required' | 'failed';
	finalUrl?: string;
	httpStatus?: number;
	rawContentType?: string;
	rawPath?: string;
	rawSha256?: string;
	documentPath?: string;
	documentSha256?: string;
	documentContentType?: string;
	metadata?: Record<string, string>;
	browserRegions?: ReadonlyArray<RuntimeRegionRequirement>;
	error?: string;
	attempts: number;
	durationMs: number;
}

export interface HttpAcquisitionOptions {
	url: string;
	urls: readonly string[];
	outputDir: string;
	profile: HttpAcquisitionProfile;
	concurrency?: number;
	timeoutMs?: number;
	maxDocumentBytes?: number;
	/** Stage deduplicated source dependencies; this does not localize a website. */
	collectAssets?: boolean;
	onProgress?: ( completed: number, total: number, document: AcquiredHttpDocument ) => void;
}

const digest = ( value: string | Buffer ) => createHash( 'sha256' ).update( value ).digest( 'hex' );

/** Acquire actual route responses. This receipt never claims browser or portable-site parity. */
export async function acquireHttpDocuments( options: HttpAcquisitionOptions, dependencies = { fetch: safeFetch } ) {
	validateOutputDir( options.outputDir );
	const origin = new URL( options.url ).origin;
	assertPublicHttpUrl( options.url );
	const variants = options.profile.variants;
	if ( variants.length === 0 || variants.some( variant => ! variant.id.trim() ) || new Set( variants.map( variant => variant.id ) ).size !== variants.length ) throw new Error( 'Acquisition requires unique, nonempty variants' );
	const urls = [ ...new Set( options.urls ) ];
	for ( const url of urls ) {
		assertPublicHttpUrl( url );
		if ( new URL( url ).origin !== origin ) throw new Error( `Acquisition route is off-origin: ${ url }` );
	}
	mkdirSync( join( options.outputDir, 'source-documents' ), { recursive: true } );
	const tasks = urls.flatMap( url => variants.map( variant => ( { url, variant } ) ) );
	let completed = 0;
	const started = performance.now();
	const documents = await mapPool( tasks, Math.max( 1, Math.min( 12, options.concurrency ?? 6 ) ), async ( { url, variant } ) => {
		const routeStarted = performance.now();
		const document: AcquiredHttpDocument = { url, variant: variant.id, status: 'failed', attempts: 0, durationMs: 0 };
		try {
			let response;
			for ( let attempt = 0; attempt < 2; attempt++ ) {
				document.attempts++;
				try {
					response = await dependencies.fetch( url, {
						headersForOrigin: requestOrigin => requestOrigin === origin ? variant.headers : undefined,
						timeoutMs: options.timeoutMs ?? 30_000, maxBytes: options.maxDocumentBytes ?? 8 * 1024 * 1024,
					} );
					if ( attempt === 0 && [ 429, 503 ].includes( response.status ) ) {
						const retryAfter = response.headers.get( 'retry-after' );
						const seconds = retryAfter === null ? Number.NaN : Number( retryAfter );
						const requestedWait = Number.isFinite( seconds ) ? seconds * 1000 : retryAfter ? Date.parse( retryAfter ) - Date.now() : 500;
						const wait = Number.isFinite( requestedWait ) ? Math.max( 0, requestedWait ) : 500;
						if ( wait <= ( options.timeoutMs ?? 30_000 ) ) { await new Promise( resolve => setTimeout( resolve, wait ) ); continue; }
					}
					break;
				} catch ( error ) {
					if ( attempt === 1 || error instanceof SsrfBlockedError || error instanceof BodyTooLargeError ) throw error;
					await new Promise( resolve => setTimeout( resolve, 500 ) );
				}
			}
			if ( ! response ) throw new Error( 'Acquisition returned no response' );
			document.finalUrl = response.finalUrl;
			document.httpStatus = response.status;
			if ( response.status < 200 || response.status >= 300 ) throw new Error( `HTTP ${ response.status }` );
			const contentType = response.headers.get( 'content-type' ) ?? '';
			document.rawContentType = contentType;
			if ( ! /^text\/html(?:;|$)/i.test( contentType ) ) throw new Error( `Not an HTML document: ${ contentType }` );
			const key = digest( JSON.stringify( [ url, variant.id ] ) );
			document.rawPath = `source-documents/${ key }.response.html`;
			document.rawSha256 = digest( response.body );
			writeFileSync( join( options.outputDir, document.rawPath ), response.body );
			if ( isRouteDrift( response.finalUrl, url ) ) {
				document.status = 'browser_required';
				document.error = 'Source redirected to a different route';
			} else {
				const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec( contentType )?.[ 1 ] ?? 'utf-8';
				const html = new TextDecoder( charset, { fatal: true } ).decode( response.body );
				const prepared = await options.profile.prepare( html, { url, finalUrl: response.finalUrl, variant: variant.id } );
				if ( prepared && prepared.html.trim() ) {
					const $ = cheerio.load( prepared.html );
					let normalized = false;
					$( 'style' ).each( ( _index, element ) => { const node = $( element ); const old = node.html() ?? ''; const css = normalizeCssUrlEscapes( old ); if ( css !== old ) { node.html( css ); normalized = true; } } );
					$( '[style]' ).each( ( _index, element ) => { const node = $( element ); const old = node.attr( 'style' ) ?? ''; const css = normalizeCssUrlEscapes( old ); if ( css !== old ) { node.attr( 'style', css ); normalized = true; } } );
					const html = normalized ? $.html() : prepared.html;
					document.documentPath = `source-documents/${ key }.html`;
					document.documentSha256 = digest( html );
					document.documentContentType = 'text/html; charset=utf-8';
					document.metadata = prepared.metadata;
					document.browserRegions = prepared.browserRegions;
					writeFileSync( join( options.outputDir, document.documentPath ), html );
					document.status = 'acquired';
				} else {
					document.status = 'browser_required';
					document.error = 'Document is outside the registered acquisition profile';
				}
			}
		} catch ( error ) { document.error = String( error ); }
		document.durationMs = performance.now() - routeStarted;
		options.onProgress?.( ++completed, tasks.length, document );
		return document;
	} );
	let resources: { manifestPath: string; captured: number; failures: number } | undefined;
	if ( options.collectAssets ) {
		const { CapturedResourceStore } = await import( './screenshot/resource-capture.js' );
		const store = new CapturedResourceStore( options.outputDir, options.url, async ( url, maxBytes, timeoutMs ) => {
			const response = await dependencies.fetch( url, { maxBytes, timeoutMs, headersForOrigin: requestOrigin => requestOrigin === origin ? variants[ 0 ]!.headers : undefined } );
			const contentType = response.headers.get( 'content-type' ) ?? '';
			if ( ! /^text\/css(?:;|$)/i.test( contentType ) ) return response;
			const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec( contentType )?.[ 1 ] ?? 'utf-8';
			const css = new TextDecoder( charset, { fatal: true } ).decode( response.body );
			const normalized = normalizeCssUrlEscapes( css );
			if ( css === normalized ) return response;
			const headers = new Headers( response.headers ); headers.set( 'content-type', 'text/css; charset=utf-8' ); headers.delete( 'content-length' );
			return { ...response, headers, body: Buffer.from( normalized ) };
		} );
		await mapPool( documents.filter( document => document.status === 'acquired' ), 2, async document => {
			await store.captureDomDependencies( readFileSync( join( options.outputDir, document.documentPath! ), 'utf8' ), document.finalUrl! );
		} );
		await store.flush();
		const manifestPath = join( options.outputDir, 'resources', 'manifest.json' );
		const manifest = JSON.parse( readFileSync( manifestPath, 'utf8' ) ) as { resources: Record<string, unknown>; failures: unknown[] };
		resources = { manifestPath: 'resources/manifest.json', captured: Object.keys( manifest.resources ).length, failures: manifest.failures.length };
	}
	const receipt = {
		schema: 'data-liberation/http-acquisition/v1', sourceUrl: options.url, profile: options.profile.id,
		coverage: { routes: urls.length, requiredDocuments: tasks.length, acquired: documents.filter( document => document.status === 'acquired' ).length,
			browserRequired: documents.filter( document => document.status === 'browser_required' ).length, failed: documents.filter( document => document.status === 'failed' ).length },
		durationMs: performance.now() - started,
		verification: { rendering: 'unverified', assets: 'not_localized', interactions: 'unverified' }, resources, documents,
	};
	const receiptPath = join( options.outputDir, 'http-acquisition.json' );
	writeFileSync( receiptPath, JSON.stringify( receipt, null, 2 ) + '\n' );
	return { receiptPath, ...receipt };
}
