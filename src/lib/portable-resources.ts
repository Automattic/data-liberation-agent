import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as cheerio from 'cheerio';
import { isInlineUrl } from './self-contain.js';
import type { CapturedResourceManifest } from './screenshot/resource-capture.js';
import { fileHash, pathWithin, portableResourcePath, portableAssetUrl, uniqueAssetPath, TRANSPARENT_IMAGE_DATA_URL } from './portable-assets.js';
import { DEFAULT_MAX_FILE_BYTES } from './export-file-limit.js';
import { dependencyReferences, preparePortableReplacements, replaceDanglingCssUrl, removeDanglingMediaSource, removeDanglingResourceReference, type PortableDependency } from './portable-references.js';
import { renditionDimension, renditionFamily } from './portable-media-plan.js';

/**
 * Which captured dependencies the shared portable export budget admits first.
 * `required` covers documents' stylesheets, fonts, scripts and manifest data
 * plus one rendition per referenced picture; `additional` covers remaining
 * srcset renditions and other lower-priority media.
 */
export type PortableResourcePriority = 'required' | 'additional';

export interface PortableResourcePlan {
	/** Priority per planned dependency URL. */
	priorities: Map< string, PortableResourcePriority >;
	/** Pins each planned dependency's planner scan order, for deterministic spend order. */
	order: Map< string, number >;
	/** Bytes the required tier costs, deduped by capture path. */
	requiredBytes: number;
	/** Rendition family -> the primary dependency URL kept for the picture. */
	primaries: Map< string, PortableDependency >;
}

/** Plan dependencies of the retained pages into budget priority tiers before materialization. */
export function planPortableResources( options: {
	sourceRoot: string;
	entries: ReadonlyArray< { url: string; htmlPath: string } >;
	resourceManifest: CapturedResourceManifest;
	embeddedSources: ReadonlySet< string >;
	/** Media families the media stage already localizes; their resource-side deps get no extra tier. */
	coveredMediaFamilies: ReadonlySet< string >;
} ): PortableResourcePlan {
	const { sourceRoot, resourceManifest, embeddedSources } = options;
	const priorities = new Map< string, PortableResourcePriority >();
	const order = new Map< string, number >();
	const primaries = new Map< string, PortableDependency >();
	const familyRenditions = new Map< string, Array< { dependency: PortableDependency; dimension: number; order: number } > >();
	const seen = new Set< string >();
	const countedPaths = new Set< string >();
	let requiredBytes = 0;
	const mediaFamiliesCovered = options.coveredMediaFamilies;
	const scan = ( dependency: PortableDependency, index: number ): void => {
		if ( seen.has( dependency.url ) ) return;
		seen.add( dependency.url );
		// Required tier spends documents' stylesheets, fonts and scripts before
		// any picture rendition: media deps rank after non-media of the tier.
		order.set( dependency.url, ( dependency.kind === 'media' ? 1e9 : 0 ) + index );
		if ( dependency.kind === 'media' ) {
			// Srcset-style media deps group by rendition family; the family's
			// widest rendition becomes the required primary and the rest are
			// additional tier. Families the media stage already localizes are
			// skipped — their references resolve through the media replacements.
			const family = renditionFamily( dependency.url );
			if ( mediaFamiliesCovered.has( family ) ) return;
			familyRenditions.set( family, [
				...( familyRenditions.get( family ) ?? [] ),
				{ dependency, dimension: renditionDimension( dependency.url ), order: index },
			] );
			return;
		}
		// Non-media dependencies are required priority: stylesheets, fonts,
		// scripts, manifest data, and everything referenced from CSS. Nested
		// stylesheet assets count too so the media tier cannot starve them.
		priorities.set( dependency.url, 'required' );
		const resource = resourceManifest.resources[ dependency.url ];
		const source = resource && resolve( sourceRoot, resource.path );
		if ( ! resource || ! source || ! pathWithin( sourceRoot, source ) || ! existsSync( source ) ) return;
		if ( countedPaths.has( resource.path ) ) return;
		countedPaths.add( resource.path );
		requiredBytes += statSync( source ).size;
		if ( /text\/css/i.test( resource.contentType ) ) {
			try {
				for ( const nested of dependencyReferences( readFileSync( source, 'utf8' ), dependency.url, true ) )
					scan( nested, index );
			} catch {
				// A stylesheet the planner cannot read gets its normal copy
				// treatment by the materialization stage.
			}
		}
	};
	let index = 0;
	for ( const entry of options.entries ) {
		let html: string | undefined;
		try {
			html = readFileSync( entry.htmlPath, 'utf8' );
		} catch {
			continue;
		}
		for ( const dependency of dependencyReferences( html, entry.url, false, embeddedSources ) ) {
			scan( dependency, index++ );
		}
	}
	for ( const [ family, renditions ] of familyRenditions ) {
		for ( const { dependency } of renditions ) priorities.set( dependency.url, 'additional' );
		const primary = renditions
			.slice()
			.sort( ( left, right ) => right.dimension - left.dimension || left.order - right.order )[ 0 ];
		primaries.set( family, primary.dependency );
		priorities.set( primary.dependency.url, 'required' );
		// A picture's primary rendition is a required byte like the documents'
		// stylesheets and fonts: reserve it so the media tier cannot starve it.
		const resource = resourceManifest.resources[ primary.dependency.url ];
		const source = resource && resolve( sourceRoot, resource.path );
		if ( resource && source && pathWithin( sourceRoot, source ) && existsSync( source ) )
			requiredBytes += statSync( source ).size;
	}
	return { priorities, order, requiredBytes, primaries };
}

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
	/** Captured files larger than this are not written; they resolve like uncaptured dependencies. Default: `DEFAULT_MAX_FILE_BYTES`. */
	maxFileBytes?: number;
	/** Planned dependency priorities from `planPortableResources`. Absent: no total budget enforced. */
	plan?: PortableResourcePlan;
	/** Total bytes this stage may add to the artifact (after what the media stage wrote). */
	maxTotalBytes?: number;
	projectEmbeddedHtml: ( html: string ) => string;
}

