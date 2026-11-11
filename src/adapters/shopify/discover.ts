import { sourceFetch as fetch } from '../../lib/media-fetch/capture-requests.js';
import { SOURCE_USER_AGENT } from '../../lib/browser-kit/source-identity.js';
import { fetchSitemapWithDiagnostics, classifyUrl } from '../../lib/extraction/sitemap.js';
import { extractNavLinks } from '../../lib/html-extract/index.js';
import { extractSiteMetadata } from '../site-metadata.js';
import type { InventoryUrl } from '../shared.js';
import type { ShopifyInventory, ShopifyPage, ShopifyBlog, ShopifyArticle } from './types.js';
import { fetchShopifyPaginated } from './http.js';
import { extractShopDomain } from './content.js';

export async function discover(url: string, _opts: Record<string, unknown>): Promise<ShopifyInventory> {
  const normalized = url.includes('://') ? url : `https://${url}`;
  const origin = new URL(normalized).origin;

  // 1. Try JSON API — check if pages.json is accessible
  let jsonApiAvailable = false;
  const jsonPages = await fetchShopifyPaginated<ShopifyPage>(`${origin}/pages.json`, 'pages');
  if (jsonPages.length > 0) {
    jsonApiAvailable = true;
  }

  // 2. Fetch homepage HTML for metadata
  let homepageHtml = '';
  try {
    const resp = await fetch(normalized, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': SOURCE_USER_AGENT },
    });
    if (resp.ok) {
      homepageHtml = await resp.text();
    } else {
      await resp.body?.cancel();
    }
  } catch {
    // Network error
  }

  // Extract site metadata
  const siteMetadata = extractSiteMetadata(homepageHtml);
  const langMatch = homepageHtml.match(/<html[^>]+lang=["']([^"']+)["']/i);
  const siteLanguage = langMatch?.[1] || 'en-US';

  // Extract navigation
  const navigation = extractNavLinks(homepageHtml, origin);

  // 3. Collect URLs from JSON API if available
  const inventoryUrls: InventoryUrl[] = [];
  const counts: Record<string, number> = {};

  if (jsonApiAvailable) {
    // Add pages from JSON API
    for (const page of jsonPages) {
      const pageUrl = `${origin}/pages/${page.handle}`;
      inventoryUrls.push({ url: pageUrl, type: 'page' });
      counts['page'] = (counts['page'] || 0) + 1;
    }

    // Discover blogs and articles
    const blogs = await fetchShopifyPaginated<ShopifyBlog>(`${origin}/blogs.json`, 'blogs');
    for (const blog of blogs) {
      const articles = await fetchShopifyPaginated<ShopifyArticle>(
        `${origin}/blogs/${blog.handle}/articles.json`,
        'articles'
      );
      for (const article of articles) {
        const articleUrl = `${origin}/blogs/${blog.handle}/${article.handle}`;
        inventoryUrls.push({ url: articleUrl, type: 'post' });
        counts['post'] = (counts['post'] || 0) + 1;
      }
    }
  }

  // 4. Fetch sitemap (Shopify sitemaps are index files with sub-sitemaps)
  const sitemap = await fetchSitemapWithDiagnostics(normalized);
  const sitemapUrls = sitemap.urls;
  for (const u of sitemapUrls) {
    // Skip if already found via JSON API
    if (inventoryUrls.some((inv) => inv.url === u)) continue;
    const type = classifyUrl(u);
    inventoryUrls.push({ url: u, type });
    counts[type] = (counts[type] || 0) + 1;
  }

  // 4b. Primary-nav targets that aren't otherwise discoverable.
  // Replo/Shopify landing pages linked from the header (e.g.
  // /pages/sleep-bundle) are sometimes NOT listed in /pages.json or the
  // sitemap, so they never enter the inventory and the reconstructed menu
  // would point at an uncaptured page. Add every same-origin primary-nav
  // href as an inventory URL so it is always a capture candidate (and gets
  // pinned into a --limit slice by runExtractionLoop). Off-site nav links are
  // skipped — they stay external in the header.
  for (const navLink of navigation) {
    let navUrl: URL;
    try {
      navUrl = new URL(navLink.href);
    } catch {
      continue;
    }
    if (navUrl.origin !== origin) continue;
    const clean = `${navUrl.origin}${navUrl.pathname.replace(/\/+$/, '')}`;
    if (clean === origin || clean === `${origin}/`) continue; // homepage
    if (inventoryUrls.some((inv) => inv.url === clean || inv.url === navLink.href)) continue;
    const type = classifyUrl(clean);
    inventoryUrls.push({ url: clean, type });
    counts[type] = (counts[type] || 0) + 1;
  }

  // If we still have nothing, add the homepage
  if (inventoryUrls.length === 0) {
    inventoryUrls.push({ url: normalized, type: 'homepage' });
    counts['homepage'] = 1;
  }

  // Auto-detect the *.myshopify.com admin hostname from the storefront
  // HTML. Works regardless of whether the site is served on a custom
  // domain, so callers can supply `adminToken` without also computing
  // `shopDomain` themselves. Falls back to the URL hostname only when
  // the URL already points at myshopify.com.
  let shopDomain = extractShopDomain(homepageHtml);
  if (!shopDomain) {
    const host = new URL(normalized).hostname;
    if (host.endsWith('.myshopify.com')) shopDomain = host;
  }

  return {
    siteUrl: url,
    discoveredAt: new Date().toISOString(),
    shopDomain,
    siteMeta: {
      ...siteMetadata,
      language: siteLanguage,
    },
    navigation,
    counts,
    urls: inventoryUrls,
    diagnostics: sitemap.diagnostics,
    jsonApiAvailable,
  };
}
