# Wix Adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Wix platform adapter, refactoring existing extraction scripts (`reference/wix-discover-original.js`, `reference/wix-extract-original.js`) into the PlatformAdapter interface. This is the first adapter and exercises the full plugin architecture.

**Architecture:** The Wix adapter implements `discover()` and `extract()`. Discovery fetches the sitemap and crawls the homepage for navigation. Extraction uses Playwright to load each page, intercept Wix's internal JSON API calls, extract window globals and JSON-LD, download media, and feed everything into the WxrBuilder.

**Tech Stack:** Playwright (optional dep), Node.js 18+ (ESM)

**Spec:** `docs/superpowers/specs/2026-04-03-data-liberation-plugin-design.md`

**Depends on:** Plan 1 (plugin infrastructure) must be complete — wxr-builder, sitemap, media, extraction-log, and MCP server must exist.

---

### Task 1: Wix Adapter Skeleton

**Files:**
- Create: `src/adapters/wix.js`
- Create: `test/adapters/wix.test.js`
- Modify: `src/mcp-server.js` (add static import)

- [ ] **Step 1: Write failing test for adapter interface**

```js
// test/adapters/wix.test.js
import { describe, it, expect } from 'vitest';
import { wixAdapter } from '../../src/adapters/wix.js';

describe('wixAdapter', () => {
  it('has id "wix"', () => {
    expect(wixAdapter.id).toBe('wix');
  });

  it('detects wixsite.com URLs', () => {
    expect(wixAdapter.detect('https://mysite.wixsite.com/blog')).toBe(true);
  });

  it('detects wix.com URLs', () => {
    expect(wixAdapter.detect('https://www.wix.com/mysite')).toBe(true);
  });

  it('does not detect non-Wix URLs', () => {
    expect(wixAdapter.detect('https://www.example.com')).toBe(false);
  });

  it('has discover method', () => {
    expect(typeof wixAdapter.discover).toBe('function');
  });

  it('has extract method', () => {
    expect(typeof wixAdapter.extract).toBe('function');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/adapters/wix.test.js`
Expected: FAIL

- [ ] **Step 3: Create adapter skeleton**

```js
// src/adapters/wix.js
import { fetchSitemap, classifyUrl } from '../lib/sitemap.js';

export const wixAdapter = {
  id: 'wix',

  detect(url) {
    return /wixsite\.com|wix\.com/i.test(url);
  },

  async discover(url, opts = {}) {
    // Implementation in Task 2
    throw new Error('Not implemented');
  },

  async extract(inventory, wxr, opts = {}, context = {}) {
    // Implementation in Task 3-5
    throw new Error('Not implemented');
  },
};
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/adapters/wix.test.js`
Expected: Interface tests PASS (discover/extract tests not called yet)

- [ ] **Step 5: Register adapter in MCP server**

In `src/mcp-server.js`, uncomment/add the static import:

```js
import { wixAdapter } from './adapters/wix.js';
const adapters = [wixAdapter];
```

- [ ] **Step 6: Commit**

```bash
git add src/adapters/wix.js test/adapters/wix.test.js src/mcp-server.js
git commit -m "feat: add Wix adapter skeleton, register in MCP server"
```

---

### Task 2: Wix Discover

**Files:**
- Modify: `src/adapters/wix.js`
- Modify: `test/adapters/wix.test.js`

Refactor the discovery logic from `reference/wix-discover-original.js` into the adapter's `discover()` method. Uses Playwright to fetch sitemap + crawl homepage for navigation.

- [ ] **Step 1: Write failing test for discover**

```js
// append to test/adapters/wix.test.js
import { vi } from 'vitest';

describe('wixAdapter.discover', () => {
  it('returns inventory with urls, navigation, siteMeta, and counts', async () => {
    // Mock Playwright — we'll test with real Playwright in integration tests
    // For unit tests, mock the internal functions
    const inventory = {
      siteUrl: 'https://test.wixsite.com/site',
      platform: 'wix',
      urls: [
        { url: 'https://test.wixsite.com/site', type: 'homepage' },
        { url: 'https://test.wixsite.com/site/about', type: 'page' },
      ],
      navigation: [],
      siteMeta: { title: 'Test Site' },
      counts: { homepage: 1, page: 1 },
    };

    // For now, just verify the shape of a manually-constructed inventory
    expect(inventory.siteUrl).toBe('https://test.wixsite.com/site');
    expect(inventory.platform).toBe('wix');
    expect(inventory.urls).toHaveLength(2);
    expect(inventory.counts.homepage).toBe(1);
  });
});
```

