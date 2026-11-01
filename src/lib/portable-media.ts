import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { PortableMediaCandidate, PortableMediaPlan } from './portable-media-plan.js';
import { portableAssetUrl, uniqueAssetPath, TRANSPARENT_IMAGE_DATA_URL } from './portable-assets.js';

export interface FailedPortableMedia {
	nonImage?: boolean;
	family: string;
	sourceUrl: string;
	error: string;
	references: readonly string[];
}

export interface PortableMediaMaterializationInput {
	websiteDir: string;
	plan: PortableMediaPlan;
	maxBytes: number;
	retainedReferences: ReadonlyMap< string, readonly string[] >;
	failedMedia: readonly FailedPortableMedia[];
}

export interface PortableMediaMaterialization {
	mediaReplacements: Map< string, string >;
	portableUrlByFamily: Map< string, string >;
	assetPathsByHash: Map< string, string >;
	assetHashesByPath: Map< string, string >;
	portablePathsBySource: Map< string, string >;
	/** Captured image identities backed by a retained rendition of the same family. */
	metadataPathsBySource: Map< string, string >;
	assets: Array< { sourceUrl: string; source_url?: string; source_urls?: string[]; references?: import('./image-assets.js').ImageAssetReference[]; original?: import('./image-assets.js').ImageAssetRecord['original']; kind?: import('./image-assets.js').ImageAssetRecord['kind']; destination_owner?: import('./image-assets.js').ImageAssetRecord['destination_owner']; path: string } >;
	unresolvedMedia: Array< { url: string; error: string } >;
	portableMedia: {
		selected_count: number;
		selected_bytes: number;
		retained_external_count: number;
		blanked_count: number;
		max_bytes: number;
		reserved_bytes: number;
	};
}

function portableMediaBasename( candidate: PortableMediaCandidate ): string {
	const localName = basename( candidate.localPath );
	if (
		/^\.(?:avif|gif|jpe?g|png|svg|webp|mp4|webm|mp3|ogg|wav|woff2?|ttf|otf)$/i.test(
			extname( localName )
		)
	) {
		return localName;
	}

	const cleanedUrl = candidate.sourceUrl.replace( /&(?:quot|apos|amp);?$/i, '' );
	const sourceExtension = extname( basename( new URL( cleanedUrl ).pathname ) );
	if (
		! /^\.(?:avif|gif|jpe?g|png|svg|webp|mp4|webm|mp3|ogg|wav|woff2?|ttf|otf)$/i.test(
			sourceExtension
		)
	) {
		return localName;
	}
	return `${ localName.slice(
		0,
		localName.length - extname( localName ).length
	) }${ sourceExtension.toLowerCase() }`;
}

