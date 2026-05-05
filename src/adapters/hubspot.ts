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

type CheerioRoot = ReturnType<typeof cheerio.load>;

// Upper bound on HTML size we'll process. Pages beyond this are truncated
// before parsing runs, bounding worst-case cost.
const MAX_HTML_BYTES = 5 * 1024 * 1024;

// Extensions that should never be treated as images, even when hosted on a
// recognized HubSpot CDN.
const NON_IMAGE_EXTENSIONS = /\.(css|js|json|xml|txt|map|woff2?|ttf|eot|otf|pdf|zip|mp4|webm|mov)$/i;

// Classes HubSpot uses for marketing widgets we want to strip from content.
// `blog-post__preheader` is the above-title label strip; `blog-post__summary`
// is the intro paragraph that HubSpot renders before the body — we surface
// it as a WordPress excerpt instead of leaving it duplicated inside content.
const HUBSPOT_WIDGET_SELECTORS = [
  '.hs-cta-wrapper',
  '.hs-cta-node',
  '.hs_cos_wrapper_type_form',
  '.hs_cos_wrapper_type_blog_comments',
  '.addthis_toolbox',
  '.addthis_sharing_toolbox',
  '.blog-post__preheader',
  '.blog-post__summary',
  '.blog-post__timestamp',
  '.blog-post__author',
  '.blog-post__social-sharing',
  '.blog-post__tags',
  '.blog-more',
  '.blog-more-grid',
  '.subscriber-form',
].join(', ');

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function parseOrigin(baseUrl: string): string | null {
  try {
    return new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).origin;
  } catch {
    return null;
  }
}

/**
 * Normalize a URL candidate — accepting absolute, protocol-relative
 * (`//host/path`), and root-relative (`/path`) forms. Returns an absolute
 * URL string or null.
 */
function normalizeUrl(candidate: string, origin: string | null): string | null {
  if (!candidate) return null;
  if (candidate.startsWith('http://') || candidate.startsWith('https://')) return candidate;
  if (candidate.startsWith('//')) return 'https:' + candidate;
  if (candidate.startsWith('/')) return origin ? origin + candidate : null;
  return null;
}

/**
 * Tokenize an HTML srcset attribute into `{ url, descriptor }` pairs.
 *
 * A naive `split(',')` mis-handles URLs that contain commas in query strings
 * (e.g. `/img?sizes=1,2 1x`). This walker follows the HTML spec loosely: each
 * candidate is `URL` (non-whitespace run) optionally followed by a descriptor
 * (`1x`, `2x`, `320w`, etc.), with candidates separated by whitespace + comma.
 */