export interface PortableResourceResult {
	assets: Array< { sourceUrl: string; path: string } >;
	mediaReplacements: Map< string, string >;
	resourceReplacements: Map< string, string >;
	portablePathsBySource: Map< string, string >;
	unresolvedDependencies: Array< { url: string; sourceUrl: string; error: string } >;
	rejectedReplacementKeys: Set< string >;
	/** Captured dependencies over `maxFileBytes`, one per URL. */
	oversizedResources: Array< { url: string; bytes: number } >;
	/** Required-tier dependencies whose bytes do not fit the remaining budget. */
	overBudgetResources: Array< { url: string; bytes: number } >;
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
	const overBudgetResources = new Map< string, number >();
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const plan = options.plan;
	const maxTotalBytes = options.maxTotalBytes ?? Number.MAX_SAFE_INTEGER;
	let copiedBytes = 0;
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
		const family = dependency.kind === 'media' ? renditionFamily( dependency.url ) : undefined;
		const primaryDependency = plan?.primaries.get( family ?? '' );
		const primaryPath = primaryDependency && primaryDependency.url !== dependency.url
			? resourceReplacements.get( primaryDependency.url )
			: undefined;
		if ( ! alreadyCopied && copiedBytes + bytes > maxTotalBytes ) {
			overBudgetResources.set( dependency.url, bytes );
			unresolvedDependencies.push( {
				url: dependency.url,
				sourceUrl,
				error: `captured dependency is ${ bytes } bytes, over the remaining ${ Math.max(
					maxTotalBytes - copiedBytes,
					0
				) } bytes of the portable export budget`,
			} );
			// Point the reference at a retained rendition of its picture when one
			// exists, so the omitted size does not turn into a blank placeholder.
			if ( primaryPath ) {
				mediaReplacements.set( dependency.reference, primaryPath );
				mediaReplacements.set( dependency.url, primaryPath );
			}
			return false;
		}
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
		copiedBytes += bytes;
		assets.push( {
			sourceUrl: dependency.url,
			path: `website/${ relativePath.replace( /\\/g, '/' ) }`,
		} );
		return true;
	};
	for ( const entry of retainedEntries ) {
		const originalHtml = readFileSync( entry.htmlPath, 'utf8' );
		let html = originalHtml;
		const planned = dependencyReferences( html, entry.url, false, embeddedSources );
		// Deterministic spend order: required-tier dependencies first, in the
		// planner's scan order (stylesheets and their nested fonts, scripts,
		// then one rendition per picture), then what remains of the budget
		// spends on additional renditions.
		const priorityOf = ( dependency: PortableDependency ): PortableResourcePriority =>
			plan?.priorities.get( dependency.url ) ?? 'required';
		const orderOf = ( dependency: PortableDependency ): number =>
			plan?.order.get( dependency.url ) ?? Number.MAX_SAFE_INTEGER;
		for ( const priority of [ 'required', 'additional' ] as const ) {
			for ( const dependency of planned
				.filter( ( candidate ) => priorityOf( candidate ) === priority )
				.sort( ( left, right ) => orderOf( left ) - orderOf( right ) ) ) {
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
					const keptLocal =
						dependency.kind === 'media'
							? mediaReplacements.get( dependency.reference )
							: undefined;
					html =
						dependency.kind === 'media' && keptLocal && keptLocal !== TRANSPARENT_IMAGE_DATA_URL && ! /^(?:https?:)?\/\//i.test( keptLocal )
							? preparePortableReplacements( new Map( [ [ dependency.reference, keptLocal ] ] ), rejectedReplacementKeys )( html )
							: dependency.kind === 'media'
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
		}
		if ( html !== originalHtml ) writeFileSync( entry.htmlPath, html );
	}

	return {
		assets, mediaReplacements, resourceReplacements, portablePathsBySource, unresolvedDependencies, rejectedReplacementKeys,
		oversizedResources: [ ...oversizedResources ].map( ( [ url, bytes ] ) => ( { url, bytes } ) ),
		overBudgetResources: [ ...overBudgetResources ].map( ( [ url, bytes ] ) => ( { url, bytes } ) ),
	};
}
