import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { AcquiredHttpDocument } from './http-acquisition.js';

export interface HttpExportInput {
	kind: 'http';
	desktopVariant: string;
	mobileVariant?: string;
}

/** Load source documents directly, without manufacturing a screenshot manifest. */
export function loadHttpExportInput( outputDir: string, sourceUrl: string, input: HttpExportInput ) {
	if ( ! input.desktopVariant.trim() || input.mobileVariant === input.desktopVariant || input.mobileVariant === '' ) throw new Error( 'Export requires distinct, nonempty variant identities' );
	const root = realpathSync( outputDir );
	for ( const artifact of [ 'screenshots/manifest.json', 'layout-geometry-proof.json', 'fidelity-reference.json' ] ) {
		if ( existsSync( join( root, artifact ) ) ) throw new Error( `HTTP materialization requires separate browser evidence: ${ artifact }` );
	}
	const receiptPath = join( root, 'http-acquisition.json' );
	const bytes = readFileSync( receiptPath );
	const receipt = JSON.parse( bytes.toString( 'utf8' ) ) as { schema: string; sourceUrl: string; documents: AcquiredHttpDocument[] };
	if ( receipt.schema !== 'data-liberation/http-acquisition/v1' || receipt.sourceUrl !== sourceUrl || ! Array.isArray( receipt.documents ) ) throw new Error( 'Invalid HTTP acquisition receipt or source identity' );
	const entries: Record<string, { slug: string; html?: string; mobileHtml?: string }> = {};
	const diagnostics: Array<{ code: string; url: string; reason: string }> = [];
	const seen = new Set<string>();
	const selected = [ input.desktopVariant, ...( input.mobileVariant ? [ input.mobileVariant ] : [] ) ];
	const origin = new URL( sourceUrl ).origin;
	for ( const document of receipt.documents ) {
		if ( ! document || typeof document.url !== 'string' || new URL( document.url ).origin !== origin || typeof document.variant !== 'string' || ! [ 'acquired', 'browser_required', 'failed' ].includes( document.status ) ) throw new Error( 'Invalid HTTP acquisition document' );
		const key = JSON.stringify( [ document.url, document.variant ] );
		if ( seen.has( key ) ) throw new Error( 'Duplicate HTTP acquisition document' );
		seen.add( key );
		const entry = entries[ document.url ] ??= { slug: createHash( 'sha256' ).update( document.url ).digest( 'hex' ) };
		if ( ! selected.includes( document.variant ) ) throw new Error( `Unmapped HTTP variant: ${ document.variant }` );
		if ( document.status !== 'acquired' ) {
			diagnostics.push( { code: `http_${ document.status }`, url: document.url, reason: `${ document.variant }: ${ document.error ?? document.status }` } );
			continue;
		}
		if ( ! document.documentPath || ! document.documentSha256 || document.documentContentType !== 'text/html; charset=utf-8' ) throw new Error( 'Acquired HTTP document lacks content identity' );
		const path = realpathSync( resolve( root, document.documentPath ) );
		const local = relative( root, path );
		if ( local === '..' || local.startsWith( '../' ) || isAbsolute( local ) ) throw new Error( 'HTTP document escapes the acquisition directory' );
		if ( createHash( 'sha256' ).update( readFileSync( path ) ).digest( 'hex' ) !== document.documentSha256 ) throw new Error( 'HTTP document hash mismatch' );
		if ( document.variant === input.desktopVariant ) entry.html = local;
		else entry.mobileHtml = local;
		for ( const region of document.browserRegions ?? [] ) diagnostics.push( { code: 'http_browser_region_unobserved', url: document.url, reason: `${ document.variant }: ${ region.selector }: ${ region.reason }` } );
	}
	for ( const [ url, entry ] of Object.entries( entries ) ) {
		if ( ! seen.has( JSON.stringify( [ url, input.desktopVariant ] ) ) ) diagnostics.push( { code: 'http_variant_missing', url, reason: input.desktopVariant } );
		if ( input.mobileVariant && ! seen.has( JSON.stringify( [ url, input.mobileVariant ] ) ) ) diagnostics.push( { code: 'http_variant_missing', url, reason: input.mobileVariant } );
		if ( ! entry.html ) diagnostics.push( { code: 'route_capture_failed', url, reason: 'Required desktop HTTP document was not acquired' } );
	}
	if ( ! Object.values( entries ).some( entry => entry.html ) ) throw new Error( 'No acquired desktop HTTP documents to materialize' );
	return {
		entries, diagnostics,
		acquisition: { kind: 'http' as const, path: 'http-acquisition.json', sha256: createHash( 'sha256' ).update( bytes ).digest( 'hex' ), verification: { rendering: 'unverified', geometry: 'unverified', interactions: 'unverified' } },
	};
}
