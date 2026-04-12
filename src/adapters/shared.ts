import * as cheerio from 'cheerio';
import type { WxrBuilder } from '../lib/extraction/wxr-builder.js';
import type { ExtractionLog } from '../lib/extraction/extraction-log.js';
import type { ImportSession } from '../lib/extraction/import-session.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { classifyUrl } from '../lib/extraction/sitemap.js';
import { downloadMedia } from '../lib/extraction/media.js';
import { MediaStubStore } from '../lib/extraction/media-stubs.js';
import type { WooProductCsvBuilder, WooProduct } from '../lib/import/woo-product-csv.js';

// ---------------------------------------------------------------------------
// Strip non-content tags from HTML
// ---------------------------------------------------------------------------

function stripNonContentTags(html: string): string {
  const $ = cheerio.load(html, null, false);
  $('script, style, form').remove();
  return $.html();
}

// ---------------------------------------------------------------------------
// Shared HTML extraction helpers — used by multiple adapters
// ---------------------------------------------------------------------------

export const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|svg|webp|avif|ico|bmp|tiff)/i;

export function extractMeta(html: string, property: string): string {
  const $ = cheerio.load(html);
  return $(`meta[property="${property}"]`).attr('content')
    || $(`meta[name="${property}"]`).attr('content')
    || '';
}

export function extractTitle(html: string): string {
  const $ = cheerio.load(html);
  return $('title').first().text().trim();
}

export function extractHeading(html: string): string {
  const $ = cheerio.load(html);
  const h1 = $('h1').first().text().trim();
  if (h1) return h1;
  return $('title').first().text().trim();
}

export function extractNavLinks(html: string, baseUrl: string): NavLink[] {
  const $ = cheerio.load(html);
  const links: NavLink[] = [];
  const seen = new Set<string>();

  $('nav a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (!text || seen.has(href)) return;
    seen.add(href);

    let fullHref = href;
    if (href.startsWith('/')) {
      try {
        fullHref = new URL(href, baseUrl).href;
      } catch {
        fullHref = href;
      }
    }
    links.push({ text, href: fullHref });
  });

  return links;
}

// ---------------------------------------------------------------------------
// Shared slugify — used by all adapters
// ---------------------------------------------------------------------------

export function slugify(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '').replace(/\//g, '--') || 'homepage';
  } catch {
    return 'homepage';
  }
}

// ---------------------------------------------------------------------------
// Shared sleep helper
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Shared browser launcher (for adapters that need Playwright)
// ---------------------------------------------------------------------------

type PwBrowser = {
  contexts(): Array<{ newPage(): Promise<unknown> }>;
  newContext(opts?: Record<string, unknown>): Promise<{ newPage(): Promise<unknown> }>;
  close(): Promise<void>;
};

export async function getPlaywright(): Promise<typeof import('playwright')> {
  try {
    return await import('playwright');
  } catch {
    throw new Error(
      'Playwright is required but is not installed. ' +
        'Run `npm install playwright` and `npx playwright install chromium` to set it up.'
    );
  }
}

export async function launchBrowser(opts: { cdpPort?: number; headed?: boolean }): Promise<{
  browser: PwBrowser;
  page: unknown;
  close: () => Promise<void>;
}> {
  const pw = await getPlaywright();

  let browser: PwBrowser;
  let page: unknown;

  if (opts.cdpPort) {
    const raw = await pw.chromium.connectOverCDP(
      `http://127.0.0.1:${opts.cdpPort}`
    );
    browser = raw as unknown as PwBrowser;
    const ctx = browser.contexts()[0] || (await browser.newContext());
    page = await ctx.newPage();
  } else {
    const raw = await pw.chromium.launch({ headless: !opts.headed });
    browser = raw as unknown as PwBrowser;
    const ctx = await browser.newContext();
    page = await ctx.newPage();
  }

  return {
    browser,
    page,
    close: () => browser.close(),
  };
}

// ---------------------------------------------------------------------------
// Generic product detection from HTML (JSON-LD Product schema)
// ---------------------------------------------------------------------------

export function extractProductFromHtml(html: string): WooProduct | null {
  const $ = cheerio.load(html);
  const ldBlocks: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    ldBlocks.push($(el).html() || '');
  });

  for (const jsonStr of ldBlocks) {
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
  return null;
}

// ---------------------------------------------------------------------------
// Shared types for the extraction loop
// ---------------------------------------------------------------------------

export interface InventoryUrl {
  url: string;
  type: string;
}

