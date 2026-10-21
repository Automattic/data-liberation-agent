import * as cheerio from 'cheerio';

/** Visit declared JSON-LD images and site logos; unrelated JSON strings stay intact. */
export function mapMetadataImages( data: unknown, map: ( url: string ) => string ): void {
	let visited = 0;
	const image = ( value: unknown, depth = 0 ): unknown => {
		if ( depth > 8 ) return value;
		if ( typeof value === 'string' ) return map( value );
		if ( Array.isArray( value ) ) return value.map( ( item, index ) => index < 64 ? image( item, depth + 1 ) : item );
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
		if ( node.image !== undefined ) node.image = image( node.image );
		const types = Array.isArray( node[ '@type' ] ) ? node[ '@type' ] : [ node[ '@type' ] ];
		if ( types.some( type => type === 'Organization' || type === 'WebSite' ) && node.logo !== undefined ) node.logo = image( node.logo );
		for ( const child of Object.values( node ) ) walk( child, depth + 1 );
	};
	walk( data, 0 );
}

/** Shared capture/export interpretation of inert image metadata dependencies. */
export function metadataImageReferences( html: string ): string[] {
	const urls = new Set< string >();
	const $ = cheerio.load( html );
	$( 'meta[property],meta[name]' ).each( ( _, element ) => {
		const node = $( element );
		const field = ( node.attr( 'property' ) ?? node.attr( 'name' ) ?? '' ).toLowerCase();
		if ( [ 'og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src' ].includes( field ) ) {
			const url = node.attr( 'content' );
			if ( url && urls.size < 64 ) urls.add( url );
		}
	} );
	let bytes = 0;
	$( 'script[type="application/ld+json"]' ).slice( 0, 64 ).each( ( _, element ) => {
		const text = $( element ).text();
		bytes += Buffer.byteLength( text );
		if ( bytes > 256 * 1024 ) return;
		try {
			mapMetadataImages( JSON.parse( text ), url => { if ( urls.size < 64 ) urls.add( url ); return url; } );
		} catch { /* Invalid optional metadata is not a render dependency. */ }
	} );
	return [ ...urls ];
}