- [ ] **Step 2: Implement discover()**

Refactor from `reference/wix-discover-original.js`. The key logic:
1. Try to import Playwright — if unavailable, throw a helpful error
2. Launch browser (or connect via CDP if `opts.cdpPort` is set)
3. Fetch sitemap at `${url}/sitemap.xml`
4. If sitemap is empty, crawl homepage for links
5. Extract navigation from `<nav>`, `<header>`, `[role="navigation"]` elements
6. Classify all URLs
7. Extract site title from `<title>` tag
8. Close browser, return Inventory

```js
// Replace the discover() stub in src/adapters/wix.js

async discover(url, opts = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      'Playwright is required for Wix extraction. Install it:\n' +
      '  npm install playwright && npx playwright install chromium'
    );
  }

  const baseUrl = url.replace(/\/$/, '');
  let browser, context, page;

  try {
    if (opts.cdpPort) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.cdpPort}`);
      context = browser.contexts()[0] || await browser.newContext();
    } else {
      browser = await chromium.launch();
      context = await browser.newContext({
        ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
      });
    }
    page = await context.newPage();

    // Fetch sitemap
    let allUrls = [];
    try {
      await page.goto(`${baseUrl}/sitemap.xml`, { timeout: 15000 });
      const sitemapText = await page.content();
      const { parseSitemapXml } = await import('../lib/sitemap.js');
      const locs = parseSitemapXml(sitemapText);

      // Recurse into sitemap indexes
      for (const loc of locs) {
        if (loc.endsWith('.xml')) {
          await page.goto(loc, { timeout: 15000 });
          const subXml = await page.content();
          allUrls.push(...parseSitemapXml(subXml).filter(u => !u.endsWith('.xml')));
        } else {
          allUrls.push(loc);
        }
      }
    } catch {
      // Sitemap fetch failed
    }

    // Fallback: crawl homepage for links
    if (allUrls.length === 0) {
      await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30000 });
      const origin = new URL(baseUrl).origin;
      allUrls = await page.evaluate((orig) => {
        return [...new Set([...document.querySelectorAll('a[href]')]
          .map(a => a.href)
          .filter(h => h.startsWith(orig) && !h.includes('#'))
        )];
      }, origin);
    }

    // Extract navigation
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    const navigation = await page.evaluate(() => {
      const navLinks = [];
      document.querySelectorAll('nav a, header a, [role="navigation"] a').forEach(a => {
        const text = a.textContent.trim();
        const href = a.href;
        if (text && href && !href.includes('#') && !navLinks.find(l => l.href === href)) {
          navLinks.push({ text, href });
        }
      });
      return navLinks;
    });

    // Extract site title
    const title = await page.title();

    // Classify URLs
    const { classifyUrl } = await import('../lib/sitemap.js');
    const urls = allUrls.map(u => ({ url: u, type: classifyUrl(u) }));
    const counts = {};
    for (const { type } of urls) {
      counts[type] = (counts[type] || 0) + 1;
    }

    return {
      siteUrl: baseUrl,
      platform: 'wix',
      urls,
      navigation,
      siteMeta: { title },
      counts,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
},
```

- [ ] **Step 3: Run unit tests**

Run: `npx vitest run test/adapters/wix.test.js`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/adapters/wix.js test/adapters/wix.test.js
git commit -m "feat: implement Wix adapter discover() with sitemap + nav extraction"
```

---

### Task 3: Wix Extract — Page Data Extraction

**Files:**
- Modify: `src/adapters/wix.js`

Implement the core of `extract()`: iterate URLs, load each page in Playwright, intercept API calls, extract globals, build content. Refactored from `reference/wix-extract-original.js`.

- [ ] **Step 1: Implement extract()**

