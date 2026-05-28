import type { PlatformAdapter } from '../types.js';
import type { WxrBuilder } from '../lib/extraction/wxr-builder.js';
import type { ExtractionLog } from '../lib/extraction/extraction-log.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { fetchSitemap, classifyUrl } from '../lib/extraction/sitemap.js';
import { slugify, launchBrowser, getPlaywright, runExtractionLoop, extractNavLinks, IMAGE_EXTENSIONS } from './shared.js';
import type { InventoryUrl, NavLink } from './shared.js';
import { WooProductCsvBuilder } from '../lib/import/woo-product-csv.js';
import type { WooProduct } from '../lib/import/woo-product-csv.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SquarespaceAdapterOpts extends Record<string, unknown> {
  cdpPort?: number;
  delay?: number;
  resume?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  outputDir?: string;
  limit?: number;
}

export interface SquarespaceInventory {
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
// Squarespace JSON helpers
// ---------------------------------------------------------------------------

interface SqsJsonResponse {
  collection?: {
    title?: string;
    urlId?: string;
    type?: number;
    typeName?: string;
    description?: string;
    mainContent?: string;
    enabled?: boolean;
  };
  item?: {
    title?: string;
    urlId?: string;
    body?: string;
    excerpt?: string;
    publishOn?: number;
    addedOn?: number;
    tags?: string[];
    categories?: string[];
    assetUrl?: string;
    systemDataId?: string;
    structuredContent?: Record<string, unknown>;
    author?: { displayName?: string };
    seoData?: {
      seoTitle?: string;
      seoDescription?: string;
    };
  };
  items?: Array<{
    title?: string;
    urlId?: string;
    fullUrl?: string;
    body?: string;
    excerpt?: string;
    publishOn?: number;
    addedOn?: number;
    tags?: string[];
    categories?: string[];
    assetUrl?: string;
  }>;
  website?: {
    siteTitle?: string;
    siteTagLine?: string;
    siteDescription?: string;
    language?: string;
  };
  websiteSettings?: {
    siteTitle?: string;
    siteTagLine?: string;
    siteDescription?: string;
  };
}

/**
 * Fetch a Squarespace URL with `?format=json` appended. Pure fetch, no Playwright.
 */
async function fetchSqsJson(url: string): Promise<SqsJsonResponse | null> {
  try {
    const separator = url.includes('?') ? '&' : '?';
    const jsonUrl = `${url}${separator}format=json`;
    const resp = await fetch(jsonUrl, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)',
      },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as SqsJsonResponse;
  } catch {
    return null;
  }
}

/**
 * Extract media URLs from Squarespace content. Looks for images.squarespace-cdn.com
 * and other common Squarespace image patterns.
 */
