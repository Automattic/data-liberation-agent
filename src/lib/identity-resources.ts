import * as cheerio from 'cheerio';

/** Visit explicitly declared site-logo fields; unrelated JSON strings stay intact. */
export function mapIdentityLogos( data: unknown, map: ( url: string ) => string ): void {
	let visited = 0;
	const image = ( value: unknown ): unknown => {
		if ( typeof value === 'string' ) return map( value );
		if ( Array.isArray( value ) ) return value.map( ( item, index ) => index < 64 ? image( item ) : item );
		if ( value && typeof value === 'object' ) {
			const record = value as Record< string, unknown >;
			for ( const key of [ 'url', 'contentUrl' ] ) {
				if ( typeof record[ key ] === 'string' ) record[ key ] = map( record[ key ] as string );
			}
		}
		return value;
	};
	const walk = ( value: unknown, depth: number ): void => {
		if ( depth > 8 || visited++ >= 512 ) return;
		if ( Array.isArray( value ) ) { for ( const child of value ) walk( child, depth + 1 ); return; }
		if ( ! value || typeof value !== 'object' ) return;
		const node = value as Record< string, unknown >;
		const types = Array.isArray( node[ '@type' ] ) ? node[ '@type' ] : [ node[ '@type' ] ];
		if ( types.some( type => type === 'Organization' || type === 'WebSite' ) && node.logo !== undefined ) node.logo = image( node.logo );
		for ( const child of Object.values( node ) ) walk( child, depth + 1 );
	};
	walk( data, 0 );
}

/** Shared capture/export interpretation of inert standard JSON-LD dependencies. */
export function identityLogoReferences( html: string ): string[] {
	const urls = new Set< string >();
	const $ = cheerio.load( html );
	let bytes = 0;
	$( 'script[type="application/ld+json"]' ).slice( 0, 64 ).each( ( _, element ) => {
		const text = $( element ).text();
		bytes += Buffer.byteLength( text );
		if ( bytes > 256 * 1024 ) return;
		try {
			mapIdentityLogos( JSON.parse( text ), url => { if ( urls.size < 64 ) urls.add( url ); return url; } );
		} catch { /* Invalid optional metadata is not a render dependency. */ }
	} );
	return [ ...urls ];
}
