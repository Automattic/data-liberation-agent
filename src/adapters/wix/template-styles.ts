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
// template layout still diverges), keeps authored blocks in document order,
// drops the per-item viewer-widget chunk blocks, and hashes the page's CSS
// mapper bundles as a marker-stripped sorted multiset: the runtime emits the
// same bundles in a different order between requests.
import type { TemplateStyleBlock, TemplateStyleNormalization } from '../../lib/template-groups.js';

/** The generation-marker comment Wix's page CSS mapper embeds (or not) per request. */
const VSM_MARKER = /\/\*\*\*\s*VSM_CSS\s*\*\*\*\//g;

/** A page's CSS-mapper bundle: the page template's real layout CSS. */
const isPageMapper = ( style: TemplateStyleBlock ): boolean => /^(css|stylableCss|compCssMappers)_/.test( style.id ?? '' );

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
		const notViewerChunk = styles.filter( style => ! isItemViewerChunk( style ) );
		// Authored template style blocks keep their document order; the mapper
		// bundles ship as a sorted multiset, because requests reorder them.
		const authored = notViewerChunk.filter( style => ! isPageMapper( style ) ).map( style => withoutMarker( style.text ) );
		const mappers = notViewerChunk.filter( isPageMapper ).map( style => withoutMarker( style.text ).trim() ).sort();
		const joined = [ ...authored, ...mappers ].join( '\n' );
		return joined.trim() ? joined : null;
	},
};
