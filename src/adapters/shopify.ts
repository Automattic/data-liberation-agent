import type { PlatformAdapter } from '../types.js';
import type { WxrBuilder } from '../lib/extraction/wxr-builder.js';
import type { ExtractionLog } from '../lib/extraction/extraction-log.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { fetchSitemap, classifyUrl } from '../lib/extraction/sitemap.js';
import { slugify, runExtractionLoop, extractMeta, extractTitle, extractHeading, extractNavLinks, IMAGE_EXTENSIONS } from './shared.js';
import type { InventoryUrl, NavLink } from './shared.js';
import { WooProductCsvBuilder } from '../lib/import/woo-product-csv.js';
import type { WooProduct } from '../lib/import/woo-product-csv.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShopifyAdapterOpts extends Record<string, unknown> {
  delay?: number;
  resume?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  outputDir?: string;
  cdpPort?: number;
}

export interface ShopifyInventory {
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
  jsonApiAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Shopify JSON API helpers
// ---------------------------------------------------------------------------

interface ShopifyPage {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  published_at?: string;
  author?: string;
}

interface ShopifyBlog {
  id: number;
  title: string;
  handle: string;
}

interface ShopifyArticle {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  summary_html?: string;
  author?: string;
  tags?: string;
  published_at?: string;
  blog_id?: number;
  image?: { src: string };
}

interface ShopifyProductVariant {
  id?: number;
  title: string;
  price: string;
  compare_at_price?: string | null;
  sku: string;
  option1?: string;
  option2?: string;
  option3?: string;
  weight?: number;
  weight_unit?: string;
  inventory_quantity?: number;
  available?: boolean;
  image_id?: number | null;
  featured_image?: { src: string } | null;
}

interface ShopifyProductOption {
  name: string;
  values: string[];
}

interface ShopifyProductImage {
  id?: number;
  src: string;
  variant_ids?: number[];
}

export interface ShopifyProductJson {
  title: string;
  body_html: string;
  handle: string;
  product_type?: string;
  tags?: string;
  vendor?: string;
  image?: { src: string };
  variants?: ShopifyProductVariant[];
  options?: ShopifyProductOption[];
  images?: ShopifyProductImage[];
}

/**
 * Convert a Shopify product JSON payload into a WooProduct parent + variation rows.
 */
export function shopifyProductToWoo(product: ShopifyProductJson): { parent: WooProduct; variations: WooProduct[] } {
  const variants = product.variants || [];
  const options = product.options || [];

  const isVariable = variants.length > 1 || (options.length > 0 && options[0]?.name !== 'Title');

  // Collect images from 3 sources: featured image, images array, inline body HTML
  const imageSet = new Set<string>();
  if (product.image?.src) imageSet.add(product.image.src);
  for (const img of product.images || []) {
    imageSet.add(img.src);
  }
  // Extract inline images from body_html
  const inlineImgRegex = /src="(https?:\/\/[^"']+\.(jpg|jpeg|png|gif|webp)[^"']*)"/gi;
  let inlineMatch;
  while ((inlineMatch = inlineImgRegex.exec(product.body_html || '')) !== null) {
    imageSet.add(inlineMatch[1]);
  }
  const images = [...imageSet];

  const firstVariant = variants[0];
  const tags = product.tags
    ? product.tags.split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  const categories = product.product_type ? [product.product_type] : [];

  const parent: WooProduct = {
    name: product.title,
    type: isVariable ? 'variable' : 'simple',
    // Variable products don't carry a SKU at the parent level — SKUs live on variations
    sku: isVariable ? '' : (firstVariant?.sku || ''),
    published: true,
    description: product.body_html || '',
    regularPrice: isVariable ? '' : (firstVariant?.price || ''),
    categories,
    tags,
    images,
    inStock: firstVariant?.available !== false,
    stock: firstVariant?.inventory_quantity != null ? firstVariant.inventory_quantity : undefined,
  };

  if (options.length > 0) {
    parent.attributes = options.map((opt) => ({
      name: opt.name,
      values: opt.values,
      visible: true,
      global: false,
    }));
  }

  if (firstVariant?.weight) {
    parent.weight = String(firstVariant.weight);
  }

  // Build image lookup: image ID → src, and variant ID → image src
  const imageById = new Map<number, string>();
  const imageByVariantId = new Map<number, string>();
  for (const img of product.images || []) {
    if (img.id) imageById.set(img.id, img.src);
    for (const vid of img.variant_ids || []) {
      imageByVariantId.set(vid, img.src);
    }
  }

  // Build variation rows for variable products
  const variations: WooProduct[] = [];
  if (isVariable) {
    for (const variant of variants) {
      const hasCompareAtPrice = variant.compare_at_price != null && variant.compare_at_price !== '';

      // Resolve variant image: featured_image > image_id lookup > variant_id lookup
      let variantImage: string | undefined;
      if (variant.featured_image?.src) {
        variantImage = variant.featured_image.src;
      } else if (variant.image_id && imageById.has(variant.image_id)) {
        variantImage = imageById.get(variant.image_id);
      } else if (variant.id && imageByVariantId.has(variant.id)) {
        variantImage = imageByVariantId.get(variant.id);
      }

      const variation: WooProduct = {
        name: product.title,
        type: 'variation',
        sku: variant.sku || '',
        parentSku: parent.sku,
        published: true,
        description: '',
        regularPrice: hasCompareAtPrice ? String(variant.compare_at_price) : variant.price || '',
        salePrice: hasCompareAtPrice ? variant.price || undefined : undefined,
        inStock: variant.available !== false,
        stock: variant.inventory_quantity != null ? variant.inventory_quantity : undefined,
        ...(variantImage ? { images: [variantImage] } : {}),
      };

      if (variant.weight) {
        variation.weight = String(variant.weight);
      }

      // Single-value attributes for this variant
      const variantAttributes: WooProduct['attributes'] = [];
      if (variant.option1 != null && options[0]) {
        variantAttributes.push({ name: options[0].name, values: [variant.option1], visible: true, global: false });
      }
      if (variant.option2 != null && options[1]) {
        variantAttributes.push({ name: options[1].name, values: [variant.option2], visible: true, global: false });
      }
      if (variant.option3 != null && options[2]) {
        variantAttributes.push({ name: options[2].name, values: [variant.option3], visible: true, global: false });
      }
      if (variantAttributes.length > 0) {
        variation.attributes = variantAttributes;
      }

      variations.push(variation);
    }
  }

  return { parent, variations };
}

