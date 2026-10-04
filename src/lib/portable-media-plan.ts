import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Portable media selection plan. One pass records which known reference strings
 * occur in retained pages, then each family resolves eligibility, homepage
 * priority, byte budget, and content-hash dedupe once. The exporter localizes
 * those decisions in original family order and does not reread staged HTML.
 */

const MAX_PORTABLE_MEDIA_BYTES = 5 * 1024 * 1024;
const MAX_PORTABLE_RESPONSIVE_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_PORTABLE_MEDIA_DIMENSION = 2048;

export interface PortableMediaCandidate {
	sourceUrl: string;
	localPath: string;
	references: string[];
	exactReferences: string[];
	bytes: number;
	dimension: number;
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
	/** `selectMediaCandidates` result. Budget tie-breaks use the first entry. */
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
): PortableMediaCandidate | undefined {
	const bounded = candidates.filter(
		( candidate ) =>
			candidate.bytes <= MAX_PORTABLE_MEDIA_BYTES &&
			candidate.dimension <= MAX_PORTABLE_MEDIA_DIMENSION
	);
	return [ ...bounded ].sort(
		( a, b ) =>
			b.dimension - a.dimension || a.bytes - b.bytes || a.sourceUrl.localeCompare( b.sourceUrl )
	)[ 0 ];
}

function selectMediaCandidates( candidates: PortableMediaCandidate[] ): PortableMediaCandidate[] {
	const dimensionBounded = candidates.filter(
		( candidate ) => candidate.dimension <= MAX_PORTABLE_MEDIA_DIMENSION
	);
	const responsiveFamily =
		dimensionBounded.filter( ( candidate ) => candidate.exactReferences.length > 0 ).length > 1;
	const bounded = dimensionBounded.filter(
		( candidate ) =>
			candidate.bytes <=
			( responsiveFamily ? MAX_PORTABLE_RESPONSIVE_MEDIA_BYTES : MAX_PORTABLE_MEDIA_BYTES )
	);
	const exact = bounded.filter( ( candidate ) => candidate.exactReferences.length > 0 );
	const fallback = selectMediaCandidate( bounded );
	const selected = exact.length > 0 ? exact : fallback ? [ fallback ] : [];
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
		eligible: selectMediaCandidates( family.candidates ),
		homepagePriority: homepagePriority[ index ],
	} ) );
	const admissionOrder = [ ...ranked ].sort(
		( left, right ) =>
			Number( right.homepagePriority ) - Number( left.homepagePriority ) ||
			( left.eligible[ 0 ]?.bytes ?? 0 ) - ( right.eligible[ 0 ]?.bytes ?? 0 ) ||
			( left.eligible[ 0 ]?.sourceUrl ?? '' ).localeCompare( right.eligible[ 0 ]?.sourceUrl ?? '' )
	);
	const admitted = new Map< PortableMediaCandidate, PortableMediaFamilyDecision[ 'admitted' ][ number ] >();
	const hashes = new Set< string >();
	let selectedBytes = 0;
	for ( const family of admissionOrder ) {
		for ( const candidate of family.eligible ) {
			const contentHash = fileHash( candidate.localPath );
			const needsFile = ! hashes.has( contentHash );
			if ( ! needsFile || selectedBytes + candidate.bytes <= budget ) {
				admitted.set( candidate, { candidate, contentHash } );
				if ( needsFile ) {
					hashes.add( contentHash );
					selectedBytes += candidate.bytes;
				}
			}
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
