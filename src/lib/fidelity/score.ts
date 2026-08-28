// src/lib/fidelity/score.ts
//
// Score a source observation against the liberated copy at one viewport.
//
// The gate that would have caught the frozen-layout bug: measuring only at the
// capture width certifies the exact failure mode. This compares at a width the
// caller chose, and the check runner picks widths the sweep never sampled.
//
export interface LayoutObservation {
	/** Viewport width the observation was taken at. */
	viewport: number;
	title: string;
	/** Visible text length after collapsing whitespace. */
	textChars: number;
	/** Widest visible image, in CSS pixels. Null when none. */
	widestImage: number | null;
	/** documentElement.scrollWidth. */
	docWidth: number;
	/** True when the document is wider than the viewport. */
	overflow: boolean;
	/** Hosts the page requested that are not the local copy. */
	externalHosts: string[];
	/** Same-page hash targets found on this document. */
	hashTargets: HashTarget[];
	/** Internal pathnames whose local copy 404s. Empty on the live source. */
	internalMissing: string[];
}

export interface HashTarget {
	fragment: string;
	resolved: boolean;
	/** Elements this fragment matches. More than one and the browser silently
	 *  picks the first, which is how a per-device copy sends a mobile anchor to
	 *  the hidden desktop section. */
	targets: number;
}

export interface ViewportScore {
	viewport: number;
	pass: boolean;
	failures: string[];
	notes: string[];
	source: LayoutObservation;
	liberated: LayoutObservation;
}

/** Image width may drift by a pixel of rounding; more than this is a freeze. */
export const IMAGE_TOLERANCE_PX = 2;

export function scoreViewport(
	source: LayoutObservation,
	liberated: LayoutObservation
): ViewportScore {
	if ( source.viewport !== liberated.viewport ) {
		throw new Error(
			`Cannot score mismatched viewports: source ${ source.viewport } vs liberated ${ liberated.viewport }`
		);
	}

	const failures: string[] = [];
	const notes: string[] = [];

	if ( source.title !== liberated.title ) {
		failures.push( `title "${ liberated.title }" !== source "${ source.title }"` );
	}
	if ( source.textChars !== liberated.textChars ) {
		failures.push( `text ${ liberated.textChars } chars !== source ${ source.textChars }` );
	}

	if ( source.widestImage === null && liberated.widestImage === null ) {
		notes.push( 'no images' );
	} else if ( source.widestImage === null || liberated.widestImage === null ) {
		failures.push(
			`widest image ${ liberated.widestImage ?? 'none' } !== source ${ source.widestImage ?? 'none' }`
		);
	} else if ( Math.abs( liberated.widestImage - source.widestImage ) > IMAGE_TOLERANCE_PX ) {
		failures.push(
			`widest image ${ liberated.widestImage }px !== source ${ source.widestImage }px (Δ${
				liberated.widestImage - source.widestImage
			})`
		);
	}

	if ( liberated.overflow && ! source.overflow ) {
		failures.push( `horizontal overflow at ${ liberated.docWidth }px in a ${ liberated.viewport }px viewport` );
	}

	if ( liberated.externalHosts.length > 0 ) {
		failures.push(
			`copy requested ${ liberated.externalHosts.length } external host(s): ${ liberated.externalHosts
				.slice( 0, 3 )
				.join( ', ' ) }`
		);
	}

	const copyUnresolved = liberated.hashTargets
		.filter( ( target ) => ! target.resolved )
		.map( ( target ) => target.fragment );
	if ( copyUnresolved.length > 0 ) {
		failures.push(
			`nav ${ copyUnresolved.length } same-page anchor(s) missing: #${ copyUnresolved
				.slice( 0, 3 )
				.join( ' #' ) }`
		);
	} else {
		const copyResolved = new Set(
			liberated.hashTargets.filter( ( target ) => target.resolved ).map( ( target ) => target.fragment )
		);
		const lost = source.hashTargets
			.filter( ( target ) => target.resolved && ! copyResolved.has( target.fragment ) )
			.map( ( target ) => target.fragment );
		if ( lost.length > 0 ) {
			failures.push(
				`nav ${ lost.length } same-page anchor(s) missing: #${ lost.slice( 0, 3 ).join( ' #' ) }`
			);
		}
	}

	// Resolving is not the same as resolving correctly. A fragment that matches
	// more elements in the copy than in the source lands somewhere the source
	// never sent it, and `getElementById` reports that as a success.
	const sourceTargets = new Map(
		source.hashTargets.map( ( target ) => [ target.fragment, target.targets ] )
	);
	const ambiguous = liberated.hashTargets
		.filter( ( target ) => target.targets > Math.max( 1, sourceTargets.get( target.fragment ) ?? 1 ) )
		.map( ( target ) => target.fragment );
	if ( ambiguous.length > 0 ) {
		failures.push(
			`nav ${ ambiguous.length } same-page anchor(s) match more than one target: #${ ambiguous
				.slice( 0, 3 )
				.join( ' #' ) }`
		);
	}

	if ( liberated.internalMissing.length > 0 ) {
		failures.push(
			`nav ${ liberated.internalMissing.length } internal link(s) 404: ${ liberated.internalMissing
				.slice( 0, 3 )
				.join( ', ' ) }`
		);
	}

	return {
		viewport: source.viewport,
		pass: failures.length === 0,
		failures,
		notes,
		source,
		liberated,
	};
}

export function scoreReport( scores: ViewportScore[] ): { pass: boolean; failed: number; passed: number } {
	const failed = scores.filter( ( score ) => ! score.pass ).length;
	return { pass: failed === 0, failed, passed: scores.length - failed };
}
