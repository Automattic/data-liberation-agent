/** Bounded, observed challenge headers; response bodies and session headers stay private. */
export function rejectedNavigationReason( status: number, headers: Record< string, string > = {} ): string {
	const privateHeaders = new Set( [ 'authorization', 'proxy-authorization', 'cookie', 'set-cookie' ] );
	const challenge = Object.entries( headers )
		.filter( ( [ name, value ] ) => ! privateHeaders.has( name.toLowerCase() ) &&
			/(?:^|[^a-z])challenge(?:[^a-z]|$)/i.test( `${ name } ${ value }` ) )
		.sort( ( [ left ], [ right ] ) => left.localeCompare( right ) )
		.slice( 0, 4 )
		.map( ( [ name, value ] ) => `${ name.slice( 0, 64 ) }=${ value.replace( /\s+/g, ' ' ).trim().slice( 0, 128 ) }` );
	return `HTTP ${ status }${ challenge.length ? `; challenge: ${ challenge.join( ', ' ) }` : '' }`;
}
