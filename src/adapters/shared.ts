import * as cheerio from 'cheerio';
import type { WxrBuilder, WxrItem } from '../lib/extraction/wxr-builder.js';
import type { ExtractionLog } from '../lib/extraction/extraction-log.js';
import type { ImportSession } from '../lib/extraction/import-session.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { classifyUrl } from '../lib/extraction/sitemap.js';
import { downloadMedia } from '../lib/extraction/media.js';
import { MediaStubStore } from '../lib/extraction/media-stubs.js';
import type { WooProductCsvBuilder, WooProduct } from '../lib/import/woo-product-csv.js';
import { AdaptiveTuner, TUNER_DEFAULTS } from '../lib/extraction/adaptive-tuner.js';
import type { AdaptiveTunerConfig, TunerState } from '../lib/extraction/adaptive-tuner.js';

// ---------------------------------------------------------------------------
// Strip non-content tags from HTML
// ---------------------------------------------------------------------------

function stripNonContentTags(html: string): string {
  const $ = cheerio.load(html, null, false);
  // Remove whole subtrees we never want in post content.
  $('script, style, form').remove();
  // Strip inline style attributes — source sites typically emit absolute
  // pixel sizes, fonts, and colors that fight the WordPress theme. WP block
  // editor and theme CSS handle presentation once the content is imported.
  $('[style]').removeAttr('style');
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

type PwBrowserRaw = Awaited<ReturnType<(typeof import('playwright'))['chromium']['launch']>>;

export interface ConnectBrowserOpts {
  cdpPort?: number;
  headed?: boolean;
}

/**
 * Open a Playwright browser — CDP if cdpPort is set, otherwise a fresh headless
 * Chromium. Caller owns context/page creation and cleanup. Use launchBrowser()
 * instead if you just want a page to scrape one-off.
 */
export async function connectBrowser(opts: ConnectBrowserOpts): Promise<PwBrowserRaw> {
  const pw = await getPlaywright();
  if (opts.cdpPort) {
    return await pw.chromium.connectOverCDP(`http://127.0.0.1:${opts.cdpPort}`);
  }
  return await pw.chromium.launch({ headless: !opts.headed });
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

export function extractProductFromHtml(html: string, sourceUrl: string): WooProduct | null {
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
          sourceUrl,
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

/**
 * Cap a typed URL list to `limit` entries while keeping the sample
 * *representative* across content types.
 *
 * A naive `urls.slice(0, limit)` follows sitemap/inventory order, which on
 * multi-type sites (notably Shopify stores, where `/pages/*` sort before
 * `/products/*`) can exhaust the cap on a single type and silently drop
 * products entirely. A limited extraction of a *store* that contains zero
 * products is not a useful sample.
 *
 * Strategy:
 *   1. The homepage (if present) is always included first.
 *   2. The remaining slots are filled round-robin across the type buckets,
 *      in each type's first-appearance order, so every content type that
 *      exists gets proportional representation.
 *   3. Relative order within a type is preserved.
 *
 * Returns exactly `min(limit, urls.length)` entries.
 */
export function stratifiedUrlSlice<T extends { type: string }>(urls: T[], limit: number): T[] {
  if (limit < 0) return [];
  if (urls.length <= limit) return urls.slice();
  if (limit === 0) return [];

  // Bucket by type, preserving first-appearance order of both types and members.
  const buckets = new Map<string, T[]>();
  for (const u of urls) {
    const bucket = buckets.get(u.type);
    if (bucket) bucket.push(u);
    else buckets.set(u.type, [u]);
  }

  const result: T[] = [];
  const taken = new Set<T>();

  // 1. Homepage(s) first — the source's primary page anchors the design.
  const homepageBucket = buckets.get('homepage');
  if (homepageBucket) {
    for (const u of homepageBucket) {
      if (result.length >= limit) break;
      result.push(u);
      taken.add(u);
    }
    buckets.delete('homepage');
  }

  // 2. Round-robin across remaining type buckets until the limit is hit.
  const cursors = new Map<string, number>();
  for (const type of buckets.keys()) cursors.set(type, 0);
  let progressed = true;
  while (result.length < limit && progressed) {
    progressed = false;
    for (const [type, bucket] of buckets) {
      if (result.length >= limit) break;
      const idx = cursors.get(type)!;
      if (idx < bucket.length) {
        result.push(bucket[idx]);
        taken.add(bucket[idx]);
        cursors.set(type, idx + 1);
        progressed = true;
      }
    }
  }

  return result;
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
  /** Parsed JSON-LD objects from the page. Used by the fallback type detector. */
  jsonLd?: unknown[];
}

export interface PageExtractedEvent {
  url: string;
  slug: string;
  type: 'product' | 'post' | 'page' | 'homepage' | 'gallery' | 'event';
  items: WxrItem[];
  mediaUrls: string[];
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
  /**
   * Optional streaming callback fired after one URL has been fetched,
   * media-downloaded, and added to WXR/products. Used by watch mode to
   * update the running preview without re-entering adapters one URL at a time.
   */
  onPageExtracted?: (event: PageExtractedEvent) => void | Promise<void>;
  /**
   * Cap the number of URLs to process. Useful for sampling a real extraction
   * (with full WXR output) without committing to the entire site. When unset,
   * processes all URLs in the inventory. Takes precedence over dryRun's
   * implicit 3-URL cap.
   */
  limit?: number;
  /** Optional per-adapter tuner configuration overrides */
  tunerConfig?: AdaptiveTunerConfig;
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
    onPageExtracted,
    limit,
    tunerConfig,
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

  const savedTunerState = session?.getCursor<TunerState>('adaptive-tuner');
  const tuner = new AdaptiveTuner({ pageDelayStart: delay, config: tunerConfig }, savedTunerState);

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
  let typedUrls = inventoryUrls.slice();
  let alreadyProcessed = 0;
  if (resume) {
    const processed = log.getProcessedUrls();
    alreadyProcessed = processed.size;
    typedUrls = typedUrls.filter((u) => !processed.has(u.url));
  }
  // Apply URL cap. Explicit `limit` wins over dryRun's implicit 3-URL cap so
  // a `--limit N` (with or without --dry-run) processes exactly N URLs.
  // The cap is *stratified* across content types (see stratifiedUrlSlice) so a
  // limited extraction of a multi-type site (e.g. a Shopify store) still
  // includes products/posts rather than exhausting the budget on `/pages/*`.
  const effectiveLimit = limit ?? (dryRun ? 3 : undefined);
  if (effectiveLimit !== undefined && effectiveLimit >= 0) {
    typedUrls = stratifiedUrlSlice(typedUrls, effectiveLimit);
  }
  let urls = typedUrls.map((u) => u.url);

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

  interface FetchResult {
    url: string;
    pageData: ExtractedPage | null;
    elapsedMs: number;
    error: string | null;
  }

  let cursor = 0;
  while (cursor < urls.length) {
    const batchSize = tuner.getPageConcurrency();
    const batch = urls.slice(cursor, cursor + batchSize);

    // Phase 1: Log what we're about to fetch
    for (let j = 0; j < batch.length; j++) {
      sendLog(`[${alreadyProcessed + cursor + j + 1}/${alreadyProcessed + urls.length}] Extracting: ${batch[j]}`);
    }

    // Phase 2: Concurrent page fetches
    const fetchResults: FetchResult[] = await Promise.all(
      batch.map(async (url): Promise<FetchResult> => {
        const pageStart = Date.now();
        try {
          const pageData = await extractPage(url);
          return { url, pageData, elapsedMs: Date.now() - pageStart, error: null };
        } catch (err) {
          return { url, pageData: null, elapsedMs: Date.now() - pageStart, error: err instanceof Error ? err.message : String(err) };
        }
      })
    );

    // Phase 3: Feed timing to tuner — treat batch errors as a single
    // compound event to avoid multiplicative backoff (N errors in one
    // batch would otherwise multiply the delay by 2^N).
    const batchHasErrors = fetchResults.some((r) => r.error);
    if (batchHasErrors) {
      tuner.recordPageError();
      if (verbose) {
        const errorCount = fetchResults.filter((r) => r.error).length;
        sendLog(`  [tuner] page delay: → ${tuner.getPageDelay()}ms (error backoff — ${errorCount}/${fetchResults.length} failed)`);
      }
    }
    for (const result of fetchResults) {
      if (!result.error) {
        const pageElapsed = result.elapsedMs / 1000;
        const pageDecision = tuner.recordPageResult({ elapsed: pageElapsed });
        if (verbose && tuner.lastDebug) {
          const d = tuner.lastDebug;
          sendLog(`  [tuner:debug] page: elapsed=${d.elapsed.toFixed(2)}s throughput=${d.throughput.toFixed(2)} ema=${d.ema?.toFixed(2) ?? 'null'} ratio=${d.ratio?.toFixed(2) ?? 'n/a'} → ${d.decision}`);
        }
        if (verbose && (pageDecision === 'increase' || pageDecision === 'decrease')) {
          sendLog(`  [tuner] page delay: → ${tuner.getPageDelay()}ms (${pageDecision})`);
        }
      }
    }

    // Phase 4: Process each page sequentially (media, WXR, logging)
    for (let j = 0; j < fetchResults.length; j++) {
      const { url, pageData, error: fetchError } = fetchResults[j];
      const i = cursor + j; // running index for checkpoints
      const startMs = Date.now();
      const itemCountBefore = wxr.items.length;

      if (fetchError || !pageData) {
        failed++;
        const errorMsg = fetchError || 'Unknown error';
        log.logFailed({ url, error: errorMsg });
        sendLog(`  FAILED: ${errorMsg}`);

        if (session) {
          const invEntry = inventoryUrls.find((u) => u.url === url);
          const failType = invEntry?.type || classifyUrl(url);
          const bumpType = failType === 'product' ? 'product' : (failType === 'post' || failType === 'blog-post') ? 'post' : 'page';
          session.bumpProgress(bumpType, 'failed');
          session.save();
        }
        continue;
      }

      // Download media for this page concurrently
      let featuredMediaId: number | undefined;
      if (!dryRun && mediaDir) {
        const mediaConcurrency = tuner.getMediaConcurrency();

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

        // Download media in batches
        for (let mBatch = 0; mBatch < newMediaUrls.length; mBatch += mediaConcurrency) {
          const chunk = newMediaUrls.slice(mBatch, mBatch + mediaConcurrency);
          const mediaBatchStart = Date.now();
          const results = await Promise.all(
            chunk.map((mediaUrl) => downloadMedia(mediaUrl, mediaDir, seenMediaNames, seenMediaHashes)
              .then((r) => ({ mediaUrl, ...r })))
          );
          const mediaBatchElapsed = (Date.now() - mediaBatchStart) / 1000;
          // Exclude deduped files (bytes=0, no error) from throughput — they
          // resolve instantly from the hash cache and would skew the EMA.
          const mediaBatchBytes = results.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
          const mediaBatchErrors = results.filter((r) => r.error).length;
          const mediaBatchActualDownloads = results.filter((r) => !r.error && (r.bytes ?? 0) > 0).length;
          if (
            mediaBatchErrors >= TUNER_DEFAULTS.mediaErrorMinCount &&
            mediaBatchErrors > chunk.length * TUNER_DEFAULTS.mediaErrorRatio
          ) {
            tuner.recordMediaError();
            if (verbose) {
              sendLog(`  [tuner] media concurrency: → ${tuner.getMediaConcurrency()} (error — ${mediaBatchErrors}/${chunk.length} failed)`);
            }
          } else if (mediaBatchActualDownloads > 0) {
            // Only feed throughput when real downloads occurred — skip
            // all-dedup batches to avoid skewing the EMA with instant results.
            const mediaDecision = tuner.recordMediaResult({ elapsed: mediaBatchElapsed, bytesDownloaded: mediaBatchBytes });
            if (verbose && tuner.lastDebug) {
              const d = tuner.lastDebug;
              sendLog(`  [tuner:debug] media: elapsed=${d.elapsed.toFixed(2)}s bytes=${d.workDone} throughput=${d.throughput.toFixed(0)} ema=${d.ema?.toFixed(0) ?? 'null'} ratio=${d.ratio?.toFixed(2) ?? 'n/a'} → ${d.decision}`);
            }
            if (verbose && (mediaDecision === 'increase' || mediaDecision === 'decrease')) {
              sendLog(`  [tuner] media concurrency: → ${tuner.getMediaConcurrency()} (${mediaDecision})`);
            }
          }

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

      // If still classified as a page, check top-level JSON-LD for blog post
      // signals. We require a proper top-level @type of BlogPosting/Article
      // AND (when present) mainEntityOfPage matching the current URL. This
      // avoids promoting blog listing pages that embed BlogPosting cards for
      // each post they display.
      if (urlType === 'page' || urlType === 'homepage') {
        const BLOG_TYPES = new Set(['BlogPosting', 'NewsArticle', 'Article', 'SocialMediaPosting']);
        const isRealBlogPost = Array.isArray(pageData.jsonLd) && pageData.jsonLd.some((ld) => {
          if (!ld || typeof ld !== 'object') return false;
          const obj = ld as Record<string, unknown>;
          const atType = obj['@type'];
          if (typeof atType !== 'string' || !BLOG_TYPES.has(atType)) return false;
          const mep = obj.mainEntityOfPage;
          if (mep && typeof mep === 'object') {
            const mepRec = mep as Record<string, unknown>;
            const mepUrl = typeof mepRec.url === 'string' ? mepRec.url :
                           typeof mepRec['@id'] === 'string' ? mepRec['@id'] as string : null;
            if (mepUrl && mepUrl !== url) return false;
          }
          return true;
        });
        if (isRealBlogPost) urlType = 'post';
      }

      const isPost = urlType === 'post' || urlType === 'blog-post';
      const isProduct = urlType === 'product';

      // Product detection — try platform-specific extractor, then generic JSON-LD
      if (isProduct && csvBuilder && !dryRun) {
        const product = extractProduct?.(url, pageData.content)
          ?? extractProductFromHtml(pageData.content, url);
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
          session.setCursor('adaptive-tuner', tuner.getState());
          session.save();
          mediaStubs?.flush();
        }
      }

      if (verbose) {
        sendLog(
          `  media: ${pageData.mediaUrls.length}, quality: ${pageData.qualityScore}, ${durationMs}ms`
        );
      }

      if (onPageExtracted) {
        // Streaming consumers install media from MediaStubStore, so make the
        // just-downloaded media visible on disk before firing the callback.
        mediaStubs?.flush();
        try {
          await onPageExtracted({
            url,
            slug: pageData.slug,
            type: urlType as PageExtractedEvent['type'],
            items: wxr.items.slice(itemCountBefore),
            mediaUrls: pageData.mediaUrls,
          });
        } catch (err) {
          sendLog(`  [warn] onPageExtracted failed for ${url}: ${(err as Error).message}`);
        }
      }
    }

    // Persist tuner state after each batch so short runs and crashes
    // don't lose learned pacing. The every-10-items checkpoint inside
    // Phase 4 covers long runs; this covers the tail.
    if (session) {
      session.setCursor('adaptive-tuner', tuner.getState());
    }

    // Delay once per batch (skip after last batch)
    const currentDelay = tuner.getPageDelay();
    if (cursor + batch.length < urls.length && currentDelay > 0) {
      await sleep(currentDelay);
    }

    cursor += batch.length;
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

  sendLog(`[tuner] Final state: page delay=${tuner.getPageDelay()}ms, media concurrency=${tuner.getMediaConcurrency()}`);

  return {
    pagesExtracted,
    postsExtracted,
    productsExtracted,
    failed,
    mediaCollected: downloadedMediaUrls.size,
  };
}
