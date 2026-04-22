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
