import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as cheerio from 'cheerio';
import { isInlineUrl } from './self-contain.js';
import type { CapturedResourceManifest } from './screenshot/resource-capture.js';
import { fileHash, pathWithin, portableResourcePath, portableAssetUrl, uniqueAssetPath, TRANSPARENT_IMAGE_DATA_URL } from './portable-assets.js';
import { dependencyReferences, preparePortableReplacements, replaceDanglingCssUrl, removeDanglingMediaSource, removeDanglingResourceReference, type PortableDependency } from './portable-references.js';

export interface PortableResourceOptions {
	sourceRoot: string;
	websiteDir: string;
	entries: ReadonlyArray< { url: string; htmlPath: string } >;
	resourceManifest: CapturedResourceManifest;
	mediaReplacements: ReadonlyMap< string, string >;
	assetPathsByHash: ReadonlyMap< string, string >;
	assetHashesByPath: ReadonlyMap< string, string >;
	portablePathsBySource: ReadonlyMap< string, string >;
	embeddedSources: ReadonlySet< string >;
	projectEmbeddedHtml: ( html: string ) => string;
}

export interface PortableResourceResult {
	assets: Array< { sourceUrl: string; path: string } >;
	mediaReplacements: Map< string, string >;
	resourceReplacements: Map< string, string >;
	portablePathsBySource: Map< string, string >;
	unresolvedDependencies: Array< { url: string; sourceUrl: string; error: string } >;
	rejectedReplacementKeys: Set< string >;
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
		const requestedPath = portableResourcePath( resource.path, resource.contentType );
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
		const isText = /^(?:application\/(?:json|manifest\+json)|text\/)/i.test( resource.contentType );
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
				for ( const nested of dependencyReferences( content, dependency.url, true ) ) {
					const mediaReplacement =
						mediaReplacements.get( nested.reference ) ?? mediaReplacements.get( nested.url );
					if (
						mediaReplacement &&
						mediaReplacement !== TRANSPARENT_IMAGE_DATA_URL &&
						! /^(?:https?:)?\/\//i.test( mediaReplacement )
					)
						continue;
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
		let html = originalHtml;
		for ( const dependency of dependencyReferences( html, entry.url, false, embeddedSources ) ) {
			const mediaReplacement = mediaReplacements.get( dependency.reference );
			if (
				mediaReplacement &&
				mediaReplacement !== TRANSPARENT_IMAGE_DATA_URL &&
				! /^(?:https?:)?\/\//i.test( mediaReplacement )
			)
				continue;
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

	return { assets, mediaReplacements, resourceReplacements, portablePathsBySource, unresolvedDependencies, rejectedReplacementKeys };
}