/**
 * Extract product data from page HTML via JSON-LD or embedded product JSON.
 */
function extractProductFromHtml(html: string): WooProduct | null {
  // Try JSON-LD Product schema
  const ldMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of ldMatches) {
    const jsonStr = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
    try {
      const ld = JSON.parse(jsonStr);
      if (ld['@type'] === 'Product' && ld.name) {
        const offers = Array.isArray(ld.offers) ? ld.offers : ld.offers ? [ld.offers] : [];
        const price = offers[0]?.price ? String(offers[0].price) : '';
        const images: string[] = [];
        if (typeof ld.image === 'string') images.push(ld.image);
        else if (Array.isArray(ld.image)) {
          for (const img of ld.image) {
            if (typeof img === 'string') images.push(img);
            else if (img?.url) images.push(img.url);
          }
        }
        return {
          name: ld.name,
          description: ld.description || '',
          regularPrice: price,
          sku: ld.sku || '',
          images,
          inStock: offers[0]?.availability?.includes('InStock') ?? true,
        };
      }
    } catch {
      // invalid JSON-LD
    }
  }

  // Try [data-product-json] or similar embedded product data
  const productJsonMatch = html.match(/data-product-json[^>]*>([\s\S]*?)<\/script>/i);
  if (productJsonMatch?.[1]) {
    try {
      const pData = JSON.parse(productJsonMatch[1]);
      if (pData.title) {
        return shopifyProductToWoo(pData as ShopifyProductJson).parent;
      }
    } catch {
      // invalid JSON
    }
  }

  return null;
}

/**
 * Attempt to fetch a Shopify JSON endpoint. Returns null if the store blocks it.
 */
async function fetchShopifyJson<T>(url: string): Promise<T | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)',
        Accept: 'application/json',
      },
    });
    if (!resp.ok) {
      await resp.body?.cancel();
      return null;
    }
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Paginate through a Shopify JSON list endpoint (?limit=250&page=N).
 */
