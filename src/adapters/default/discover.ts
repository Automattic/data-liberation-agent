import { fetchSitemapWithDiagnostics, classifyUrl, extractSameOriginLinks, resolvePageLink } from '../../lib/extraction/sitemap.js';
import { documentRequestUrl } from '../../lib/url/route-key.js';
import { extractMeta, extractTitle, extractNavLinks } from '../../lib/html-extract/index.js';
import { sourceContextOptions, getPlaywright } from '../../lib/browser-kit/browser-kit.js';
import type { InventoryUrl } from '../shared.js';
import type { DefaultInventory } from './types.js';

const UA = 'Mozilla/5.0 (compatible; DataLiberation/1.0)';

/**
 * Discovery for the platform-agnostic fallback adapter. Mirrors the webflow
 * adapter: homepage metadata + sitemap + bounded linked-page fallback when
 * the sitemap is absent/thin, plus raw/rendered entry links. Capture expands
 * the bounded rendered linked frontier, keeping adapter discovery as its seed.
 */
export async function discoverDefault(url: string, _opts: Record<string, unknown>): Promise<DefaultInventory> {
  const normalized = url.includes('://') ? url : `https://${url}`;

  let homepageHtml = '';
  try {
    const resp = await fetch(normalized, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': UA },
    });
    if (resp.ok) homepageHtml = await resp.text();
    else await resp.body?.cancel();
  } catch {
    // Network error — continue with empty HTML.
  }

  const ogTitle = extractMeta(homepageHtml, 'og:title');
  const ogDescription = extractMeta(homepageHtml, 'og:description');
  const siteTitle = ogTitle || extractTitle(homepageHtml) || 'Imported Site';
  const siteTagline = ogDescription || extractMeta(homepageHtml, 'description') || '';

  const langMatch = homepageHtml.match(/<html[^>]+lang=["']([^"']+)["']/i);
  const siteLanguage = langMatch?.[1] || 'en-US';

  const sitemap = await fetchSitemapWithDiagnostics(url);
  const sitemapUrls = sitemap.urls;
  let navigation = extractNavLinks(homepageHtml, normalized);
  let renderedUrls: string[] = [];

  // Single-page apps commonly serve an empty shell to both the homepage and
  // sitemap.xml. Render their primary navigation before falling back to one route.
  if (sitemapUrls.length < 5) {
    try {
      const pw = await getPlaywright();
      const browser = await pw.chromium.launch({ headless: true });
      try {
        const page = await browser.newPage(await sourceContextOptions(browser, normalized));
        await page.goto(normalized, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        const renderedNavigation = extractNavLinks(await page.content(), page.url());
        if (renderedNavigation.length > 0) navigation = renderedNavigation;
        renderedUrls = await page.locator('a[href],area[href]').evaluateAll(
          (links) => links.map((link) => (link as HTMLAnchorElement).href)
        );
      } finally {
        await browser.close();
      }
    } catch {
      // Browser discovery is supplemental; retain sitemap and raw HTML results.
    }
  }

  const counts: Record<string, number> = {};
  const inventoryUrls: InventoryUrl[] = [];
  const discoveredUrls = new Set(sitemapUrls);
  const knownRoutes = new Set(sitemapUrls.map(documentRequestUrl));
  const origin = new URL(normalized).origin;
  // A sitemap is not a complete route list: builders routinely omit legal and
  // CTA pages that are linked only from site chrome, which may be a plain
  // `div` rather than a <footer>. Merge the homepage's own same-origin links
  // whatever the sitemap's size. Retain exact slash and query addresses until
  // source navigation proves an alias; normalization is not that evidence.
  for (const href of [
    ...navigation.map((link) => link.href),
    ...renderedUrls,
    ...extractSameOriginLinks(homepageHtml, normalized),
  ]) {
    const pageUrl = resolvePageLink(href, normalized, origin);
    if (!pageUrl) continue;
    const key = documentRequestUrl(pageUrl);
    if (knownRoutes.has(key)) continue;
    knownRoutes.add(key);
    discoveredUrls.add(pageUrl);
  }
  for (const u of discoveredUrls) {
    const type = classifyUrl(u);
    inventoryUrls.push({ url: u, type });
    counts[type] = (counts[type] || 0) + 1;
  }

  if (inventoryUrls.length === 0) {
    inventoryUrls.push({ url: normalized, type: 'homepage' });
    counts['homepage'] = 1;
  }

  return {
    siteUrl: url,
    discoveredAt: new Date().toISOString(),
    siteMeta: {
      title: siteTitle,
      tagline: siteTagline,
      language: siteLanguage,
    },
    navigation,
    counts,
    urls: inventoryUrls,
    diagnostics: sitemap.diagnostics,
  };
}
