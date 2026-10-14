import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Portable media selection plan. One pass records which known reference strings
 * occur in retained pages, then each family resolves eligibility, homepage
 * priority, byte budget, and content-hash dedupe once. The media stage localizes
 * those decisions in original family order and does not reread staged HTML.
 */

const MAX_PORTABLE_MEDIA_BYTES = 5 * 1024 * 1024;
const MAX_PORTABLE_RESPONSIVE_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_PORTABLE_MEDIA_DIMENSION = 2048;

const WIDTH_RENDITION_QUERY_PARAMS = new Set( [
	'w', 'h', 'width', 'height', 'format', 'dw', 'dpr', 'size',
] );

export function renditionFamily( sourceUrl: string ): string {
	const url = new URL( sourceUrl );
	const transformedPath = /^(.*?)\/v1\/(?:fill|fit|crop)\//i.exec( url.pathname )?.[ 1 ];
	let pathname = transformedPath
		? transformedPath
		: url.pathname
			.replace( /\/:(?:\/)?rs=w:\d+,h:\d+(?:,[^/]*)*(?=\/|$)/gi, '' );
	pathname = pathname.replace( /-(\d+)w(?=\.\w+$)/i, '' );
	const keptParams: string[] = [];
	for ( const [ key, value ] of url.searchParams ) {
		if ( WIDTH_RENDITION_QUERY_PARAMS.has( key.toLowerCase() ) && /^\d+(?:w|h)?$/i.test( value ) ) continue;
		keptParams.push( value ? `${ key }=${ value }` : key );
	}
	return `${ url.origin }${ pathname }${ keptParams.length > 0 ? `?${ keptParams.join( '&' ) }` : '' }`;
}

/**
 * The scale a rendition restores: the largest size encoded in the URL itself
 * (a width query parameter such as Squarespace's `?format=1200w`, the width
 * suffix of a hashed file name, a `w_800` transformation segment, or a plain
 * `w`/`h` query), used to rank renditions of one picture.
 */
export function renditionDimension( sourceUrl: string ): number {
	try {
		const url = new URL( sourceUrl );
		const transformations = [ ...url.pathname.matchAll( /\/v1\/(?:fill|fit|crop)\/([^/]+)/gi ) ]
			.map( ( match ) => match[ 1 ] );
		const dimensions: number[] = [];
		for ( const [ key, value ] of url.searchParams ) {
			if ( [ 'w', 'h' ].includes( key.toLowerCase() ) ) dimensions.push( Number( value ) || 0 );
			const format = /^(\d+)w$/i.exec( value );
			if ( key.toLowerCase() === 'format' && format ) dimensions.push( Number( format[ 1 ] ) || 0 );
		}
		for ( const match of (
			// The rendered scale is encoded in the last transformation segment, so
			// a rendered.jpg@704 path that passes through w_3939 intermediates is
			// still a 704 rendition.
			transformations.at( -1 ) ?? url.pathname
		).matchAll( /(?:^|[,/])(?:w|h)_(\d+)|\/:(?:\/)?rs=w:(\d+)|-(\d+)w(?=\.\w+$)/gi ) ) {
			dimensions.push( Number( match[ 1 ] ?? match[ 2 ] ?? match[ 3 ] ) || 0 );
		}
		return Math.max( 0, ...dimensions );
	} catch {
		return 0;
	}
}

export interface PortableMediaCandidate {
	sourceUrl: string;
	localPath: string;
	references: string[];
	exactReferences: string[];
	bytes: number;
	dimension: number;
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

function selectMediaCandidates( candidates: PortableMediaCandidate[] ): PortableMediaCandidate[] {
	const dimensionBounded = candidates.filter(
		( candidate ) => candidate.dimension <= MAX_PORTABLE_MEDIA_DIMENSION
	);
	const responsiveFamily =
		dimensionBounded.filter( ( candidate ) => candidate.exactReferences.length > 0 ).length > 1;
	const bounded = dimensionBounded.filter(
		( candidate ) =>
			candidate.bytes <=
			( candidate.galleryFrame || responsiveFamily ? MAX_PORTABLE_RESPONSIVE_MEDIA_BYTES : MAX_PORTABLE_MEDIA_BYTES )
	);
	const exact = bounded.filter( ( candidate ) => candidate.exactReferences.length > 0 );
	const fallback = selectMediaCandidate( bounded, MAX_PORTABLE_RESPONSIVE_MEDIA_BYTES );
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
	const admit = ( candidate: PortableMediaCandidate ): void => {
		const contentHash = fileHash( candidate.localPath );
		const needsFile = ! hashes.has( contentHash );
		if ( ! needsFile || selectedBytes + candidate.bytes <= budget ) {
			admitted.set( candidate, { candidate, contentHash } );
			if ( needsFile ) {
				hashes.add( contentHash );
				selectedBytes += candidate.bytes;
			}
		}
	};
	// Required tier first: every family gets one rendition (the widest scale
	// the srcset names) before anything spends bytes on additional renditions,
	// so a fan-out of sizes can never displace another picture entirely.
	for ( const family of admissionOrder ) {
		const primary = family.eligible[ 0 ];
		if ( primary ) admit( primary );
	}
	// Additional tier after: remaining renditions and lower-priority media
	// share whatever the budget still has left, in the same admission order.
	for ( const family of admissionOrder ) {
		for ( const candidate of family.eligible.slice( 1 ) ) admit( candidate );
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
