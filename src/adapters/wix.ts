import type { PlatformAdapter } from '../types.js';
import type { WxrBuilder } from '../lib/extraction/wxr-builder.js';
import type { ExtractionLog } from '../lib/extraction/extraction-log.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { classifyUrl, parseSitemapXml } from '../lib/extraction/sitemap.js';
import {
  slugify,
  launchBrowser,
  getPlaywright,
  runExtractionLoop,
  IMAGE_EXTENSIONS,
} from './shared.js';
import type { InventoryUrl, NavLink } from './shared.js';
import { WooProductCsvBuilder } from '../lib/import/woo-product-csv.js';
import type { WooProduct } from '../lib/import/woo-product-csv.js';

// Re-export shared types so existing consumers still work
export type { InventoryUrl, NavLink };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WixAdapterOpts extends Record<string, unknown> {
  cdpPort?: number;
  token?: string;
  delay?: number;
  resume?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  outputDir?: string;
  limit?: number;
}

export interface Inventory {
  siteUrl: string;
  discoveredAt: string;
  siteMeta: {
    title: string;
    tagline: string;
    language: string;
  };
  navigation: NavLink[];
  counts: Record<string, number>;
  urls: InventoryUrl[];
}

export interface CapturedApiCall {
  url: string;
  data: unknown;
}

export interface PageMeta {
  title: string;
  description: string;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  canonical: string;
}

export interface PageData {
  sourceUrl: string;
  slug: string;
  extractedAt: string;
  apiCalls: CapturedApiCall[];
  globals: Record<string, unknown>;
  jsonLd: unknown[];
  meta: PageMeta;
  accessibility: Array<{ role: string; name: string; description?: string }> | null;
  mediaUrls: string[];
  content: string;
  qualityScore: 'high' | 'medium' | 'low';
}

// ---------------------------------------------------------------------------
// Helpers (module-level, not exported)
// ---------------------------------------------------------------------------

