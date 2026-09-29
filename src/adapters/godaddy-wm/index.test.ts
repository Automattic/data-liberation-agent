import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { exportWebsiteCapture } from '../../lib/capture-export.js';
import { godaddyWmAdapter } from './index.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('GoDaddy W+M publication evidence', () => {
  it('carries a blog post published date into portable HTML, but not ordinary pages', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const postPage = await browser.newPage();
      await postPage.setContent('<html><head></head><body><article>Post</article><script>window._BLOG_DATA = { post: { publishedDate: "2025-02-03T04:05:06.000Z" } };</script></body></html>');
      await godaddyWmAdapter.liberation?.beforeSerialize?.(postPage, { url: 'https://example.test/news,-updates-and-reviews/f/post', viewport: 'desktop' });
      const postHtml = await postPage.content();
      expect(postHtml).toContain('property="article:published_time" content="2025-02-03T04:05:06.000Z"');

      const page = await browser.newPage();
      await page.setContent('<html><head></head><body><main>Page</main></body></html>');
      await godaddyWmAdapter.liberation?.beforeSerialize?.(page, { url: 'https://example.test/about', viewport: 'desktop' });
      expect(await page.content()).not.toContain('article:published_time');

      const outputDir = mkdtempSync(join(tmpdir(), 'dla-godaddy-publication-'));
      directories.push(outputDir);
      mkdirSync(join(outputDir, 'html'), { recursive: true });
      mkdirSync(join(outputDir, 'screenshots'), { recursive: true });
      writeFileSync(join(outputDir, 'html', 'homepage.html'), '<html><head></head><body><main>Home</main></body></html>');
      writeFileSync(join(outputDir, 'html', 'post.html'), postHtml);
      writeFileSync(join(outputDir, 'html', 'page.html'), await page.content());
      writeFileSync(join(outputDir, 'screenshots', 'manifest.json'), JSON.stringify({
        version: 1,
        entries: {
          'https://example.test/': { slug: 'homepage', html: 'html/homepage.html' },
          'https://example.test/news,-updates-and-reviews/f/post': { slug: 'post', html: 'html/post.html' },
          'https://example.test/about': { slug: 'page', html: 'html/page.html' },
        },
      }));
      exportWebsiteCapture({ outputDir, sourceUrl: 'https://example.test/', platform: 'godaddy-wm', summary: {}, failures: [] });

      expect(readFileSync(join(outputDir, 'website', 'news,-updates-and-reviews', 'f', 'post', 'index.html'), 'utf8')).toContain('article:published_time');
      expect(readFileSync(join(outputDir, 'website', 'about', 'index.html'), 'utf8')).not.toContain('article:published_time');
    } finally {
      await browser.close();
    }
  });
});
