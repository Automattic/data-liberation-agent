import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ExtractionLog } from '../lib/extraction/extraction-log.js';
import { WxrBuilder } from '../lib/extraction/wxr-builder.js';
import { connectBrowser, runExtractionLoop, type ExtractedPage } from './shared.js';

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
