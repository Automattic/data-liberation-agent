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

// Non-image file extensions used to filter out JS/CSS/font URLs that happen
// to appear in <img src> (unusual but defensive).
const NON_IMAGE_EXTENSIONS = /\.(css|js|json|xml|txt|map|woff2?|ttf|eot|otf|pdf|zip|mp4|webm|mov)$/i;

function parseOrigin(baseUrl: string): string | null {
  try {
    return new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin;
  } catch {
    return null;
  }
}

function normalizeUrl(candidate: string, origin: string | null): string | null {
  if (!candidate) return null;
  if (candidate.startsWith('http://') || candidate.startsWith('https://')) return candidate;
  if (candidate.startsWith('//')) return 'https:' + candidate;
  if (candidate.startsWith('/')) return origin ? origin + candidate : null;
  return null;
}

/**
 * Extract media (image) URLs from an EmDash page.
 *
 * - /_emdash/api/media/file/{ULID} (with or without extension): always an image
 * - External URLs: pass through if the pathname has an image extension
 * - og:image and twitter:image meta tags: included
 *
 * Returns absolute URLs (relative paths resolved against baseUrl).
 */
export function extractEmDashMediaUrls(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const origin = parseOrigin(baseUrl);
  const urls = new Set<string>();

  const push = (candidate: string | undefined): void => {
    if (!candidate) return;
    const abs = normalizeUrl(candidate, origin);
    if (!abs) return;
    try {
      const parsed = new URL(abs);
      if (NON_IMAGE_EXTENSIONS.test(parsed.pathname)) return;
      // Always accept local EmDash media URLs (ULID-based, may have no extension)
      if (parsed.pathname.includes(LOCAL_MEDIA_PREFIX)) {
        urls.add(abs);
        return;
      }
      // External URLs: pass through if the pathname does not look like a
      // non-image asset (JS, CSS, fonts, etc.). CDN image URLs often have no
      // file extension at all (e.g. Unsplash /photo-123?w=1200).
      urls.add(abs);
    } catch {
      // Invalid URL
    }
  };

  // <img src> and <img data-src>
  $('img').each((_, el) => {
    const $el = $(el);
    push($el.attr('src'));
    push($el.attr('data-src'));
  });

  // og:image and twitter:image
  push(extractMeta(html, 'og:image'));
  push(extractMeta(html, 'twitter:image'));

  return [...urls];
}

/**
 * Rewrite relative src/href/data-src attributes in HTML to absolute URLs so
 * WordPress can match attachment URLs during import. Also strips srcset/sizes
 * attributes from <img> and <source> tags (see spec § "srcset handling").
 */
export function resolveRelativeUrls(html: string, baseUrl: string): string {
  const origin = parseOrigin(baseUrl);
  if (!origin) return html;

  const $ = cheerio.load(html, null, false);  // fragment parse
  $('[src], [href], [data-src]').each((_, el) => {
    const $el = $(el);
    for (const attr of ['src', 'href', 'data-src'] as const) {
      const v = $el.attr(attr);
      if (!v) continue;
      if (/^https?:\/\//i.test(v)) continue;
      if (v.startsWith('//')) {
        $el.attr(attr, 'https:' + v);
      } else if (v.startsWith('/')) {
        $el.attr(attr, origin + v);
      }
    }
  });

  // Strip srcset/sizes — default theme doesn't emit them, but custom themes
  // might. Without stripping, custom-theme content would orphan-link srcset
  // URLs that the importer never downloaded. Stripping is safer than partial
  // rewriting; full srcset support deferred per spec.
  $('img, source').removeAttr('srcset').removeAttr('sizes');

  return $.html();
}

/**
 * Strip the first <h1> if its text matches the post title. EmDash default theme
 * renders the title inside the article container; WordPress also renders
 * post_title, so we'd see it twice otherwise.
 */
export function stripDuplicateTitle(html: string, title: string): string {
  if (!title) return html;
  const normalize = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizedTitle = normalize(title);
  if (!normalizedTitle) return html;

  return html.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/i, (fullMatch, inner) => {
    return normalize(inner) === normalizedTitle ? '' : fullMatch;
  });
}

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

export interface EmDashTaxonomy {
  categories: string[];
  tags: string[];
}

/**
 * Extract categories (from /category/{slug} links) and tags (from /tag/{slug}
 * links) anywhere on the page. Deduplicates case-insensitively. Returns
 * display-name text, not slugs.
 */
export function extractEmDashTaxonomy(html: string): EmDashTaxonomy {
  const $ = cheerio.load(html);
  const tagSet = new Map<string, string>();  // slug (lowercased) → display name
  const catSet = new Map<string, string>();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;

    const tagMatch = href.match(/\/tag\/([^/?#]+)/);
    if (tagMatch) {
      const slug = tagMatch[1].toLowerCase();
      if (!tagSet.has(slug)) tagSet.set(slug, text);
      return;
    }
    const catMatch = href.match(/\/category\/([^/?#]+)/);
    if (catMatch) {
      const slug = catMatch[1].toLowerCase();
      if (!catSet.has(slug)) catSet.set(slug, text);
    }
  });

  return {
    categories: [...catSet.values()],
    tags: [...tagSet.values()],
  };
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
    const inv = inventory as EmDashInventory;
    const emOpts = opts as EmDashAdapterOpts;
    const delayMs = emOpts.delay ?? 300;
    const outputDir = emOpts.outputDir || '';

    const result = await runExtractionLoop({
      urls: inv.urls,
      navigation: inv.navigation,
      wxr,
      log: context.log,
      outputDir,
      delay: delayMs,
      dryRun: !!emOpts.dryRun,
      resume: !!emOpts.resume,
      verbose: emOpts.verbose,
      limit: emOpts.limit,
      server: context.server,
      extractPage: async (url: string) => {
        const resp = await fetch(url, {
          signal: AbortSignal.timeout(15000),
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)' },
        });
        if (!resp.ok) {
          await resp.body?.cancel();
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }
        let html = await resp.text();
        if (html.length > MAX_HTML_BYTES) {
          html = html.slice(0, MAX_HTML_BYTES);
        }

        const meta = extractEmDashMetadata(html);
        const title = meta.title || slugify(url);
        const taxonomy = extractEmDashTaxonomy(html);
        const authors = extractEmDashAuthors(html);

        const rawContent = extractEmDashContent(html);
        const deduped = stripDuplicateTitle(rawContent, title);
        const content = resolveRelativeUrls(deduped, url);

        const mediaUrls = extractEmDashMediaUrls(html, url);

        const textOnly = content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        let qualityScore: 'high' | 'medium' | 'low' = 'low';
        if (textOnly.length > 200) qualityScore = 'high';
        else if (textOnly.length > 50) qualityScore = 'medium';

        return {
          title,
          slug: slugify(url),
          content,
          excerpt: meta.excerpt,
          date: meta.date,
          seoTitle: extractMeta(html, 'og:title') || extractTitle(html) || title,
          seoDescription: extractMeta(html, 'og:description') || meta.excerpt,
          mediaUrls,
          qualityScore,
          categories: taxonomy.categories,
          tags: taxonomy.tags,
          // runExtractionLoop's ExtractedPage supports a single `author` field.
          // For multi-author posts, take the first as primary; other authors
          // are lost until WxrBuilder gains multi-author per-post support.
          // Acceptable trade-off for v1.
          author: authors[0],
        };
      },
    });

    return result;
  },
};