function parseSrcset(srcset: string): { url: string; descriptor: string }[] {
  const out: { url: string; descriptor: string }[] = [];
  const n = srcset.length;
  let i = 0;
  while (i < n) {
    while (i < n && /[\s,]/.test(srcset.charAt(i))) i++;
    if (i >= n) break;
    const urlStart = i;
    while (i < n && !/\s/.test(srcset.charAt(i))) i++;
    let url = srcset.slice(urlStart, i);
    let urlHasTrailingComma = false;
    while (url.endsWith(',')) {
      url = url.slice(0, -1);
      urlHasTrailingComma = true;
    }
    while (i < n && /[ \t]/.test(srcset.charAt(i))) i++;
    let descriptor = '';
    if (!urlHasTrailingComma) {
      const descStart = i;
      while (i < n && srcset.charAt(i) !== ',') i++;
      descriptor = srcset.slice(descStart, i).trim();
    }
    if (url) out.push({ url, descriptor });
    if (i < n && srcset.charAt(i) === ',') i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

function isHubSpotBlogPost($: CheerioRoot): boolean {
  return $('.hs-blog-post').length > 0;
}

function stripWidgets($container: ReturnType<CheerioRoot>): void {
  $container.find(HUBSPOT_WIDGET_SELECTORS).remove();
}

/**
 * Extract content from a HubSpot page.
 *
 * Strategy:
 * 1. Blog posts: use `.post-body` container (clean article content)
 * 2. Regular pages: use `.body-container` with navigation/chrome stripped
 * 3. Fallback to `<main>` or `<body>` with chrome stripped
 */
function extractContent($: CheerioRoot): string {
  // 1. .post-body — try first regardless of body class, since some custom
  //    themes strip `hs-blog-post` but still render blog content in a
  //    .post-body container.
  const postBody = $('.post-body').first();
  if (postBody.length) {
    stripWidgets(postBody);
    const html = postBody.html();
    if (html) return html.trim();
  }

  // 2. .body-container with nav/header/footer removed
  const bodyContainer = $('.body-container').first();
  if (bodyContainer.length) {
    bodyContainer.find('nav, header, footer').remove();
    stripWidgets(bodyContainer);
    const html = bodyContainer.html();
    if (html) return html.trim();
  }

  // 3. <main>
  const main = $('main').first();
  if (main.length && main.text().trim()) {
    stripWidgets(main);
    const html = main.html();
    if (html) return html.trim();
  }

  // 4. <body> with chrome stripped
  const body = $('body').first();
  if (body.length) {
    body.find('nav, header, footer').remove();
    stripWidgets(body);
    const html = body.html();
    if (html) return html.trim();
  }

  return '';
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

/**
 * Parse all JSON-LD blocks in the page, flattening `@graph` wrappers and
 * stripping CDATA markers. Returns the flat list of JSON-LD objects.
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

/**
 * Extract publication date from a HubSpot blog post.
 *
 * Tried in order:
 * 1. `.blog-post__timestamp` element text (HubSpot's default theme renders
 *    the post date in this class and also powers the visible byline)
 * 2. `<time datetime="…">` element (explicit machine-readable date)
 * 3. JSON-LD `datePublished` (survives custom themes)
 * 4. `<meta property="article:published_time">`
 * 5. Byline text like "by Author, on Dec 6, 2024 6:57:40 PM" — scoped to the
 *    first 500 chars of the post body so we don't pick up dates from unrelated
 *    prose deeper in the article or in sidebar widgets.
 */
function extractHubSpotDate($: CheerioRoot, html: string): string {
  const timestampText = $('.blog-post__timestamp').first().text().replace(/\s+/g, ' ').trim();
  if (timestampText) {
    const parsed = new Date(timestampText);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }

  const timeAttr = $('time[datetime]').first().attr('datetime');
  if (timeAttr) return timeAttr;

  for (const block of parseJsonLdBlocks($)) {
    if (!isArticleLd(block)) continue;
    const datePublished = block.datePublished;
    if (typeof datePublished === 'string' && datePublished) return datePublished;
  }

  const articleDate = extractMeta(html, 'article:published_time');
  if (articleDate) return articleDate;

  const postBodyText = $('.post-body').first().text() || $('body').first().text() || '';
  const haystack = postBodyText.slice(0, 500);
  const bylineDate = haystack.match(
    /\b(?:on|posted on|published on|by[^,\n]{1,80},\s*on)\s+([A-Z][a-z]{2,}\s+\d{1,2},\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M)?)/
  );
  if (bylineDate?.[1]) {
    const parsed = new Date(bylineDate[1]);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }

  return '';
}

/**
 * Extract author name from HubSpot blog post.
 *
 * Tried in order:
 * 1. `.blog-post__author` element text (HubSpot default theme)
 * 2. `/author/{slug}` link text (fallback for variants of the default theme)
 * 3. JSON-LD Article `author.name` (handles @graph)
 * 4. JSON-LD Person block linked via @graph
 * 5. <meta name="author"> tag
 */
function extractHubSpotAuthor($: CheerioRoot, html: string): string | undefined {
  const classAuthor = $('.blog-post__author').first().text().replace(/\s+/g, ' ').trim();
  if (classAuthor) return classAuthor;

  const authorLink = $('a[href*="/author/"]').first().text().trim();
  if (authorLink) return authorLink;

  const blocks = parseJsonLdBlocks($);
  for (const block of blocks) {
    if (!isArticleLd(block)) continue;
    const author = block.author;
    if (!author) continue;
    const first = Array.isArray(author) ? author[0] : author;
    if (first && typeof first === 'object' && typeof (first as { name?: unknown }).name === 'string') {
      return (first as { name: string }).name;
    }
  }
  for (const block of blocks) {
    if (block['@type'] === 'Person' && typeof block.name === 'string') {
      return block.name as string;
    }
  }

  const metaAuthor = extractMeta(html, 'author');
  return metaAuthor || undefined;
}

/**
 * Extract tags from HubSpot blog post topic links.
 *
 * Preferred: `.blog-post__tag-link` elements (HubSpot's default theme wraps
 * each tag in this class). Fallback: any `/topic/{slug}` anchor anywhere on
 * the page — we require the slug to be the last path segment so we don't
 * pick up `/topic/foo/page/2` pagination links.
 */
function extractHubSpotTags($: CheerioRoot): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const add = (text: string) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(clean);
  };

  const tagLinks = $('.blog-post__tag-link');
  if (tagLinks.length) {
    tagLinks.each((_, el) => add($(el).text()));
    return tags;
  }

  $('a[href*="/topic/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!/\/topic\/[^/?#]+\/?(?:[?#]|$)/.test(href)) return;
    add($(el).text());
  });
  return tags;
}

