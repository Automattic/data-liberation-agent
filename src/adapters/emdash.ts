import * as cheerio from 'cheerio';
import type { PlatformAdapter } from '../types.js';
import type { WxrBuilder } from '../lib/extraction/wxr-builder.js';
import type { ExtractionLog } from '../lib/extraction/extraction-log.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { fetchSitemap, classifyUrl } from '../lib/extraction/sitemap.js';
import {
  slugify,
  runExtractionLoop,
  extractMeta,
  extractTitle,
  extractHeading,
  extractNavLinks,
  IMAGE_EXTENSIONS,
} from './shared.js';
import type { InventoryUrl, NavLink } from './shared.js';

// ---------------------------------------------------------------------------
// Scope (v1)
// ---------------------------------------------------------------------------
// Posts, pages, categories, tags, bylines, media.
// Out of scope: comments, products, custom plugin collections.
// See DISCOVERIES.md and docs/superpowers/specs/2026-04-22-emdash-adapter-design.md
// ---------------------------------------------------------------------------

export interface EmDashAdapterOpts extends Record<string, unknown> {
  delay?: number;
  resume?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  outputDir?: string;
  limit?: number;
}

export interface EmDashInventory {
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

// Upper bound on HTML size we process — matches HubSpot precedent.
const MAX_HTML_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Content extraction helpers
// ---------------------------------------------------------------------------

type CheerioRoot = ReturnType<typeof cheerio.load>;

const WIDGET_SELECTORS = [
  'aside',
  'section.more-posts',
  'emdash-live-search',
  'form[data-ec-comment-form]',
  'section.ec-comments',
  'div.widget-area',
  'div.widget',
  '#emdash-playground-toolbar',
].join(', ');

function stripWidgets($container: ReturnType<CheerioRoot>): void {
  $container.find(WIDGET_SELECTORS).remove();
}

/**
 * Extract content body from an EmDash page. Layered cascade:
 * 1. .article-content (EmDash default theme — clean post/page body)
 * 2. .post-body / .entry-content / .post-content (common WP-influenced themes)
 * 3. <article> (any custom theme using semantic HTML5)
 * 4. <main> with nav/header/footer stripped
 * 5. <body> with chrome stripped (last resort)
 *
 * Widgets (sidebars, comments, related posts, live search, playground toolbar)
 * are stripped regardless of which container matched.
 */
export function extractEmDashContent(html: string): string {
  const $ = cheerio.load(html);

  // Tier 1: EmDash default theme
  const articleContent = $('.article-content').first();
  if (articleContent.length) {
    stripWidgets(articleContent);
    const out = articleContent.html();
    if (out && out.trim()) return out.trim();
  }

  // Tier 2: common WP-influenced theme classes
  for (const sel of ['.post-body', '.entry-content', '.post-content']) {
    const el = $(sel).first();
    if (el.length) {
      stripWidgets(el);
      const out = el.html();
      if (out && out.trim()) return out.trim();
    }
  }

  // Tier 3: semantic <article>
  const article = $('article').first();
  if (article.length) {
    stripWidgets(article);
    const out = article.html();
    if (out && out.trim()) return out.trim();
  }

  // Tier 4: <main> with chrome stripped
  const main = $('main').first();
  if (main.length) {
    main.find('nav, header, footer').remove();
    stripWidgets(main);
    const out = main.html();
    if (out && out.trim()) return out.trim();
  }

  // Tier 5: <body> with chrome stripped
  const body = $('body').first();
  if (body.length) {
    body.find('nav, header, footer').remove();
    stripWidgets(body);
    const out = body.html();
    if (out && out.trim()) return out.trim();
  }

  return '';
}

// ---------------------------------------------------------------------------
// Metadata extraction helpers
// ---------------------------------------------------------------------------

/**
 * Parse all JSON-LD blocks in the page, flattening @graph wrappers and
 * stripping CDATA markers. Returns the flat list of JSON-LD objects.
 * Mirrors hubspot.ts:parseJsonLdBlocks pattern.
 */
function parseJsonLdBlocks($: CheerioRoot): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el)
      .text()
      .trim()
      .replace(/^<!\[CDATA\[/i, '')
      .replace(/\]\]>$/, '')
      .trim();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const graph = obj['@graph'];
      if (Array.isArray(graph)) {
        for (const node of graph) {
          if (node && typeof node === 'object') out.push(node as Record<string, unknown>);
        }
      } else {
        out.push(obj);
      }
    }
  });
  return out;
}

