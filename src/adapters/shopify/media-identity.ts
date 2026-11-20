import { MAX_PORTABLE_MEDIA_DIMENSION } from '../../lib/portable-media-limits.js';

// One uploaded file is served under two host aliases:
//   https://cdn.shopify.com/s/files/1/<shop id>/files/X?v=…   (catalog JSON)
//   https://<store>/cdn/shop/files/X?v=…&width=…              (theme markup)
const IMAGE = '(?:files|products|collections)\\/[^?#]+\\.(?:avif|gif|jpe?g|png|svg|webp)';
const STORE_FILE = new RegExp( `^\\/cdn\\/shop\\/(${ IMAGE })$`, 'i' );
const CDN_FILE = new RegExp( `^\\/s\\/files\\/1\\/(?:\\d+\\/)+(${ IMAGE })$`, 'i' );
/** `v` is a cache key and `width` a resize; neither selects a different picture. Crops and pads do. */
const SIZING_PARAMS = new Set( [ 'v', 'width' ] );

/**
 * A catalog image under the store's own `/cdn/shop/` alias, so catalog rows and
 * theme markup name one file. Other URLs are returned unchanged.
 */
export function shopifyStoreFileUrl( value: string, storeOrigin: string ): string {
	try {
		const url = new URL( value );
		const path = url.hostname === 'cdn.shopify.com' ? CDN_FILE.exec( url.pathname )?.[ 1 ] : undefined;
		if ( ! path ) return value;
		const store = new URL( `/cdn/shop/${ path }`, storeOrigin );
		store.search = url.search;
		return store.href;
	} catch {
		return value;
	}
}

/**
 * One fetch identity per Shopify image file: every `width`/`v` rendition resolves
 * to the file at the shared portable dimension ceiling (the CDN never upscales),
 * so a page's srcset widths and a catalog row share one download.
 */
export function shopifyImageOriginal( value: string ): string | undefined {
	const url = new URL( value );
	const file = url.hostname === 'cdn.shopify.com' ? CDN_FILE.test( url.pathname ) : STORE_FILE.test( url.pathname );
	if ( ! file || [ ...url.searchParams.keys() ].some( key => ! SIZING_PARAMS.has( key ) ) ) return undefined;
	const original = new URL( `${ url.origin }${ url.pathname }` );
	original.searchParams.set( 'width', String( MAX_PORTABLE_MEDIA_DIMENSION ) );
	return original.href === url.href ? undefined : original.href;
}