/** Extract image URLs from all captured page data sources. */
function extractImageUrls(data: {
  apiCalls: CapturedApiCall[];
  globals: Record<string, unknown>;
  jsonLd: unknown[];
  meta: PageMeta;
  accessibility: Array<{ role: string; name: string }> | null;
  pageHtml?: string;
}): string[] {
  const urls = new Set<string>();

  // Scan all captured data as JSON for wixstatic/wixmp URLs
  const allDataStr = JSON.stringify({ apiCalls: data.apiCalls, globals: data.globals, jsonLd: data.jsonLd });
  const wixMatches = allDataStr.match(/https?:\/\/[^"'\s]*(?:wixstatic\.com|wixmp\.com)[^"'\s]*/g) || [];
  for (const url of wixMatches) {
    urls.add(url);
  }

  // JSON-LD image fields
  for (const ld of data.jsonLd) {
    const obj = ld as Record<string, unknown>;
    if (typeof obj.image === 'string') urls.add(obj.image);
    if (Array.isArray(obj.image)) {
      for (const img of obj.image) {
        if (typeof img === 'string') urls.add(img);
        if (typeof img === 'object' && img && typeof (img as Record<string, unknown>).url === 'string') {
          urls.add((img as Record<string, unknown>).url as string);
        }
      }
    }
    if (typeof obj.thumbnailUrl === 'string') urls.add(obj.thumbnailUrl);
  }

  // OG image
  if (data.meta.ogImage) urls.add(data.meta.ogImage);

  // Scan page HTML for <img> src attributes
  if (data.pageHtml) {
    const imgSrcMatches = data.pageHtml.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
    for (const match of imgSrcMatches) {
      const src = match.match(/src=["']([^"']+)["']/i);
      if (src?.[1] && src[1].startsWith('http')) {
        urls.add(src[1]);
      }
    }
    // Also background images in style attributes
    const bgMatches = data.pageHtml.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/gi) || [];
    for (const match of bgMatches) {
      const bgUrl = match.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
      if (bgUrl?.[1]) urls.add(bgUrl[1]);
    }
  }

  // Filter: only keep URLs that look like images
  const imageExtensions = IMAGE_EXTENSIONS;
  const imageCdns = /wixstatic\.com|wixmp\.com|images\.unsplash\.com|cdn\.shopify\.com/i;
  return [...urls].filter((u) => {
    try {
      const parsed = new URL(u);
      return imageExtensions.test(parsed.pathname) || imageCdns.test(parsed.hostname);
    } catch {
      return false;
    }
  });
}

/** Walk a JSON value tree looking for HTML content in known field names. */
function findHtmlContent(value: unknown, depth = 0): string | null {
  if (depth > 8 || value == null) return null;
  if (typeof value === 'string') return null;
  if (typeof value !== 'object') return null;

  const obj = value as Record<string, unknown>;
  const contentKeys = ['html', 'richText', 'body', 'content', 'text', 'plainText'];

  for (const key of contentKeys) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 50 && v.includes('<')) {
      return v;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findHtmlContent(item, depth + 1);
      if (found) return found;
    }
  } else {
    for (const child of Object.values(obj)) {
      const found = findHtmlContent(child, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Determine the best content string from the extracted page data.
 */
function deriveContent(pageData: {
  apiCalls: CapturedApiCall[];
  jsonLd: unknown[];
  renderedContent: string | null;
  accessibility: Array<{ role: string; name: string }> | null;
  meta: PageMeta;
}): { content: string; qualityScore: 'high' | 'medium' | 'low' } {
  // 1. Try API calls — walk the JSON tree for HTML content fields
  // Skip non-content API endpoints (tag manager, access tokens) whose responses
  // contain <script> blocks in fields named "content"/"html" that match
  // findHtmlContent but produce empty strings after script/style stripping.
  for (const call of pageData.apiCalls) {
    const htmlContent = findHtmlContent(call.data);
    if (htmlContent && htmlContent.length > 50) {
      // Verify the match has real text content after stripping script/style tags
      const stripped = htmlContent
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .trim();
      if (stripped.length > 50 && /<[a-z][\s\S]*>/i.test(stripped)) {
        return { content: htmlContent, qualityScore: 'high' };
      }
    }
  }

  // 2. Rendered DOM content
  if (pageData.renderedContent && pageData.renderedContent.length > 30) {
    return { content: pageData.renderedContent, qualityScore: 'high' };
  }

  // 3. Try JSON-LD
  for (const ld of pageData.jsonLd) {
    const obj = ld as Record<string, unknown>;
    if (typeof obj.articleBody === 'string' && obj.articleBody.length > 50) {
      return { content: `<p>${obj.articleBody}</p>`, qualityScore: 'medium' };
    }
    if (typeof obj.description === 'string' && obj.description.length > 50) {
      return { content: `<p>${obj.description}</p>`, qualityScore: 'medium' };
    }
  }

  // 4. Accessibility tree fallback
  if (pageData.accessibility && pageData.accessibility.length > 0) {
    const parts: string[] = [];
    for (const node of pageData.accessibility) {
      if (node.role === 'heading') {
        parts.push(`<h2>${node.name}</h2>`);
      } else if (node.name) {
        parts.push(`<p>${node.name}</p>`);
      }
    }
    if (parts.length > 0) {
      return { content: parts.join('\n'), qualityScore: 'low' };
    }
  }

  // 5. Nothing found
  return { content: '', qualityScore: 'low' };
}

// ---------------------------------------------------------------------------
// extractPage — loads a single URL in Playwright, intercepts API calls
// ---------------------------------------------------------------------------

async function extractWixPage(
  page: unknown,
  url: string
): Promise<PageData> {
  const p = page as {
    on(event: string, handler: (resp: unknown) => void): void;
    off(event: string, handler: (resp: unknown) => void): void;
    goto(url: string, opts: Record<string, unknown>): Promise<unknown>;
    evaluate(fn: () => unknown): Promise<unknown>;
    content(): Promise<string>;
    context(): {
      newCDPSession(page: unknown): Promise<{
        send(method: string, params: Record<string, unknown>): Promise<unknown>;
        detach(): Promise<void>;
      }>;
    };
  };

  const captured: {
    apiCalls: CapturedApiCall[];
  } = { apiCalls: [] };

  const responseHandler = async (response: unknown) => {
    const resp = response as {
      url(): string;
      headers(): Record<string, string>;
      json(): Promise<unknown>;
    };
    const respUrl = resp.url();
    const ct = resp.headers()['content-type'] || '';
    if (!ct.includes('application/json')) return;

    const isWixApi =
      respUrl.includes('/_api/') ||
      respUrl.includes('wixapis.com') ||
      respUrl.includes('wix.com/_api');
    if (!isWixApi) return;

    try {
      const body = await resp.json();
      captured.apiCalls.push({ url: respUrl, data: body });
    } catch {
      // response body not readable
    }
  };

  p.on('response', responseHandler);

  try {
    await p.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  } catch {
    // Navigation may timeout on heavy Wix pages
  }

  p.off('response', responseHandler);

  const browserData = (await p.evaluate(() => {
    const result: Record<string, unknown> = {};

    const knownGlobals = [
      '__WIX_DATA__',
      '__SITE_DATA__',
      'wixBiSession',
      '__wixInjectedPageData',
    ];
    const win = window as unknown as Record<string, unknown>;
    for (const g of knownGlobals) {
      if (win[g]) {
        result[g] = win[g];
      }
    }

    for (const key of Object.keys(window)) {
      if ((key.startsWith('__WIX') || key.startsWith('_wix')) && !result[key]) {
        try {
          result[key] = win[key];
        } catch {
          // skip inaccessible
        }
      }
    }

    const jsonLd = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]')
    )
      .map((s) => {
        try {
          return JSON.parse(s.textContent || '');
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const meta = {
      title: document.title,
      description:
        (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)
          ?.content || '',
      ogTitle:
        (document.querySelector('meta[property="og:title"]') as HTMLMetaElement | null)
          ?.content || '',
      ogDescription:
        (
          document.querySelector(
            'meta[property="og:description"]'
          ) as HTMLMetaElement | null
        )?.content || '',
      ogImage:
        (document.querySelector('meta[property="og:image"]') as HTMLMetaElement | null)
          ?.content || '',
      canonical:
        (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)
          ?.href || '',
    };

    return { globals: result, jsonLd, meta };
  })) as {
    globals: Record<string, unknown>;
    jsonLd: unknown[];
    meta: PageMeta;
  };

  let renderedContent: string | null = null;
  try {
    renderedContent = (await p.evaluate(() => {
      const mainEl = document.querySelector('main')
        || document.querySelector('#PAGES_CONTAINER')
        || document.querySelector('#SITE_PAGES');
      if (!mainEl) return null;

      const richTextEls = mainEl.querySelectorAll('[data-testid="richTextElement"]');
      if (richTextEls.length === 0) return null;

      const blocks: string[] = [];
      const seen = new Set<string>();

      richTextEls.forEach((el) => {
        const children = el.querySelectorAll('h1, h2, h3, h4, h5, h6, p, ul, ol, blockquote');
        if (children.length > 0) {
          children.forEach((child) => {
            const text = (child as HTMLElement).innerText?.trim();
            if (!text || seen.has(text)) return;
            seen.add(text);
            const tag = child.tagName.toLowerCase();
            if (tag.startsWith('h')) {
              blocks.push(`<${tag}>${text}</${tag}>`);
            } else if (tag === 'ul' || tag === 'ol') {
              blocks.push((child as HTMLElement).outerHTML);
            } else if (tag === 'blockquote') {
              blocks.push(`<blockquote>${text}</blockquote>`);
            } else {
              blocks.push(`<p>${text}</p>`);
            }
          });
        } else {
          const text = (el as HTMLElement).innerText?.trim();
          if (text && !seen.has(text)) {
            seen.add(text);
            blocks.push(`<p>${text}</p>`);
          }
        }
      });

      const images = mainEl.querySelectorAll('img[src*="wixstatic"], img[src*="wixmp"], [data-testid="image"] img');
      images.forEach((img) => {
        const src = (img as HTMLImageElement).src;
        const alt = (img as HTMLImageElement).alt || '';
        if (src && !seen.has(src)) {
          seen.add(src);
          blocks.push(`<img src="${src}" alt="${alt}" />`);
        }
      });

      return blocks.length > 0 ? blocks.join('\n') : null;
    })) as string | null;
  } catch {
    // DOM extraction failed
  }

  let accessibility: Array<{ role: string; name: string; description?: string }> | null =
    null;
  try {
    const client = await p.context().newCDPSession(page);
    const axResult = (await client.send('Accessibility.getFullAXTree', {
      depth: 10,
    })) as { nodes?: Array<{ role?: { value: string }; name?: { value: string }; description?: { value: string } }> };
    const textNodes = (axResult.nodes || [])
      .filter((n) =>
        [
          'heading',
          'paragraph',
          'StaticText',
          'link',
          'img',
          'list',
          'listitem',
          'article',
          'main',
          'section',
        ].includes(n.role?.value || '')
      )
      .map((n) => ({
        role: n.role?.value || '',
        name: n.name?.value || '',
        description: n.description?.value,
      }))
      .filter((n) => n.name);
    accessibility = textNodes;
    await client.detach();
  } catch {
    // CDP session failed
  }

  let pageHtml = '';
  try {
    pageHtml = await p.content();
  } catch {
    // content() failed
  }

  const mediaUrls: string[] = extractImageUrls({
    apiCalls: captured.apiCalls,
    globals: browserData.globals,
    jsonLd: browserData.jsonLd,
    meta: browserData.meta,
    accessibility,
    pageHtml,
  });

  const { content, qualityScore } = deriveContent({
    apiCalls: captured.apiCalls,
    jsonLd: browserData.jsonLd,
    renderedContent,
    accessibility,
    meta: browserData.meta,
  });

  return {
    sourceUrl: url,
    slug: slugify(url),
    extractedAt: new Date().toISOString(),
    apiCalls: captured.apiCalls,
    globals: browserData.globals,
    jsonLd: browserData.jsonLd,
    meta: browserData.meta,
    accessibility,
    mediaUrls,
    content,
    qualityScore,
  };
}

// ---------------------------------------------------------------------------
// Wix product extraction helper
// ---------------------------------------------------------------------------

/**
 * Try to extract WooCommerce product data from a Wix page's captured data.
 * Looks in: JSON-LD Product schema, captured API calls, window globals.
 */
function extractWixProduct(pageData: PageData): WooProduct | null {
  // 1. JSON-LD Product schema
  for (const ld of pageData.jsonLd) {
    const obj = ld as Record<string, unknown>;
    if (obj['@type'] === 'Product' && typeof obj.name === 'string') {
      // Wix emits "Offers" (uppercase) while schema.org uses "offers" (lowercase)
      const rawOffers = obj.offers || obj.Offers;
      const offers = Array.isArray(rawOffers) ? rawOffers : rawOffers ? [rawOffers as Record<string, unknown>] : [];
      const offer = (offers[0] || {}) as Record<string, unknown>;
      const price = offer.price ? String(offer.price) : '';
      const images: string[] = [];
      if (typeof obj.image === 'string') images.push(obj.image);
      else if (Array.isArray(obj.image)) {
        for (const img of obj.image) {
          if (typeof img === 'string') images.push(img);
          else if (typeof img === 'object' && img) {
            // Wix uses schema.org "contentUrl" for ImageObject; also check "url"
            const imgUrl = (img as Record<string, unknown>).url || (img as Record<string, unknown>).contentUrl;
            if (typeof imgUrl === 'string') images.push(imgUrl);
          }
        }
      }
      // Wix emits "Availability" (uppercase)
      const availability = offer.availability || offer.Availability;
      return {
        name: obj.name,
        description: typeof obj.description === 'string' ? obj.description : '',
        regularPrice: price,
        sku: typeof obj.sku === 'string' ? obj.sku : '',
        images,
        inStock: typeof availability === 'string'
          ? (availability as string).includes('InStock')
          : true,
        sourceUrl: pageData.sourceUrl,
      };
    }
  }

  // 2. Captured API calls — look for product data in Wix store API responses
  for (const call of pageData.apiCalls) {
    const data = call.data as Record<string, unknown>;
    // Wix stores API often returns product under .product or .catalog.product
    const product = (data.product || (data.catalog as Record<string, unknown>)?.product) as Record<string, unknown> | undefined;
    if (product && typeof product.name === 'string') {
      const price = product.price as Record<string, unknown> | undefined;
      const media = (product.media as Record<string, unknown>)?.items as Array<Record<string, unknown>> | undefined;
      const images: string[] = [];
      if (media) {
        for (const item of media) {
          const src = (item.image as Record<string, unknown>)?.url as string | undefined;
          if (src) images.push(src);
        }
      }
      return {
        name: product.name as string,
        description: typeof product.description === 'string' ? product.description : '',
        regularPrice: price?.formatted ? String(price.formatted).replace(/[^0-9.]/g, '') : '',
        sku: typeof product.sku === 'string' ? product.sku : '',
        images,
        inStock: (product.stock as Record<string, unknown> | undefined)?.inventoryStatus
          ? (product.stock as Record<string, unknown>).inventoryStatus !== 'OUT_OF_STOCK'
          : undefined,
        sourceUrl: pageData.sourceUrl,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const wixAdapter: PlatformAdapter = {
  id: 'wix',

  detect(url: string): boolean {
    return /wixsite\.com|wix\.com/i.test(url);
  },

  async discover(url: string, opts: Record<string, unknown>): Promise<Inventory> {
    const wixOpts = opts as WixAdapterOpts;
    const { browser, page, close } = await launchBrowser({ cdpPort: wixOpts.cdpPort });

    try {
    const p = page as {
      goto(url: string, opts?: Record<string, unknown>): Promise<{ ok(): boolean } | null>;
      content(): Promise<string>;
      evaluate(fn: (...args: unknown[]) => unknown, ...args: unknown[]): Promise<unknown>;
    };

    // 1. Fetch sitemap via Playwright
    const baseUrl = (() => {
      const u = new URL(url);
      return u.origin + u.pathname.replace(/\/$/, '');
    })();

    const sitemapUrls: string[] = [];

    async function fetchSitemapPw(sitemapUrl: string, depth = 0): Promise<void> {
      if (depth > 3) return;
      try {
        const resp = await p.goto(sitemapUrl, { timeout: 15000 });
        if (!resp || !resp.ok()) return;
        const text = await p.content();
        const locs = parseSitemapXml(text);
        for (const loc of locs) {
          if (loc.endsWith('.xml')) {
            await fetchSitemapPw(loc, depth + 1);
          } else {
            sitemapUrls.push(loc);
          }
        }
      } catch {
        // sitemap fetch failed
      }
    }

    await fetchSitemapPw(`${baseUrl}/sitemap.xml`);

    // 2. If sitemap is empty, crawl homepage for same-origin links
    let allUrls = sitemapUrls;
    if (allUrls.length === 0) {
      try {
        await p.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        const origin = new URL(url).origin;
        allUrls = (await p.evaluate((orig: unknown) => {
          const o = orig as string;
          return [
            ...new Set(
              [...document.querySelectorAll('a[href]')]
                .map((a) => (a as HTMLAnchorElement).href)
                .filter((h) => h.startsWith(o) && !h.includes('#'))
            ),
          ];
        }, origin)) as string[];
      } catch {
        // crawl failed
      }
    }

    // 3. Extract navigation from homepage
    let navigation: NavLink[] = [];
    try {
      await p.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      navigation = (await p.evaluate(() => {
        const navLinks: Array<{ text: string; href: string }> = [];
        document
          .querySelectorAll('nav a, header a, [role="navigation"] a')
          .forEach((el) => {
            const a = el as HTMLAnchorElement;
            const text = a.textContent?.trim() || '';
            const href = a.href;
            if (text && href && !href.includes('#') && !navLinks.find((l) => l.href === href)) {
              navLinks.push({ text, href });
            }
          });
        return navLinks;
      })) as NavLink[];
    } catch {
      // nav extraction failed
    }

    // 4. Extract site title
    let siteTitle = '';
    try {
      siteTitle = (await p.evaluate(() => document.title)) as string;
    } catch {
      // title extraction failed
    }

    // 5. Classify URLs
    const counts: Record<string, number> = {};
    const inventoryUrls: InventoryUrl[] = [];
    for (const u of allUrls) {
      const type = classifyUrl(u);
      inventoryUrls.push({ url: u, type });
      counts[type] = (counts[type] || 0) + 1;
    }

    return {
      siteUrl: url,
      discoveredAt: new Date().toISOString(),
      siteMeta: {
        title: siteTitle || 'Imported Site',
        tagline: '',
        language: 'en-US',
      },
      navigation,
      counts,
      urls: inventoryUrls,
    };
    } finally {
      await close();
    }
  },

  async extract(
    inventory: unknown,
    wxr: WxrBuilder,
    opts: Record<string, unknown>,
    context: { log: ExtractionLog; server: Server }
  ): Promise<{
    pagesExtracted: number;
    postsExtracted: number;
    failed: number;
    mediaCollected: number;
  }> {
    const inv = inventory as Inventory;
    const wixOpts = opts as WixAdapterOpts;
    const delayMs = wixOpts.delay != null ? wixOpts.delay : 500;
    const outputDir = wixOpts.outputDir || '';

    // Product CSV builder — streams products as JSONL, builds CSV at the end
    const csvBuilder = new WooProductCsvBuilder();
    let hasProducts = false;
    if (outputDir && !wixOpts.dryRun) {
      csvBuilder.openStream(outputDir);
    }

    // Build a set of product URLs for quick lookup
    const productUrls = new Set(
      inv.urls.filter((u) => u.type === 'product').map((u) => u.url)
    );

    // Launch browser for Wix-specific page extraction
    const { page, close } = await launchBrowser({ cdpPort: wixOpts.cdpPort });

    try {
      const result = await runExtractionLoop({
        urls: inv.urls,
        navigation: inv.navigation,
        wxr,
        log: context.log,
        outputDir,
        delay: delayMs,
        dryRun: !!wixOpts.dryRun,
        resume: !!wixOpts.resume,
        verbose: wixOpts.verbose,
        limit: wixOpts.limit,
        server: context.server,
        csvBuilder,
        extractPage: async (url: string) => {
          const pageData = await extractWixPage(page, url);

          // Check if this is a product page and try to extract product data
          const isProduct = productUrls.has(url) || /\/product-page\//.test(url) || /\/store\//.test(url);
          if (isProduct) {
            const wooProduct = extractWixProduct(pageData);
            if (wooProduct) {
              csvBuilder.addProduct(wooProduct);
              hasProducts = true;
            }
          }

          // Strip site-name suffix from Wix titles (e.g. "About | MySite Copy" → "About")
          const rawTitle = pageData.meta.ogTitle || pageData.meta.title || pageData.slug;
          const pipeIdx = rawTitle.lastIndexOf(' | ');
          const cleanedTitle = pipeIdx > 0 ? rawTitle.slice(0, pipeIdx).trim() : rawTitle;

          // Extract author from JSON-LD
          let author: string | undefined;
          for (const ld of pageData.jsonLd) {
            const obj = ld as Record<string, unknown>;
            const ldAuthor = obj.author as Record<string, unknown> | string | undefined;
            if (typeof ldAuthor === 'string' && ldAuthor) {
              author = ldAuthor;
              break;
            }
            if (ldAuthor && typeof ldAuthor === 'object' && typeof ldAuthor.name === 'string') {
              author = ldAuthor.name;
              break;
            }
          }

          return {
            title: cleanedTitle || pageData.slug,
            slug: pageData.slug,
            content: pageData.content,
            excerpt: pageData.meta.ogDescription || pageData.meta.description || '',
            date: pageData.extractedAt,
            seoTitle: pageData.meta.title,
            seoDescription: pageData.meta.description,
            mediaUrls: pageData.mediaUrls,
            qualityScore: pageData.qualityScore,
            author,
          };
        },
      });

      // Finalize product CSV — reads JSONL and writes CSV
      if (hasProducts && outputDir && !wixOpts.dryRun) {
        if (csvBuilder.isStreaming) {
          csvBuilder.closeStream();
        } else {
          csvBuilder.serialize(`${outputDir}/products.csv`);
        }
      }

      return result;
    } finally {
      await close();
    }
  },
};