function extractSquarespaceMediaUrls(html: string, assetUrl?: string): string[] {
  const urls = new Set<string>();

  if (assetUrl) urls.add(assetUrl);

  // Squarespace CDN image URLs
  const cdnPattern = /https?:\/\/images\.squarespace-cdn\.com\/content\/[^\s"'<>)]+/g;
  const cdnMatches = html.match(cdnPattern) || [];
  for (const m of cdnMatches) urls.add(m);

  // Static Squarespace assets
  const staticPattern = /https?:\/\/static1?\.squarespace\.com\/static\/[^\s"'<>)]+/g;
  const staticMatches = html.match(staticPattern) || [];
  for (const m of staticMatches) urls.add(m);

  // Standard <img> tags
  const imgSrcMatches = html.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
  for (const match of imgSrcMatches) {
    const src = match.match(/src=["']([^"']+)["']/i);
    if (src?.[1] && src[1].startsWith('http')) {
      urls.add(src[1]);
    }
  }

  // Filter to image-like URLs
  const imageExtensions = IMAGE_EXTENSIONS;
  const imageCdns = /squarespace-cdn\.com|squarespace\.com\/static/i;
  return [...urls].filter((u) => {
    try {
      const parsed = new URL(u);
      return imageExtensions.test(parsed.pathname) || imageCdns.test(parsed.hostname + parsed.pathname);
    } catch {
      return false;
    }
  });
}

/**
 * Format a Squarespace timestamp (ms since epoch) to ISO string.
 */
function sqsTimestampToIso(ts?: number): string {
  if (!ts) return new Date().toISOString();
  return new Date(ts).toISOString();
}

// ---------------------------------------------------------------------------
// Playwright DOM fallback — used when ?format=json returns empty mainContent
// (Squarespace 7.1 fluid engine sites render content client-side)
// Inspired by scripts/squarespace/extract.js: getDomSections / extractPublicDomRecord
// ---------------------------------------------------------------------------

async function extractDomContent(
  page: unknown,
  url: string
): Promise<{ content: string; mediaUrls: string[]; title: string }> {
  const p = page as {
    goto(url: string, opts: Record<string, unknown>): Promise<unknown>;
    evaluate(fn: () => unknown): Promise<unknown>;
    waitForLoadState(state: string, opts: Record<string, unknown>): Promise<void>;
    title(): Promise<string>;
    context(): {
      newCDPSession(page: unknown): Promise<{
        send(method: string, params: Record<string, unknown>): Promise<unknown>;
        detach(): Promise<void>;
      }>;
    };
  };

  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  try { await p.waitForLoadState('networkidle', { timeout: 10000 }); } catch { /* timeout ok */ }

  const title = await p.title().catch(() => '');

  // Extract content from rendered DOM — mirrors legacy getDomSections()
  const domResult = (await p.evaluate(() => {
    const container = document.querySelector('main')
      || document.querySelector('[role="main"]')
      || document.body;

    const elements = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, img, blockquote, figcaption')];
    const blocks: string[] = [];
    const mediaUrls: string[] = [];
    const seen = new Set<string>();

    for (const el of elements.slice(0, 250)) {
      if (el.tagName === 'IMG') {
        const src = (el as HTMLImageElement).src;
        const alt = (el as HTMLImageElement).alt || '';
        if (src && src.startsWith('http')) {
          mediaUrls.push(src);
          if (!seen.has(src)) {
            seen.add(src);
            blocks.push(`<img src="${src}" alt="${alt}" />`);
          }
        }
        continue;
      }

      const text = (el as HTMLElement).innerText?.trim();
      if (!text || seen.has(text)) continue;

      // Skip navigation chrome
      if (['Skip to Content', 'SKIP TO CONTENT'].includes(text)) continue;

      seen.add(text);
      const tag = el.tagName.toLowerCase();
      if (tag.startsWith('h')) {
        blocks.push(`<${tag}>${text}</${tag}>`);
      } else if (tag === 'li') {
        blocks.push(`<li>${text}</li>`);
      } else if (tag === 'blockquote') {
        blocks.push(`<blockquote>${text}</blockquote>`);
      } else if (tag === 'figcaption') {
        blocks.push(`<figcaption>${text}</figcaption>`);
      } else {
        blocks.push(`<p>${text}</p>`);
      }
    }

    return { blocks, mediaUrls };
  })) as { blocks: string[]; mediaUrls: string[] };

  // Accessibility tree fallback if DOM produced nothing
  let content = domResult.blocks.join('\n');
  if (!content) {
    try {
      const session = await p.context().newCDPSession(page);
      const ax = (await session.send('Accessibility.getFullAXTree', { depth: 10 })) as {
        nodes?: Array<{ role?: { value: string }; name?: { value: string } }>;
      };
      const parts: string[] = [];
      for (const node of ax.nodes || []) {
        const role = node.role?.value || '';
        const name = node.name?.value || '';
        if (!name) continue;
        if (role === 'heading') parts.push(`<h2>${name}</h2>`);
        else if (['paragraph', 'StaticText'].includes(role)) parts.push(`<p>${name}</p>`);
      }
      content = parts.join('\n');
      await session.detach();
    } catch { /* CDP failed — non-fatal */ }
  }

  return {
    content,
    mediaUrls: domResult.mediaUrls,
    title,
  };
}

// ---------------------------------------------------------------------------
// Squarespace product extraction via ?format=json
// ---------------------------------------------------------------------------

async function extractSquarespaceProduct(url: string): Promise<WooProduct | null> {
  const json = await fetchSqsJson(url);
  const item = json?.item;
  if (!item) return null;

  const sc = item.structuredContent as Record<string, unknown> | undefined;
  if (!sc) return null;

  const priceMoney = sc.priceMoney as { value?: string; currency?: string } | undefined;
  const salePriceMoney = sc.salePriceMoney as { value?: string; currency?: string } | undefined;
  const onSale = sc.onSale as boolean | undefined;

  const variants = (sc.variants as Array<{
    sku?: string;
    priceMoney?: { value?: string };
    optionValues?: Array<{ value?: string; optionName?: string }>;
    stock?: { quantity?: number; unlimited?: boolean };
  }>) || [];

  // Collect images from item.items (image gallery)
  const images: string[] = [];
  const itemImages = (item as Record<string, unknown>).items as Array<{ assetUrl?: string }> | undefined;
  if (itemImages) {
    for (const img of itemImages) {
      if (img.assetUrl) images.push(img.assetUrl);
    }
  }
  if (item.assetUrl && !images.includes(item.assetUrl)) {
    images.unshift(item.assetUrl);
  }

  const isVariable = variants.length > 1;
  const price = priceMoney?.value || '';
  const salePrice = onSale && salePriceMoney?.value && salePriceMoney.value !== '0.00' ? salePriceMoney.value : undefined;

  const parent: WooProduct = {
    name: item.title || '',
    type: isVariable ? 'variable' : 'simple',
    sku: isVariable ? '' : (variants[0]?.sku || ''),
    published: true,
    description: item.body || '',
    regularPrice: isVariable ? '' : price,
    salePrice: isVariable ? undefined : salePrice,
    images,
    categories: item.categories || [],
    tags: item.tags || [],
  };

  // Build option names for attributes
  const optionOrdering = (sc.variantOptionOrdering as string[]) || [];
  if (optionOrdering.length > 0 && isVariable) {
    const optionValues = new Map<string, Set<string>>();
    for (const name of optionOrdering) optionValues.set(name, new Set());
    for (const v of variants) {
      for (const ov of v.optionValues || []) {
        if (ov.optionName && ov.value) {
          optionValues.get(ov.optionName)?.add(ov.value);
        }
      }
    }
    parent.attributes = optionOrdering.map((name) => ({
      name,
      values: [...(optionValues.get(name) || [])],
      visible: true,
      global: false,
    }));
  }

  return parent;
}

// ---------------------------------------------------------------------------
// Admin discovery via CDP — finds drafts, unlisted, password-protected pages
// ---------------------------------------------------------------------------

interface AdminEntry {
  url: string;
  title: string;
  type: string;
  visibility: 'published' | 'draft' | 'unlinked' | 'password-protected';
  adminPageId: string | null;
}

const COLLECTION_TYPES: Record<number, string> = {
  1: 'index', 2: 'gallery', 5: 'album', 6: 'blog',
  7: 'events', 8: 'product', 10: 'page', 11: 'portfolio',
};

function classifyAdminType(rawType: unknown, urlPath: string): string {
  if (typeof rawType === 'number' && COLLECTION_TYPES[rawType]) return COLLECTION_TYPES[rawType];
  if (typeof rawType === 'string') {
    const n = rawType.toLowerCase();
    if (n.startsWith('blog')) return 'post';
    if (n.startsWith('gallery') || n.startsWith('portfolio')) return 'gallery';
    if (n.startsWith('events')) return 'event';
    if (n.startsWith('products')) return 'product';
    if (n.startsWith('index') || n.startsWith('folder')) return 'page';
    return n;
  }
  const path = urlPath.toLowerCase();
  if (path.includes('/blog') || path.includes('/post')) return 'post';
  if (path.includes('/gallery') || path.includes('/portfolio')) return 'gallery';
  if (path.includes('/store') || path.includes('/product')) return 'product';
  if (path.includes('/event')) return 'event';
  return path === '/' ? 'homepage' : 'page';
}

/** Check if a value looks like a Squarespace page/collection object. */
function looksLikePageObject(value: Record<string, unknown>): boolean {
  if (value.assetUrl || value.scriptUrl || value.mimeType || value.contentType) return false;
  const hasUrl = !!(value.fullUrl || value.publicUrl || value.pageUrl || value.path || value.url || value.href || value.slug);
  const hasLabel = !!(value.title || value.navigationTitle || value.name);
  const hasId = !!(value.id || value.pageId || value.collectionId);
  return hasUrl && (hasLabel || hasId);
}

/** Recursively extract page-like entries from a JSON tree (API responses, __NEXT_DATA__). */
function extractAdminEntries(rootValue: unknown, origin: string, targetHost: string): AdminEntry[] {
  const entries = new Map<string, AdminEntry>();
  const visited = new WeakSet<object>();

  function normUrl(raw: unknown): string | null {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.includes('/config/pages')) return null;
    try {
      const abs = new URL(trimmed, origin);
      if (abs.host !== targetHost) return null;
      if (/^\/(api|scripts|assets|styles|fonts|static)\//.test(abs.pathname)) return null;
      if (/\.(jpg|jpeg|png|gif|webp|svg|avif|ico|js|css|map|json|txt|xml|pdf|woff2?|ttf|eot)$/i.test(abs.pathname)) return null;
      abs.hash = '';
      return abs.toString();
    } catch { return null; }
  }

  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (visited.has(value as object)) return;
    visited.add(value as object);

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const obj = value as Record<string, unknown>;
    if (looksLikePageObject(obj)) {
      const url = normUrl(obj.fullUrl || obj.publicUrl || obj.pageUrl || obj.path || obj.url || obj.href || obj.slug);
      if (url) {
        const title = (obj.navigationTitle || obj.title || obj.name || new URL(url).pathname) as string;
        const adminPageId = obj.pageId || obj.collectionId || obj.id;
        const visibility: AdminEntry['visibility'] =
          obj.published === false ? 'draft'
          : (obj.showInNavigation === false || obj.navigationHidden || obj.unlinked) ? 'unlinked'
          : obj.passwordProtected ? 'password-protected'
          : 'published';

        entries.set(url, {
          url,
          title,
          type: classifyAdminType(obj.typeName || obj.pageType || obj.type || obj.collectionType, new URL(url).pathname),
          visibility,
          adminPageId: adminPageId ? String(adminPageId) : null,
        });
      }
    }

    for (const child of Object.values(obj)) visit(child);
  }

  visit(rootValue);
  return [...entries.values()];
}

/**
 * Connect to a logged-in Squarespace admin session via CDP, navigate to /config/pages,
 * and extract page entries from API calls, __NEXT_DATA__, and DOM links.
 */
async function discoverAdmin(siteUrl: string, cdpPort: number): Promise<AdminEntry[]> {
  const origin = new URL(siteUrl).origin;
  const targetHost = new URL(siteUrl).host;
  const pw = await getPlaywright();
  const browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);

  try {
    const context = browser.contexts()[0] || await (browser as unknown as { newContext(): Promise<{ newPage(): Promise<unknown>; pages(): unknown[] }> }).newContext();
    // Look for an existing admin tab or open a new one
    const pages = context.pages() as Array<{
      url(): string;
      goto(url: string, opts: Record<string, unknown>): Promise<unknown>;
      waitForLoadState(state: string, opts: Record<string, unknown>): Promise<void>;
      evaluate(fn: () => unknown): Promise<unknown>;
      on(event: string, handler: (resp: unknown) => void): void;
      off(event: string, handler: (resp: unknown) => void): void;
    }>;
    let page = pages.find(p => p.url().includes('/config'));
    if (!page) {
      page = await (context as unknown as { newPage(): Promise<typeof pages[0]> }).newPage();
    }

    const apiCalls: Array<{ url: string; data: unknown }> = [];

    const responseHandler = async (response: unknown) => {
      const resp = response as { url(): string; headers(): Record<string, string>; json(): Promise<unknown> };
      const respUrl = resp.url();
      const ct = resp.headers()['content-type'] || '';
      if (!ct.includes('application/json')) return;
      const isAdminApi = respUrl.includes('/api/') || respUrl.includes('/api/content/') || respUrl.includes('/api/commondata/');
      if (!isAdminApi) return;
      try { apiCalls.push({ url: respUrl, data: await resp.json() }); } catch { /* body not readable */ }
    };

    page.on('response', responseHandler);

    // Navigate to /config/pages to trigger admin API calls
    try {
      await page.goto(`${origin}/config/pages`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await new Promise(r => setTimeout(r, 3000));
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
    } catch {
      // Navigation may fail if not logged in
    }

    page.off('response', responseHandler);

    // Extract __NEXT_DATA__ hydration payload
    let nextData: unknown = null;
    try {
      nextData = await page.evaluate(() => (window as unknown as Record<string, unknown>).__NEXT_DATA__ || null);
    } catch { /* not available */ }

    // Combine entries from API calls and __NEXT_DATA__
    const entries = [
      ...extractAdminEntries(apiCalls.map(c => c.data), origin, targetHost),
      ...extractAdminEntries(nextData, origin, targetHost),
    ];

    // Deduplicate by URL
    const byUrl = new Map<string, AdminEntry>();
    for (const entry of entries) byUrl.set(entry.url, entry);

    return [...byUrl.values()];
  } finally {
    await browser.close();
  }
}

/**
 * Merge admin-discovered entries into the public inventory.
 * Admin entries add drafts/unlisted pages and enrich existing entries with visibility metadata.
 */
function mergeAdminDiscovery(
  inventory: SquarespaceInventory,
  adminEntries: AdminEntry[]
): SquarespaceInventory {
  if (adminEntries.length === 0) return inventory;

  const mergedUrls = new Map<string, InventoryUrl & { visibility?: string }>();
  for (const u of inventory.urls) mergedUrls.set(u.url, { ...u });

  for (const entry of adminEntries) {
    const existing = mergedUrls.get(entry.url);
    if (existing) {
      // Enrich with admin data
      if (entry.type && entry.type !== 'page') existing.type = entry.type;
      (existing as unknown as Record<string, unknown>).visibility = entry.visibility;
    } else {
      // New URL from admin (draft, unlisted, etc.)
      mergedUrls.set(entry.url, {
        url: entry.url,
        type: entry.type || 'page',
        visibility: entry.visibility,
      } as InventoryUrl & { visibility?: string });
    }
  }

  // Update navigation — add admin-only published pages
  const navHrefs = new Set(inventory.navigation.map(n => n.href));
  const navigation = [...inventory.navigation];
  for (const entry of adminEntries) {
    if (entry.visibility !== 'published' || navHrefs.has(entry.url)) continue;
    navigation.push({ text: entry.title, href: entry.url });
    navHrefs.add(entry.url);
  }

  // Recount
  const counts: Record<string, number> = {};
  const urls: InventoryUrl[] = [];
  for (const u of mergedUrls.values()) {
    urls.push(u);
    counts[u.type] = (counts[u.type] || 0) + 1;
  }

  return { ...inventory, navigation, counts, urls };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const squarespaceAdapter: PlatformAdapter = {
  id: 'squarespace',

  detect(url: string): boolean {
    return /squarespace\.com/i.test(url);
  },

  async discover(url: string, opts: Record<string, unknown>): Promise<SquarespaceInventory> {
    const sqOpts = opts as SquarespaceAdapterOpts;
    // 1. Fetch site metadata via ?format=json
    const siteJson = await fetchSqsJson(url);

    const siteTitle =
      siteJson?.website?.siteTitle ||
      siteJson?.websiteSettings?.siteTitle ||
      'Imported Site';
    const siteTagline =
      siteJson?.website?.siteTagLine ||
      siteJson?.websiteSettings?.siteTagLine ||
      siteJson?.website?.siteDescription ||
      '';
    const siteLanguage = siteJson?.website?.language || 'en-US';

    // 2. Fetch sitemap
    const sitemapUrls = await fetchSitemap(url);

    // 3. Extract navigation from the homepage HTML — Squarespace renders its
    // primary navigation server-side as <nav><a>…</a></nav>, so a plain HTML
    // fetch of the homepage is enough. The `?format=json` payload only
    // contains nav data when the user has an admin session (e.g. via CDP),
    // which we don't require for public extraction.
    let navigation: NavLink[] = [];
    try {
      const homepageResp = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)' },
      });
      if (homepageResp.ok) {
        const homepageHtml = await homepageResp.text();
        navigation = extractNavLinks(homepageHtml, url);
      }
    } catch {
      // Non-fatal — leave navigation empty; the merge from admin discovery
      // (below, when cdpPort is set) can still backfill links.
    }

    // 4. Classify URLs — for Squarespace, we can probe each URL with ?format=json
    // to determine if it's a collection or item, but for the initial pass we use
    // path-based classification from the shared sitemap module.
    const counts: Record<string, number> = {};
    const inventoryUrls: InventoryUrl[] = [];

    for (const u of sitemapUrls) {
      const type = classifyUrl(u);
      inventoryUrls.push({ url: u, type });
      counts[type] = (counts[type] || 0) + 1;
    }

    // If sitemap was empty, try to discover from the homepage JSON items
    if (inventoryUrls.length === 0 && siteJson?.items) {
      const origin = new URL(url).origin;
      for (const item of siteJson.items) {
        if (item.fullUrl) {
          const fullUrl = item.fullUrl.startsWith('http')
            ? item.fullUrl
            : `${origin}${item.fullUrl}`;
          const type = classifyUrl(fullUrl);
          inventoryUrls.push({ url: fullUrl, type });
          counts[type] = (counts[type] || 0) + 1;
        }
      }
    }

    // If we still have nothing, add the homepage itself
    if (inventoryUrls.length === 0) {
      inventoryUrls.push({ url, type: 'homepage' });
      counts['homepage'] = 1;
    }

    let inventory: SquarespaceInventory = {
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

    // Admin discovery via CDP — finds drafts, unlisted pages, password-protected content
    if (sqOpts.cdpPort) {
      try {
        const adminEntries = await discoverAdmin(url, sqOpts.cdpPort);
        if (adminEntries.length > 0) {
          inventory = mergeAdminDiscovery(inventory, adminEntries);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        (inventory as unknown as Record<string, unknown>).adminWarning =
          `Squarespace admin discovery failed: ${message}. ` +
          'Drafts, unlisted pages, and password-protected content may be missing. ' +
          'Make sure you are logged in to Squarespace admin in the Chrome window connected via CDP.';
      }
    }

    return inventory;
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
    const inv = inventory as SquarespaceInventory;
    const sqOpts = opts as SquarespaceAdapterOpts;
    const delayMs = sqOpts.delay != null ? sqOpts.delay : 300;

    // Launch browser lazily — only if a page needs DOM fallback
    let browserSession: { page: unknown; close: () => Promise<void> } | null = null;

    async function getBrowserPage(): Promise<unknown> {
      if (!browserSession) {
        const session = await launchBrowser({ cdpPort: sqOpts.cdpPort });
        browserSession = { page: session.page, close: () => session.close() };
      }
      return browserSession.page;
    }

    const outputDir = sqOpts.outputDir || '';
    const csvBuilder = new WooProductCsvBuilder();
    if (outputDir && !sqOpts.dryRun) {
      csvBuilder.openStream(outputDir);
    }

    try {
      const result = await runExtractionLoop({
        urls: inv.urls,
        navigation: inv.navigation,
        wxr,
        log: context.log,
        outputDir,
        delay: delayMs,
        dryRun: !!sqOpts.dryRun,
        resume: !!sqOpts.resume,
        verbose: sqOpts.verbose,
        limit: sqOpts.limit,
        server: context.server,
        csvBuilder,
        extractPage: async (url: string) => {
          const json = await fetchSqsJson(url);

          const item = json?.item;
          const collection = json?.collection;

          let body = item?.body || collection?.mainContent || '';
          let title = item?.title || collection?.title || slugify(url);
          const excerpt = item?.excerpt || collection?.description || '';
          const date = sqsTimestampToIso(item?.publishOn || item?.addedOn);
          const seoTitle = item?.seoData?.seoTitle || title;
          const seoDescription = item?.seoData?.seoDescription || excerpt;
          const categories = item?.categories || [];
          const tags = item?.tags || [];

          let mediaUrls = extractSquarespaceMediaUrls(body, item?.assetUrl);

          // Check if JSON content is empty/stub (Squarespace 7.1 Fluid Engine returns
          // structural HTML like sqs-layout/sqs-block divs with no actual text content)
          const textOnly = body.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
          const isEmptyContent = !body || body.includes('columns-12 empty') || textOnly.length < 50;

          if (isEmptyContent) {
            // Fall back to Playwright DOM extraction
            try {
              const page = await getBrowserPage();
              const domResult = await extractDomContent(page, url);
              if (domResult.content) {
                body = domResult.content;
                mediaUrls = [
                  ...mediaUrls,
                  ...extractSquarespaceMediaUrls(domResult.content),
                  ...domResult.mediaUrls,
                ];
                // Deduplicate
                mediaUrls = [...new Set(mediaUrls)];
              }
              if (domResult.title && title === slugify(url)) {
                title = domResult.title;
              }
            } catch {
              // Playwright not available or DOM extraction failed — continue with what we have
            }
          }

          const bodyText = body.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
          let qualityScore: 'high' | 'medium' | 'low' = 'low';
          if (bodyText.length > 200) qualityScore = 'high';
          else if (bodyText.length > 50) qualityScore = 'medium';

          const author = item?.author?.displayName || undefined;

          return {
            title,
            slug: slugify(url),
            content: body,
            excerpt,
            date,
            seoTitle,
            seoDescription,
            mediaUrls,
            qualityScore,
            categories,
            tags,
            author,
          };
        },
        extractProduct: (_url: string, _html: string) => {
          // Return null — we handle products asynchronously below
          return null;
        },
      });

      // Extract products from Squarespace JSON API for product URLs
      const productUrls = inv.urls.filter((u) => classifyUrl(u.url) === 'product');
      for (const pu of productUrls) {
        if (sqOpts.dryRun) break;
        try {
          const product = await extractSquarespaceProduct(pu.url);
          if (product && product.name) {
            csvBuilder.addProduct(product);
            result.productsExtracted++;
          }
        } catch {
          // product extraction failed — non-fatal
        }
      }

      if (result.productsExtracted > 0 && outputDir && !sqOpts.dryRun) {
        if (csvBuilder.isStreaming) {
          csvBuilder.closeStream();
        } else {
          csvBuilder.serialize(`${outputDir}/products.csv`);
        }
      }

      return result;
    } finally {
      if (browserSession) await (browserSession as NonNullable<typeof browserSession>).close();
    }
  },
};
