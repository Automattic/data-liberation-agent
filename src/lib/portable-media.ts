import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { PortableMediaCandidate, PortableMediaPlan } from './portable-media-plan.js';
import { portableAssetUrl, uniqueAssetPath, TRANSPARENT_IMAGE_DATA_URL } from './portable-assets.js';

export interface FailedPortableMedia {
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
	assets: Array< { sourceUrl: string; path: string } >;
	unresolvedMedia: Array< { url: string; error: string } >;
	portableMedia: {
		selected_count: number;
		selected_bytes: number;
		retained_external_count: number;
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
	const localizedMediaFamilies = new Set< string >();
	const portableUrlByFamily = new Map< string, string >();
	const assetPathsByHash = new Map< string, string >();
	const assetHashesByPath = new Map< string, string >();
	const portablePathsBySource = new Map< string, string >();
	for ( const decision of plan.families ) {
		const { family, candidates, eligible, admitted } = decision;
		if ( decision.outcome === 'limit-excluded' ) {
			for ( const reference of retainedReferences.get( family ) ?? [] )
				mediaReplacements.set( reference, TRANSPARENT_IMAGE_DATA_URL );
			for ( const candidate of candidates ) {
				for ( const reference of candidate.references ) {
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
			for ( const candidate of candidates ) {
				for ( const reference of candidate.references ) {
					mediaReplacements.set( reference, TRANSPARENT_IMAGE_DATA_URL );
				}
			}
			unresolvedMedia.push( {
				url: eligible[ 0 ].sourceUrl,
				error: 'removed because the aggregate portable media limit was reached',
			} );
			retainedExternalMediaCount++;
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
				assets.push( {
					sourceUrl: candidate.sourceUrl,
					path: join( 'website', assetPath ).replace( /\\/g, '/' ),
				} );
			}
			portablePathsBySource.set(
				candidate.sourceUrl,
				`website/${ assetPath.replace( /\\/g, '/' ) }`
			);
			fallbackAssetPath ||= assetPath;
			for ( const reference of candidate.exactReferences ) {
				mediaReplacements.set( reference, portableAssetUrl( assetPath ) );
			}
		}
		for ( const reference of retainedReferences.get( family ) ?? [] ) {
			if ( ! mediaReplacements.has( reference ) )
				mediaReplacements.set( reference, portableAssetUrl( fallbackAssetPath ) );
		}
		if ( fallbackAssetPath ) portableUrlByFamily.set( family, portableAssetUrl( fallbackAssetPath ) );
	}
	const portableMedia = {
		selected_count: assets.length,
		selected_bytes: plan.selectedBytes,
		retained_external_count: retainedExternalMediaCount,
		max_bytes: input.maxBytes,
		reserved_bytes: 0,
	};
	for ( const { family, sourceUrl, error, references } of failedMedia ) {
		if ( localizedMediaFamilies.has( family ) ) continue;
		for ( const reference of retainedReferences.get( family ) ?? [] )
			mediaReplacements.set( reference, TRANSPARENT_IMAGE_DATA_URL );
		for ( const reference of references )
			mediaReplacements.set( reference, TRANSPARENT_IMAGE_DATA_URL );
		unresolvedMedia.push( { url: sourceUrl, error } );
	}
	return { mediaReplacements, portableUrlByFamily, assetPathsByHash, assetHashesByPath, portablePathsBySource, assets, unresolvedMedia, portableMedia };
}
