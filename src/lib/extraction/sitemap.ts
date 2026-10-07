import * as cheerio from 'cheerio';
import { sourceContextOptions } from '../browser-kit/browser-kit.js';
import { assertPublicHttpUrl, safeFetch } from '../media-fetch/safe-fetch.js';

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[\da-f]+|\d+);/gi, (entity) => {
    if (entity === '&amp;') return '&';
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    const numeric = entity.slice(2, -1);
    const codePoint = Number(numeric.startsWith('x') || numeric.startsWith('X') ? `0${numeric}` : numeric);
    return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : entity;
  });
}

export interface SitemapDocument {
  kind: 'urlset' | 'index' | 'unknown';
  locs: string[];
}

export function parseSitemapDocument(xml: string): SitemapDocument {
  const kind = /<\s*(?:\w+:)?sitemapindex\b/i.test(xml) ? 'index'
    : /<\s*(?:\w+:)?urlset\b/i.test(xml) ? 'urlset'
      : 'unknown';
  const urls: string[] = [];
  const locMatches = xml.match(/<\s*(?:\w+:)?loc\s*>([^<]+)<\/\s*(?:\w+:)?loc\s*>/gi);
  if (!locMatches) return { kind, locs: urls };
  for (const match of locMatches) {
    const url = decodeXml(match.replace(/<\/?(?:\w+:)?loc\s*>/gi, '').trim());
    if (url) urls.push(url);
  }
  return { kind, locs: urls };
}

import { canonicalizeHost } from '../screenshot/same-origin.js';
import { normalizedUrl } from '../url/route-key.js';

export function parseSitemapXml(xml: string): string[] {
  return parseSitemapDocument(xml).locs;
}

export type UrlType = 'homepage' | 'post' | 'product' | 'gallery' | 'event' | 'page';

export interface SitemapDiagnostic {
  code: string;
  url: string;
  reason: string;
}

export interface SitemapFetchResult {
  urls: string[];
  diagnostics: SitemapDiagnostic[];
}

// Extensions that cannot be a document, so a URL carrying one is never a page.
//
// `resolvePageLink` below keeps its own list and it is a strict subset of this
// one -- no `webp`, no video or audio, no archives, no feeds, no fonts -- so the
// two already disagree, and deliberately: that function also applies SKIP_PATHS
// (`/cart`, `/checkout`, `/search`), which inspection does not want, because a
// `/cart` route is commerce evidence worth reporting. Capture and the adapters
// go through it; inspection goes through this. Widening either does not widen
// the other, so a new extension belongs in both unless the asymmetry is meant.
// Deliberately a denylist: an unknown or absent extension still gets inspected,
// because `.php`, `.aspx` and extensionless paths are all ordinary pages. Only
// file types we are confident about are excluded.
const NON_DOCUMENT_EXTENSIONS = new Set([
  // images
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'tif', 'tiff', 'heic',
  // audio and video
  'mp4', 'webm', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'ogg', 'oga', 'ogv', 'm4a', 'm4v', 'flac', 'aac',
  // documents and archives
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'tar', 'rar', '7z', 'dmg', 'exe', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // code, data and fonts
  'css', 'js', 'mjs', 'map', 'json', 'xml', 'rss', 'atom', 'txt', 'csv', 'woff', 'woff2', 'ttf', 'otf', 'eot',
]);

/**
 * Whether a URL names something that cannot be an HTML document.
 *
 * Discovery inventories same-origin links, and a page that links straight to its
 * images — a gallery, a WordPress media library — offers plenty of them. Counted
 * as pages they are selected for sampling, come back as `image/jpeg`, and can
 * never render, which leaves the inspection reporting fewer rendered samples
 * than it selected and therefore an uncertain complexity band for a source that
 * measured cleanly.
 */
export function isNonDocumentUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase().split(/[?#]/)[0];
  }
  const extension = path.slice(path.lastIndexOf('.') + 1);
  return path.includes('.') && extension !== path && NON_DOCUMENT_EXTENSIONS.has(extension);
}

