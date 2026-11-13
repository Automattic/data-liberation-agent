/**
 * Apply an adapter's HTML rewrite to every string in an interaction report
 * (dialog markup, trigger and dialog selectors), then restate each dialog's
 * byte count, which consumers verify against the markup.
 */
export function canonicalizeInteractionReport< T >( report: T, canonicalize: ( html: string ) => string ): T {
	const rewrite = ( value: unknown ): unknown => {
		if ( typeof value === 'string' ) return canonicalize( value );
		if ( Array.isArray( value ) ) return value.map( rewrite );
		if ( value && typeof value === 'object' ) {
			const source = value as Record< string, unknown >;
			const out: Record< string, unknown > = {};
			for ( const [ key, child ] of Object.entries( source ) ) out[ key ] = rewrite( child );
			// A complete dialog's byte count describes its markup; a truncated one
			// records the original size, which the rewrite does not change.
			if (
				typeof source.html === 'string' &&
				typeof out.html === 'string' &&
				source.htmlBytes === Buffer.byteLength( source.html )
			) {
				out.htmlBytes = Buffer.byteLength( out.html );
			}
			return out;
		}
		return value;
	};
	return rewrite( report ) as T;
}
