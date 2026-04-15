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

export interface WeeblyAdapterOpts extends Record<string, unknown> {
  delay?: number;
  resume?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  outputDir?: string;
}

export interface WeeblyInventory {
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
// HTML helpers
// ---------------------------------------------------------------------------

/**
 * Extract the inner HTML of the first element matching a given class or ID,
 * handling nested tags of the same type by tracking depth.
 */
function extractBySelector(html: string, pattern: RegExp, tag = 'div'): string {
  const match = html.match(pattern);
  if (!match) return '';

  const startIdx = html.indexOf(match[0]);
  const afterTag = startIdx + match[0].length;
  let depth = 1;
  let i = afterTag;
  const openTag = `<${tag}`;
  const closeTag = `</${tag}>`;

  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf(openTag, i);
    const nextClose = html.indexOf(closeTag, i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + openTag.length;
    } else {
      depth--;
      if (depth === 0) {
        return html.slice(afterTag, nextClose).trim();
      }
      i = nextClose + closeTag.length;
    }
  }
  return '';
}

/**
 * Extract content from Weebly's #wsite-content container.
 * Falls back to <main>, <article>, or body content.
 */
function extractContent(html: string): string {
  // Strategy 1: Weebly's main content container
  const wsiteContent = extractBySelector(html, /<div[^>]*\sid=["']wsite-content["'][^>]*>/i);
  if (wsiteContent) return wsiteContent;

  // Strategy 2: <main> tag
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch?.[1]?.trim()) return mainMatch[1].trim();

  // Strategy 3: <article> tag
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch?.[1]?.trim()) return articleMatch[1].trim();

  return '';
}

/**
 * Extract heading from the page — tries h1, then og:title, then <title>.
 */
function extractHeading(html: string): string {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]*>/g, '').trim();
  if (h1) return h1;

  const ogTitle = extractMeta(html, 'og:title');
  if (ogTitle) return ogTitle;

  return extractTitle(html);
}

/**
 * Extract Weebly navigation links from the wsite-menu structure.
 * Weebly uses li.wsite-menu-item-wrap > a.wsite-menu-item for top-level nav.
 * Falls back to the shared <nav> extractor.
 */
function extractWeeblyNavLinks(html: string, baseUrl: string): NavLink[] {
  const links: NavLink[] = [];
  const seen = new Set<string>();

  // Match Weebly menu items: <a ... class="wsite-menu-item" ...>text</a>
  const menuItemPattern = /<a[^>]+class=["'][^"']*wsite-menu-item[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = menuItemPattern.exec(html)) !== null) {
    const fullTag = match[0];
    const text = match[1].replace(/<[^>]*>/g, '').trim();
    const hrefMatch = fullTag.match(/href=["']([^"']+)["']/i);
    if (!text || !hrefMatch) continue;

    let href = hrefMatch[1];
    if (seen.has(href)) continue;
    seen.add(href);

    // Normalize protocol-relative and relative URLs
    if (href.startsWith('//')) {
      href = 'https:' + href;
    } else if (href.startsWith('/')) {
      try {
        href = new URL(href, baseUrl).href;
      } catch {
        // keep as-is
      }
    }

    links.push({ text, href });
  }

  // Fall back to generic <nav> extraction if Weebly menu structure wasn't found
  if (links.length === 0) {
    return extractNavLinks(html, baseUrl);
  }

  return links;
}

/**
 * Extract media URLs from Weebly content.
 * Looks for editmysite.com CDN URLs, weeblycloud.com, and standard <img> tags.
 */
