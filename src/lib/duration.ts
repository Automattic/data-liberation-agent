const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

/**
 * Parse a positive duration such as `90s`, `14m`, `1.5h` or `45000ms` into
 * milliseconds. A bare number is milliseconds. Returns undefined when the text
 * is not a positive duration.
 */
export function parseDurationMs( text: string ): number | undefined {
	const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec( text );
	if ( ! match ) return undefined;
	const ms = Math.round( Number( match[ 1 ] ) * UNIT_MS[ ( match[ 2 ]?.toLowerCase() ?? 'ms' ) as keyof typeof UNIT_MS ] );
	return Number.isSafeInteger( ms ) && ms >= 1 ? ms : undefined;
}
