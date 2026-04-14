import type { PlatformAdapter } from '../types.js';
import type { WxrBuilder } from '../lib/extraction/wxr-builder.js';
import type { ExtractionLog } from '../lib/extraction/extraction-log.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { fetchSitemap, classifyUrl } from '../lib/extraction/sitemap.js';
import { slugify, runExtractionLoop, extractMeta, extractTitle, extractNavLinks, IMAGE_EXTENSIONS } from './shared.js';
import type { InventoryUrl, NavLink } from './shared.js';
import { WooProductCsvBuilder } from '../lib/import/woo-product-csv.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HubSpotAdapterOpts extends Record<string, unknown> {
  delay?: number;
  resume?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  outputDir?: string;
}

export interface HubSpotInventory {
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
 * Extract a specific HTML element's inner content by matching a class on a
 * given tag (usually div). Handles nested tags of the same type by depth tracking.
 */
function extractByClass(html: string, className: string, tag = 'div'): string {
  const openPattern = new RegExp(`<${tag}[^>]*\\bclass=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`, 'i');
  const openMatch = html.match(openPattern);
  if (!openMatch) return '';

  const startIdx = html.indexOf(openMatch[0]);
  const afterTag = startIdx + openMatch[0].length;
  const openTag = `<${tag}`;
  const closeTag = `</${tag}>`;

  let depth = 1;
  let i = afterTag;
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
 * Get the body element's class attribute. HubSpot tags the body with classes
 * that identify the content type (e.g. `hs-blog-post`, `hs-site-page`).
 */
function getBodyClass(html: string): string {
  const match = html.match(/<body[^>]*\bclass=["']([^"']*)["']/i);
  return match?.[1] || '';
}

/**
 * Check if this page is a HubSpot blog post based on body class.
 * HubSpot sets `hs-blog-post` on <body> for blog post pages.
 */
function isHubSpotBlogPost(html: string): boolean {
  return /\bhs-blog-post\b/.test(getBodyClass(html));
}

/**
 * Strip HubSpot marketing widgets from content:
 * - CTAs (`hs-cta-wrapper`, `hs-cta-node`) — interactive marketing widgets
 * - Forms (`hs_cos_wrapper_type_form`) — HubSpot-hosted lead forms
 * - Comments widget (`hs_cos_wrapper_type_blog_comments`)
 * - AddThis social sharing widgets
 * These don't translate meaningfully to WordPress and clutter the imported content.
 */
function stripHubSpotWidgets(html: string): string {
  let out = html;
  // Strip CTA wrappers
  out = out.replace(/<(div|span)[^>]*\bclass=["'][^"']*\bhs-cta-(wrapper|node)\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, '');
  // Strip form wrappers
  out = out.replace(
    /<div[^>]*\bclass=["'][^"']*\bhs_cos_wrapper_type_form\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
    ''
  );
  // Strip blog comments widget
  out = out.replace(
    /<div[^>]*\bclass=["'][^"']*\bhs_cos_wrapper_type_blog_comments\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
    ''
  );
  // Strip AddThis widgets
  out = out.replace(
    /<div[^>]*\bclass=["'][^"']*\baddthis[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
    ''
  );
  return out;
}

/**
 * Extract content from a HubSpot page.
 *
 * Strategy:
 * 1. Blog posts: use `.post-body` container (clean article content)
 * 2. Regular pages: use `.body-container` with navigation/chrome stripped
 * 3. Fallback to `<main>` or stripped `<body>`
 */
function extractContent(html: string): string {
  const isPost = isHubSpotBlogPost(html);

  if (isPost) {
    // Blog posts have a clean `.post-body` container
    const postBody = extractByClass(html, 'post-body');
    if (postBody) return stripHubSpotWidgets(postBody);
  }

  // Regular pages: .body-container wraps all content, then strip chrome
  const bodyContainer = extractByClass(html, 'body-container');
  if (bodyContainer) {
    let content = bodyContainer;
    content = content.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '');
    content = content.replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '');
    content = content.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '');
    return stripHubSpotWidgets(content);
  }

  // Fallback: <main>
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch?.[1]?.trim()) return stripHubSpotWidgets(mainMatch[1]);

  // Last resort: <body> with chrome stripped
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1]) {
    let body = bodyMatch[1];
    body = body.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '');
    body = body.replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '');
    body = body.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '');
    return stripHubSpotWidgets(body);
  }

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
 * Extract publication date from a HubSpot blog post.
 *
 * HubSpot renders dates in multiple places:
 * 1. <meta property="article:published_time" content="...">
 * 2. <time datetime="..."> element (sometimes)
 * 3. Byline text like "by Jason Bullard, on Dec 6, 2024 6:57:40 PM"
 */
