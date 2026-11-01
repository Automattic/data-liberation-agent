import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { IntegrityError } from './failure-class.js';
import { MAX_PORTABLE_MEDIA_DIMENSION } from './portable-media-limits.js';

/**
 * Portable media selection plan. One pass records which known reference strings
 * occur in retained pages, then each family resolves eligibility, homepage
 * priority, byte budget, and content-hash dedupe once. The media stage localizes
 * those decisions in original family order and does not reread staged HTML.
 */

const MAX_PORTABLE_MEDIA_BYTES = 5 * 1024 * 1024;
const MAX_PORTABLE_RESPONSIVE_MEDIA_BYTES = 8 * 1024 * 1024;

export interface PortableMediaCandidate {
	imageAsset?: import('./image-assets.js').ImageAssetRecord;
	sourceUrl: string;
	localPath: string;
	references: string[];
	exactReferences: string[];
	bytes: number;
	dimension: number;
	/** Largest observed rendered edge, when capture has geometry for this family. */
	renderedDimension?: number;
	/** Gallery frame assets may use the existing larger responsive-image byte bound. */
	galleryFrame?: boolean;
}

export interface PortableMediaReferenceIndex {
	/** Probe strings searched by the reference pass. */
	indexed: Set< string >;
	/** Probe strings found in at least one scanned page. */
	matched: Set< string >;
}

export interface PortableMediaFamilyInput {
	family: string;
	candidates: PortableMediaCandidate[];
}

export type PortableMediaFamilyOutcome = 'limit-excluded' | 'budget-excluded' | 'selected';

export interface PortableMediaFamilyDecision {
	family: string;
	candidates: PortableMediaCandidate[];
	/** All bounded renditions, in preferred dimension order. Budget ties use the first entry. */
	eligible: PortableMediaCandidate[];
	/** Eligible candidates admitted by budget and content-hash dedupe, in eligible order. */
	admitted: Array< { candidate: PortableMediaCandidate; contentHash: string } >;
	homepagePriority: boolean;
	outcome: PortableMediaFamilyOutcome;
}

export interface PortableMediaPlan {
	/** Input family order, one decision per family. */
	families: PortableMediaFamilyDecision[];
	selectedBytes: number;
}

export function containsMediaReference( content: string, reference: string ): boolean {
	for ( const candidate of [ reference, reference.replace( /&/g, '&amp;' ) ] ) {
		let offset = content.indexOf( candidate );
		while ( offset !== -1 ) {
			const suffix = content.slice( offset + candidate.length );
			if (
				new URL( reference, 'https://example.com' ).search ||
				( ! suffix.startsWith( '?' ) && ! suffix.startsWith( '&amp;' ) )
			) {
				return true;
			}
			offset = content.indexOf( candidate, offset + candidate.length );
		}
	}
	return false;
}

/**
 * Read each page, record which known references it contains, then drop the page.
 * Match results use `containsMediaReference`, including entity spelling and the
 * query / `&amp;` boundary check.
 */
export function indexPortableMediaReferences(
	htmlPaths: readonly string[],
	references: readonly string[],
): PortableMediaReferenceIndex {
	const unique: string[] = [];
	const indexed = new Set< string >();
	for ( const reference of references ) {
		if ( indexed.has( reference ) ) continue;
		indexed.add( reference );
		unique.push( reference );
	}
	const matched = new Set< string >();
	if ( unique.length === 0 ) return { matched, indexed };
	const pending = new Set( unique );
	for ( const htmlPath of htmlPaths ) {
		if ( pending.size === 0 ) break;
		const html = readFileSync( htmlPath, 'utf8' );
		for ( const reference of pending ) {
			if ( containsMediaReference( html, reference ) ) matched.add( reference );
		}
		for ( const reference of matched ) pending.delete( reference );
	}
	return { matched, indexed };
}

export function mediaReferenceMatched(
	index: PortableMediaReferenceIndex,
	reference: string,
): boolean {
	if ( ! index.indexed.has( reference ) )
		throw new Error( `portable media reference was not indexed: ${ reference }` );
	return index.matched.has( reference );
}

function selectMediaCandidate(
	candidates: PortableMediaCandidate[],
	maxBytes: number,
): PortableMediaCandidate | undefined {
	const bounded = candidates.filter(
		( candidate ) =>
			candidate.bytes <= maxBytes &&
			candidate.dimension <= MAX_PORTABLE_MEDIA_DIMENSION
	);
	return [ ...bounded ].sort(
		( a, b ) =>
			b.dimension - a.dimension || a.bytes - b.bytes || a.sourceUrl.localeCompare( b.sourceUrl )
	)[ 0 ];
}