export interface NavLink {
  text: string;
  href: string;
}

export interface ExtractedPage {
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  date: string;
  seoTitle: string;
  seoDescription: string;
  mediaUrls: string[];
  qualityScore: 'high' | 'medium' | 'low';
  categories?: string[];
  tags?: string[];
  /** Author display name (e.g. from JSON-LD, platform API, or HTML meta) */
  author?: string;
  /** Override URL-based type classification (e.g. from structured data / JSON-LD) */
  detectedType?: 'product' | 'post' | 'page';
}

export interface ExtractionLoopOpts {
  urls: InventoryUrl[];
  navigation: NavLink[];
  wxr: WxrBuilder;
  log: ExtractionLog;
  outputDir: string;
  delay: number;
  dryRun: boolean;
  resume: boolean;
  verbose?: boolean;
  server?: Server;
  csvBuilder?: WooProductCsvBuilder;
  /** Optional higher-level resume state; counters & stage are updated automatically */
  session?: ImportSession;
  extractPage: (url: string) => Promise<ExtractedPage>;
  /** Optional platform-specific product extractor — called before the generic JSON-LD fallback */
  extractProduct?: (url: string, html: string) => WooProduct | null;
}

// ---------------------------------------------------------------------------
// Shared extraction loop — iterate-extract-flush pattern
// ---------------------------------------------------------------------------

