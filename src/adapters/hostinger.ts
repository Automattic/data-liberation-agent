import type { PlatformAdapter } from '../types.js';
import type { WxrBuilder } from '../lib/extraction/wxr-builder.js';
import type { ExtractionLog } from '../lib/extraction/extraction-log.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { fetchSitemap, classifyUrl } from '../lib/extraction/sitemap.js';
import { slugify, runExtractionLoop, extractMeta, extractTitle, extractNavLinks, IMAGE_EXTENSIONS } from './shared.js';
import type { InventoryUrl, NavLink } from './shared.js';
import { WooProductCsvBuilder } from '../lib/import/woo-product-csv.js';
import type { WooProduct } from '../lib/import/woo-product-csv.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HostingerAdapterOpts extends Record<string, unknown> {
  delay?: number;
  resume?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  outputDir?: string;
}

export interface HostingerInventory {
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

// ---------------------------------------------------------------------------
// JSON-LD parsing
// ---------------------------------------------------------------------------

/**
 * Extract and parse all JSON-LD blocks from HTML.
 */
function extractJsonLdBlocks(html: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed)) {
        for (const p of parsed) if (p && typeof p === 'object') blocks.push(p as Record<string, unknown>);
      } else if (parsed && typeof parsed === 'object') {
        blocks.push(parsed as Record<string, unknown>);
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return blocks;
}

/**
 * Find the first JSON-LD block with type matching the given pattern (e.g. /Article/).
 */
function findJsonLdByType(blocks: Array<Record<string, unknown>>, typePattern: RegExp): Record<string, unknown> | null {
  for (const block of blocks) {
    const type = block['@type'];
    if (typeof type === 'string' && typePattern.test(type)) return block;
    if (Array.isArray(type) && type.some((t) => typeof t === 'string' && typePattern.test(t))) return block;
  }
  return null;
}

/**
 * Convert a JSON-LD Product block into a WooProduct for CSV output.
 */
function jsonLdToWooProduct(ld: Record<string, unknown>, sourceUrl: string): WooProduct | null {
  const name = typeof ld.name === 'string' ? ld.name : '';
  if (!name) return null;

  const offers = Array.isArray(ld.offers)
    ? ld.offers as Array<Record<string, unknown>>
    : ld.offers && typeof ld.offers === 'object'
      ? [ld.offers as Record<string, unknown>]
      : [];
  const firstOffer = offers[0];
  const price = firstOffer?.price != null ? String(firstOffer.price) : '';
  const availability = typeof firstOffer?.availability === 'string' ? firstOffer.availability : '';

  const images: string[] = [];
  if (typeof ld.image === 'string') {
    images.push(ld.image);
  } else if (Array.isArray(ld.image)) {
    for (const img of ld.image) {
      if (typeof img === 'string') images.push(img);
      else if (img && typeof img === 'object' && typeof (img as { url?: unknown }).url === 'string') {
        images.push((img as { url: string }).url);
      }
    }
  }

  return {
    name,
    type: 'simple',
    description: typeof ld.description === 'string' ? ld.description : '',
    regularPrice: price,
    sku: typeof ld.sku === 'string' ? ld.sku : '',
    images,
    inStock: availability ? /InStock/i.test(availability) : true,
    sourceUrl,
  };
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

/**
 * Extract content from a Hostinger Website Builder page.
 *
 * Hostinger's builder is built on Astro/Vue and renders content as
 * <section class="block ...">...</section> blocks. Chrome elements use
 * modifier classes (block-sticky-bar, block--footer, block-header, etc.)
 * which we skip. Generic `class="block"` and `class="block transition..."`
 * sections contain the actual page content.
 *
 * Strategy:
 * 1. Try <main> and <article> first (for sites that have them)
 * 2. Collect <section class="block ..."> content blocks, skipping chrome
 * 3. Fall back to <body> with chrome elements stripped
 */
const HOSTINGER_CHROME_CLASS = /\b(block-sticky-bar|block-header|block--footer|block-header-cart|block-header-item|block-blog-header)\b/;
const CHROME_SECTION_STRIP = /<section[^>]*\bclass=["'][^"']*\b(block-sticky-bar|block-header|block--footer|block-blog-header)\b[^"']*["'][^>]*>[\s\S]*?<\/section>/gi;
const NAV_HEADER_FOOTER_STRIP = [
  /<nav\b[^>]*>[\s\S]*?<\/nav>/gi,
  /<header\b[^>]*>[\s\S]*?<\/header>/gi,
  /<footer\b[^>]*>[\s\S]*?<\/footer>/gi,
];

function stripChrome(html: string): string {
  let out = html;
  for (const pattern of NAV_HEADER_FOOTER_STRIP) out = out.replace(pattern, '');
  return out.replace(CHROME_SECTION_STRIP, '');
}

function extractContent(html: string): string {
  // Strategy 1: Hostinger's <section class="block ..."> blocks.
  // Checked first because <main> on Astro sites wraps ALL page content
  // including chrome, so main-based extraction would include site furniture.
  const sectionPattern = /<section[^>]*\bclass=["']([^"']*)["'][^>]*>([\s\S]*?)<\/section>/gi;
  const contentBlocks: string[] = [];
  let match;
  while ((match = sectionPattern.exec(html)) !== null) {
    const className = match[1];
    const inner = match[2];
    if (!/\bblock\b/.test(className)) continue;
    if (HOSTINGER_CHROME_CLASS.test(className)) continue;
    if (inner.trim()) contentBlocks.push(inner.trim());
  }
  if (contentBlocks.length > 0) return contentBlocks.join('\n\n');

  // Strategy 2: <article> tag
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch?.[1]?.trim()) return articleMatch[1].trim();

  // Strategy 3: <main> with chrome stripped
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch?.[1]?.trim()) return stripChrome(mainMatch[1]).trim();

  // Strategy 4: <body> with chrome stripped (last resort)
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1]) return stripChrome(bodyMatch[1]).trim();

  return '';
}

