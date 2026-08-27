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