export async function runExtractionLoop(opts: ExtractionLoopOpts): Promise<{
  pagesExtracted: number;
  postsExtracted: number;
  productsExtracted: number;
  failed: number;
  mediaCollected: number;
}> {
  const {
    urls: inventoryUrls,
    navigation,
    wxr,
    log,
    outputDir,
    delay,
    dryRun,
    resume,
    verbose,
    server,
    csvBuilder,
    session,
    extractPage,
    extractProduct,
  } = opts;

  // Seed discovered counts from the inventory so the session reflects
  // what the adapter found before extraction began.
  if (session) {
    const discoveredByType: Record<string, number> = {};
    for (const u of inventoryUrls) {
      discoveredByType[u.type] = (discoveredByType[u.type] || 0) + 1;
    }
    session.setDiscovered(discoveredByType);
    session.setStage('extracting');
  }

  const mediaDir = outputDir ? `${outputDir}/media` : null;

  // Fresh start: purge old media and logs unless resuming.
  // Note: output.wxr is NOT deleted here — the caller manages WXR via
  // openStream() which truncates the file, or serialize() which overwrites.
  if (!resume && outputDir) {
    const { rmSync, writeFileSync } = await import('fs');
    try { rmSync(`${outputDir}/media`, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(`${outputDir}/redirect-map.json`, { force: true }); } catch { /* ignore */ }
    try { rmSync(`${outputDir}/media-stubs.json`, { force: true }); } catch { /* ignore */ }
    try { writeFileSync(log.logPath, ''); } catch { /* ignore */ }
  }

  if (mediaDir) {
    const { mkdirSync } = await import('fs');
    mkdirSync(mediaDir, { recursive: true });
  }

  const seenMediaNames = new Map<string, number>();
  const seenMediaHashes = new Map<string, string>();
  const downloadedMediaUrls = new Set<string>();
  // Per-asset status survives across runs: permanent failures stop retrying,
  // user-marked `ignored` URLs are skipped forever.
  const mediaStubs = outputDir ? MediaStubStore.load(outputDir) : null;
  /** Map from local file path to WXR media ID — used to deduplicate byte-identical files */
  const mediaPathToId = new Map<string, number>();

  // On resume, rebuild the hash map from existing media files
  if (resume && mediaDir) {
    const { readdirSync, readFileSync: readFs } = await import('fs');
    const { createHash } = await import('crypto');
    try {
      for (const file of readdirSync(mediaDir)) {
        const filePath = `${mediaDir}/${file}`;
        const hash = createHash('sha256').update(readFs(filePath)).digest('hex');
        seenMediaHashes.set(hash, filePath);
        seenMediaNames.set(file, 1);
      }
    } catch {
      // media dir may not exist yet
    }
  }

  // Determine which URLs to process
  const totalUrls = inventoryUrls.length;
  let urls = inventoryUrls.map((u) => u.url);
  let alreadyProcessed = 0;
  if (resume) {
    const processed = log.getProcessedUrls();
    alreadyProcessed = processed.size;
    urls = urls.filter((u) => !processed.has(u));
  }
  if (dryRun) {
    urls = urls.slice(0, 3);
  }

  if (urls.length === 0) {
    return { pagesExtracted: 0, postsExtracted: 0, productsExtracted: 0, failed: 0, mediaCollected: 0 };
  }

  let pagesExtracted = 0;
  let postsExtracted = 0;
  let productsExtracted = 0;
  let failed = 0;

  // Track authors by name to avoid duplicates
  const authorSlugs = new Set<string>();

  const sendLog = (message: string) => {
    try {
      server?.sendLoggingMessage?.({ level: 'info', data: message });
    } catch {
      // logging not available
    }
  };

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const startMs = Date.now();

    sendLog(`[${alreadyProcessed + i + 1}/${totalUrls}] Extracting: ${url}`);

    try {
      const pageData = await extractPage(url);

      // Download media for this page concurrently (up to 6 at a time)
      let featuredMediaId: number | undefined;
      if (!dryRun && mediaDir) {
        const MEDIA_CONCURRENCY = 6;

        // Filter to new URLs and mark them as seen immediately to prevent
        // duplicates from other pages queueing the same URL
        const newMediaUrls: string[] = [];
        for (const mediaUrl of pageData.mediaUrls) {
          if (downloadedMediaUrls.has(mediaUrl)) continue;
          // Respect persistent stub state: skip permanently-failed / ignored
          // URLs so resume runs don't burn cycles retrying them.
          if (mediaStubs && !mediaStubs.shouldAttempt(mediaUrl)) {
            downloadedMediaUrls.add(mediaUrl);
            const prior = mediaStubs.get(mediaUrl);
            if (prior?.status === 'success' && prior.localPath) {
              // Reuse the existing file. If this run's WXR doesn't yet have a
              // media item for this path, register it now — otherwise resume
              // runs would emit WXR without any <wp:attachment> entries for
              // media downloaded on prior runs.
              let mediaId = mediaPathToId.get(prior.localPath);
              if (!mediaId) {
                mediaId = wxr.addMedia({
                  url: mediaUrl,
                  localPath: prior.localPath,
                  title: prior.localPath.split('/').pop() || '',
                });
                mediaPathToId.set(prior.localPath, mediaId);
                if (wxr.isStreaming) {
                  wxr.flushItem(wxr.items[wxr.items.length - 1]);
                }
              }
              if (!featuredMediaId) featuredMediaId = mediaId;
            }
            continue;
          }
          downloadedMediaUrls.add(mediaUrl);
          newMediaUrls.push(mediaUrl);
        }

        // Download in batches of MEDIA_CONCURRENCY
        for (let batch = 0; batch < newMediaUrls.length; batch += MEDIA_CONCURRENCY) {
          const chunk = newMediaUrls.slice(batch, batch + MEDIA_CONCURRENCY);
          const results = await Promise.all(
            chunk.map((mediaUrl) => downloadMedia(mediaUrl, mediaDir, seenMediaNames, seenMediaHashes)
              .then((r) => ({ mediaUrl, ...r })))
          );

          // Process results sequentially — WXR builder and log are not concurrent-safe
          for (const result of results) {
            if (!result.error && result.localPath) {
              const existingId = mediaPathToId.get(result.localPath);
              if (existingId) {
                if (!featuredMediaId) featuredMediaId = existingId;
              } else {
                const mediaId = wxr.addMedia({
                  url: result.mediaUrl,
                  localPath: result.localPath,
                  title: result.filename || '',
                });
                mediaPathToId.set(result.localPath, mediaId);
                if (wxr.isStreaming) {
                  wxr.flushItem(wxr.items[wxr.items.length - 1]);
                }
                if (!featuredMediaId) featuredMediaId = mediaId;
              }
            }
            log.logMedia({
              url: result.mediaUrl,
              localPath: result.localPath,
              error: result.error,
            });
            if (mediaStubs) {
              if (result.error) {
                mediaStubs.markFailure(result.mediaUrl, result.error);
              } else if (result.localPath) {
                mediaStubs.markSuccess(result.mediaUrl, result.localPath);
              }
            }
          }
        }
      }

      // Determine type: adapter signal > inventory > JSON-LD > URL pattern
      const invEntry = inventoryUrls.find((u) => u.url === url);
      let urlType = pageData.detectedType || invEntry?.type || classifyUrl(url);

      // If still classified as a page, check JSON-LD for blog post signals
      if (urlType === 'page' || urlType === 'homepage') {
        const blogLdTypes = /["']@type["']\s*:\s*["'](BlogPosting|NewsArticle|Article|SocialMediaPosting)["']/i;
        if (blogLdTypes.test(pageData.content)) {
          urlType = 'post';
        }
      }

      const isPost = urlType === 'post' || urlType === 'blog-post';
      const isProduct = urlType === 'product';

      // Product detection — try platform-specific extractor, then generic JSON-LD
      if (isProduct && csvBuilder && !dryRun) {
        const product = extractProduct?.(url, pageData.content)
          ?? extractProductFromHtml(pageData.content);
        if (product) {
          csvBuilder.addProduct(product);
          productsExtracted++;
        }
      }

      const cleanContent = stripNonContentTags(pageData.content);

      // Register author if present
      let authorLogin: string | undefined;
      if (pageData.author) {
        authorLogin = pageData.author.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || undefined;
        if (authorLogin && !authorSlugs.has(authorLogin)) {
          authorSlugs.add(authorLogin);
          wxr.addAuthor({ login: authorLogin, displayName: pageData.author });
        }
      }

      if (isProduct && csvBuilder) {
        // Products are handled via WooCommerce CSV — don't also add as pages
      } else if (isPost) {
        wxr.addPost({
          title: pageData.title,
          slug: pageData.slug,
          content: cleanContent,
          excerpt: pageData.excerpt,
          date: pageData.date,
          seoTitle: pageData.seoTitle,
          seoDescription: pageData.seoDescription,
          sourceUrl: url,
          featuredMediaId,
          categories: pageData.categories,
          tags: pageData.tags,
          author: authorLogin,
        });
        postsExtracted++;
      } else {
        wxr.addPage({
          title: pageData.title,
          slug: pageData.slug,
          content: cleanContent,
          excerpt: pageData.excerpt,
          date: pageData.date,
          seoTitle: pageData.seoTitle,
          seoDescription: pageData.seoDescription,
          sourceUrl: url,
        });
        pagesExtracted++;
      }

      // Flush the page/post item to WXR immediately (skip for products — they're CSV-only)
      if (!(isProduct && csvBuilder)) {
        if (wxr.isStreaming) {
          wxr.flushItem(wxr.items[wxr.items.length - 1]);
        }

        // Add redirect from original path to slug
        try {
          const originalPath = new URL(url).pathname;
          if (originalPath && originalPath !== '/' && originalPath !== `/${pageData.slug}`) {
            wxr.addRedirect({ from: originalPath, to: `/${pageData.slug}` });
          }
        } catch {
          // URL parsing failed
        }
      }

      const durationMs = Date.now() - startMs;
      log.logProcessed({
        url,
        slug: pageData.slug,
        durationMs,
        qualityScore: pageData.qualityScore,
      });

      if (session) {
        const bumpType = isProduct ? 'product' : isPost ? 'post' : 'page';
        session.bumpProgress(bumpType, 'extracted');
        if ((i + 1) % 10 === 0) {
          session.save();
          mediaStubs?.flush();
        }
      }

      if (verbose) {
        sendLog(
          `  media: ${pageData.mediaUrls.length}, quality: ${pageData.qualityScore}, ${durationMs}ms`
        );
      }
    } catch (err) {
      failed++;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.logFailed({ url, error: errorMsg });
      sendLog(`  FAILED: ${errorMsg}`);

      if (session) {
        const invEntry = inventoryUrls.find((u) => u.url === url);
        const failType = invEntry?.type || classifyUrl(url);
        const bumpType = failType === 'product' ? 'product' : (failType === 'post' || failType === 'blog-post') ? 'post' : 'page';
        session.bumpProgress(bumpType, 'failed');
        // Failures are rare — persist each one so resume reports are accurate
        session.save();
      }
    }

    // Delay between pages (skip after last)
    if (i < urls.length - 1 && delay > 0) {
      await sleep(delay);
    }
  }

  // Add navigation as menu items
  for (let i = 0; i < navigation.length; i++) {
    const nav = navigation[i];
    wxr.addMenuItem({
      title: nav.text,
      url: nav.href,
      menuSlug: 'main-menu',
      order: i + 1,
    });
    if (wxr.isStreaming) {
      wxr.flushItem(wxr.items[wxr.items.length - 1]);
    }
  }

  if (session) {
    session.setStage('finalizing');
  }
  mediaStubs?.flush();

  return {
    pagesExtracted,
    postsExtracted,
    productsExtracted,
    failed,
    mediaCollected: downloadedMediaUrls.size,
  };
}
