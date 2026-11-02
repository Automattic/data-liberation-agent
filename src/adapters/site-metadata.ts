import { extractMeta, extractTitle } from '../lib/html-extract/index.js';

/** Site identity comes before the homepage's share title. Platform-specific
 * document-title normalization must not alter an explicitly declared OG name. */
export function extractSiteMetadata(
  html: string,
  documentTitle: (title: string) => string = (title) => title,
): { title: string; tagline: string } {
  return {
    title: extractMeta(html, 'og:site_name') || extractMeta(html, 'og:title') ||
      documentTitle(extractTitle(html)) || 'Imported Site',
    tagline: extractMeta(html, 'og:description') || extractMeta(html, 'description') || '',
  };
}
