import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ExtractionLog } from '../lib/extraction/extraction-log.js';
import { WxrBuilder } from '../lib/extraction/wxr-builder.js';
import { connectBrowser, runExtractionLoop, stratifiedUrlSlice, type ExtractedPage } from './shared.js';

const FIXTURE_TMP = join(process.cwd(), '.tmp-test');
mkdirSync(FIXTURE_TMP, { recursive: true });

function makeWxr() {
  return new WxrBuilder({
    title: 'Test',
    url: 'https://example.com',
    description: '',
    language: 'en-US',
  });
}

function makePage(url: string, overrides: Partial<ExtractedPage> = {}): ExtractedPage {
  return {
    title: url.includes('/blog/') ? 'Hello' : 'About',
    slug: url.includes('/blog/') ? 'hello' : 'about',
    content: '<p>Content</p>',
    excerpt: '',
    date: '2026-04-30 12:00:00',
    seoTitle: '',
    seoDescription: '',
    mediaUrls: [],
    qualityScore: 'high',
    ...overrides,
  };
}

describe('stratifiedUrlSlice', () => {
  function u(type: string, n: number) {
    return { url: `https://x.com/${type}/${n}`, type };
  }

  it('returns everything when limit >= length', () => {
    const urls = [u('page', 1), u('product', 1)];
    expect(stratifiedUrlSlice(urls, 5)).toEqual(urls);
    expect(stratifiedUrlSlice(urls, 2)).toEqual(urls);
  });

  it('returns empty for limit 0 or negative', () => {
    expect(stratifiedUrlSlice([u('page', 1)], 0)).toEqual([]);
    expect(stratifiedUrlSlice([u('page', 1)], -1)).toEqual([]);
  });

  it('includes products even when pages sort first (the Shopify-store bug)', () => {
    // Mirrors the inventory ordering that broke the limited getsnooz run:
    // all /pages/* before any /products/*.
    const urls = [
      ...Array.from({ length: 30 }, (_, i) => u('page', i)),
      ...Array.from({ length: 20 }, (_, i) => u('product', i)),
    ];
    const sliced = stratifiedUrlSlice(urls, 20);
    expect(sliced).toHaveLength(20);
    const types = sliced.map((s) => s.type);
    expect(types).toContain('product');
    expect(types).toContain('page');
    // Round-robin gives roughly even representation across the two types.
    const productCount = types.filter((t) => t === 'product').length;
    expect(productCount).toBeGreaterThanOrEqual(8);
  });

  it('always puts the homepage first', () => {
    const urls = [
      u('page', 1),
      u('page', 2),
      { url: 'https://x.com/', type: 'homepage' },
      u('product', 1),
    ];
    const sliced = stratifiedUrlSlice(urls, 2);
    expect(sliced[0].type).toBe('homepage');
    expect(sliced).toHaveLength(2);
  });

  it('preserves relative order within a type bucket', () => {
    const urls = [
      u('product', 1),
      u('product', 2),
      u('product', 3),
      u('page', 1),
      u('page', 2),
    ];
    const sliced = stratifiedUrlSlice(urls, 4);
    const products = sliced.filter((s) => s.type === 'product').map((s) => s.url);
    // whatever subset is taken, it must be a prefix of the original product order
    expect(products).toEqual(['https://x.com/product/1', 'https://x.com/product/2'].slice(0, products.length));
  });

  it('returns exactly min(limit, length) entries', () => {
    const urls = [u('page', 1), u('product', 1), u('post', 1), u('product', 2)];
    expect(stratifiedUrlSlice(urls, 3)).toHaveLength(3);
  });
});

describe('runExtractionLoop streaming callback', () => {
  it('emits each extracted URL with the WXR items created for that URL', async () => {
    const outputDir = mkdtempSync(join(FIXTURE_TMP, 'shared-cb-'));
    try {
      const wxr = makeWxr();
      const log = new ExtractionLog(outputDir);
      const onPageExtracted = vi.fn();
      const extractPage = vi.fn((url: string) => Promise.resolve(makePage(url)));

      const result = await runExtractionLoop({
        urls: [
          { url: 'https://example.com/about', type: 'page' },
          { url: 'https://example.com/blog/hello', type: 'post' },
        ],
        navigation: [],
        wxr,
        log,
        outputDir,
        delay: 0,
        dryRun: false,
        resume: false,
        extractPage,
        onPageExtracted,
      });

      expect(result.pagesExtracted).toBe(1);
      expect(result.postsExtracted).toBe(1);
      expect(extractPage).toHaveBeenCalledTimes(2);
      expect(onPageExtracted).toHaveBeenCalledTimes(2);
      expect(onPageExtracted.mock.calls[0][0]).toMatchObject({
        url: 'https://example.com/about',
        slug: 'about',
        type: 'page',
      });
      expect(onPageExtracted.mock.calls[0][0].items.map((item: { type: string }) => item.type)).toEqual(['page']);
      expect(onPageExtracted.mock.calls[1][0]).toMatchObject({
        url: 'https://example.com/blog/hello',
        slug: 'hello',
        type: 'post',
      });
      expect(onPageExtracted.mock.calls[1][0].items.map((item: { type: string }) => item.type)).toEqual(['post']);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.env.SKIP_BROWSER_TESTS)('connectBrowser', () => {
  it('launches headless Chromium by default', async () => {
    const b = await connectBrowser({});
    try {
      const ctx = await b.newContext();
      const page = await ctx.newPage();
      await page.goto('data:text/html,<h1>hi</h1>');
      expect(page).toBeDefined();
    } finally {
      await b.close();
    }
  }, 30_000);
});
