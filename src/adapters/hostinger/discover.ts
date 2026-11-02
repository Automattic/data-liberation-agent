import { SOURCE_USER_AGENT } from '../../lib/browser-kit/source-identity.js';
import { fetchSitemapWithDiagnostics, classifyUrl } from '../../lib/extraction/sitemap.js';
import { extractNavLinks } from '../../lib/html-extract/index.js';
import { extractSiteMetadata } from '../site-metadata.js';
import type { InventoryUrl } from '../shared.js';
import type { HostingerInventory } from './types.js';

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

export async function discover(url: string, _opts: Record<string, unknown>): Promise<HostingerInventory> {
  // 1. Fetch homepage HTML
  let homepageHtml = '';
  try {
    const normalized = url.includes('://') ? url : `https://${url}`;
    const resp = await fetch(normalized, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': SOURCE_USER_AGENT,
      },
    });
    if (resp.ok) {
      homepageHtml = await resp.text();
    } else {
      await resp.body?.cancel();
    }
  } catch {
    // Network error — continue with empty HTML
  }

  // 2. Extract site metadata
  const siteMetadata = extractSiteMetadata(homepageHtml);

  // Detect language from <html lang="..."> — important for non-English sites
  const langMatch = homepageHtml.match(/<html[^>]+lang=["']([^"']+)["']/i);
  const siteLanguage = langMatch?.[1] || 'en-US';

  // 3. Fetch sitemap
  const sitemap = await fetchSitemapWithDiagnostics(url);
  const sitemapUrls = sitemap.urls;

  // 4. Extract navigation from homepage
  const normalized = url.includes('://') ? url : `https://${url}`;
  const navigation = extractNavLinks(homepageHtml, normalized);

  // 5. Classify URLs — posts detected by /blog-post or /blog/ path segments
  const counts: Record<string, number> = {};
  const inventoryUrls: InventoryUrl[] = [];

  for (const u of sitemapUrls) {
    let type = classifyUrl(u);
    // Hostinger convention: /blog-post* and /blog/* are blog posts
    if (type === 'page' && /\/blog-post|\/blog\//.test(u)) {
      type = 'post';
    }
    inventoryUrls.push({ url: u, type });
    counts[type] = (counts[type] || 0) + 1;
  }

  // If sitemap was empty, add the homepage
  if (inventoryUrls.length === 0) {
    inventoryUrls.push({ url: normalized, type: 'homepage' });
    counts['homepage'] = 1;
  }

  return {
    siteUrl: url,
    discoveredAt: new Date().toISOString(),
    siteMeta: {
      ...siteMetadata,
      language: siteLanguage,
    },
    navigation,
    counts,
    urls: inventoryUrls,
    diagnostics: sitemap.diagnostics,
  };
}
