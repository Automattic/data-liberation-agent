import { IMAGE_EXTENSIONS } from '../../lib/html-extract/index.js';

// ---------------------------------------------------------------------------
// Media helpers
// ---------------------------------------------------------------------------

/**
 * Extract media URLs from Weebly content.
 * Looks for editmysite.com CDN URLs, weeblycloud.com, and standard <img> tags.
 */
export function extractWeeblyMediaUrls(html: string): string[] {
  const urls = new Set<string>();

  // Weebly CDN URLs (editmysite.com)
  const cdnPattern = /https?:\/\/[^\s"'<>)]*editmysite\.com\/[^\s"'<>)]+/g;
  const cdnMatches = html.match(cdnPattern) || [];
  for (const m of cdnMatches) urls.add(m);

  // Weebly Cloud image URLs
  const cloudPattern = /https?:\/\/[^\s"'<>)]*weeblycloud\.com\/[^\s"'<>)]+/g;
  const cloudMatches = html.match(cloudPattern) || [];
  for (const m of cloudMatches) urls.add(m);

  // Weebly uploads directory
  const uploadsPattern = /https?:\/\/[^\s"'<>)]*\/uploads\/[^\s"'<>)]+/g;
  const uploadsMatches = html.match(uploadsPattern) || [];
  for (const m of uploadsMatches) urls.add(m);

  // Standard <img> tags
  const imgSrcMatches = html.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
  for (const imgMatch of imgSrcMatches) {
    const src = imgMatch.match(/src=["']([^"']+)["']/i);
    if (src?.[1] && src[1].startsWith('http')) {
      urls.add(src[1]);
    }
  }

  // Filter to image URLs only (exclude CSS, JS, fonts, and other assets)
  const nonImageExtensions = /\.(css|js|json|xml|txt|map|woff2?|ttf|eot|pdf)$/i;
  return [...urls].filter((u) => {
    try {
      const parsed = new URL(u);
      if (nonImageExtensions.test(parsed.pathname)) return false;
      return IMAGE_EXTENSIONS.test(parsed.pathname);
    } catch {
      return false;
    }
  });
}