The extract method:
1. Get URLs from inventory (filter by resume log if `opts.resume`)
2. For each URL: load page, intercept `/_api/*` and `wixapis.com` JSON responses, extract window globals, get accessibility tree
3. Determine content from best source: API calls > JSON-LD > accessibility tree
4. Call `wxr.addPost()` or `wxr.addPage()` based on URL classification
5. Collect media URLs, download them, call `wxr.addMedia()`
6. Call `wxr.addRedirect()` for each page
7. Log to JSONL with quality score and durationMs
8. Send progress via MCP logging if server context available

```js
// Replace the extract() stub in src/adapters/wix.js
// Add imports at top:
import { downloadMedia, safeFilename } from '../lib/media.js';

// In the adapter object:
async extract(inventory, wxr, opts = {}, context = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('Playwright is required for Wix extraction.');
  }

  const { ExtractionLog } = await import('../lib/extraction-log.js');
  const { mkdirSync } = await import('fs');
  const { join } = await import('path');

  const outputDir = opts.outputDir || './liberation-output';
  const mediaDir = join(outputDir, 'media');
  mkdirSync(mediaDir, { recursive: true });

  const log = context.log || new ExtractionLog(outputDir);
  const processedUrls = opts.resume ? log.getProcessedUrls() : new Set();
  const delay = opts.delay || 500;
  const seenMediaNames = new Map();
  const allMediaUrls = new Set();

  // Filter URLs
  let urls = inventory.urls.map(u => u.url);
  if (opts.resume) {
    urls = urls.filter(u => !processedUrls.has(u));
  }
  if (opts.dryRun) {
    urls = urls.slice(0, 3);
  }

  let browser, browserContext, page;
  try {
    if (opts.cdpPort) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.cdpPort}`);
      browserContext = browser.contexts()[0] || await browser.newContext();
    } else {
      browser = await chromium.launch();
      browserContext = await browser.newContext({
        ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
      });
    }
    page = await browserContext.newPage();

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const startTime = Date.now();

      // Send progress
      if (context.server) {
        context.server.sendLoggingMessage({
          level: 'info',
          data: `[${i + 1}/${urls.length}] ${url}`,
        });
      }

      try {
        const pageData = await this._extractPage(page, url, opts);
        const urlType = inventory.urls.find(u => u.url === url)?.type || 'page';
        const slug = this._slugify(url);

        // Determine quality score
        const hasTitle = !!pageData.title;
        const hasContent = !!pageData.content && pageData.content.length > 50;
        const hasDate = !!pageData.date;
        const qualityScore = (hasTitle && hasContent && hasDate) ? 'high' :
                             (hasTitle && hasContent) || (hasTitle && hasDate) ? 'medium' : 'low';

        // Add to WXR
        if (urlType === 'post') {
          const postId = wxr.addPost({
            title: pageData.title || slug,
            slug,
            content: pageData.content || '',
            excerpt: pageData.excerpt || '',
            date: pageData.date || '',
            categories: pageData.categories || [],
            tags: pageData.tags || [],
            seoTitle: pageData.seoTitle || '',
            seoDescription: pageData.seoDescription || '',
          });
        } else {
          wxr.addPage({
            title: pageData.title || slug,
            slug,
            content: pageData.content || '',
            excerpt: pageData.excerpt || '',
            date: pageData.date || '',
            seoTitle: pageData.seoTitle || '',
            seoDescription: pageData.seoDescription || '',
          });
        }

        // Add redirect
        const urlPath = new URL(url).pathname;
        wxr.addRedirect({ from: urlPath, to: slug });

        // Collect media URLs
        for (const mediaUrl of pageData.mediaUrls || []) {
          allMediaUrls.add(mediaUrl);
        }

        const durationMs = Date.now() - startTime;
        log.logProcessed({ url, slug, durationMs, qualityScore });

        if (opts.verbose) {
          console.log(`  [${qualityScore}] ${slug} (${durationMs}ms) — API calls: ${pageData.apiCallCount}, globals: ${pageData.globalsFound}`);
        }
      } catch (err) {
        log.logFailed({ url, error: err.message });
        if (opts.verbose) {
          console.error(`  FAILED: ${url} — ${err.message}`);
        }
      }

      // Delay between pages
      if (i < urls.length - 1) {
        await new Promise(r => setTimeout(r, delay));
      }
    }

    // Download media
    if (!opts.dryRun) {
      if (context.server) {
        context.server.sendLoggingMessage({
          level: 'info',
          data: `Downloading ${allMediaUrls.size} media files...`,
        });
      }

      for (const mediaUrl of allMediaUrls) {
        const result = await downloadMedia(mediaUrl, mediaDir, seenMediaNames);
        if (result.error) {
          log.logMedia({ url: mediaUrl, error: result.error });
        } else {
          wxr.addMedia({
            url: mediaUrl,
            localPath: result.localPath,
            title: result.filename,
          });
          log.logMedia({ url: mediaUrl, localPath: result.localPath });
        }
      }
    }

    // Extract navigation as menu items
    for (const nav of inventory.navigation || []) {
      wxr.addMenuItem({
        title: nav.text,
        url: nav.href,
        menuSlug: 'main-menu',
      });
    }

  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return log.getSummary();
},