async function fetchShopifyPaginated<T>(baseUrl: string, key: string): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  const maxPages = 20; // safety limit
  while (page <= maxPages) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${sep}limit=250&page=${page}`;
    const data = await fetchShopifyJson<Record<string, T[]>>(url);
    if (!data || !data[key] || data[key].length === 0) break;
    items.push(...data[key]);
    if (data[key].length < 250) break;
    page++;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Quality scoring
// ---------------------------------------------------------------------------

export interface QualitySignals {
  title: string;
  content: string;
  images: string[];
  date: string;
  hasStructuredData: boolean;
  hasPriceSku: boolean;
}

export function scorePageQuality(signals: QualitySignals): 'high' | 'medium' | 'low' {
  let score = 0;
  if (signals.title.length > 0) score += 20;
  if (signals.content.length > 200) score += 25;
  else if (signals.content.length > 50) score += 10;
  if (signals.images.length > 0) score += 15;
  if (signals.hasStructuredData) score += 10;
  if (signals.hasPriceSku) score += 10;
  if (signals.date.length > 0) score += 10;

  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// HTML helpers (regex-based, no DOM parser dependency)
// ---------------------------------------------------------------------------


/**
 * Extract content from Shopify page HTML.
 * Tries multiple strategies and picks the richest result. Narrow selectors
 * (Replo, .rte) are preferred when they return substantial content (>=100
 * chars of text); otherwise we fall through to broader selectors (<article>,
 * <main>) which capture section-based page builders.
 */
function extractShopifyContent(html: string): string {
  const textLen = (h: string) => h.replace(/<[^>]*>/g, '').trim().length;
  const MIN_CONTENT = 100; // chars of stripped text to accept a narrow strategy

  // Strategy 1: Replo page builder
  const reploMatch = html.match(/<div[^>]*id="replo-fullpage-element"[^>]*>([\s\S]*?)<\/main>/i);
  if (reploMatch?.[1] && textLen(reploMatch[1]) >= MIN_CONTENT) {
    return reploMatch[1].trim();
  }

  // Strategy 2: .rte content block (standard Shopify rich text)
  const rteStart = html.match(/<div[^>]*class="[^"]*\brte\b[^"]*"[^>]*>/i);
  if (rteStart) {
    const startIdx = html.indexOf(rteStart[0]);
    const afterTag = startIdx + rteStart[0].length;
    let depth = 1;
    let i = afterTag;
    while (i < html.length && depth > 0) {
      const nextOpen = html.indexOf('<div', i);
      const nextClose = html.indexOf('</div>', i);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        i = nextOpen + 4;
      } else {
        depth--;
        if (depth === 0) {
          const rteContent = html.slice(afterTag, nextClose).trim();
          if (textLen(rteContent) >= MIN_CONTENT) return rteContent;
          break; // thin .rte — fall through to broader strategies
        }
        i = nextClose + 6;
      }
    }
  }

  // Strategy 3: .alchemy-rte (another common page builder pattern)
  const alchemyMatch = html.match(/<div[^>]*class="[^"]*alchemy-rte[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (alchemyMatch?.[1] && textLen(alchemyMatch[1]) >= MIN_CONTENT) return alchemyMatch[1].trim();

  // Strategy 4: <article> tag content
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch?.[1] && textLen(articleMatch[1]) >= MIN_CONTENT) return articleMatch[1].trim();

  // Strategy 5: <main> tag (broadest — captures all section content)
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch?.[1]?.trim()) return mainMatch[1].trim();

  return '';
}

/**
 * Extract media URLs from content. Looks for cdn.shopify.com image URLs.
 */
function extractShopifyMediaUrls(html: string): string[] {
  const urls = new Set<string>();

  // Shopify CDN URLs
  const cdnPattern = /https?:\/\/cdn\.shopify\.com\/s\/files\/[^\s"'<>)]+/g;
  const cdnMatches = html.match(cdnPattern) || [];
  for (const m of cdnMatches) urls.add(m);

  // Standard <img> tags
  const imgSrcMatches = html.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
  for (const match of imgSrcMatches) {
    const src = match.match(/src=["']([^"']+)["']/i);
    if (src?.[1] && src[1].startsWith('http')) {
      urls.add(src[1]);
    }
  }

  // Filter to actual image URLs
  const imageExtensions = IMAGE_EXTENSIONS;
  const nonImageExtensions = /\.(css|js|json|xml|txt|map|woff2?|ttf|eot|pdf)$/i;
  return [...urls].filter((u) => {
    try {
      const parsed = new URL(u);
      if (nonImageExtensions.test(parsed.pathname)) return false;
      return imageExtensions.test(parsed.pathname);
    } catch {
      return false;
    }
  });
}

/**
 * Extract date from HTML — tries schema.org, <time>, and meta tags.
 */
function extractDate(html: string): string {
  // Schema.org datePublished
  const schemaDate = html.match(/datePublished["']?\s*[:=]\s*["']([^"']+)["']/i)?.[1];
  if (schemaDate) return schemaDate;

  // <time datetime="...">
  const timeEl = html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];
  if (timeEl) return timeEl;

  // meta article:published_time
  const metaDate = extractMeta(html, 'article:published_time');
  if (metaDate) return metaDate;

  return '';
}

// ---------------------------------------------------------------------------
// CDP-based admin GraphQL discovery
// ---------------------------------------------------------------------------

async function discoverProductsViaCdp(cdpPort: number, origin: string): Promise<string[]> {
  const { launchBrowser } = await import('./shared.js');
  const { page, close } = await launchBrowser({ cdpPort });

  const handles: string[] = [];
  const seen = new Set<string>();

  try {
    const pw = page as import('playwright').Page;

    pw.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('admin.shopify.com/api/operations/')) return;
      if (!url.includes('ProductIndex') && !url.includes('ProductList')) return;

      try {
        const json = await response.json() as Record<string, unknown>;
        const data = json.data as Record<string, unknown> | undefined;
        if (!data) return;

        const products = data.filteredProducts as Record<string, unknown> | undefined;
        const edges = (products?.edges || []) as Array<{ node: { handle?: string } }>;

        for (const edge of edges) {
          const handle = edge.node?.handle;
          if (handle && !seen.has(handle)) {
            seen.add(handle);
            handles.push(handle);
          }
        }
      } catch {
        // Response parsing failed
      }
    });

    try {
      await pw.goto(`${origin}/admin/products`, { waitUntil: 'networkidle', timeout: 30000 });
    } catch {
      // Navigation may timeout but we still capture intercepted responses
    }

    // Scroll to trigger lazy loading
    for (let i = 0; i < 5; i++) {
      await pw.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise((r) => setTimeout(r, 2000));
      if (handles.length > 200) break;
    }

    await new Promise((r) => setTimeout(r, 1000));
  } finally {
    await close();
  }

  return handles;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const shopifyAdapter: PlatformAdapter = {
  id: 'shopify',

  detect(url: string): boolean {
    return /myshopify\.com|shopify\.com/i.test(url);
  },

  async discover(url: string, _opts: Record<string, unknown>): Promise<ShopifyInventory> {
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
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)' },
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
    const ogTitle = extractMeta(homepageHtml, 'og:title');
    const ogDescription = extractMeta(homepageHtml, 'og:description');
    const siteTitle = ogTitle || extractTitle(homepageHtml) || 'Imported Site';
    const siteTagline = ogDescription || extractMeta(homepageHtml, 'description') || '';
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
    const sitemapUrls = await fetchSitemap(normalized);
    for (const u of sitemapUrls) {
      // Skip if already found via JSON API
      if (inventoryUrls.some((inv) => inv.url === u)) continue;
      const type = classifyUrl(u);
      inventoryUrls.push({ url: u, type });
      counts[type] = (counts[type] || 0) + 1;
    }

    // 5. CDP-based admin discovery (if cdpPort provided)
    const shopifyOpts = _opts as ShopifyAdapterOpts;
    if (shopifyOpts.cdpPort) {
      try {
        const cdpHandles = await discoverProductsViaCdp(shopifyOpts.cdpPort, origin);
        for (const handle of cdpHandles) {
          const productUrl = `${origin}/products/${handle}`;
          if (inventoryUrls.some((inv) => inv.url === productUrl)) continue;
          inventoryUrls.push({ url: productUrl, type: 'product' });
          counts['product'] = (counts['product'] || 0) + 1;
        }
      } catch {
        // CDP discovery failed — continue with existing results
      }
    }

    // If we still have nothing, add the homepage
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
      jsonApiAvailable,
    };
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
    const inv = inventory as ShopifyInventory;
    const shopifyOpts = opts as ShopifyAdapterOpts;
    const delayMs = shopifyOpts.delay != null ? shopifyOpts.delay : 300;
    const outputDir = shopifyOpts.outputDir || '';

    // Product CSV builder — streams products as JSONL, builds CSV at the end
    const csvBuilder = new WooProductCsvBuilder();
    let hasProducts = false;
    if (outputDir && !shopifyOpts.dryRun) {
      csvBuilder.openStream(outputDir);
    }

    // Build a set of product URLs for quick lookup
    const productUrls = new Set(
      inv.urls.filter((u) => u.type === 'product').map((u) => u.url)
    );

    // Lazy-init browser session for CDP/headed fallback on 403s
    let browserSession: { page: unknown; close: () => Promise<void> } | null = null;
    async function getBrowserPage(): Promise<unknown> {
      if (!browserSession) {
        const { launchBrowser } = await import('./shared.js');
        // Prefer user-provided CDP port; otherwise auto-launch headed Chromium
        // (headed bypasses Cloudflare bot detection that blocks headless)
        const session = await launchBrowser(
          shopifyOpts.cdpPort ? { cdpPort: shopifyOpts.cdpPort } : { headed: true }
        );
        browserSession = { page: session.page, close: () => session.close() };
      }
      return browserSession.page;
    }

    let result;
    try {
    result = await runExtractionLoop({
      urls: inv.urls,
      navigation: inv.navigation,
      wxr,
      log: context.log,
      outputDir,
      delay: delayMs,
      dryRun: !!shopifyOpts.dryRun,
      resume: !!shopifyOpts.resume,
      verbose: shopifyOpts.verbose,
      server: context.server,
      extractPage: async (url: string) => {
        // Tier 1: Try JSON API — append .json to URL
        let title = '';
        let content = '';
        let excerpt = '';
        let date = '';
        let tags: string[] = [];
        let categories: string[] = [];
        let mediaUrls: string[] = [];
        let jsonSuccess = false;
        let productHandled = false; // tracks whether CSV builder already has this product
        let detectedType: 'product' | 'post' | 'page' | undefined;
        let author: string | undefined;

        // Check if this URL is a product
        const isProduct = productUrls.has(url) || /\/products\//.test(url);

        try {
          const jsonUrl = url.replace(/\/?$/, '') + '.json';
          const jsonResp = await fetchShopifyJson<Record<string, unknown>>(jsonUrl);

          if (jsonResp) {
            const article = jsonResp.article as ShopifyArticle | undefined;
            const page = jsonResp.page as ShopifyPage | undefined;
            const product = jsonResp.product as ShopifyProductJson | undefined;

            if (product?.title) {
              // Product JSON found — add to CSV builder for WooCommerce export
              detectedType = 'product';
              const { parent, variations } = shopifyProductToWoo(product);
              csvBuilder.addProduct(parent);
              for (const variation of variations) {
                csvBuilder.addProduct(variation);
              }
              hasProducts = true;
              productHandled = true;

              // Collect JSON metadata — but DON'T set jsonSuccess so we
              // fall through to HTML for richer page content (product pages
              // typically have section-based content far beyond body_html).
              title = product.title;
              content = product.body_html || '';
              tags = product.tags
                ? product.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
                : [];
              categories = product.product_type ? [product.product_type] : [];
              mediaUrls = parent.images ? [...parent.images] : [];
              mediaUrls.push(...extractShopifyMediaUrls(content));
            } else if (article?.body_html) {
              title = article.title;
              content = article.body_html;
              excerpt = article.summary_html || article.body_html.replace(/<[^>]*>/g, '').slice(0, 200);
              date = article.published_at || '';
              author = article.author || undefined;
              tags = article.tags ? article.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [];
              if (article.image?.src) {
                mediaUrls.push(article.image.src);
              }
              mediaUrls.push(...extractShopifyMediaUrls(content));
              jsonSuccess = true;
            } else if (page?.body_html) {
              title = page.title;
              content = page.body_html;
              date = page.published_at || '';
              author = page.author || undefined;
              mediaUrls.push(...extractShopifyMediaUrls(content));
              jsonSuccess = true;
            }

            // Thin-content gate: if JSON returned very little actual text,
            // mark as not successful so we fall through to HTML extraction.
            // Keep JSON metadata (title, date, tags, author) but replace content.
            if (jsonSuccess) {
              const strippedText = content.replace(/<[^>]*>/g, '').trim();
              if (strippedText.length < 100) {
                jsonSuccess = false;
              }
            }
          }
        } catch {
          // JSON failed — fall through to HTML
        }

        // Tier 2: Fall back to HTML parsing, or supplement thin JSON content
        const isBlogPost = /\/blogs\//.test(url);
        const needsHtml = !jsonSuccess || isBlogPost;
        if (needsHtml) {
          let html = '';
          let needsBrowser = false;
          try {
            const resp = await fetch(url, {
              signal: AbortSignal.timeout(15000),
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)' },
            });
            if (resp.ok) {
              html = await resp.text();
              // Detect Cloudflare challenge pages served with 200 status
              if (html.includes('Just a moment...') && html.includes('cf_chl_opt')) {
                html = '';
                needsBrowser = true;
              }
            } else {
              await resp.body?.cancel();
              if (resp.status === 403) needsBrowser = true;
            }
          } catch {
            // Network error
          }

          // Tier 3: browser fallback for blocked pages (Cloudflare, bot protection)
          // Uses CDP if cdpPort provided, otherwise auto-launches headed Chromium
          if (needsBrowser && !html) {
            try {
              const page = await getBrowserPage() as import('playwright').Page;
              await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
              html = await page.content();
            } catch {
              // Browser extraction failed — continue with empty html
            }
          }

          if (!jsonSuccess) {
            // Full HTML fallback — replace all content from HTML
            // Try to extract product data from HTML structured data (JSON-LD, microdata)
            // Skip if we already handled the product via JSON API
            if (!productHandled) {
              const wooProduct = extractProductFromHtml(html);
              if (wooProduct) {
                detectedType = 'product';
                csvBuilder.addProduct(wooProduct);
                hasProducts = true;
              }
            }

            const htmlContent = extractShopifyContent(html);
            // Only replace content if HTML actually has more
            if (htmlContent.replace(/<[^>]*>/g, '').trim().length > content.replace(/<[^>]*>/g, '').trim().length) {
              content = htmlContent;
            }
            // Only replace metadata if we didn't get it from JSON
            if (!title) title = extractHeading(html) || '';
            if (!excerpt) excerpt = extractMeta(html, 'og:description') || extractMeta(html, 'description') || '';
            if (!date) date = extractDate(html);
            // Merge HTML media with any JSON media already collected
            const htmlMedia = extractShopifyMediaUrls(html);
            for (const m of htmlMedia) {
              if (!mediaUrls.includes(m)) mediaUrls.push(m);
            }
          }

          // Always extract OG image (covers blog featured images and general cases)
          if (html) {
            const ogImage = extractMeta(html, 'og:image');
            if (ogImage && ogImage.startsWith('http') && !mediaUrls.includes(ogImage)) {
              try {
                if (IMAGE_EXTENSIONS.test(new URL(ogImage).pathname)) {
                  // Prepend OG image so it becomes the featured image
                  mediaUrls.unshift(ogImage);
                }
              } catch { /* invalid URL */ }
            }
          }
        }

        if (!title) title = slugify(url);

        const seoTitle = title;
        const seoDescription = excerpt;

        // Deduplicate media
        mediaUrls = [...new Set(mediaUrls)];

        // Quality score
        const qualityScore = scorePageQuality({
          title,
          content,
          images: mediaUrls,
          date,
          hasStructuredData: jsonSuccess,
          hasPriceSku: detectedType === 'product',
        });

        return {
          title,
          slug: slugify(url),
          content,
          excerpt,
          date,
          seoTitle,
          seoDescription,
          mediaUrls,
          qualityScore,
          categories,
          tags,
          detectedType,
          author,
        };
      },
    });

    // Finalize product CSV — reads JSONL and writes CSV
    if (hasProducts && outputDir && !shopifyOpts.dryRun) {
      if (csvBuilder.isStreaming) {
        csvBuilder.closeStream();
      } else {
        csvBuilder.serialize(`${outputDir}/products.csv`);
      }
    }

    return result;
    } finally {
      if (browserSession) await (browserSession as { close: () => Promise<void> }).close();
    }
  },
};
