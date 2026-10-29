import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as cheerio from 'cheerio';
import { isInlineUrl } from './self-contain.js';
import type { CapturedResourceManifest } from './screenshot/resource-capture.js';
import { fileHash, pathWithin, portableResourcePath, portableAssetUrl, uniqueAssetPath, TRANSPARENT_IMAGE_DATA_URL } from './portable-assets.js';
import { DEFAULT_MAX_FILE_BYTES } from './export-file-limit.js';
import { dependencyReferences, isExcludedRendition, preparePortableReplacements, replaceDanglingCssUrl, removeDanglingMediaSource, removeDanglingResourceReference, stripExcludedRenditionReferences, type PortableDependency } from './portable-references.js';
import { stripImageSetCandidates } from './srcset.js';

/** The format named by a recognized binary signature, or undefined for text and unknown bytes. */
function recognizedBinaryContentType( path: string ): string | undefined {
	const bytes = readFileSync( path );
	const head = bytes.toString( 'ascii', 0, 4 );
	if ( bytes.length >= 12 && bytes.toString( 'ascii', 4, 8 ) === 'ftyp' ) {
		const brand = bytes.toString( 'ascii', 8, 12 );
		if ( /^(?:avif|avis)$/.test( brand ) ) return 'image/avif';
		if ( /^(?:heic|heix|mif1|msf1)$/.test( brand ) ) return 'image/heic';
		if ( /^(?:mp4 |M4V )$/.test( brand ) ) return 'video/mp4';
	}
	if ( bytes.subarray( 0, 8 ).equals( Buffer.from( [ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ] ) ) ) return 'image/png';
	if ( bytes.subarray( 0, 3 ).equals( Buffer.from( [ 0xff, 0xd8, 0xff ] ) ) ) return 'image/jpeg';
	if ( head === 'RIFF' && bytes.toString( 'ascii', 8, 12 ) === 'WEBP' ) return 'image/webp';
	if ( head === 'RIFF' && bytes.toString( 'ascii', 8, 12 ) === 'WAVE' ) return 'audio/wav';
	if ( head === 'wOF2' ) return 'font/woff2';
	if ( head === 'wOFF' ) return 'font/woff';
	// sfnt fonts: a 4-byte tag, then a small table count. The count keeps text
	// that starts with "true" or "OTTO" out.
	const sfntTables = bytes.length >= 12 ? bytes.readUInt16BE( 4 ) : 0;
	if ( sfntTables >= 1 && sfntTables <= 512 ) {
		if ( head === 'OTTO' ) return 'font/otf';
		if ( head === 'true' || bytes.subarray( 0, 4 ).equals( Buffer.from( [ 0, 1, 0, 0 ] ) ) ) return 'font/ttf';
	}
	if ( head === 'GIF8' ) return 'image/gif';
	if ( head === 'OggS' ) return 'audio/ogg';
	if ( bytes.toString( 'ascii', 0, 3 ) === 'ID3' ) return 'audio/mpeg';
	return undefined;
}

export interface PortableResourceOptions {
	sourceRoot: string;
	/** Capture-owned images must never fall back to an unverified proxy response. */
	imageUrls?: ReadonlySet<string>;
	websiteDir: string;
	entries: ReadonlyArray< { url: string; htmlPath: string } >;
	resourceManifest: CapturedResourceManifest;
	mediaReplacements: ReadonlyMap< string, string >;
	assetPathsByHash: ReadonlyMap< string, string >;
	assetHashesByPath: ReadonlyMap< string, string >;
	portablePathsBySource: ReadonlyMap< string, string >;
	embeddedSources: ReadonlySet< string >;
	/** Captured files larger than this are not written; they resolve like uncaptured dependencies. Default: `DEFAULT_MAX_FILE_BYTES`. */
	maxFileBytes?: number;
	/** Dependency URLs the total export budget dropped; they resolve like uncaptured dependencies. */
	excludedResources?: ReadonlyMap< string, unknown >;
	/** Dependency URLs the total export budget excluded as redundant srcset renditions: their references leave every srcset and image-set list. */
	excludedRenditions?: ReadonlyMap< string, unknown >;
	projectEmbeddedHtml: ( html: string ) => string;
}

