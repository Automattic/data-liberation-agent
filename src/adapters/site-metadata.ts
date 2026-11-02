import { extractMeta, extractTitle } from '../lib/html-extract/index.js';

/** A platform's own record of the site (an API field, a known document-title
 * format) names the site first; then its declared `og:site_name`, then the
 * homepage share and document titles. */
export function extractSiteMetadata(
  html: string,
  platform: { title?: string; tagline?: string } = {},
): { title: string; tagline: string } {
  return {
    title: platform.title?.trim() || extractMeta(html, 'og:site_name') || extractMeta(html, 'og:title') ||
      extractTitle(html) || 'Imported Site',
    tagline: platform.tagline?.trim() || extractMeta(html, 'og:description') || extractMeta(html, 'description') || '',
  };
}