/**
 * Extract page heading — tries h1, then og:title, then <title>.
 */
function extractHeading(html: string): string {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]*>/g, '').trim();
  if (h1) return h1;

  const ogTitle = extractMeta(html, 'og:title');
  if (ogTitle) return ogTitle;

  return extractTitle(html);
}

/**
 * Extract media URLs from a Hostinger page.
 *
 * Hostinger serves images from assets.zyrosite.com via Cloudflare Image Resize
 * with URLs like:
 *   https://assets.zyrosite.com/cdn-cgi/image/format=auto,w=400,h=280,fit=crop/SITE_ID/image-HASH.png
 *
 * We strip the /cdn-cgi/image/...params.../ portion to get the original image URL,
 * which gives us better quality and deduplication (since resize params vary per page).
 */
function extractHostingerMediaUrls(html: string): string[] {
  const urls = new Set<string>();

  // Match zyrosite CDN image URLs (full, including resize params)
  const zyroPattern = /https?:\/\/[^\s"'<>)]*zyrosite\.com\/[^\s"'<>)]+/g;
  const zyroMatches = html.match(zyroPattern) || [];
  for (const m of zyroMatches) {
    // Strip Cloudflare Image Resize prefix to get the original asset URL
    const normalized = m.replace(
      /(https?:\/\/[^/]+\/cdn-cgi\/image\/[^/]+\/)(.+)/,
      (_all, _prefix, path) => `https://assets.zyrosite.com/${path}`
    );
    urls.add(normalized);
  }

  // Standard <img> tags
  const imgSrcMatches = html.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
  for (const imgMatch of imgSrcMatches) {
    const src = imgMatch.match(/src=["']([^"']+)["']/i);
    if (src?.[1] && src[1].startsWith('http')) {
      urls.add(src[1]);
    }
  }

  // Filter to image URLs only
  const nonImageExtensions = /\.(css|js|json|xml|txt|map|woff2?|ttf|eot|pdf)$/i;
  return [...urls].filter((u) => {
    try {
      const parsed = new URL(u);
      if (nonImageExtensions.test(parsed.pathname)) return false;
      // zyrosite URLs often lack extensions in the path but are always images
      if (/zyrosite\.com/i.test(parsed.hostname)) return true;
      return IMAGE_EXTENSIONS.test(parsed.pathname);
    } catch {
      return false;
    }
  });
}

/**
 * Strip the first <h1> element if its text matches the post title.
 *
 * Hostinger's blog templates render the post title as an <h1> inside the
 * content body (.block-blog-header__title). When WordPress displays the
 * post, it shows the post_title field PLUS this embedded h1, producing
 * a duplicated title. Stripping the matching h1 avoids that.
 */
function stripDuplicateTitle(html: string, title: string): string {
  if (!title) return html;
  // Normalize for comparison: strip tags, collapse whitespace, lowercase
  const normalize = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizedTitle = normalize(title);
  if (!normalizedTitle) return html;

  return html.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/i, (fullMatch, inner) => {
    return normalize(inner) === normalizedTitle ? '' : fullMatch;
  });
}