export interface PortableResourceResult {
	assets: Array< { sourceUrl: string; path: string } >;
	mediaReplacements: Map< string, string >;
	resourceReplacements: Map< string, string >;
	/** Source byte identities keyed by served URL, for integrity projection after all transformations. */
	sourceHashesByPortablePath: Map< string, string >;
	portablePathsBySource: Map< string, string >;
	unresolvedDependencies: Array< { url: string; sourceUrl: string; error: string } >;
	rejectedReplacementKeys: Set< string >;
	/** Captured dependencies over `maxFileBytes`, one per URL. */
	oversizedResources: Array< { url: string; bytes: number } >;
}

/** Drop source integrity only when the final served resource no longer has source bytes.
 * Run after self-containment and stylesheet projection, before evidence and shared parts.
 * Keeping unchanged metadata verbatim also preserves authored multi-digest semantics.
 */
export function projectPortableResourceIntegrity( websiteDir: string, sourceHashes: ReadonlyMap< string, string > ): void {
	const changedPaths = new Set< string >();
	for ( const [ url, sourceHash ] of sourceHashes ) {
		const path = resolve( websiteDir, `.${ decodeURIComponent( url ) }` );
		if ( pathWithin( websiteDir, path ) && existsSync( path ) && fileHash( path ) !== sourceHash ) changedPaths.add( url );
	}
	if ( ! changedPaths.size ) return;
	const visit = ( directory: string ): void => {
		for ( const entry of readdirSync( directory, { withFileTypes: true } ) ) {
			const path = join( directory, entry.name );
			if ( entry.isDirectory() ) { visit( path ); continue; }
			if ( ! entry.isFile() || ! entry.name.endsWith( '.html' ) ) continue;
			const html = readFileSync( path, 'utf8' );
			const $ = cheerio.load( html, { sourceCodeLocationInfo: true } );
			const ranges: Array< { startOffset: number; endOffset: number } > = [];
			$( 'link[integrity],script[integrity]' ).each( ( _, element ) => {
				const node = $( element );
				const reference = node.attr( element.tagName === 'link' ? 'href' : 'src' );
				if ( ! reference || ! changedPaths.has( reference ) ) return;
				const location = ( element.sourceCodeLocation as { attrs?: Record< string, { startOffset: number; endOffset: number } > } | undefined )?.attrs?.integrity;
				if ( location ) ranges.push( location );
			} );
			let projected = html;
			for ( const range of ranges.sort( ( a, b ) => b.startOffset - a.startOffset ) ) {
				projected = projected.slice( 0, range.startOffset ) + projected.slice( range.endOffset );
			}
			if ( projected !== html ) writeFileSync( path, projected );
		}
	};
	visit( websiteDir );
}

/** Materialize captured dependencies into the private portable generation.
	* Seed indexes belong to media selection; this stage owns its recursive state
	* and returns the resulting identities and diagnostics for later projection.
	*/