export function classifyUrl(url: string): UrlType {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase();
  }

  if (path === '/' || path === '') return 'homepage';
  // Match /blog/<slug>, /post/<slug>, /blogs/<handle>/<slug>, etc.
  // Also match Wix patterns like /blog-1/post/<slug> and older Wix /single-post/<slug>.
  // Require a slug segment after the keyword — bare `/blog` is a listing page,
  // not a blog post, so it should fall through to the `page` default.
  if (/\/(blog|post|posts|article|articles|news|journal)\/[^/]/.test(path)) return 'post';
  if (/\/blogs\/[^/]+\/[^/]+/.test(path)) return 'post'; // Shopify /blogs/<blog>/<article>
  if (/\/blog-\d+\/post\//.test(path)) return 'post'; // Wix /blog-1/post/<slug>
  if (/\/single-post\//.test(path)) return 'post'; // Older Wix Blog URL pattern
  // A category/listing page under a store path is not a product, the same way a bare
  // /blog is not a post above. Weebly names these /store/c<N>/... against /store/p<N>/...
  // for an actual product; other platforms use /category/, /collections/ (Shopify), etc.,
  // or the bare /store//shop/ index. Check these before the broad product test below, or
  // e.g. lonestardinners.com's /store/c1/Current_Menu.html imports into WooCommerce as a
  // junk product named after the category, priced at whatever its cheapest listing costs.
  if (/\/(?:store|shop)\/c\d+\//.test(path)) return 'page';
  if (/\/(?:category|categories|collections|product-category|product-tag)(?:\/|$)/.test(path)) return 'page';
  if (/\/(?:store|shop)\/?$/.test(path)) return 'page';
  if (/\/(products?|product-page|store|shop)\//.test(path)) return 'product';
  if (/\/(gallery|portfolio)/.test(path)) return 'gallery';
  if (/\/(event|events)/.test(path)) return 'event';
  return 'page';
}

const MAX_SITEMAP_DEPTH = 3;
const MAX_URLS = 50000;

function parseRobotsSitemapDirectives(text: string): string[] {
  const urls: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^sitemap:\s*(\S+)/i.exec(trimmed);
    if (match?.[1]) urls.push(match[1]);
  }
  return urls;
}

export async function fetchSitemap(baseUrl: string): Promise<string[]> {
  return (await fetchSitemapWithDiagnostics(baseUrl)).urls;
}

/**
 * Fetch sitemap routes scoped to the entry URL's origin. `fetchSitemap` keeps
 * the array-only contract used by existing adapters; callers that surface
 * discovery diagnostics can opt into this richer result.
 *
 * Candidates are probed in preference order: `Sitemap:` directives in
 * `/robots.txt`, then `/sitemap-index.xml`, then `/sitemap.xml`. The first
 * document that parses as a sitemap wins; a `sitemapindex`'s children are
 * followed by document kind whatever their filename, while a urlset entry
 * recurses only when its path ends in `.xml`.
 * Thin inventories traverse same-origin HTML with at most 100 raw requests,
 * 60 seconds, 2 MiB per document and 1000 retained routes. Diagnostics describe
 * linked-frontier closure, not unlinked pages or arbitrary runtime navigation.
 */
export async function fetchSitemapWithDiagnostics(baseUrl: string): Promise<SitemapFetchResult> {
  const normalizedBase = baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`;
  let baseOrigin: string;
  let siteHost: string;
  try {
    baseOrigin = new URL(normalizedBase).origin;
    siteHost = canonicalizeHost(normalizedBase);
  } catch {
    return { urls: [], diagnostics: [] };
  }
  const allUrls: string[] = [];
  const seenUrls = new Set<string>();
  const diagnostics: SitemapDiagnostic[] = [];
  const visited = new Set<string>();

  /**
   * Accept a sitemap entry on the entry URL's site and move it onto the entry
   * URL's origin. A site served over https whose sitemap still lists `http://`
   * (or the other `www` variant) is the same site; capture enforces the entry
   * origin exactly, so the entry is rewritten rather than kept as listed.
   * Anything else is reported, never dropped silently.
   */
  function acceptEntry(entry: string): URL | null {
    let entryUrl: URL;
    try {
      entryUrl = new URL(entry);
    } catch {
      diagnostics.push({ code: 'sitemap_url_rejected', url: entry, reason: 'invalid URL' });
      return null;
    }
    if (entryUrl.protocol !== 'http:' && entryUrl.protocol !== 'https:') {
      diagnostics.push({ code: 'sitemap_url_rejected', url: entry, reason: 'unsupported protocol' });
      return null;
    }
    if (canonicalizeHost(entryUrl) !== siteHost) {
      diagnostics.push({ code: 'sitemap_url_rejected', url: entry, reason: 'origin differs from the entry URL' });
      return null;
    }
    // Change only the scheme and host; keep the listed path and query. The
    // setters cannot move the URL to another host, whereas re-parsing
    // `pathname` as a relative reference reads a path such as `//alt` as
    // scheme-relative and yields `https://alt/`.
    const accepted = new URL(baseOrigin);
    accepted.pathname = entryUrl.pathname;
    accepted.search = entryUrl.search;
    return accepted;
  }

  function noteMiss(diagnostic: SitemapDiagnostic, bucket?: SitemapDiagnostic[]): void {
    (bucket ?? diagnostics).push(diagnostic);
  }

  async function fetchAndParse(url: string, depth: number, misses?: SitemapDiagnostic[]): Promise<boolean> {
    if (depth > MAX_SITEMAP_DEPTH || allUrls.length >= MAX_URLS || visited.has(url)) return false;
    visited.add(url);

    // Same-origin enforcement to prevent SSRF: only the entry origin is fetched.
    try {
      if (new URL(url).origin !== baseOrigin) {
        diagnostics.push({ code: 'sitemap_url_rejected', url, reason: 'origin differs from the entry URL' });
        return false;
      }
    } catch {
      diagnostics.push({ code: 'sitemap_url_rejected', url, reason: 'invalid URL' });
      return false;
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        noteMiss({ code: 'sitemap_not_found', url, reason: `HTTP ${response.status}` }, misses);
        return false;
      }
      const xml = await response.text();
      const document = parseSitemapDocument(xml);
      if (document.kind === 'unknown' && document.locs.length === 0) {
        noteMiss({ code: 'sitemap_not_found', url, reason: 'response is not a sitemap document' }, misses);
        return false;
      }

      for (const u of document.locs) {
        if (allUrls.length >= MAX_URLS) break;
        // Check for .xml before query string (e.g. sitemap_products_1.xml?from=...&to=...)
        const pathPart = u.includes('?') ? u.slice(0, u.indexOf('?')) : u;
        const entryUrl = acceptEntry(u);
        if (!entryUrl) continue;
        // Index entries are child sitemaps regardless of filename. Preserve
        // the existing .xml recursion signal for urlset entries.
        if (document.kind === 'index' || pathPart.endsWith('.xml')) {
          await fetchAndParse(entryUrl.href, depth + 1);
        } else {
          // Capture and export treat `/x` and `/x/` as one route. Keep the
          // first form the sitemap lists so the two cannot collide at export.
          const route = normalizedUrl(entryUrl.href);
          if (!seenUrls.has(route)) {
            allUrls.push(entryUrl.href);
            seenUrls.add(route);
          }
        }
      }
      return true;
    } catch (error) {
      diagnostics.push({
        code: 'sitemap_fetch_failed',
        url,
        reason: error instanceof Error ? error.message : 'Sitemap fetch failed',
      });
      return false;
    }
  }

  const declared: string[] = [];
  const declaredSeen = new Set<string>();
  try {
    const robotsUrl = new URL('/robots.txt', baseOrigin).href;
    const response = await fetch(robotsUrl, { signal: AbortSignal.timeout(15000) });
    if (response.ok) {
      for (const loc of parseRobotsSitemapDirectives(await response.text())) {
        let absolute: string;
        try {
          absolute = new URL(loc, normalizedBase).href;
        } catch {
          diagnostics.push({ code: 'sitemap_url_rejected', url: loc, reason: 'invalid URL' });
          continue;
        }
        const accepted = acceptEntry(absolute);
        if (!accepted || declaredSeen.has(accepted.href)) continue;
        declaredSeen.add(accepted.href);
        declared.push(accepted.href);
      }
    }
  } catch {
    // robots.txt is a pointer, not a sitemap; a miss here is not a sitemap miss.
  }

  const wellKnown = [
    new URL('/sitemap-index.xml', baseOrigin).href,
    new URL('/sitemap.xml', baseOrigin).href,
  ].filter((url) => !declaredSeen.has(url));

  let foundSitemap = false;
  for (const candidate of declared) {
    if (await fetchAndParse(candidate, 0)) {
      foundSitemap = true;
      break;
    }
  }
  const fallbackMisses: SitemapDiagnostic[] = [];
  if (!foundSitemap) {
    for (const candidate of wellKnown) {
      if (await fetchAndParse(candidate, 0, fallbackMisses)) {
        foundSitemap = true;
        break;
      }
    }
  }
  if (!foundSitemap) {
    diagnostics.push({
      code: 'sitemap_missing',
      url: `${baseOrigin}/`,
      reason: 'No sitemap found at any probed location',
    });
    diagnostics.push(...fallbackMisses);
  }

  // A normal sitemap keeps its inexpensive path; thin inventories close a
  // bounded frontier of linked HTML instead of stopping at the entry document.
  if (allUrls.length < 5) {
    const fallback = await crawlLinkedPages(normalizedBase, baseOrigin, allUrls);
    allUrls.splice(0, allUrls.length, ...fallback.urls);
    if (fallback.closed) {
      for (let i = diagnostics.length - 1; i >= 0; i--) {
        if (diagnostics[i].code === 'sitemap_missing') {
          diagnostics[i] = { ...diagnostics[i], code: 'sitemap_absent', reason: `No sitemap found; linked-page fallback closed. ${fallbackMisses.map(miss => `${miss.url}: ${miss.reason}`).join('; ')}` };
        } else if (fallbackMisses.includes(diagnostics[i])) diagnostics.splice(i, 1);
      }
    }
    diagnostics.push(...fallback.diagnostics);
  }

  return { urls: allUrls, diagnostics };
}

const LINKED_PAGE_REQUEST_LIMIT = 100;
const LINKED_PAGE_TIME_LIMIT_MS = 60_000;
const LINKED_PAGE_BODY_LIMIT = 2 * 1024 * 1024;
const LINKED_PAGE_ROUTE_LIMIT = 1000;

/** Sequential breadth-first traversal keeps request and frontier order stable. */
async function crawlLinkedPages(baseUrl: string, baseOrigin: string, seeds: string[]): Promise<SitemapFetchResult & { closed: boolean }> {
  const urls = [...seeds];
  const routes = new Set(urls.map(normalizedUrl));
  const queue: string[] = [];
  const queued = new Set<string>();
  for (const url of [new URL(baseUrl).href, ...seeds]) {
    const key = normalizedUrl(url);
    if (!queued.has(key)) { queued.add(key); queue.push(url); }
  }
  const requested = new Set<string>();
  const parsedRequests = new Set<string>();
  const alreadyParsed = new Error('Linked document already parsed');
  const diagnostics: SitemapDiagnostic[] = [];
  const deadline = AbortSignal.timeout(LINKED_PAGE_TIME_LIMIT_MS);
  let requests = 0;
  let parsed = 0;
  let position = 0;
  let dropped = 0;
  let firstDropped = '';
  let entryLinks = 0;
  let entryParsed = false;
  let rendered = false;

  function retain(links: string[]): void {
    for (const url of links) {
      const key = normalizedUrl(url);
      if (!routes.has(key)) {
        if (urls.length >= LINKED_PAGE_ROUTE_LIMIT) {
          dropped++;
          firstDropped ||= url;
          continue;
        }
        routes.add(key);
        urls.push(url);
      }
      if (!queued.has(key)) {
        queued.add(key);
        queue.push(url);
      }
    }
  }

  const boundedFetch: typeof fetch = async (input, init) => {
    const request = new URL(String(input));
    request.hash = '';
    const url = request.href;
    if (request.origin !== baseOrigin) throw new Error('redirect leaves the entry origin');
    if (parsedRequests.has(url)) throw alreadyParsed;
    if (requested.has(url)) throw new Error('redirect revisits a requested URL');
    if (requests >= LINKED_PAGE_REQUEST_LIMIT) throw new Error(`request budget exhausted (${LINKED_PAGE_REQUEST_LIMIT})`);
    deadline.throwIfAborted();
    requests++;
    requested.add(url);
    return fetch(url, init);
  };

  for (; position < queue.length; position++) {
    const url = queue[position];
    if (requested.has(url)) continue;
    if (requests >= LINKED_PAGE_REQUEST_LIMIT || deadline.aborted) break;
    try {
      const response = await safeFetch(url, {
        fetchImpl: boundedFetch, signal: deadline, timeoutMs: 15_000,
        maxBytes: LINKED_PAGE_BODY_LIMIT,
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type');
      if (contentType && !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) throw new Error(`non-HTML response (${contentType})`);
      const links = extractSameOriginLinks(response.body.toString('utf8'), response.finalUrl, baseOrigin);
      const finalRequest = new URL(response.finalUrl);
      finalRequest.hash = '';
      parsedRequests.add(finalRequest.href);
      parsedRequests.add(url);
      parsed++;
      if (position === 0) { entryLinks = links.length; entryParsed = true; }
      retain(links);
    } catch (error) {
      if (error !== alreadyParsed) diagnostics.push({ code: 'fallback_fetch_omitted', url, reason: error instanceof Error ? error.message : 'Linked-page fetch failed' });
    }
    // Rendering supplements a successfully fetched HTML shell, never a rejected
    // request, oversized body or non-document response.
    if (position === 0 && entryParsed && entryLinks === 0 && !deadline.aborted) {
      rendered = true;
      const result = await crawlRenderedNavLinks(baseUrl, baseOrigin, deadline);
      retain(result.urls);
      if (result.reason) diagnostics.push({ code: 'fallback_render_omitted', url: baseUrl, reason: result.reason });
    }
  }
  const pending = queue.slice(position).filter(url => !requested.has(url));
  const budget = deadline.aborted ? `time budget exhausted (${LINKED_PAGE_TIME_LIMIT_MS} ms)` : `request budget exhausted (${LINKED_PAGE_REQUEST_LIMIT})`;
  for (const url of pending) diagnostics.push({ code: 'fallback_budget_omitted', url, reason: budget });
  if (dropped) diagnostics.push({ code: 'fallback_route_budget_omitted', url: firstDropped, reason: `${dropped} link occurrences not retained; route limit ${LINKED_PAGE_ROUTE_LIMIT}` });
  const closed = diagnostics.length === 0;
  diagnostics.push({
    code: closed ? 'fallback_link_closure' : 'fallback_link_coverage', url: baseUrl,
    reason: `${requests}/${LINKED_PAGE_REQUEST_LIMIT} HTTP requests (including redirects); ${parsed} HTML documents parsed; ${urls.length} routes retained; ${pending.length} queued documents unvisited; ${dropped} over-limit link occurrences; entry rendering attempted: ${rendered}. Limits: ${LINKED_PAGE_TIME_LIMIT_MS} ms, ${LINKED_PAGE_BODY_LIMIT} bytes/document, ${LINKED_PAGE_ROUTE_LIMIT} routes. Scope: same-origin page links, not unlinked routes or linked-page runtime navigation.`,
  });
  return { urls, diagnostics, closed };
}

/**
 * Every same-origin page link in one HTML document, in document order.
 *
 * Parsed with a DOM rather than matched by landmark regexes: a lazy
 * `<nav>…</nav>` match stops at the first nested `</nav>` (Webflow dropdowns),
 * and site chrome routinely lives outside `<nav>`/`<footer>` — a header CTA, a
 * GDPR bar, or a builder footer that is a plain `div` (Duda). The scope stays
 * one document; the same filter as the rendered fallback below drops obvious
 * asset references. Public path names alone do not establish whether a page
 * is editorial content or platform UI.
 */
export function extractSameOriginLinks(html: string, baseUrl: string, baseOrigin = new URL(baseUrl).origin): string[] {
  const $ = cheerio.load(html);
  const urls: string[] = [];
  const seen = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.trim();
    if (!href || href.startsWith('#')) return;
    const resolved = resolvePageLink(href, baseUrl, baseOrigin);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      urls.push(resolved);
    }
  });
  return urls;
}

