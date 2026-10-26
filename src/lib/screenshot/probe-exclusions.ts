// src/lib/screenshot/probe-exclusions.ts
//
// Adapter-declared regions that interaction probing never drives. Generic
// capture only knows "this subtree is platform runtime the copy cannot carry";
// recognising which subtree that is belongs to the adapter.
//
import type { Page } from 'playwright';
import type { ProfileDiagnostic } from './manifest-queue.js';

/** A platform-runtime region excluded from interaction probing. */
export interface ProbeExclusion {
	/** Stable id for the region, recorded in diagnostics. */
	id: string;
	/** CSS selector matching the region's root(s); its whole subtree is skipped. */
	selector: string;
	/** Why probing it is pointless, recorded in diagnostics. */
	reason: string;
}

export const PROBE_REGION_EXCLUDED = 'interaction_probe_region_excluded';

/** The probe skip selector for the given regions: each root and everything inside it. */
export function probeExclusionSkip( exclusions: readonly ProbeExclusion[] ): string | undefined {
	if ( ! exclusions.length ) return undefined;
	const roots = exclusions.map( ( exclusion ) => `:is(${ exclusion.selector })` );
	return roots.flatMap( ( root ) => [ root, `${ root } *` ] ).join( ', ' );
}

/** Join skip selectors owned by different probes; undefined when none applies. */
export function combineSkips( ...skips: Array< string | undefined > ): string | undefined {
	const present = skips.filter( ( skip ): skip is string => Boolean( skip ) );
	return present.length ? present.join( ', ' ) : undefined;
}

/**
 * Resolve the declared regions present on this page: the skip selector to pass
 * to every probe, and one diagnostic per region found, so the skip is visible.
 * Regions absent from the page contribute nothing.
 */
export async function resolveProbeExclusions(
	page: Page,
	exclusions: readonly ProbeExclusion[] | undefined
): Promise< { skip?: string; diagnostics: ProfileDiagnostic[] } > {
	if ( ! exclusions?.length ) return { diagnostics: [] };
	const counts = await page.evaluate(
		( selectors: string[] ) => selectors.map( ( selector ) => {
			try {
				return Array.from( document.querySelectorAll( selector ) ).filter( ( root ) => ! root.parentElement?.closest( selector ) ).length;
			} catch {
				return 0;
			}
		} ),
		exclusions.map( ( exclusion ) => exclusion.selector )
	);
	const present = exclusions.filter( ( _, index ) => ( counts[ index ] ?? 0 ) > 0 );
	const skip = probeExclusionSkip( present );
	return {
		...( skip ? { skip } : {} ),
		diagnostics: present.map( ( exclusion ) => ( {
			code: PROBE_REGION_EXCLUDED,
			reason: `${ exclusion.id }: ${ counts[ exclusions.indexOf( exclusion ) ] } region(s) matching ${ exclusion.selector } not probed for interactions; ${ exclusion.reason }`,
		} ) ),
	};
}