export function materializePortableResources( options: PortableResourceOptions ): PortableResourceResult {
	const outputDir = options.sourceRoot;
	const { websiteDir, resourceManifest, embeddedSources } = options;
	const retainedEntries = options.entries;
	const mediaReplacements = new Map( options.mediaReplacements );
	const assetPathsByHash = new Map( options.assetPathsByHash );
	const assetHashesByPath = new Map( options.assetHashesByPath );
	const portablePathsBySource = new Map( options.portablePathsBySource );
	const assets: PortableResourceResult[ 'assets' ] = [];
	const unresolvedDependencies: Array< { url: string; sourceUrl: string; error: string } > = [];
	const rejectedReplacementKeys = new Set< string >();
	const copiedResources = new Set< string >();
	const copyingResources = new Set< string >();
	const resourceReplacements = new Map< string, string >();
	const oversizedResources = new Map< string, number >();
	const sourceHashesByPortablePath = new Map< string, string >();
	const sourceHashesByFile = new Map< string, string >();
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const promoteCapturedMediaReplacement = ( dependencyUrl: string, documentUrl: string ) => {
		const portablePath = resourceReplacements.get( dependencyUrl );
		if ( ! portablePath ) return;
		for ( const [ reference, replacement ] of mediaReplacements ) {
			if ( replacement !== TRANSPARENT_IMAGE_DATA_URL ) continue;
			try {
				if ( new URL( reference.replace( /&amp;/g, '&' ), documentUrl ).href === dependencyUrl )
					mediaReplacements.set( reference, portablePath );
			} catch {
				// Malformed references cannot alias a captured resource URL.
			}
		}
	};
	const copyResource = ( dependency: PortableDependency, sourceUrl: string ): boolean => {
		if ( options.imageUrls?.has( dependency.url ) ) return false;
		const resource = resourceManifest.resources[ dependency.url ];
		if ( ! resource ) {
			unresolvedDependencies.push( {
				url: dependency.url,
				sourceUrl,
				error: 'referenced same-origin dependency was not captured',
			} );
			return false;
		}
		const source = resolve( outputDir, resource.path );
		if ( ! pathWithin( outputDir, source ) || ! existsSync( source ) ) {
			unresolvedDependencies.push( {
				url: dependency.url,
				sourceUrl,
				error: 'captured dependency file is unavailable',
			} );
			return false;
		}
		if ( options.excludedResources?.has( dependency.url ) ) {
			unresolvedDependencies.push( {
				url: dependency.url,
				sourceUrl,
				error: 'captured dependency dropped to keep the website within the total export budget',
			} );
			return false;
		}
		const bytes = statSync( source ).size;
		if ( bytes > maxFileBytes ) {
			oversizedResources.set( dependency.url, bytes );
			unresolvedDependencies.push( {
				url: dependency.url,
				sourceUrl,
				error: `captured dependency is ${ bytes } bytes, over the ${ maxFileBytes }-byte per-file export limit`,
			} );
			return false;
		}
		// Servers can label binary bytes with a text MIME (AVIF as text/plain,
		// query-based WOFF2 as text/html). Recognized bytes are copied exactly and
		// named by their format, so no later HTML/CSS pass reads them as text.
		const transportIsText = /^(?:application\/(?:json|manifest\+json)|text\/)/i.test( resource.contentType );
		const sniffedType = transportIsText ? recognizedBinaryContentType( source ) : undefined;
		const requestedPath =
			( sniffedType && portableResourcePath( resource.path, sniffedType ) ) ??
			portableResourcePath( resource.path, resource.contentType );
		if ( ! requestedPath ) {
			unresolvedDependencies.push( {
				url: dependency.url,
				sourceUrl,
				error: `captured dependency has no portable extension for ${
					resource.contentType || 'unknown content type'
				}`,
			} );
			return false;
		}
		const isText = transportIsText && ! sniffedType;
		const contentHash = isText ? '' : fileHash( source );
		const relativePath = isText
			? requestedPath
			: assetPathsByHash.get( contentHash ) ??
			  uniqueAssetPath( requestedPath, contentHash, assetHashesByPath );
		const destination = resolve( websiteDir, relativePath );
		const portablePath = portableAssetUrl( relativePath );
		const alreadyCopied =
			( ! isText && assetPathsByHash.has( contentHash ) ) ||
			copiedResources.has( resource.path ) ||
			copyingResources.has( resource.path );
		if ( ! pathWithin( websiteDir, destination ) ) {
			unresolvedDependencies.push( {
				url: dependency.url,
				sourceUrl,
				error: 'captured dependency file is unavailable',
			} );
			return false;
		}
		const sourceHash = sourceHashesByFile.get( source ) ?? ( contentHash || fileHash( source ) );
		sourceHashesByFile.set( source, sourceHash );
		const previousHash = sourceHashesByPortablePath.get( portablePath );
		// An ambiguous collision cannot establish unchanged bytes for every reference.
		sourceHashesByPortablePath.set( portablePath, previousHash === undefined || previousHash === sourceHash ? sourceHash : '' );
		resourceReplacements.set( dependency.reference, portablePath );
		resourceReplacements.set( dependency.url, portablePath );
		portablePathsBySource.set( dependency.url, `website/${ relativePath.replace( /\\/g, '/' ) }` );
		if ( alreadyCopied ) return true;
		mkdirSync( dirname( destination ), { recursive: true } );
		copyingResources.add( resource.path );
		if ( isText ) {
			let content = readFileSync( source, 'utf8' );
			if ( /application\/(?:json|manifest\+json)/i.test( resource.contentType ) ) {
				try {
					const manifest = JSON.parse( content );
					for ( const icon of ( Array.isArray( manifest?.icons ) ? manifest.icons : [] ).slice( 0, 64 ) ) {
						if ( typeof icon?.src !== 'string' || isInlineUrl( icon.src ) ) continue;
						const url = new URL( icon.src, dependency.url ).href;
						if ( copyResource( { reference: url, url, kind: 'resource' }, dependency.url ) ) icon.src = resourceReplacements.get( url );
					}
					content = JSON.stringify( manifest );
				} catch { /* Preserve invalid optional metadata for diagnostics. */ }
			}
			if ( /text\/css/i.test( resource.contentType ) ) {
				if ( options.excludedRenditions?.size )
					content = stripImageSetCandidates( content, isExcludedRendition( options.excludedRenditions, dependency.url ) );
				for ( const nested of dependencyReferences( content, dependency.url, true ) ) {
					const mediaReplacement =
						mediaReplacements.get( nested.reference ) ?? mediaReplacements.get( nested.url );
					if (
						mediaReplacement &&
						mediaReplacement !== TRANSPARENT_IMAGE_DATA_URL &&
						! /^(?:https?:)?\/\//i.test( mediaReplacement )
					) {
						mediaReplacements.set( nested.reference, mediaReplacement );
						continue;
					}
					if ( copyResource( nested, dependency.url ) ) {
						if ( mediaReplacement === TRANSPARENT_IMAGE_DATA_URL ) {
							promoteCapturedMediaReplacement( nested.url, dependency.url );
						}
					} else {
						content = replaceDanglingCssUrl( content, nested.reference, rejectedReplacementKeys );
					}
				}
			}
			content = preparePortableReplacements( mediaReplacements, rejectedReplacementKeys )( content );
			if ( /^text\/html(?:;|$)/i.test( resource.contentType ) && embeddedSources.has( dependency.url ) ) {
				const $ = cheerio.load( content );
				const base = new URL( $( 'base[href]' ).first().attr( 'href' ) ?? dependency.url, dependency.url ).href;
				content = options.projectEmbeddedHtml( content );
				for ( const nested of dependencyReferences( content, base ) ) copyResource( nested, dependency.url );
			}
			writeFileSync(
				destination,
				preparePortableReplacements( resourceReplacements, rejectedReplacementKeys )( content )
			);
		} else {
			copyFileSync( source, destination );
			assetPathsByHash.set( contentHash, relativePath );
			assetHashesByPath.set( relativePath, contentHash );
		}
		copyingResources.delete( resource.path );
		copiedResources.add( resource.path );
		assets.push( {
			sourceUrl: dependency.url,
			path: `website/${ relativePath.replace( /\\/g, '/' ) }`,
		} );
		return true;
	};
	for ( const entry of retainedEntries ) {
		const originalHtml = readFileSync( entry.htmlPath, 'utf8' );
		// Redundant renditions leave their lists before dependencies resolve, so
		// no excluded candidate is materialized or left dangling in a srcset.
		let html = options.excludedRenditions?.size
			? stripExcludedRenditionReferences( originalHtml, entry.url, options.excludedRenditions )
			: originalHtml;
		for ( const dependency of dependencyReferences( html, entry.url, false, embeddedSources ) ) {
			const mediaReplacement = mediaReplacements.get( dependency.reference ) ?? mediaReplacements.get( dependency.url );
			if (
				mediaReplacement &&
				mediaReplacement !== TRANSPARENT_IMAGE_DATA_URL &&
				! /^(?:https?:)?\/\//i.test( mediaReplacement )
			) {
				mediaReplacements.set( dependency.reference, mediaReplacement );
				continue;
			}
			if ( copyResource( dependency, entry.url ) ) {
				// A browser-captured response is a faithful bounded fallback when the
				// independent media fetch failed. Let its local replacement win.
				if ( mediaReplacement === TRANSPARENT_IMAGE_DATA_URL ) {
					promoteCapturedMediaReplacement( dependency.url, entry.url );
				}
			} else {
				html =
					dependency.kind === 'media'
						? removeDanglingMediaSource(
								html,
								dependency.reference,
								dependency.url,
								mediaReplacements,
								rejectedReplacementKeys
						  )
						: dependency.kind === 'css'
						? replaceDanglingCssUrl( html, dependency.reference, rejectedReplacementKeys )
						: removeDanglingResourceReference( html, dependency.reference );
			}
		}
		if ( html !== originalHtml ) writeFileSync( entry.htmlPath, html );
	}

	return {
		assets, mediaReplacements, resourceReplacements, portablePathsBySource, unresolvedDependencies, rejectedReplacementKeys, sourceHashesByPortablePath,
		oversizedResources: [ ...oversizedResources ].map( ( [ url, bytes ] ) => ( { url, bytes } ) ),
	};
}