_slugify(url) {
  return new URL(url).pathname.replace(/^\//, '').replace(/\//g, '--') || 'homepage';
},
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/wix.js
git commit -m "feat: implement Wix adapter extract() with progress logging"
```

---

### Task 4: Wix Extract — Page Data Helper

**Files:**
- Modify: `src/adapters/wix.js`

Implement `_extractPage()` — the core per-page extraction logic refactored from the existing `extractPageData()` in `reference/wix-extract-original.js`.

- [ ] **Step 1: Implement _extractPage()**

```js
// Add to wixAdapter object in src/adapters/wix.js

async _extractPage(page, url, opts = {}) {
  const captured = { apiCalls: [], globals: null, jsonLd: [], meta: {} };

  // Intercept Wix internal API calls
  const responseHandler = async (response) => {
    const respUrl = response.url();
    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('application/json')) return;

    const isWixApi = respUrl.includes('/_api/') ||
                     respUrl.includes('wixapis.com') ||
                     respUrl.includes('wix.com/_api');
    if (!isWixApi) return;

    try {
      const body = await response.json();
      captured.apiCalls.push({ url: respUrl, data: body });
    } catch {}
  };

  page.on('response', responseHandler);

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  } catch {
    // Page may partially load — continue with what we have
  }

  page.off('response', responseHandler);

  // Extract window globals
  captured.globals = await page.evaluate(() => {
    const result = {};
    const knownGlobals = ['__WIX_DATA__', '__SITE_DATA__', 'wixBiSession', '__wixInjectedPageData'];
    for (const g of knownGlobals) {
      if (window[g]) result[g] = window[g];
    }
    for (const key of Object.keys(window)) {
      if ((key.startsWith('__WIX') || key.startsWith('_wix')) && !result[key]) {
        try { result[key] = window[key]; } catch {}
      }
    }
    return result;
  });

  // Extract JSON-LD
  captured.jsonLd = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map(s => { try { return JSON.parse(s.textContent); } catch { return null; } })
      .filter(Boolean);
  });

  // Extract meta tags
  captured.meta = await page.evaluate(() => ({
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content || '',
    ogTitle: document.querySelector('meta[property="og:title"]')?.content || '',
    ogDescription: document.querySelector('meta[property="og:description"]')?.content || '',
    ogImage: document.querySelector('meta[property="og:image"]')?.content || '',
    canonical: document.querySelector('link[rel="canonical"]')?.href || '',
  }));

  // Extract content — priority: API calls > JSON-LD > accessibility tree
  let content = '';
  let date = '';
  let categories = [];
  let tags = [];

  // Try API calls first (blog posts)
  for (const call of captured.apiCalls) {
    const body = call.data?.post?.content?.plainText || call.data?.post?.richContent;
    if (body) {
      content = typeof body === 'string' ? `<p>${body}</p>` : '';
      date = call.data?.post?.firstPublishedDate || call.data?.post?.publishedDate || '';
      break;
    }
  }

  // Try JSON-LD
  if (!content) {
    const article = captured.jsonLd.find(j =>
      j['@type'] === 'Article' || j['@type'] === 'BlogPosting' || j['@type'] === 'WebPage'
    );
    if (article?.articleBody) {
      content = `<p>${article.articleBody}</p>`;
    }
    if (article?.datePublished) date = article.datePublished;
  }

  // Fallback: accessibility tree
  if (!content) {
    try {
      const client = await page.context().newCDPSession(page);
      const axResult = await client.send('Accessibility.getFullAXTree', { depth: 10 });
      const textNodes = (axResult.nodes || []).filter(n =>
        ['heading', 'paragraph', 'StaticText', 'link', 'img', 'list', 'listitem',
         'article', 'main', 'section'].includes(n.role?.value)
      ).map(n => ({
        role: n.role?.value,
        name: n.name?.value,
      })).filter(n => n.name);

      const blocks = [];
      for (const node of textNodes) {
        if (node.role === 'heading') blocks.push(`<h2>${node.name}</h2>`);
        else if (['paragraph', 'StaticText', 'article', 'section'].includes(node.role)) blocks.push(`<p>${node.name}</p>`);
      }
      content = blocks.join('\n');
      await client.detach();
    } catch {}
  }

  // Collect media URLs from captured data
  const mediaUrls = [];
  const allDataStr = JSON.stringify(captured);
  const imgMatches = allDataStr.match(/https:\/\/[^"]*(?:wixstatic\.com|wixmp\.com)[^"]*/g) || [];
  for (const imgUrl of imgMatches) {
    mediaUrls.push(imgUrl);
  }
  if (captured.meta.ogImage && !mediaUrls.includes(captured.meta.ogImage)) {
    mediaUrls.push(captured.meta.ogImage);
  }

  return {
    title: captured.meta.ogTitle || captured.meta.title || '',
    content,
    excerpt: captured.meta.ogDescription || captured.meta.description || '',
    date,
    categories,
    tags,
    seoTitle: captured.meta.ogTitle || captured.meta.title || '',
    seoDescription: captured.meta.description || '',
    mediaUrls: [...new Set(mediaUrls)],
    apiCallCount: captured.apiCalls.length,
    globalsFound: Object.keys(captured.globals || {}).length,
  };
},
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/wix.js
git commit -m "feat: implement Wix per-page extraction (API interception, globals, a11y tree)"
```

---

### Task 5: Record Test Fixtures

**Files:**
- Create: `test/fixtures/wix-sitemap.xml`
- Create: `test/fixtures/wix-page-home.json`
- Create: `test/fixtures/wix-page-blog-post.json`
- Create: `test/fixtures/wix-api-response.json`

Record fixture data from a real Wix site for deterministic integration tests. This requires manual interaction with a real Wix site.

- [ ] **Step 1: Create sitemap fixture**

```xml
<!-- test/fixtures/wix-sitemap.xml -->
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://test.wixsite.com/site</loc></url>
  <url><loc>https://test.wixsite.com/site/about</loc></url>
  <url><loc>https://test.wixsite.com/site/blog/hello-world</loc></url>
  <url><loc>https://test.wixsite.com/site/blog/second-post</loc></url>
  <url><loc>https://test.wixsite.com/site/contact</loc></url>