function isArticleLd(block: Record<string, unknown>): boolean {
  const type = block['@type'];
  const match = (t: unknown) => t === 'BlogPosting' || t === 'Article' || t === 'NewsArticle';
  return match(type) || (Array.isArray(type) && type.some(match));
}

export interface EmDashPageMetadata {
  title: string;
  excerpt: string;
  date: string;
  modifiedDate: string;
}

export function extractEmDashMetadata(html: string): EmDashPageMetadata {
  const $ = cheerio.load(html);

  // Title: article-title → h1 → og:title → <title>
  const articleTitle = $('h1.article-title').first().text().trim();
  const title =
    articleTitle ||
    extractMeta(html, 'og:title') ||
    $('h1').first().text().trim() ||
    extractTitle(html);

  // Excerpt: p.article-excerpt → og:description → <meta name="description">
  const articleExcerpt = $('p.article-excerpt').first().text().trim();
  const excerpt =
    articleExcerpt ||
    extractMeta(html, 'og:description') ||
    extractMeta(html, 'description') ||
    '';

  // Date: article:published_time → JSON-LD datePublished → <time datetime>
  let date = extractMeta(html, 'article:published_time');
  if (!date) {
    for (const block of parseJsonLdBlocks($)) {
      if (!isArticleLd(block)) continue;
      const dp = block.datePublished;
      if (typeof dp === 'string' && dp) {
        date = dp;
        break;
      }
    }
  }
  if (!date) {
    const timeAttr = $('time[datetime]').first().attr('datetime');
    if (timeAttr) date = timeAttr;
  }

  // Modified date: article:modified_time → JSON-LD dateModified
  let modifiedDate = extractMeta(html, 'article:modified_time');
  if (!modifiedDate) {
    for (const block of parseJsonLdBlocks($)) {
      if (!isArticleLd(block)) continue;
      const dm = block.dateModified;
      if (typeof dm === 'string' && dm) {
        modifiedDate = dm;
        break;
      }
    }
  }

  return { title, excerpt, date: date ?? '', modifiedDate: modifiedDate ?? '' };
}

// ---------------------------------------------------------------------------
// Media / URL helpers
// ---------------------------------------------------------------------------

// Paths EmDash serves locally from the media library.
const LOCAL_MEDIA_PREFIX = '/_emdash/api/media/file/';

// URL paths that appear in sitemap or listing-crawl but are not content pages.
// Filtered out before extraction. Matches /category/foo, /tag/foo, /category/foo/page/2, etc.
const NON_CONTENT_URL_PATTERNS: RegExp[] = [
  /\/category(\/|$)/i,
  /\/tag(\/|$)/i,
  /\/search(\/|$)/i,
  /\/404(\/|$)/i,
  /\/_emdash(\/|$)/i,
];

/**
 * Fetch the /posts archive page and extract `/posts/{slug}` links as a discovery
 * fallback when the sitemap is empty or missing. Default EmDash Blog theme
 * renders all posts on one page (no pagination); returns the empty array if
 * /posts is 404 (custom themes may drop the route).
 */
async function fetchPostsListing(baseUrl: string): Promise<string[]> {
  const listingUrl = `${baseUrl.replace(/\/$/, '')}/posts`;
  try {
    const resp = await fetch(listingUrl, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)' },
    });
    if (!resp.ok) {
      await resp.body?.cancel();
      return [];
    }
    const html = await resp.text();
    const $ = cheerio.load(html);
    const urls = new Set<string>();
    $('a[href^="/posts/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      // Skip the listing page itself and any /posts/page/N pagination links
      if (href === '/posts' || href === '/posts/') return;
      if (/^\/posts\/page\//.test(href)) return;
      try {
        const abs = new URL(href, baseUrl).toString();
        urls.add(abs);
      } catch {
        // invalid href
      }
    });
    return [...urls];
  } catch {
    return [];
  }
}

/**
 * Extract author display names. Priority:
 * 1. JSON-LD BlogPosting author (single object or array)
 * 2. .byline-name elements (default theme multi-author support)
 * 3. <meta name="author">
 */