/**
 * A URL's route identity: capture treats URLs that differ only by fragment,
 * query string or a trailing slash as one route.
 */
export function routeKey(url: string): string {
  const route = new URL(url);
  route.hash = '';
  route.search = '';
  route.pathname = route.pathname.replace(/\/$/, '') || '/';
  return route.href;
}

async function crawlRenderedNavLinks(baseUrl: string, baseOrigin: string, signal?: AbortSignal): Promise<{ urls: string[]; reason?: string }> {
  let browser: import('playwright').Browser | undefined;
  const abort = () => { void browser?.close().catch(() => {}); };
  try {
    signal?.throwIfAborted();
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    signal?.addEventListener('abort', abort, { once: true });
    signal?.throwIfAborted();
    const page = await browser.newPage(await sourceContextOptions(browser, baseUrl, { publicUrlsOnly: true }));
    await page.route('**/*', async route => {
      try { assertPublicHttpUrl(route.request().url()); }
      catch { await route.abort(); return; }
      await route.continue();
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    if (new URL(page.url()).origin !== baseOrigin) throw new Error('rendered navigation leaves the entry origin');

    const hrefs = await page.locator('a[href]').evaluateAll((links) =>
      links.map((link) => (link as HTMLAnchorElement).href),
    );
    const seen = new Set<string>();
    const urls = hrefs.flatMap((href) => {
      const resolved = resolvePageLink(href, baseUrl, baseOrigin);
      if (!resolved || seen.has(resolved)) return [];
      seen.add(resolved);
      return [resolved];
    });
    return { urls };
  } catch (error) {
    return { urls: [], reason: error instanceof Error ? error.message : 'Entry rendering failed' };
  } finally {
    signal?.removeEventListener('abort', abort);
    await browser?.close();
  }
}

export function resolvePageLink(href: string, baseUrl: string, baseOrigin: string): string | null {
  try {
    const resolved = new URL(href, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    if (resolved.origin !== baseOrigin) return null;
    if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|docx?|zip|xml|json)$/i.test(resolved.pathname)) return null;
    resolved.hash = '';
    return resolved.href;
  } catch {
    return null;
  }
}
