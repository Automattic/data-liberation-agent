// src/adapters/wix/template-styles.ts
//
// Wix-owned aggregation of a page's inline `<style>` blocks for template
// grouping (#836). Wix's Thunderbolt runtime writes page-local CSS that is
// generated per request or per item, so the attribute-level `<style>` text a
// generic fingerprint compares splits routes that share one template:
//
// - `<style rel="stylesheet" data-href="…/services/<tpa>-ooi/…">` blocks are
//   the inlined chunks of a TPA widget (the blog post body, a challenge).
//   Their composition and minified class names are regenerated per item, so
//   the same template's items ship different text.
// - The page's CSS-mapper bundles (`css_masterPage`, `css_<pageId>`,
//   `stylableCss_<pageId>`, `compCssMappers_<pageId>`) hold the page
//   template's real layout CSS — the evidence that must keep templates
//   apart — but carry a `/*** VSM_CSS ***/` generation-marker comment whose
//   presence depends on how the page mapper ran, and their placement in the
//   document changes between requests.
//
// The aggregation keeps every block's text (so any CSS that changes the
// template layout still diverges) and drops only the request-dependent marker
// and block order, plus the per-item viewer-widget chunk blocks.
import type { TemplateStyleBlock, TemplateStyleNormalization } from '../../lib/template-groups.js';

/** The generation-marker comment Wix's page CSS mapper embeds (or not) per request. */
const VSM_MARKER = /\/\*\*\*\s*VSM_CSS\s*\*\*\*\//g;

/**
 * A TPA viewer-widget chunk inlined for the item the page renders. Its
 * `data-href` points at the platform/TPA service; per-item generation shows as
 * differing chunk ids and minified class names for the same template.
 */
const isItemViewerChunk = ( style: TemplateStyleBlock ): boolean => {
	const dataHref = style.attributes[ 'data-href' ];
	return typeof dataHref === 'string' && /\/services\/[^/]*-ooi\//.test( dataHref );
};

const withoutMarker = ( text: string ): string => text.replace( VSM_MARKER, '' );

export const templateStyleNormalization: TemplateStyleNormalization = {
	pageStyles( styles ) {
		const texts = styles
			.filter( style => ! isItemViewerChunk( style ) )
			.map( style => withoutMarker( style.text ) );
		const joined = texts.join( '\n' );
		return joined.trim() ? joined : null;
	},
};