function selectMediaCandidates( candidates: PortableMediaCandidate[], allEligible = false ): PortableMediaCandidate[] {
	const dimensionBounded = candidates.filter(
		( candidate ) => candidate.dimension <= MAX_PORTABLE_MEDIA_DIMENSION
	);
	const responsiveFamily =
		dimensionBounded.filter( ( candidate ) => candidate.exactReferences.length > 0 ).length > 1;
	const familyByteCap = ( candidate: PortableMediaCandidate ): number =>
		candidate.galleryFrame || responsiveFamily ? MAX_PORTABLE_RESPONSIVE_MEDIA_BYTES : MAX_PORTABLE_MEDIA_BYTES;
	const bounded = dimensionBounded.filter(
		( candidate ) => candidate.bytes <= familyByteCap( candidate )
	);
	const exact = bounded.filter( ( candidate ) => candidate.exactReferences.length > 0 );
	const fallback = selectMediaCandidate( bounded, MAX_PORTABLE_RESPONSIVE_MEDIA_BYTES );
	// Head-only raster images have no rendered geometry to constrain. If no
	// portable rendition exists, keep the verified original within the byte cap.
	// SVGs retain their existing dimension limit.
	const headOriginal = ! fallback ? candidates.find( candidate =>
		candidate.bytes <= MAX_PORTABLE_MEDIA_BYTES &&
		candidate.exactReferences.length > 0 &&
		candidate.imageAsset?.original?.content_type.startsWith( 'image/' ) &&
		candidate.imageAsset.original.content_type !== 'image/svg+xml' &&
		candidate.imageAsset.references.length > 0 &&
		candidate.imageAsset.references.every( reference => reference.kind === 'head' )
	) : undefined;
	// A raster original above the dimension ceiling stays a real image when the
	// family has no bounded rendition and its verified bytes fit the byte cap:
	// a placeholder would erase a picture the source shows, and WordPress scales
	// oversized originals on upload. SVGs and non-images keep the dimension limit.
	const oversizedOriginal = ! bounded.length && ! headOriginal
		? candidates.filter( candidate =>
			candidate.bytes <= familyByteCap( candidate ) &&
			candidate.imageAsset?.original?.content_type.startsWith( 'image/' ) &&
			candidate.imageAsset.original.content_type !== 'image/svg+xml'
		).sort(
			( a, b ) => b.dimension - a.dimension || a.bytes - b.bytes || a.sourceUrl.localeCompare( b.sourceUrl )
		)[ 0 ]
		: undefined;
	const unboundedOriginal = headOriginal ?? oversizedOriginal;
	const selected = allEligible && bounded.length > 0 ? bounded : exact.length > 0 ? exact : fallback ? [ fallback ] : unboundedOriginal ? [ unboundedOriginal ] : [];
	return [ ...selected ].sort(
		( a, b ) =>
			b.dimension - a.dimension || a.bytes - b.bytes || a.sourceUrl.localeCompare( b.sourceUrl )
	);
}

function fileHash( path: string ): string {
	return createHash( 'sha256' ).update( readFileSync( path ) ).digest( 'hex' );
}

function familyHomepagePriority(
	families: readonly PortableMediaFamilyInput[],
	homepageHtmlPath: string,
): boolean[] {
	if (
		families.every( ( family ) =>
			family.candidates.every( ( candidate ) => candidate.references.length === 0 )
		)
	) {
		return families.map( () => false );
	}
	const homepageHtml = readFileSync( homepageHtmlPath, 'utf8' );
	return families.map( ( family ) =>
		family.candidates.some( ( candidate ) =>
			candidate.references.some( ( reference ) => containsMediaReference( homepageHtml, reference ) )
		)
	);
}