/**
 * Rewrite relative src and href attributes in HTML to absolute URLs.
 * Ensures WordPress can match attachment URLs in content during import.
 */
function resolveRelativeUrls(html: string, baseUrl: string): string {
  let origin: string;
  try {
    origin = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin;
  } catch {
    return html;
  }

  return html.replace(/(src|href)=["'](\/[^"']+)["']/gi, (_match, attr, path) => {
    return `${attr}="${origin}${path}"`;
  });
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const hostingerAdapter: PlatformAdapter = {
  id: 'hostinger',

  detect(_url: string): boolean {
    // Hostinger sites are on custom domains with no reliable URL pattern.
    // Detection relies entirely on HTTP fingerprinting (see detect-platform.ts
    // SOURCE_SIGNALS for zyrosite.com and Hostinger generator meta tag).
    return false;
  },

  async discover(url: string, _opts: Record<string, unknown>): Promise<HostingerInventory> {
    // 1. Fetch homepage HTML
    let homepageHtml = '';
    try {
      const normalized = url.includes('://') ? url : `https://${url}`;
      const resp = await fetch(normalized, {
        signal: AbortSignal.timeout(15000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)',
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
    const ogTitle = extractMeta(homepageHtml, 'og:title');
    const ogDescription = extractMeta(homepageHtml, 'og:description');
    const siteTitle = ogTitle || extractTitle(homepageHtml) || 'Imported Site';
    const siteTagline = ogDescription || extractMeta(homepageHtml, 'description') || '';

    // Detect language from <html lang="..."> — important for non-English sites
    const langMatch = homepageHtml.match(/<html[^>]+lang=["']([^"']+)["']/i);
    const siteLanguage = langMatch?.[1] || 'en-US';

    // 3. Fetch sitemap
    const sitemapUrls = await fetchSitemap(url);

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
        title: siteTitle,
        tagline: siteTagline,
        language: siteLanguage,
      },
      navigation,
      counts,
      urls: inventoryUrls,
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
    productsExtracted: number;
    failed: number;
    mediaCollected: number;
  }> {
    const inv = inventory as HostingerInventory;
    const hoOpts = opts as HostingerAdapterOpts;
    const delayMs = hoOpts.delay != null ? hoOpts.delay : 300;
    const outputDir = hoOpts.outputDir || '';

    const csvBuilder = new WooProductCsvBuilder();
    if (outputDir && !hoOpts.dryRun) {
      csvBuilder.openStream(outputDir);
    }

    // Cache product data extracted during extractPage (where we have the full
    // HTML including JSON-LD scripts from <head>). The shared loop's
    // extractProduct callback looks up by URL rather than re-fetching.
    const productCache = new Map<string, WooProduct>();

    const result = await runExtractionLoop({
      urls: inv.urls,
      navigation: inv.navigation,
      wxr,
      log: context.log,
      outputDir,
      delay: delayMs,
      dryRun: !!hoOpts.dryRun,
      resume: !!hoOpts.resume,
      verbose: hoOpts.verbose,
      limit: hoOpts.limit as number | undefined,
      server: context.server,
      csvBuilder,
      extractPage: async (url: string) => {
        // Fetch the page HTML, throwing on non-200 so the loop logs the failure.
        const resp = await fetch(url, {
          signal: AbortSignal.timeout(15000),
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)',
          },
        });
        if (!resp.ok) {
          await resp.body?.cancel();
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }
        const html = await resp.text();

        // Extract structured data — Hostinger blog posts include rich JSON-LD
        const ldBlocks = extractJsonLdBlocks(html);
        const article = findJsonLdByType(ldBlocks, /^(Article|BlogPosting|NewsArticle)$/);
        const product = findJsonLdByType(ldBlocks, /^Product$/);

        // Detect product pages: Hostinger marks them with a .block-product wrapper
        // and/or a JSON-LD Product schema. Both signals are reliable.
        const isProduct = !!product || /class=["'][^"']*\bblock-product(?:-wrapper)?\b/.test(html);

        // Cache product data for the shared loop's extractProduct callback.
        // The callback only receives pageData.content (stripped of <head>),
        // so we extract from the full HTML here where JSON-LD is still available.
        if (isProduct && product) {
          const wooProduct = jsonLdToWooProduct(product, url);
          if (wooProduct) productCache.set(url, wooProduct);
        }

        // Title: prefer JSON-LD headline, then h1/og:title/title
        const title =
          (article?.headline as string) ||
          extractHeading(html) ||
          slugify(url);

        // Extract content, strip the duplicate title h1, and resolve relative URLs
        // for WordPress import compatibility. Title is stripped so the rendered
        // page doesn't show "My Title" above "My Title" (post_title + embedded h1).
        const content = resolveRelativeUrls(
          stripDuplicateTitle(extractContent(html), title),
          url
        );

        const excerpt = extractMeta(html, 'og:description') || extractMeta(html, 'description') || '';
        const seoTitle = extractMeta(html, 'og:title') || extractTitle(html) || title;
        const seoDescription = excerpt;

        // Date: prefer JSON-LD datePublished, then article:published_time meta, then <time>
        let date = (article?.datePublished as string) || '';
        if (!date) date = extractMeta(html, 'article:published_time') || '';
        if (!date) {
          const timeElement = html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];
          if (timeElement) date = timeElement;
        }

        // Categories: JSON-LD articleSection (may be string or array)
        let categories: string[] = [];
        const section = article?.articleSection;
        if (typeof section === 'string') {
          categories = [section];
        } else if (Array.isArray(section)) {
          categories = section.filter((s): s is string => typeof s === 'string');
        }

        // Author: JSON-LD author.name (single or array)
        let author: string | undefined;
        const ldAuthor = article?.author;
        if (ldAuthor && typeof ldAuthor === 'object') {
          if (Array.isArray(ldAuthor)) {
            const first = ldAuthor[0];
            if (first && typeof first === 'object' && typeof (first as { name?: unknown }).name === 'string') {
              author = (first as { name: string }).name;
            }
          } else if (typeof (ldAuthor as { name?: unknown }).name === 'string') {
            author = (ldAuthor as { name: string }).name;
          }
        }

        // Extract media
        const mediaUrls = extractHostingerMediaUrls(html);

        // OG image fallback
        const ogImage = extractMeta(html, 'og:image');
        if (ogImage && ogImage.startsWith('http') && !mediaUrls.includes(ogImage)) {
          try {
            const parsed = new URL(ogImage);
            if (IMAGE_EXTENSIONS.test(parsed.pathname) || /zyrosite\.com/i.test(parsed.hostname)) {
              mediaUrls.push(ogImage);
            }
          } catch { /* invalid URL */ }
        }

        // Quality score based on content length
        const textOnly = content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        let qualityScore: 'high' | 'medium' | 'low' = 'low';
        if (textOnly.length > 200) qualityScore = 'high';
        else if (textOnly.length > 50) qualityScore = 'medium';

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
          tags: [],
          author,
          // Signal product pages to the shared loop so they route to products.csv
          // instead of being imported as regular pages. Hostinger marks product
          // pages with .block-product wrappers and/or JSON-LD Product schema.
          detectedType: isProduct ? 'product' : undefined,
        };
      },
      extractProduct: (url: string) => productCache.get(url) ?? null,
    });

    if (result.productsExtracted > 0 && outputDir && !hoOpts.dryRun) {
      if (csvBuilder.isStreaming) {
        csvBuilder.closeStream();
      } else {
        csvBuilder.serialize(`${outputDir}/products.csv`);
      }
    }

    return result;
  },
};