/** Materialize admitted media in family order and return stage-owned resource seeds. */
export function materializePortableMedia( input: PortableMediaMaterializationInput ): PortableMediaMaterialization {
	const { websiteDir, plan, retainedReferences, failedMedia } = input;
	const mediaReplacements = new Map< string, string >();
	const unresolvedMedia: PortableMediaMaterialization[ 'unresolvedMedia' ] = [];
	const assets: PortableMediaMaterialization[ 'assets' ] = [];
	let retainedExternalMediaCount = 0;
	const blankedFamilies = new Set< string >();
	const localizedMediaFamilies = new Set< string >();
	const portableUrlByFamily = new Map< string, string >();
	const assetPathsByHash = new Map< string, string >();
	const assetHashesByPath = new Map< string, string >();
	const portablePathsBySource = new Map< string, string >();
	const metadataPathsBySource = new Map< string, string >();
	const assetsByPath = new Map< string, PortableMediaMaterialization[ 'assets' ][ number ] >();
	const assetReferences: import('./image-assets.js').ImageAssetReference[] = [];
	const seenReferences = new Set< string >();
	for ( const decision of plan.families ) {
		const { family, candidates, eligible, admitted } = decision;
		if ( decision.outcome === 'limit-excluded' ) {
			if ( candidates.every( candidate => ! candidate.imageAsset?.kind || candidate.imageAsset.kind === 'image' ) ) for ( const reference of retainedReferences.get( family ) ?? [] )
				mediaReplacements.set( reference, TRANSPARENT_IMAGE_DATA_URL );
			for ( const candidate of candidates ) {
				if ( ! candidate.imageAsset?.kind || candidate.imageAsset.kind === 'image' ) for ( const reference of candidate.references ) {
					mediaReplacements.set( reference, candidate.sourceUrl );
				}
				unresolvedMedia.push( {
					url: candidate.sourceUrl,
					error: 'removed because media exceeds portable size or dimension limits',
				} );
				retainedExternalMediaCount++;
			}
			continue;
		}
		if ( decision.outcome === 'budget-excluded' ) {
			const isImage = candidates.every( candidate => ! candidate.imageAsset?.kind || candidate.imageAsset.kind === 'image' );
			if ( isImage ) {
				blankedFamilies.add( family );
				for ( const reference of retainedReferences.get( family ) ?? [] ) mediaReplacements.set( reference, TRANSPARENT_IMAGE_DATA_URL );
			}
			for ( const candidate of candidates ) {
				if ( ! candidate.imageAsset?.kind || candidate.imageAsset.kind === 'image' ) for ( const reference of candidate.references ) {
					mediaReplacements.set( reference, TRANSPARENT_IMAGE_DATA_URL );
				}
			}
			unresolvedMedia.push( {
				url: eligible[ 0 ].sourceUrl,
				error: isImage ? 'blanked because the aggregate portable media limit was reached' : 'not localized because the aggregate portable media limit was reached',
			} );
			if ( ! isImage ) retainedExternalMediaCount++;
			continue;
		}
		localizedMediaFamilies.add( family );
		let fallbackAssetPath = '';
		for ( const { candidate, contentHash } of admitted ) {
			let assetPath = assetPathsByHash.get( contentHash );
			if ( assetPath === undefined ) {
				assetPath = uniqueAssetPath(
					join( 'media', portableMediaBasename( candidate ) ),
					contentHash,
					assetHashesByPath
				);
				const destination = join( websiteDir, assetPath );
				mkdirSync( dirname( destination ), { recursive: true } );
				copyFileSync( candidate.localPath, destination );
				assetPathsByHash.set( contentHash, assetPath );
				assetHashesByPath.set( assetPath, contentHash );
				const asset: PortableMediaMaterialization[ 'assets' ][ number ] = {
					sourceUrl: candidate.sourceUrl,
					source_url: candidate.sourceUrl,
					...( candidate.imageAsset ? { kind: candidate.imageAsset.kind, destination_owner: candidate.imageAsset.destination_owner, source_urls: [], references: [], original: candidate.imageAsset.original } : {} ),
					path: join( 'website', assetPath ).replace( /\\/g, '/' ),
				};
				assets.push( asset );
				assetsByPath.set( asset.path, asset );
			}
			portablePathsBySource.set(
				candidate.sourceUrl,
				`website/${ assetPath.replace( /\\/g, '/' ) }`
			);
			for ( const url of candidate.imageAsset?.source_urls ?? [] ) portablePathsBySource.set( url, `website/${ assetPath.replace( /\\/g, '/' ) }` );
			fallbackAssetPath ||= assetPath;
			for ( const reference of candidate.imageAsset ? candidate.references : candidate.exactReferences ) {
				mediaReplacements.set( reference, portableAssetUrl( assetPath ) );
			}
		}
		for ( const reference of retainedReferences.get( family ) ?? [] ) {
			if ( ! mediaReplacements.has( reference ) )
				mediaReplacements.set( reference, portableAssetUrl( fallbackAssetPath ) );
		}
		if ( fallbackAssetPath ) {
			// Ownership follows the final rewrite, not the candidate's inherited
			// family metadata. This also merges identities for hash-deduplicated files.
			const familySources = new Set< string >();
			for ( const candidate of candidates ) {
				if ( ! candidate.imageAsset ) continue;
				for ( const source of [ candidate.sourceUrl, ...candidate.imageAsset.source_urls ] ) familySources.add( source );
				for ( const reference of candidate.imageAsset.references ) {
					const key = JSON.stringify( reference );
					if ( seenReferences.has( key ) ) continue;
					seenReferences.add( key );
					assetReferences.push( reference );
				}
			}
			for ( const source of familySources ) {
				const replacement = mediaReplacements.get( source ) ?? portableAssetUrl( fallbackAssetPath );
				const owner = admitted.find( entry => portableAssetUrl( assetPathsByHash.get( entry.contentHash )! ) === replacement );
				const path = assetPathsByHash.get( owner?.contentHash ?? admitted[ 0 ].contentHash )!;
				portablePathsBySource.set( source, `website/${ path.replace( /\\/g, '/' ) }` );
			}
			// An extra responsive file may serve no family reference. It still
			// identifies itself, but must not inherit the fallback's references.
			for ( const { candidate, contentHash } of admitted ) {
				if ( ! candidate.imageAsset ) continue;
				const path = `website/${ assetPathsByHash.get( contentHash )!.replace( /\\/g, '/' ) }`;
				if ( [ ...familySources ].some( source => portablePathsBySource.get( source ) === path ) ) continue;
				portablePathsBySource.set( candidate.sourceUrl, path );
			}
			portableUrlByFamily.set( family, portableAssetUrl( fallbackAssetPath ) );
			for ( const candidate of candidates ) {
				// Unadmitted renditions use the family's coverage fallback.
				if ( admitted.some( entry => entry.candidate === candidate ) ) continue;
				if ( candidate.imageAsset?.kind && candidate.imageAsset.kind !== 'image' ) continue;
				for ( const source of [ candidate.sourceUrl, ...( candidate.imageAsset?.source_urls ?? [] ) ] ) {
					metadataPathsBySource.set( source, `website/${ fallbackAssetPath.replace( /\\/g, '/' ) }` );
				}
			}
		}
	}
	for ( const [ source, path ] of portablePathsBySource ) {
		const asset = assetsByPath.get( path );
		if ( ! asset?.source_urls ) continue;
		asset.source_urls.push( source );
	}
	for ( const reference of assetReferences ) {
		const asset = assetsByPath.get( portablePathsBySource.get( reference.source_url ) ?? '' );
		const replacement = mediaReplacements.get( reference.source_url );
		if ( asset?.source_urls?.includes( reference.source_url ) &&
			( ! replacement || replacement === `/${ asset.path.replace( /^website\//, '' ) }` ) ) asset.references!.push( reference );
	}
	const portableMedia = {
		selected_count: assets.length,
		selected_bytes: plan.selectedBytes,
		retained_external_count: retainedExternalMediaCount,
		blanked_count: blankedFamilies.size,
		max_bytes: input.maxBytes,
		reserved_bytes: 0,
	};
	for ( const { family, sourceUrl, error, references, nonImage } of failedMedia ) {
		if ( localizedMediaFamilies.has( family ) ) continue;
		if ( nonImage ) { unresolvedMedia.push( { url: sourceUrl, error } ); continue; }
		blankedFamilies.add( family );
		for ( const reference of retainedReferences.get( family ) ?? [] )
			mediaReplacements.set( reference, TRANSPARENT_IMAGE_DATA_URL );
		for ( const reference of references )
			mediaReplacements.set( reference, TRANSPARENT_IMAGE_DATA_URL );
		unresolvedMedia.push( { url: sourceUrl, error } );
	}
	portableMedia.blanked_count = blankedFamilies.size;
	return { mediaReplacements, portableUrlByFamily, assetPathsByHash, assetHashesByPath, portablePathsBySource, metadataPathsBySource, assets, unresolvedMedia, portableMedia };
}