function extractWeeblyMediaUrls(html: string): string[] {
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

/**
 * Extract blog post date from Weebly's date format.
 * Weebly displays dates as plain text in MM/DD/YYYY format.
 */
function extractWeeblyDate(html: string): string {
  // Try standard meta tags first
  const articleDate = extractMeta(html, 'article:published_time');
  if (articleDate) return articleDate;

  // Weebly blog date in date-text class
  const dateTextMatch = html.match(/class=["'][^"']*date-text[^"']*["'][^>]*>([^<]+)</i);
  if (dateTextMatch?.[1]) {
    const dateStr = dateTextMatch[1].trim();
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }

  // <time> element — prefer semantic markup before falling back to text scraping
  const timeElement = html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];
  if (timeElement) return timeElement;

  // Weebly blog date as plain text in MM/DD/YYYY format. Scope the search to
  // the #wsite-content container so we don't pick up stray dates from footer
  // copyright lines, testimonials, or chrome.
  const contentScope = extractBySelector(html, /<div[^>]*\sid=["']wsite-content["'][^>]*>/i) || html;
  const datePattern = /(\d{1,2}\/\d{1,2}\/\d{4})/;
  const dateMatch = contentScope.match(datePattern);
  if (dateMatch?.[1]) {
    const parsed = new Date(dateMatch[1]);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }

  return '';
}

/**
 * Extract blog categories from Weebly's category links.
 * Weebly uses /blog/category/slug format for category pages.
 */
function extractWeeblyCategories(html: string): string[] {
  const categories: string[] = [];
  const seen = new Set<string>();

  const categoryPattern = /href=["'][^"']*\/blog\/category\/([^"']+)["'][^>]*>([^<]+)/gi;
  let match;
  while ((match = categoryPattern.exec(html)) !== null) {
    const name = match[2].trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      categories.push(name);
    }
  }

  return categories;
}

// ---------------------------------------------------------------------------
// Resolve relative URLs in HTML content to absolute
// ---------------------------------------------------------------------------

/**
 * Rewrite relative src and href attributes in HTML to absolute URLs.
 * This ensures WordPress can match attachment URLs in content during import.
 */
function resolveRelativeUrls(html: string, baseUrl: string): string {
  let origin: string;
  try {
    origin = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin;
  } catch {
    return html;
  }

  // Resolve src="/..." and href="/..." to absolute URLs.
  // The (?!\/) guard skips protocol-relative URLs like src="//cdn.example.com/...",
  // which would otherwise be mangled into "https://site.com//cdn.example.com/...".
  return html.replace(/(src|href)=["'](\/(?!\/)[^"']+)["']/gi, (_match, attr, path) => {
    return `${attr}="${origin}${path}"`;
  });
}

// ---------------------------------------------------------------------------
// Weebly product extraction from HTML
// ---------------------------------------------------------------------------

/**
 * Extract product data from a Weebly product page.
 *
 * Weebly product pages have minimal semantic markup — the content inside
 * #wsite-content is flat: an <h2> for the title, plain divs for price/SKU,
 * and paragraphs for the description. There are no product-specific classes
 * on the actual DOM elements (only in CSS selectors).
 *
 * We extract from within #wsite-content to avoid picking up nav/header text.
 */
function extractWeeblyProduct(_url: string, html: string): WooProduct | null {
  // NOTE: html here is pageData.content — already scoped to #wsite-content
  // by extractContent(). No need to re-scope.
  if (!html) return null;

  // Product title: first <h2> in the content
  const titleMatch = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const name = titleMatch?.[1]?.replace(/<[^>]*>/g, '').trim();
  if (!name) return null;

  // Price: look for dollar amount pattern
  // Weebly renders price as flat text like "$8.50" or "$8.50 per item"
  const pricePattern = /\$\s*(\d+(?:\.\d{2})?)/;
  const priceMatch = html.match(pricePattern);
  const firstPrice = priceMatch?.[1] || '';

  // Sale price: look for crossed-out / original price patterns
  const salePriceMatch = html.match(/class=["'][^"']*(?:sale|original)[^"']*["'][^>]*>\s*\$\s*(\d+(?:\.\d{2})?)/i);
  const salePrice = salePriceMatch?.[1] || undefined;

  // Description: collect text from <p> tags first. If no <p> tags produce
  // results, fall back to <div class="paragraph"> blocks. Weebly wraps text
  // in both, and the <div> version often contains a concatenated duplicate
  // of all the <p> content, so we prefer <p> tags when available.
  const descParts: string[] = [];

  function isDescText(text: string): boolean {
    if (text.length < 15) return false;
    if (/^\$\d/.test(text)) return false;
    if (/^SKU:/i.test(text)) return false;
    if (/^(Add to Cart|Unavailable|Out of Stock|per item|Have questions|Items handcrafted)/i.test(text)) return false;
    return true;
  }

  // Try <p> tags first
  const pTags = html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
  for (const p of pTags) {
    const text = p.replace(/<[^>]*>/g, '').trim();
    if (isDescText(text)) descParts.push(text);
  }

  // Fall back to <div class="paragraph"> blocks if no <p> content found
  if (descParts.length === 0) {
    const divParas = html.match(/<div[^>]+class=["'][^"']*paragraph[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi) || [];
    for (const div of divParas) {
      const text = div.replace(/<[^>]*>/g, '').trim();
      if (isDescText(text)) descParts.push(text);
    }
  }

  const description = descParts.join('\n\n');

  // Images: Weebly product images in /uploads/ paths
  const images: string[] = [];
  const imgPattern = /<img[^>]+src=["']([^"']*\/uploads\/[^"']+)["']/gi;
  let imgMatch;
  while ((imgMatch = imgPattern.exec(html)) !== null) {
    let src = imgMatch[1];
    // Make absolute if relative
    if (src.startsWith('/')) {
      try {
        const urlObj = new URL(_url);
        src = urlObj.origin + src;
      } catch { /* keep relative */ }
    }
    // Strip Weebly resize params for original image
    src = src.replace(/\?width=\d+/, '');
    if (!images.includes(src)) {
      images.push(src);
    }
  }

  // Also check for CDN-hosted product images
  const cdnImgPattern = /<img[^>]+src=["'](https?:\/\/[^"']*editmysite\.com\/[^"']+)["']/gi;
  while ((imgMatch = cdnImgPattern.exec(html)) !== null) {
    const src = imgMatch[1];
    if (IMAGE_EXTENSIONS.test(src) && !images.includes(src)) {
      images.push(src);
    }
  }

  return {
    name,
    type: 'simple',
    description,
    regularPrice: firstPrice,
    salePrice,
    images,
    // Default to in-stock. Weebly's commerce template often renders "Unavailable"
    // as part of the page chrome even for products that are in stock, so we can't
    // reliably detect stock status from the static HTML alone.
    inStock: true,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const weeblyAdapter: PlatformAdapter = {
  id: 'weebly',

  detect(url: string): boolean {
    return /weebly\.com/i.test(url);
  },

  async discover(url: string, _opts: Record<string, unknown>): Promise<WeeblyInventory> {
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

    // Detect language from <html lang="...">
    const langMatch = homepageHtml.match(/<html[^>]+lang=["']([^"']+)["']/i);
    const siteLanguage = langMatch?.[1] || 'en-US';

    // 3. Fetch sitemap
    const sitemapUrls = await fetchSitemap(url);

    // 4. Extract navigation from Weebly menu structure
    const normalized = url.includes('://') ? url : `https://${url}`;
    const navigation = extractWeeblyNavLinks(homepageHtml, normalized);

    // 5. Classify URLs
    const counts: Record<string, number> = {};
    const inventoryUrls: InventoryUrl[] = [];

    for (const u of sitemapUrls) {
      // Weebly blog posts live under /blog/ paths
      let type = classifyUrl(u);
      if (type === 'page' && /\/blog\//.test(u) && !/\/blog\/category\//.test(u)) {
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
    const inv = inventory as WeeblyInventory;
    const wbOpts = opts as WeeblyAdapterOpts;
    const delayMs = wbOpts.delay != null ? wbOpts.delay : 300;
    const outputDir = wbOpts.outputDir || '';

    const csvBuilder = new WooProductCsvBuilder();
    if (outputDir && !wbOpts.dryRun) {
      csvBuilder.openStream(outputDir);
    }

    const result = await runExtractionLoop({
      urls: inv.urls,
      navigation: inv.navigation,
      wxr,
      log: context.log,
      outputDir,
      delay: delayMs,
      dryRun: !!wbOpts.dryRun,
      resume: !!wbOpts.resume,
      verbose: wbOpts.verbose,
      server: context.server,
      csvBuilder,
      extractPage: async (url: string) => {
        // Fetch the page HTML
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

        // Extract content and resolve relative URLs to absolute so WordPress
        // can match attachment URLs during import (rewrites src="/uploads/..." etc.)
        const content = resolveRelativeUrls(extractContent(html), url);
        const title = extractHeading(html) || slugify(url);
        const excerpt = extractMeta(html, 'og:description') || extractMeta(html, 'description') || '';
        const seoTitle = extractMeta(html, 'og:title') || extractTitle(html) || title;
        const seoDescription = excerpt;

        // Extract date
        const date = extractWeeblyDate(html);

        // Extract media
        const mediaUrls = extractWeeblyMediaUrls(html);

        // Extract OG image
        const ogImage = extractMeta(html, 'og:image');
        if (ogImage && ogImage.startsWith('http') && !mediaUrls.includes(ogImage)) {
          try {
            if (IMAGE_EXTENSIONS.test(new URL(ogImage).pathname)) {
              mediaUrls.push(ogImage);
            }
          } catch { /* invalid URL */ }
        }

        // Extract categories from blog posts
        const categories = extractWeeblyCategories(html);

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
        };
      },
      extractProduct: extractWeeblyProduct,
    });

    if (result.productsExtracted > 0 && outputDir && !wbOpts.dryRun) {
      if (csvBuilder.isStreaming) {
        csvBuilder.closeStream();
      } else {
        csvBuilder.serialize(`${outputDir}/products.csv`);
      }
    }

    return result;
  },
};