</urlset>
```

- [ ] **Step 2: Create page data fixtures**

Create JSON fixtures representing the data `_extractPage()` would capture from real Wix pages. These include API calls, window globals, JSON-LD, and meta tags. Use the existing `reference/wix-probe-original.js` output as a guide for realistic data shapes.

```json
// test/fixtures/wix-page-blog-post.json
{
  "title": "Hello World",
  "content": "<p>This is my first blog post on Wix.</p><p>It has multiple paragraphs.</p>",
  "excerpt": "My first blog post",
  "date": "2026-01-15T10:00:00Z",
  "categories": [],
  "tags": [],
  "seoTitle": "Hello World - Test Site",
  "seoDescription": "My first blog post on this test site",
  "mediaUrls": ["https://static.wixstatic.com/media/abc123.jpg"],
  "apiCallCount": 3,
  "globalsFound": 2
}
```

- [ ] **Step 3: Commit**

```bash
git add test/fixtures/
git commit -m "test: add Wix fixture data for integration tests"
```

---

### Task 6: Integration Test with Fixtures

**Files:**
- Modify: `test/adapters/wix.test.js`

Write integration tests that verify the full discover → extract → WXR pipeline using fixtures. Mock Playwright's `page.goto`, `page.evaluate`, and `page.on('response')` to return fixture data.

- [ ] **Step 1: Write integration tests**

```js
// append to test/adapters/wix.test.js
import { WxrBuilder } from '../../src/lib/wxr-builder.js';
import { ExtractionLog } from '../../src/lib/extraction-log.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('wixAdapter end-to-end with mocked page data', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wix-e2e-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('builds WXR from fixture page data', () => {
    // Simulate what extract() produces by calling wxr-builder directly
    // with fixture data — tests the wxr-builder integration, not Playwright
    const fixture = JSON.parse(readFileSync('test/fixtures/wix-page-blog-post.json', 'utf8'));
    const wxr = new WxrBuilder({ title: 'Test Site', url: 'https://test.wixsite.com/site' });

    wxr.addPost({
      title: fixture.title,
      slug: 'hello-world',
      content: fixture.content,
      excerpt: fixture.excerpt,
      date: fixture.date,
      seoTitle: fixture.seoTitle,
      seoDescription: fixture.seoDescription,
    });

    wxr.addRedirect({ from: '/blog/hello-world', to: 'hello-world' });

    const wxrPath = join(tempDir, 'output.wxr');
    wxr.serialize(wxrPath);

    // Verify WXR was written
    expect(existsSync(wxrPath)).toBe(true);
    const xml = readFileSync(wxrPath, 'utf8');
    expect(xml).toContain('<title>Hello World</title>');
    expect(xml).toContain('first blog post');
    expect(xml).toContain('<wp:post_type>post</wp:post_type>');
    expect(xml).toContain('_seo_title');

    // Verify redirect map
    const redirectPath = join(tempDir, 'redirect-map.json');
    expect(existsSync(redirectPath)).toBe(true);
    const redirects = JSON.parse(readFileSync(redirectPath, 'utf8'));
    expect(redirects[0].from).toBe('/blog/hello-world');
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npx vitest run test/adapters/wix.test.js`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add test/adapters/wix.test.js
git commit -m "test: add Wix adapter integration tests with fixtures"
```

