import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { vi } from 'vitest';
import { emdashAdapter } from '../../src/adapters/emdash.js';

describe('emdashAdapter', () => {
  it('has id "emdash"', () => {
    expect(emdashAdapter.id).toBe('emdash');
  });

  it('detect() returns false (routing handled by detect-platform.ts)', () => {
    expect(emdashAdapter.detect('https://example.com')).toBe(false);
    expect(emdashAdapter.detect('https://yurulog.liberogic.jp')).toBe(false);
  });
});

describe('emdashAdapter.discover', () => {
  it('fetches homepage and extracts site meta', async () => {
    const homeHtml = readFileSync('test/fixtures/emdash/yurulog-home.html', 'utf8');
    const sitemapXml = readFileSync('test/fixtures/emdash/yurulog-sitemap.xml', 'utf8');
    const sitemapPostsXml = readFileSync('test/fixtures/emdash/yurulog-sitemap-posts.xml', 'utf8');

    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/')) {
        return { ok: true, headers: new Map(), text: async () => homeHtml, body: { cancel: async () => {} } };
      }
      if (url.endsWith('/sitemap.xml')) {
        return { ok: true, headers: new Map(), text: async () => sitemapXml, body: { cancel: async () => {} } };
      }
      if (url.endsWith('/sitemap-posts.xml')) {
        return { ok: true, headers: new Map(), text: async () => sitemapPostsXml, body: { cancel: async () => {} } };
      }
      return { ok: false, status: 404, headers: new Map(), text: async () => '', body: { cancel: async () => {} } };
    });

    const inv = await emdashAdapter.discover('https://yurulog.liberogic.jp', {});
    expect(inv.siteUrl).toBe('https://yurulog.liberogic.jp');
    expect(inv.siteMeta.title).toBeTruthy();
    expect(inv.siteMeta.language).toBe('ja');  // yurulog is a Japanese-language blog
    expect(inv.urls.length).toBeGreaterThan(0);
  });

  it('throws on fetch failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    await expect(emdashAdapter.discover('https://example.com', {})).rejects.toThrow(/fetch failed/i);
  });

  it('throws on non-2xx homepage response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: { cancel: async () => {} },
    });
    await expect(emdashAdapter.discover('https://example.com', {})).rejects.toThrow(/500/);
  });

  it('falls back to /posts listing when sitemap is empty', async () => {
    const homeHtml = readFileSync('test/fixtures/emdash/yurulog-home.html', 'utf8');
    const emptySitemap = readFileSync('test/fixtures/emdash/pmaioranatest-empty-sitemap.xml', 'utf8');
    const listingHtml = readFileSync('test/fixtures/emdash/pmaioranatest-posts-listing.html', 'utf8');

    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/')) {
        return { ok: true, headers: new Map(), text: async () => homeHtml, body: { cancel: async () => {} } };
      }
      if (url.endsWith('/sitemap.xml')) {
        return { ok: true, headers: new Map(), text: async () => emptySitemap, body: { cancel: async () => {} } };
      }
      if (url.endsWith('/posts')) {
        return { ok: true, headers: new Map(), text: async () => listingHtml, body: { cancel: async () => {} } };
      }
      return { ok: false, status: 404, headers: new Map(), text: async () => '', body: { cancel: async () => {} } };
    });

    const inv = await emdashAdapter.discover('https://pmaioranatest.dashhost.cc', {});
    // Listing fallback should find the 173 posts
    expect(inv.urls.length).toBeGreaterThan(100);
    expect(inv.urls.every((u) => u.type === 'post' || u.type === 'page' || u.type === 'homepage')).toBe(true);
  });

  it('filters out taxonomy/listing/internal URLs from inventory', async () => {
    // Craft a minimal homepage HTML that includes links to content and non-content routes
    const homeHtml = `
      <html lang="en">
      <head><title>Test</title></head>
      <body>
        <nav>
          <a href="/pages/about">About</a>
          <a href="/posts/my-first-post">Post</a>
          <a href="/category/diy">DIY</a>
          <a href="/tag/fun">Fun</a>
          <a href="/search">Search</a>
          <a href="/404">404</a>
          <a href="/_emdash/admin">Admin</a>
        </nav>
      </body>
      </html>
    `;
    // Empty sitemap + 404 listing — only homepage nav contributes URLs
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/')) {
        return { ok: true, headers: new Map(), text: async () => homeHtml, body: { cancel: async () => {} } };
      }
      if (url.endsWith('/sitemap.xml') || url.endsWith('/posts')) {
        return { ok: false, status: 404, headers: new Map(), text: async () => '', body: { cancel: async () => {} } };
      }
      return { ok: false, status: 404, headers: new Map(), text: async () => '', body: { cancel: async () => {} } };
    });

    const inv = await emdashAdapter.discover('https://example.com', {});
    const paths = inv.urls.map((u) => new URL(u.url).pathname);
    // Only /pages/about should survive the filter (the post is added by nav-crawl only if we scrape all anchors,
    // which our current impl only does for /pages/* nav entries). Acceptable for v1 — posts come from sitemap/listing.
    expect(paths).toContain('/pages/about');
    expect(paths).not.toContain('/category/diy');
    expect(paths).not.toContain('/tag/fun');
    expect(paths).not.toContain('/search');
    expect(paths).not.toContain('/404');
    expect(paths.some((p) => p.startsWith('/_emdash/'))).toBe(false);
  });
});
