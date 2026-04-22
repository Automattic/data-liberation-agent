import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { detectFromUrl, detectFromHttp, PATH_PROBES } from '../src/lib/extraction/detect-platform.js';

describe('detectFromUrl (heuristics)', () => {
  it('detects wixsite.com', () => {
    expect(detectFromUrl('https://mysite.wixsite.com/blog')).toBe('wix');
  });

  it('detects squarespace.com', () => {
    expect(detectFromUrl('https://mysite.squarespace.com')).toBe('squarespace');
  });

  it('detects webflow.io', () => {
    expect(detectFromUrl('https://mysite.webflow.io')).toBe('webflow');
  });

  it('detects myshopify.com', () => {
    expect(detectFromUrl('https://mystore.myshopify.com')).toBe('shopify');
  });

  it('returns null for custom domains', () => {
    expect(detectFromUrl('https://www.mybusiness.com')).toBeNull();
  });

  it('handles URLs without protocol', () => {
    expect(detectFromUrl('mysite.wixsite.com/blog')).toBe('wix');
  });
});

describe('detectFromHttp (fingerprinting)', () => {
  it('detects Wix from X-Wix-Request-Id header', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['x-wix-request-id', 'abc123']]),
      text: () => Promise.resolve('<html></html>'),
    });
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('wix');
    expect(result.confidence).toBe('high');
    expect(result.signals).toContain('X-Wix-Request-Id header');
  });

  it('detects Squarespace from X-ServedBy header', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['x-servedby', 'squarespace']]),
      text: () => Promise.resolve('<html></html>'),
    });
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('squarespace');
  });

  it('returns unknown for unrecognized sites', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map(),
      text: () => Promise.resolve('<html><body>Hello</body></html>'),
    });
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('unknown');
    expect(result.confidence).toBe('low');
  });

  it('handles fetch failure gracefully', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('unknown');
    expect(result.confidence).toBe('low');
  });

  it('detects GoDaddy Websites & Marketing from generator meta in page source', async () => {
    const html = readFileSync('test/fixtures/godaddy-wm-blog-post.html', 'utf8');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map(),
      text: () => Promise.resolve(html),
    });
    const result = await detectFromHttp('https://cruisewarehouse.com');
    expect(result.platform).toBe('godaddy-wm');
    expect(result.signals.some((s) => /generator meta|isteam/i.test(s))).toBe(true);
  });

  it('detects GoDaddy Websites & Marketing from X-SiteId header', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['x-siteid', 'us-west-2']]),
      text: () => Promise.resolve('<html></html>'),
    });
    const result = await detectFromHttp('https://skywaydiner.com');
    expect(result.platform).toBe('godaddy-wm');
    expect(result.confidence).toBe('high');
  });
});

describe('PATH_PROBES infrastructure', () => {
  afterEach(() => {
    PATH_PROBES.length = 0;
  });

  it('exports PATH_PROBES as an array', () => {
    expect(Array.isArray(PATH_PROBES)).toBe(true);
  });

  it('PATH_PROBES is empty (no consumers in this PR)', () => {
    expect(PATH_PROBES).toEqual([]);
  });

  it('matches a path probe when source signals fail (status only)', async () => {
    // Inject a test probe by mutating PATH_PROBES (vitest tests share module state)
    PATH_PROBES.push({
      path: '/_test/admin',
      expectedStatus: [302, 401],
      platform: 'testplatform',
      signal: '/_test/admin probe',
    });

    // Mock chain: first fetch (homepage) returns generic HTML (forces probe),
    // second fetch (probe HEAD) returns 302.
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
        text: () => Promise.resolve('<html><body>Generic</body></html>'),
      })
      .mockResolvedValueOnce({
        status: 302,
        headers: new Map([['location', 'https://example.com/_test/admin/login']]),
      });

    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('testplatform');
    expect(result.confidence).toBe('high');
    expect(result.signals).toContain('/_test/admin probe');
  });

  it('does NOT match when probe returns wrong status', async () => {
    PATH_PROBES.push({
      path: '/_test/admin',
      expectedStatus: [302, 401],
      platform: 'testplatform',
      signal: '/_test/admin probe',
    });

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
        text: () => Promise.resolve('<html></html>'),
      })
      .mockResolvedValueOnce({
        status: 404,  // Wrong status
        headers: new Map(),
      });

    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('unknown');
  });

  it('matches when Location header contains expected substring', async () => {
    PATH_PROBES.push({
      path: '/_test/admin',
      expectedStatus: [302],
      locationContains: '/_test/admin/login',
      platform: 'testplatform',
      signal: '/_test/admin probe with location check',
    });

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
        text: () => Promise.resolve('<html></html>'),
      })
      .mockResolvedValueOnce({
        status: 302,
        headers: new Map([['location', 'https://example.com/_test/admin/login?redirect=%2F_test%2Fadmin']]),
      });

    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('testplatform');
  });

  it('does NOT match when Location header lacks expected substring', async () => {
    PATH_PROBES.push({
      path: '/_test/admin',
      expectedStatus: [302],
      locationContains: '/_test/admin/login',
      platform: 'testplatform',
      signal: '/_test/admin probe with location check',
    });

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
        text: () => Promise.resolve('<html></html>'),
      })
      .mockResolvedValueOnce({
        status: 302,
        headers: new Map([['location', 'https://example.com/somewhere-else']]),  // Wrong location
      });

    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('unknown');  // Status matched but Location didn't
  });

  it('does NOT match when Location header is missing entirely', async () => {
    PATH_PROBES.push({
      path: '/_test/admin',
      expectedStatus: [302],
      locationContains: '/_test/admin/login',
      platform: 'testplatform',
      signal: '/_test/admin probe with location check',
    });

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
        text: () => Promise.resolve('<html></html>'),
      })
      .mockResolvedValueOnce({
        status: 302,
        headers: new Map(),  // No Location header
      });

    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('unknown');
  });
});