// ---------------------------------------------------------------------------
// Media + URL rewriting
// ---------------------------------------------------------------------------

/**
 * Pick the largest-resolution URL from a parsed srcset.
 *
 * Responsive images emit the same source at many widths (e.g. `foo-300w`,
 * `foo-600w`, `foo-1200w`). Importing every candidate duplicates the asset
 * in WordPress, which will then re-derive its own thumbnails on top — a
 * multiplicative explosion. We want the single largest source; WP regenerates
 * intermediate sizes server-side.
 *
 * Ranking prefers the highest `Nw` (width) descriptor, then the highest
 * `Nx` (density), then the last candidate listed (HubSpot's srcset is
 * typically ordered small → large).
 */
function pickLargestFromSrcset(srcset: string): string | undefined {
  const candidates = parseSrcset(srcset);
  if (candidates.length === 0) return undefined;

  const score = (descriptor: string): number => {
    const wMatch = descriptor.match(/(\d+(?:\.\d+)?)w/);
    if (wMatch) return parseFloat(wMatch[1]);
    const xMatch = descriptor.match(/(\d+(?:\.\d+)?)x/);
    if (xMatch) return parseFloat(xMatch[1]);
    return 0;
  };

  let best = candidates[candidates.length - 1];
  let bestScore = score(best.descriptor);
  for (const c of candidates) {
    const s = score(c.descriptor);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best.url;
}

/**
 * Extract media URLs from a HubSpot page.
 *
 * Sources covered:
 * - HubSpot CDN (hubspotusercontent-*.net, f.hubspotusercontent*.net)
 * - `/hubfs/` paths on the site itself
 * - `<img src>`, `<img data-src>`
 * - Largest candidate from `<img srcset>` and `<source srcset>` inside `<picture>`
 */
function extractHubSpotMediaUrls($: CheerioRoot, baseUrl: string): string[] {
  const urls = new Set<string>();
  const origin = parseOrigin(baseUrl);

  const push = (candidate: string | undefined) => {
    if (!candidate) return;
    const normalized = normalizeUrl(candidate, origin);
    if (normalized) urls.add(normalized);
  };

  $('img').each((_, el) => {
    const $el = $(el);
    push($el.attr('src'));
    push($el.attr('data-src'));
    const srcset = $el.attr('srcset');
    if (srcset) push(pickLargestFromSrcset(srcset));
  });

  $('source[srcset]').each((_, el) => {
    const srcset = $(el).attr('srcset') || '';
    push(pickLargestFromSrcset(srcset));
  });

  // Filter to image URLs. An image extension OR a HubSpot-hosted URL (which
  // often lacks an explicit extension on optimized assets). The hostname
  // shortcut is NOT a bypass for files like PDFs or stylesheets — the
  // non-image extension blocklist is enforced above it.
  return [...urls].filter((u) => {
    try {
      const parsed = new URL(u);
      if (NON_IMAGE_EXTENSIONS.test(parsed.pathname)) return false;
      if (IMAGE_EXTENSIONS.test(parsed.pathname)) return true;
      return /hubspotusercontent/i.test(parsed.hostname) || /\/hubfs\//.test(parsed.pathname);
    } catch {
      return false;
    }
  });
}

/**
 * Finalize extracted post content HTML:
 *   1. Resolve relative `src`, `href`, `data-src` attributes to absolute URLs.
 *   2. Strip `srcset` and `sizes` from `<img>` elements and remove `<source>`
 *      tags from `<picture>` wrappers.
 *
 * Why the srcset stripping: the importer imports only the largest candidate
 * from each srcset, and `rewriteMediaUrls` only knows how to replace URLs
 * that were imported as media. Any smaller srcset variants we leave behind
 * will never be rewritten and will orphan-link back to hubspotusercontent.
 *
 * Once srcset is stripped, WordPress re-derives a fresh responsive srcset at
 * render time via `wp_filter_content_tags()` — it matches the rewritten
 * `<img src>` against the imported attachment's metadata and injects the
 * sub-sizes WP generated on upload. Browsers rendering a `<picture>` with
 * its `<source>` children removed fall back to the nested `<img>`.
 */
function finalizeContentHtml(contentHtml: string, baseUrl: string): string {
  const origin = parseOrigin(baseUrl);

  const resolve = origin
    ? (candidate: string): string => {
        if (/^https?:\/\//i.test(candidate)) return candidate;
        if (candidate.startsWith('//')) return 'https:' + candidate;
        if (candidate.startsWith('/')) return origin + candidate;
        return candidate;
      }
    : (candidate: string): string => candidate;

  // `false` = don't add <html>/<body> wrappers (fragment parse).
  const $ = cheerio.load(contentHtml, null, false);

  // Promote <img> src to the largest srcset candidate BEFORE dropping srcset.
  // The media extractor imports the largest candidate, and `rewriteMediaUrls`
  // in the importer rewrites content URLs only if they match what it imported.
  // HubSpot often emits a small fallback `src` alongside a much larger srcset,
  // so without this promotion the imported-media URL and the content `src`
  // never line up and the post keeps pointing at hubspotusercontent.
  $('img[srcset]').each((_, el) => {
    const $el = $(el);
    const srcset = $el.attr('srcset') || '';
    const largest = pickLargestFromSrcset(srcset);
    if (largest) $el.attr('src', largest);
  });

  if (origin) {
    $('[src], [href], [data-src]').each((_, el) => {
      const $el = $(el);
      for (const attr of ['src', 'href', 'data-src'] as const) {
        const v = $el.attr(attr);
        if (v) $el.attr(attr, resolve(v));
      }
    });
  }

  // Drop responsive-image metadata so WordPress regenerates its own.
  $('img').removeAttr('srcset').removeAttr('sizes');
  $('picture source').remove();

  return $.html();
}

/**
 * Strip the first <h1> if its text matches the post title. HubSpot renders
 * the title inside content; WordPress also displays post_title, so we'd see
 * the title twice otherwise.
 */
function stripDuplicateTitle($: CheerioRoot, title: string): void {
  if (!title) return;
  const normalized = title.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return;
  const $h1 = $('h1').first();
  if (!$h1.length) return;
  const h1Text = $h1.text().replace(/\s+/g, ' ').trim().toLowerCase();
  if (h1Text === normalized) $h1.remove();
}

/**
 * URL-based blog classification. HubSpot sites often put posts under paths
 * like `/blog/`, `/news/`, `/insights/`. Require a non-empty segment after the
 * keyword so index pages aren't reclassified, and restrict the broader
 * keywords (`resources`, `updates`) to two-segment depth.
 */
function looksLikeBlogPostPath(u: string): boolean {
  if (/\/(blog|news|insights|articles)\/[^/?#]+/i.test(u)) return true;
  if (/\/(resources|updates)\/[^/?#]+\/[^/?#]+/i.test(u)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const hubspotAdapter: PlatformAdapter = {
  id: 'hubspot',

  // URL-based adapter detection is not currently called anywhere in the
  // codebase (platform routing goes through `detect-platform.ts`). HubSpot
  // CMS sites use custom domains with no URL signal, so a URL-only detector
  // cannot produce a reliable signal — we intentionally return false and
  // rely on the HubSpot generator meta tag registered in `detect-platform.ts`.
  detect(_url: string): boolean {
    return false;
  },

  async discover(url: string, _opts: Record<string, unknown>): Promise<HubSpotInventory> {
    const normalized = url.includes('://') ? url : `https://${url}`;

    // Fetch homepage HTML — propagate failures so callers can see why
    // discovery produced nothing, rather than silently returning a
    // hollow inventory.
    let resp: Response;
    try {
      resp = await fetch(normalized, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)' },
      });
    } catch (err) {
      throw new Error(`HubSpot discover(): fetch failed for ${normalized}: ${(err as Error).message}`);
    }
    if (!resp.ok) {
      await resp.body?.cancel();
      throw new Error(`HubSpot discover(): HTTP ${resp.status} ${resp.statusText} for ${normalized}`);
    }
    let homepageHtml: string;
    try {
      homepageHtml = await resp.text();
    } catch (err) {
      await resp.body?.cancel().catch(() => { /* already failing */ });
      throw new Error(`HubSpot discover(): failed reading body of ${normalized}: ${(err as Error).message}`);
    }
    if (homepageHtml.length > MAX_HTML_BYTES) {
      homepageHtml = homepageHtml.slice(0, MAX_HTML_BYTES);
    }

    const $ = cheerio.load(homepageHtml);

    const ogTitle = extractMeta(homepageHtml, 'og:title');
    const ogDescription = extractMeta(homepageHtml, 'og:description');
    const siteTitle = ogTitle || extractTitle(homepageHtml) || 'Imported Site';
    const siteTagline = ogDescription || extractMeta(homepageHtml, 'description') || '';
    const siteLanguage = $('html').attr('lang') || 'en-US';

    const sitemapUrls = await fetchSitemap(url);
    const navigation = extractNavLinks(homepageHtml, normalized);

    const counts: Record<string, number> = {};
    const inventoryUrls: InventoryUrl[] = [];

    for (const u of sitemapUrls) {
      let type = classifyUrl(u);
      if (type === 'page' && looksLikeBlogPostPath(u)) {
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
      limit: hsOpts.limit as number | undefined,
      server: context.server,
      csvBuilder,
      onPageExtracted: hsOpts.onPageExtracted as never,
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

        const $ = cheerio.load(html);

        // `hs-blog-post` class (on <body> or a body-wrapper div) is the
        // authoritative HubSpot signal. Fall back to URL path heuristic for
        // sites with heavily customized templates that don't emit it.
        const isPost = isHubSpotBlogPost($) || looksLikeBlogPostPath(url);

        const title = extractHeading(html) || slugify(url);

        // HubSpot blog metadata lives in `.blog-post__*` classes that
        // extractContent strips from the DOM. Capture them BEFORE content
        // extraction runs, then let stripWidgets remove them from the post body.
        const summaryText = $('.blog-post__summary').first().text().replace(/\s+/g, ' ').trim();
        const excerpt = summaryText
          || extractMeta(html, 'og:description')
          || extractMeta(html, 'description')
          || '';
        const date = isPost ? extractHubSpotDate($, html) : '';
        const author = isPost ? extractHubSpotAuthor($, html) : undefined;
        // HubSpot has a single flat taxonomy ("Topics") — no distinction
        // between categories and tags. We map them to WordPress categories
        // because most themes use category archives for primary navigation;
        // landing them as tags tends to leave category archives empty on the
        // imported site. Note: the WXR builder's streaming mode writes the
        // taxonomy section at open time, so late-registered <wp:category>
        // entries may not persist — a shared-code limitation.
        const topicCategories = isPost ? extractHubSpotTags($) : [];

        // Strip duplicate <h1> title before serializing, then extract content.
        stripDuplicateTitle($, title);
        const contentHtml = extractContent($);
        const content = finalizeContentHtml(contentHtml, url);

        const seoTitle = extractMeta(html, 'og:title') || extractTitle(html) || title;
        const seoDescription = extractMeta(html, 'og:description') || extractMeta(html, 'description') || excerpt;

        const mediaUrls = extractHubSpotMediaUrls($, url);

        const ogImage = extractMeta(html, 'og:image');
        if (ogImage && !mediaUrls.includes(ogImage)) {
          const absolute = normalizeUrl(ogImage, parseOrigin(url));
          if (absolute) {
            try {
              const parsed = new URL(absolute);
              if (
                !NON_IMAGE_EXTENSIONS.test(parsed.pathname) &&
                (IMAGE_EXTENSIONS.test(parsed.pathname) ||
                  /hubspotusercontent/i.test(parsed.hostname) ||
                  /\/hubfs\//.test(parsed.pathname))
              ) {
                mediaUrls.push(absolute);
              }
            } catch { /* invalid URL */ }
          }
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
          categories: topicCategories,
          tags: [],
          author,
          // If body class confirms a blog post, signal 'post'. Otherwise leave
          // undefined so the shared loop falls back to inventory/URL classification
          // — some HubSpot sites use custom themes that strip the default
          // hs-blog-post body class, so absence of that class does NOT prove
          // a page isn't a blog post.
          detectedType: isPost ? 'post' : undefined,
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
