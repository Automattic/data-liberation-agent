/** Cloudflare's block page: these markers stay the same when its text is translated. */
function isCloudflareBlockPage( body: string ): boolean {
	return body.includes( 'id="cf-error-details"' ) && body.includes( 'data-translate="block_headline"' );
}

/**
 * Bounded, observed challenge headers and a fixed block-page label; response
 * bodies and session headers stay private.
 */
export function rejectedNavigationReason( status: number, headers: Record< string, string > = {}, body = '' ): string {
	const privateHeaders = new Set( [ 'authorization', 'proxy-authorization', 'cookie', 'set-cookie' ] );
	const challenge = Object.entries( headers )
		.filter( ( [ name, value ] ) => ! privateHeaders.has( name.toLowerCase() ) &&
			/(?:^|[^a-z])challenge(?:[^a-z]|$)/i.test( `${ name } ${ value }` ) )
		.sort( ( [ left ], [ right ] ) => left.localeCompare( right ) )
		.slice( 0, 4 )
		.map( ( [ name, value ] ) => `${ name.slice( 0, 64 ) }=${ value.replace( /\s+/g, ' ' ).trim().slice( 0, 128 ) }` );
	const blocked = isCloudflareBlockPage( body ) ? '; blocked: cloudflare' : '';
	return `HTTP ${ status }${ blocked }${ challenge.length ? `; challenge: ${ challenge.join( ', ' ) }` : '' }`;
}

/** Whether a recorded rejection shows the source's security service refused the request. */
export function isSecurityServiceRejection( reason: string ): boolean {
	return /; (?:blocked|challenge): /.test( reason );
}