export function planPortableMediaFamilies(
	families: readonly PortableMediaFamilyInput[],
	budget: number,
	homepageHtmlPath: string,
): PortableMediaPlan {
	const homepagePriority = familyHomepagePriority( families, homepageHtmlPath );
	const ranked = families.map( ( family, index ) => ( {
		index,
		eligible: selectMediaCandidates( family.candidates, true ),
		preferred: selectMediaCandidates( family.candidates ),
		homepagePriority: homepagePriority[ index ],
	} ) );
	const admissionOrder = [ ...ranked ].sort(
		( left, right ) =>
			Number( right.homepagePriority ) - Number( left.homepagePriority ) ||
			( left.eligible[ 0 ]?.bytes ?? 0 ) - ( right.eligible[ 0 ]?.bytes ?? 0 ) ||
			( left.eligible[ 0 ]?.sourceUrl ?? '' ).localeCompare( right.eligible[ 0 ]?.sourceUrl ?? '' )
	);
	const admitted = new Map< PortableMediaCandidate, PortableMediaFamilyDecision[ 'admitted' ][ number ] >();
	const hashes = new Map< string, { count: number; bytes: number } >();
	const verified = new Map< PortableMediaCandidate, string >();
	let selectedBytes = 0;
	const hashOf = ( candidate: PortableMediaCandidate ): string => {
		let hash = verified.get( candidate );
		if ( hash === undefined ) {
			hash = fileHash( candidate.localPath );
			if ( candidate.imageAsset?.original && hash !== candidate.imageAsset.original.sha256 )
				throw new IntegrityError( `Image original changed after verification: ${ candidate.sourceUrl }` );
			verified.set( candidate, hash );
		}
		return hash;
	};
	const admit = ( candidate: PortableMediaCandidate, replace?: PortableMediaCandidate ): boolean => {
		if ( admitted.has( candidate ) ) return true;
		const contentHash = hashOf( candidate );
		const previous = replace && admitted.get( replace );
		const previousFile = previous && hashes.get( previous.contentHash );
		const releasedBytes = previousFile?.count === 1 ? previousFile.bytes : 0;
		const extraBytes = hashes.has( contentHash ) && ! ( previous?.contentHash === contentHash && previousFile?.count === 1 ) ? 0 : candidate.bytes;
		if ( selectedBytes - releasedBytes + extraBytes > budget ) return false;
		if ( previous && replace ) {
			admitted.delete( replace );
			if ( --previousFile!.count === 0 ) {
				hashes.delete( previous.contentHash );
				selectedBytes -= previousFile!.bytes;
			}
		}
		const existing = hashes.get( contentHash );
		if ( existing ) existing.count++;
		else {
			hashes.set( contentHash, { count: 1, bytes: candidate.bytes } );
			selectedBytes += candidate.bytes;
		}
		admitted.set( candidate, { candidate, contentHash } );
		return true;
	};
	const baselines = new Map< number, PortableMediaCandidate >();
	// Reserve one rendition per family before spending anything on resolution.
	for ( const family of admissionOrder ) {
		const smallest = [ ...family.eligible ].sort( ( a, b ) =>
			a.dimension - b.dimension || a.bytes - b.bytes || a.sourceUrl.localeCompare( b.sourceUrl )
		);
		const rendered = Math.max( 0, ...family.eligible.map( candidate => candidate.renderedDimension ?? 0 ) );
		const baseline = smallest.find( candidate => candidate.dimension >= rendered ) ?? smallest[ smallest.length - 1 ];
		if ( baseline ) {
			const admittedBaseline = admit( baseline ) ? baseline : smallest.find( candidate => admit( candidate ) );
			if ( admittedBaseline ) baselines.set( family.index, admittedBaseline );
		}
	}
	// Upgrades replace the reservation and pay only the incremental,
	// hash-deduplicated cost. Additional responsive renditions use spare bytes.
	for ( const family of admissionOrder ) {
		const baseline = baselines.get( family.index );
		if ( ! baseline ) continue;
		let upgraded = false;
		for ( const candidate of family.preferred ) {
			const replace = ! upgraded && candidate.dimension >= baseline.dimension ? baseline : undefined;
			if ( admit( candidate, replace ) && replace ) upgraded = true;
		}
	}
	return {
		families: families.map( ( family, index ) => {
			const eligible = ranked[ index ].eligible;
			const admittedCandidates = eligible.flatMap( ( candidate ) => {
				const admission = admitted.get( candidate );
				return admission ? [ admission ] : [];
			} );
			const outcome: PortableMediaFamilyOutcome =
				eligible.length === 0
					? 'limit-excluded'
					: admittedCandidates.length === 0
						? 'budget-excluded'
						: 'selected';
			return {
				family: family.family,
				candidates: family.candidates,
				eligible,
				admitted: admittedCandidates,
				homepagePriority: homepagePriority[ index ],
				outcome,
			};
		} ),
		selectedBytes,
	};
}