export function extractEmDashAuthors(html: string): string[] {
  const $ = cheerio.load(html);

  // 1. JSON-LD
  for (const block of parseJsonLdBlocks($)) {
    if (!isArticleLd(block)) continue;
    const author = block.author;
    if (!author) continue;
    const list = Array.isArray(author) ? author : [author];
    const names: string[] = [];
    for (const a of list) {
      if (a && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string') {
        names.push((a as { name: string }).name.trim());
      }
    }
    if (names.length) return names;
  }

  // 2. .byline-name (default theme — supports multi-author)
  const bylineNames: string[] = [];
  $('.byline-name, .post-byline-name, .featured-byline-name').each((_, el) => {
    const name = $(el).text().trim();
    if (name && !bylineNames.includes(name)) bylineNames.push(name);
  });
  if (bylineNames.length) return bylineNames;

  // 3. <meta name="author">
  const metaAuthor = extractMeta(html, 'author');
  if (metaAuthor) return [metaAuthor];

  return [];
}

export const emdashAdapter: PlatformAdapter = {
  id: 'emdash',

  detect(_url: string): boolean {
    // URL-based detection routed through detect-platform.ts (URL_PATTERNS
    // for *.dashhost.cc, SOURCE_SIGNALS for HTML markers, PATH_PROBES for
    // /_emdash/admin). Adapter-level detect intentionally returns false.
    return false;
  },

  async discover(url: string, _opts: Record<string, unknown>): Promise<EmDashInventory> {
    const normalized = url.includes('://') ? url : `https://${url}`;

    // 1. Fetch homepage — propagate failures so callers see why discovery
    //    produced nothing, rather than silently returning a hollow inventory.
    // Fetch with trailing slash so the server returns the canonical homepage
    // (avoids a redirect round-trip on most web servers).
    const homepageUrl = `${normalized.replace(/\/$/, '')}/`;
    let resp: Response;
    try {
      resp = await fetch(homepageUrl, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)' },
      });
    } catch (err) {
      throw new Error(`EmDash discover(): fetch failed for ${normalized}: ${(err as Error).message}`);
    }
    if (!resp.ok) {
      await resp.body?.cancel();
      throw new Error(`EmDash discover(): HTTP ${resp.status} ${resp.statusText} for ${normalized}`);
    }
    let homepageHtml: string;
    try {
      homepageHtml = await resp.text();
    } catch (err) {
      throw new Error(`EmDash discover(): failed reading body of ${normalized}: ${(err as Error).message}`);
    }
    if (homepageHtml.length > MAX_HTML_BYTES) {
      homepageHtml = homepageHtml.slice(0, MAX_HTML_BYTES);
    }

    const $ = cheerio.load(homepageHtml);

    // 2. Site meta
    const ogTitle = extractMeta(homepageHtml, 'og:title');
    const ogDescription = extractMeta(homepageHtml, 'og:description');
    const siteTitle = ogTitle || extractTitle(homepageHtml) || 'Imported Site';
    const siteTagline = ogDescription || extractMeta(homepageHtml, 'description') || '';
    const siteLanguage = $('html').attr('lang') || 'en';

    // 3. Primary URL discovery: sitemap-index → posts/pages sitemaps
    const sitemapUrls = await fetchSitemap(url);

    // 4. Fallback: crawl /posts listing when sitemap is empty or misses posts
    const fallbackPostUrls = await fetchPostsListing(normalized);

    // 5. Homepage nav + footer links for pages discovery
    const navLinks = extractNavLinks(homepageHtml, normalized);
    const navPageUrls = navLinks
      .map((l) => l.href)
      .filter((href) => /\/pages\//.test(href));

    // 6. Merge + dedup
    const allUrls = new Set<string>([...sitemapUrls, ...fallbackPostUrls, ...navPageUrls]);

    // 7. Filter out non-content URLs (taxonomy archives, listings, internal routes)
    const contentUrls = [...allUrls].filter((u) => {
      try {
        const path = new URL(u).pathname;
        if (path === '/posts' || path === '/pages') return false;
        return !NON_CONTENT_URL_PATTERNS.some((re) => re.test(path));
      } catch {
        return false;
      }
    });

    // 8. Classify
    const counts: Record<string, number> = {};
    const inventoryUrls: InventoryUrl[] = [];
    for (const u of contentUrls) {
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
      siteMeta: { title: siteTitle, tagline: siteTagline, language: siteLanguage },
      navigation: navLinks,
      counts,
      urls: inventoryUrls,
    };
  },

  async extract(
    _inventory: unknown,
    _wxr: WxrBuilder,
    _opts: Record<string, unknown>,
    _context: { log: ExtractionLog; server: Server }
  ): Promise<unknown> {
    throw new Error('Not implemented');
  },
};
