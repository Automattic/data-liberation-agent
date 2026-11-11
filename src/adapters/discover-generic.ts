import { fetchSitemapWithDiagnostics, extractSameOriginLinks, resolvePageLink, normalizeDiscoveredRoutes, type SitemapDiagnostic } from '../lib/extraction/sitemap.js';
import { extractNavLinks } from '../lib/html-extract/index.js';
import { extractSiteMetadata } from './site-metadata.js';
import { createSourcePage, sourceContextOptions, launchChromium } from '../lib/browser-kit/browser-kit.js';
import { SOURCE_USER_AGENT } from '../lib/browser-kit/source-identity.js';
import { sourceFetch } from '../lib/media-fetch/capture-requests.js';
import { decodeHtml } from '../lib/decode-html.js';

/** The discovery fields consumed by capture (including CLI/MCP) and inspection. */
export interface DiscoveryInventory {
  siteMeta: { title: string };
  urls: Array<{ url: string }>;
  diagnostics?: SitemapDiagnostic[];
}

export interface GenericDiscoveryOptions {
  extraSitemaps?: readonly string[];
  seeds?: (html: string) => string[];
}

/** Sitemap discovery plus raw entry links and a supplemental rendered SPA pass. */
export async function discoverGeneric(
  url: string,
  opts: Record<string, unknown>,
  { extraSitemaps, seeds }: GenericDiscoveryOptions = {},
): Promise<DiscoveryInventory> {
  const normalized = url.includes('://') ? url : `https://${url}`;
  // Capture supplies the entry document it already fetched, even when empty.
  let homepageHtml = typeof opts.entryHtml === 'string' ? opts.entryHtml : '';
  if (typeof opts.entryHtml !== 'string') try {
    const resp = await sourceFetch(normalized, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': SOURCE_USER_AGENT },
    });
    if (resp.ok) homepageHtml = decodeHtml(new Uint8Array(await resp.arrayBuffer()), resp.headers.get('content-type') ?? '', { fatal: false });
    else await resp.body?.cancel();
  } catch {
    // Network error — retain sitemap and supplemental browser results.
  }

  const sitemap = await fetchSitemapWithDiagnostics(normalized, {
    extraSitemaps,
    // Reuse the entry document so feed autodiscovery and the coverage crawl do not refetch it.
    entryHtml: typeof opts.entryHtml === 'string' || homepageHtml ? homepageHtml : undefined,
  });
  let navigation = extractNavLinks(homepageHtml, normalized);
  let renderedUrls: string[] = [];
  if (sitemap.urls.length < 5) {
    try {
      const browser = await launchChromium();
      try {
        const page = await createSourcePage(browser, await sourceContextOptions(browser, normalized));
        await page.goto(normalized, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        const renderedNavigation = extractNavLinks(await page.content(), page.url());
        if (renderedNavigation.length > 0) navigation = renderedNavigation;
        renderedUrls = await page.locator('a[href],area[href]').evaluateAll(
          (links) => links.map((link) => (link as HTMLAnchorElement).href),
        );
      } finally {
        await browser.close();
      }
    } catch {
      // Browser discovery is supplemental; retain sitemap and raw HTML results.
    }
  }

  const discoveredUrls = new Set(sitemap.urls);
  const origin = new URL(normalized).origin;
  // Sitemaps often omit legal and CTA pages; merge entry links at every size.
  for (const href of [
    ...navigation.map((link) => link.href),
    ...renderedUrls,
    ...extractSameOriginLinks(homepageHtml, normalized),
    ...(seeds?.(homepageHtml) ?? []),
  ]) {
    const pageUrl = resolvePageLink(href, normalized, origin);
    if (pageUrl) discoveredUrls.add(pageUrl);
  }
  const urls = (await normalizeDiscoveredRoutes([...discoveredUrls])).map(url => ({ url }));
  if (urls.length === 0) urls.push({ url: normalized });
  return {
    siteMeta: { title: extractSiteMetadata(homepageHtml).title },
    urls,
    diagnostics: sitemap.diagnostics,
  };
}
