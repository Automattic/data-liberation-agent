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
    expect(inv.siteMeta.language).toBe('en');  // html lang from fixture
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
});