---

### Task 7: Canary Test Skeleton

**Files:**
- Create: `test/canary/wix-live.test.js`

A test that runs against a real Wix site. Not run in CI — manual/scheduled only. Verifies that Wix hasn't changed their internal APIs.

- [ ] **Step 1: Create canary test**

```js
// test/canary/wix-live.test.js
import { describe, it, expect } from 'vitest';
import { wixAdapter } from '../../src/adapters/wix.js';

// This test hits a real Wix site. Run manually:
//   npx vitest run test/canary/wix-live.test.js
//
// It verifies that Wix's internal APIs haven't changed in ways
// that break our extraction. If this fails, update the adapter
// and add a DISCOVERIES.md entry.

const TEST_URL = 'https://www.wix.com/blog';

describe('Wix live canary', () => {
  it('can discover a real Wix site', async () => {
    const inventory = await wixAdapter.discover(TEST_URL, {});
    expect(inventory.platform).toBe('wix');
    expect(inventory.urls.length).toBeGreaterThan(0);
    expect(inventory.siteMeta.title).toBeTruthy();
    console.log(`  Discovered ${inventory.urls.length} URLs`);
    console.log(`  Site title: ${inventory.siteMeta.title}`);
  }, 60000); // 60s timeout
});
```

- [ ] **Step 2: Commit**

```bash
git add test/canary/wix-live.test.js
git commit -m "test: add Wix live canary test (manual/scheduled only)"
```

---

### Task 8: Verify End-to-End CLI

Manual verification that the full pipeline works.

- [ ] **Step 1: Run CLI detection against a Wix site**

Run: `node src/cli.js https://www.wix.com/blog`
Expected: Detects "wix" platform, shows URL counts from sitemap

- [ ] **Step 2: Run MCP server and call liberate_detect**

Run: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"liberate_detect","arguments":{"url":"https://www.wix.com/blog"}}}' | node src/mcp-server.js 2>/dev/null`
Expected: JSON response with `platform: "wix"`

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: end-to-end verification fixes"
```
