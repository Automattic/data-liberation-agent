// src/adapters/wix/capture.ts
//
// Wix-specific capture knowledge. None of this belongs in the shared capture
// path: recognising a platform's CDN is exactly what an adapter is for.
//
import type { AdapterCapture } from '../page-actions.js';

/** Wix media ids look like `8e80e7_a1b2…`, stable across crops of one asset. */
const WIX_MEDIA_ID = /([a-z0-9]{4,12}_[a-z0-9]{24,48})/i;
/** Only `/fill/w_,h_` URLs are the runtime-swapped per-viewport crops. */
const WIX_FILL_VARIANT = /static\.wixstatic\.com\/.+\/fill\/w_\d+,h_\d+/;

/**
 * Recognise a Wix responsive image variant, returning its stable media id and
 * the variant URL.
 *
 * Pure, so the URL shape this depends on is testable without a browser.
 */
export function wixMediaVariant( url: string ): { id: string; url: string } | null {
	if ( ! WIX_FILL_VARIANT.test( url ) ) return null;
	const match = WIX_MEDIA_ID.exec( url );
	return match ? { id: match[ 1 ]!.toLowerCase(), url } : null;
}

export const capture: AdapterCapture = {
	/**
	 * At narrow viewports Wix's `<wow-image>` runtime swaps each image for a
	 * mobile-cropped CDN variant. Recording {media id → variant URL} lets the
	 * export serve that crop via `<picture>` with no JavaScript.
	 */
	async responsiveImages( page ) {
		// The browser step stays generic — read the URLs the runtime settled on.
		// Deciding which are Wix variants happens here, where it can be tested.
		const urls = await page.evaluate( () =>
			[ ...document.querySelectorAll( 'img' ) ].map(
				( image ) => ( image as HTMLImageElement ).currentSrc || ( image as HTMLImageElement ).src || ''
			)
		);
		const variants: Record< string, string > = {};
		for ( const url of urls ) {
			const variant = wixMediaVariant( url );
			if ( variant ) variants[ variant.id ] = variant.url;
		}
		return variants;
	},
};