function extractHubSpotDate(html: string): string {
  const articleDate = extractMeta(html, 'article:published_time');
  if (articleDate) return articleDate;

  const timeElement = html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];
  if (timeElement) return timeElement;

  // Byline pattern: "on Dec 6, 2024 6:57:40 PM"
  const bylineDate = html.match(/\bon\s+([A-Z][a-z]{2,}\s+\d{1,2},\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M)?)/);
  if (bylineDate?.[1]) {
    const parsed = new Date(bylineDate[1]);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }

  return '';
}

/**
 * Extract author name from HubSpot blog post.
 *
 * HubSpot blog posts link to the author via /author/name paths.
 * Falls back to the `<meta name="author">` tag.
 */
function extractHubSpotAuthor(html: string): string | undefined {
  const authorLink = html.match(/<a[^>]+href=["'][^"']*\/author\/[^"']+["'][^>]*>([^<]+)<\/a>/i);
  if (authorLink?.[1]) return authorLink[1].replace(/<[^>]*>/g, '').trim();

  const metaAuthor = extractMeta(html, 'author');
  return metaAuthor || undefined;
}

/**
 * Extract tags from HubSpot blog post topic links.
 * Topics appear as links to /topic/{slug} paths.
 */
function extractHubSpotTags(html: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const pattern = /<a[^>]+href=["'][^"']*\/topic\/[^"']+["'][^>]*>([^<]+)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const name = match[1].replace(/<[^>]*>/g, '').trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      tags.push(name);
    }
  }
  return tags;
}

/**
 * Extract media URLs from a HubSpot page.
 *
 * HubSpot serves media from several patterns:
 * - /hubfs/ paths on the site itself
 * - hubspotusercontent-*.net CDN (regional)
 * - f.hubspotusercontent*.net for files
 * - Standard <img> tags
 */
function extractHubSpotMediaUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();

  // HubSpot CDN (regional user content)
  const cdnPattern = /https?:\/\/[^\s"'<>)]*hubspotusercontent[^\s"'<>)]+/gi;
  for (const m of html.match(cdnPattern) || []) urls.add(m);

  // /hubfs/ paths (may be relative or absolute)
  let origin: string | null = null;
  try {
    origin = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin;
  } catch {
    origin = null;
  }

  const hubfsPattern = /(?:https?:\/\/[^\s"'<>)]+)?\/hubfs\/[^\s"'<>)]+/g;
  for (const m of html.match(hubfsPattern) || []) {
    if (m.startsWith('http')) {
      urls.add(m);
    } else if (origin) {
      urls.add(origin + m);
    }
  }

  // Standard <img> tags
  const imgSrcMatches = html.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
  for (const imgMatch of imgSrcMatches) {
    const src = imgMatch.match(/src=["']([^"']+)["']/i);
    if (src?.[1] && src[1].startsWith('http')) {
      urls.add(src[1]);
    }
  }

  // Filter to image URLs
  const nonImageExtensions = /\.(css|js|json|xml|txt|map|woff2?|ttf|eot|pdf)$/i;
  return [...urls].filter((u) => {
    try {
      const parsed = new URL(u);
      if (nonImageExtensions.test(parsed.pathname)) return false;
      // HubSpot CDN and /hubfs/ paths typically host images without explicit extensions
      if (/hubspotusercontent|hubfs/i.test(parsed.hostname + parsed.pathname)) return true;
      return IMAGE_EXTENSIONS.test(parsed.pathname);
    } catch {
      return false;
    }
  });
}

/**
 * Rewrite relative src and href attributes in HTML to absolute URLs.
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

/**
 * Strip the first <h1> if its text matches the post title.
 * HubSpot renders the title inside content; WordPress also displays post_title.
 */
function stripDuplicateTitle(html: string, title: string): string {
  if (!title) return html;
  const normalize = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizedTitle = normalize(title);
  if (!normalizedTitle) return html;

  return html.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/i, (fullMatch, inner) => {
    return normalize(inner) === normalizedTitle ? '' : fullMatch;
  });
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const hubspotAdapter: PlatformAdapter = {
  id: 'hubspot',

  detect(_url: string): boolean {
    // HubSpot CMS sites are on custom domains with no usable URL pattern.
    // Detection relies on the Hubspot generator meta tag in detect-platform.ts.
    return false;
  },

  async discover(url: string, _opts: Record<string, unknown>): Promise<HubSpotInventory> {
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
      // Network error
    }

    // 2. Extract site metadata
    const ogTitle = extractMeta(homepageHtml, 'og:title');
    const ogDescription = extractMeta(homepageHtml, 'og:description');
    const siteTitle = ogTitle || extractTitle(homepageHtml) || 'Imported Site';
    const siteTagline = ogDescription || extractMeta(homepageHtml, 'description') || '';

    const langMatch = homepageHtml.match(/<html[^>]+lang=["']([^"']+)["']/i);
    const siteLanguage = langMatch?.[1] || 'en-US';

    // 3. Fetch sitemap
    const sitemapUrls = await fetchSitemap(url);

    // 4. Extract navigation
    const normalized = url.includes('://') ? url : `https://${url}`;
    const navigation = extractNavLinks(homepageHtml, normalized);

    // 5. Classify URLs
    // HubSpot blog posts typically live under paths like /blog/, /news/, or
    // /{custom-blog-name}/. URL-pattern classification catches /blog/ but
    // custom blog paths will be reclassified during extraction based on the
    // body class `hs-blog-post`.
    const counts: Record<string, number> = {};
    const inventoryUrls: InventoryUrl[] = [];

    for (const u of sitemapUrls) {
      let type = classifyUrl(u);
      // Common HubSpot blog URL patterns
      if (type === 'page' && /\/(blog|news|insights|articles|resources|updates)\//.test(u)) {
        type = 'post';
      }
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
    const inv = inventory as HubSpotInventory;
    const hsOpts = opts as HubSpotAdapterOpts;
    const delayMs = hsOpts.delay != null ? hsOpts.delay : 300;
    const outputDir = hsOpts.outputDir || '';

    const csvBuilder = new WooProductCsvBuilder();
    if (outputDir && !hsOpts.dryRun) {
      csvBuilder.openStream(outputDir);
    }

    const result = await runExtractionLoop({
      urls: inv.urls,
      navigation: inv.navigation,
      wxr,
      log: context.log,
      outputDir,
      delay: delayMs,
      dryRun: !!hsOpts.dryRun,
      resume: !!hsOpts.resume,
      verbose: hsOpts.verbose,
      server: context.server,
      csvBuilder,
      extractPage: async (url: string) => {
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

        // Type detection from body class: hs-blog-post is authoritative
        const isPost = isHubSpotBlogPost(html);

        // Title: prefer h1, then og:title, then <title>
        const title = extractHeading(html) || slugify(url);

        // Extract content, strip embedded title h1, resolve relative URLs
        const content = resolveRelativeUrls(
          stripDuplicateTitle(extractContent(html), title),
          url
        );

        const excerpt = extractMeta(html, 'og:description') || extractMeta(html, 'description') || '';
        const seoTitle = extractMeta(html, 'og:title') || extractTitle(html) || title;
        const seoDescription = excerpt;

        const date = isPost ? extractHubSpotDate(html) : '';
        const author = isPost ? extractHubSpotAuthor(html) : undefined;
        // Topics appear as inline /topic/{slug} links in the post content,
        // which survive extraction. We also surface them as post tags on the
        // item, though note: the WXR builder's streaming mode writes the
        // taxonomy section at open time, so late-registered <wp:tag> entries
        // would not land in the file. Fixing that is a shared-code concern.
        const tags = isPost ? extractHubSpotTags(html) : [];

        const mediaUrls = extractHubSpotMediaUrls(html, url);

        const ogImage = extractMeta(html, 'og:image');
        if (ogImage && ogImage.startsWith('http') && !mediaUrls.includes(ogImage)) {
          try {
            const parsed = new URL(ogImage);
            if (IMAGE_EXTENSIONS.test(parsed.pathname) || /hubspotusercontent|hubfs/i.test(parsed.hostname + parsed.pathname)) {
              mediaUrls.push(ogImage);
            }
          } catch { /* invalid URL */ }
        }

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
          categories: [],
          tags,
          author,
          // Override URL-based classification with body-class signal
          detectedType: isPost ? 'post' : 'page',
        };
      },
    });

    if (result.productsExtracted > 0 && outputDir && !hsOpts.dryRun) {
      if (csvBuilder.isStreaming) {
        csvBuilder.closeStream();
      } else {
        csvBuilder.serialize(`${outputDir}/products.csv`);
      }
    }

    return result;
  },
};
