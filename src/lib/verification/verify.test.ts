import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { verifyExtraction, type VerificationReport } from './verify.js';

const TMP = join(import.meta.dirname, '__test_verify__');

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  mkdirSync(join(TMP, 'media'), { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function writeMinimalWxr(content: string = '<p>Hello</p>'): void {
  const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:wp="http://wordpress.org/export/1.2/"
     xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/">
<channel>
  <title>Test</title>
  <wp:wxr_version>1.2</wp:wxr_version>
  <item>
    <title>Page One</title>
    <wp:post_type><![CDATA[page]]></wp:post_type>
    <content:encoded><![CDATA[${content}]]></content:encoded>
  </item>
</channel>
</rss>`;
  writeFileSync(join(TMP, 'output.wxr'), wxr);
}

function writeLog(lines: object[]): void {
  writeFileSync(
    join(TMP, 'extraction-log.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  );
}

function writeRedirectMap(redirects: Array<{ from: string; to: string }>): void {
  writeFileSync(join(TMP, 'redirect-map.json'), JSON.stringify(redirects, null, 2));
}

describe('verifyExtraction', () => {
  it('returns clean report for valid extraction', async () => {
    writeMinimalWxr();
    writeLog([
      { type: 'processed', url: 'https://example.com/', slug: 'homepage', durationMs: 500, qualityScore: 'high' },
    ]);
    writeRedirectMap([{ from: '/', to: '/homepage' }]);

    const report = await verifyExtraction(TMP);

    expect(report.outputDir).toBe(TMP);
    expect(report.wxrFound).toBe(true);
    expect(report.contentItems).toBeGreaterThan(0);
    expect(report.staleCdnUrls).toEqual([]);
    expect(report.failedUrls).toEqual([]);
    expect(report.failedMedia).toEqual([]);
    expect(report.redirectCount).toBe(1);
  });

  it('detects stale Wix CDN URLs in content', async () => {
    writeMinimalWxr('<p>Image: <img src="https://static.wixstatic.com/media/abc.jpg" /></p>');
    writeLog([
      { type: 'processed', url: 'https://example.com/', slug: 'homepage', durationMs: 500, qualityScore: 'high' },
    ]);

    const report = await verifyExtraction(TMP);
    expect(report.staleCdnUrls.length).toBe(1);
    expect(report.staleCdnUrls[0]).toContain('wixstatic.com');
  });

  it('detects stale Squarespace CDN URLs in content', async () => {
    writeMinimalWxr('<img src="https://images.squarespace-cdn.com/content/v1/abc/def.jpg" />');
    writeLog([]);

    const report = await verifyExtraction(TMP);
    expect(report.staleCdnUrls.length).toBe(1);
    expect(report.staleCdnUrls[0]).toContain('squarespace-cdn.com');
  });

  it('reports failed URLs from extraction log', async () => {
    writeMinimalWxr();
    writeLog([
      { type: 'processed', url: 'https://example.com/', slug: 'homepage', durationMs: 500, qualityScore: 'high' },
      { type: 'failed', url: 'https://example.com/broken', error: 'Timeout' },
    ]);

    const report = await verifyExtraction(TMP);
    expect(report.failedUrls).toEqual([
      { url: 'https://example.com/broken', error: 'Timeout' },
    ]);
  });

  it('reports failed media downloads', async () => {
    writeMinimalWxr();
    writeLog([
      { type: 'media_failed', url: 'https://cdn.example.com/img.jpg', error: '404' },
    ]);

    const report = await verifyExtraction(TMP);
    expect(report.failedMedia).toEqual([
      { url: 'https://cdn.example.com/img.jpg', error: '404' },
    ]);
  });

  it('counts media files on disk', async () => {
    writeMinimalWxr();
    writeLog([]);
    writeFileSync(join(TMP, 'media', 'photo.jpg'), 'fake');

    const report = await verifyExtraction(TMP);
    expect(report.mediaOnDisk).toBe(1);
  });

  it('counts post_type items in the PLAIN-text WXR form (not just CDATA-wrapped)', async () => {
    // The WXR builder emits <wp:post_type>page</wp:post_type> (no CDATA); the
    // counter must match both forms or it reports 0 on real output.
    const wxr = `<?xml version="1.0"?>
<rss xmlns:wp="http://wordpress.org/export/1.2/"><channel>
  <item><wp:post_type>page</wp:post_type></item>
  <item><wp:post_type>page</wp:post_type></item>
  <item><wp:post_type>attachment</wp:post_type></item>
  <item><wp:post_type><![CDATA[post]]></wp:post_type></item>
</channel></rss>`;
    writeFileSync(join(TMP, 'output.wxr'), wxr);
    writeLog([]);
    const report = await verifyExtraction(TMP);
    expect(report.pages).toBe(2);
    expect(report.mediaAttachments).toBe(1);
    expect(report.posts).toBe(1);
  });

  it('reports missing WXR gracefully', async () => {
    writeLog([]);

    const report = await verifyExtraction(TMP);
    expect(report.wxrFound).toBe(false);
    expect(report.contentItems).toBe(0);
  });

  it('includes quality score breakdown', async () => {
    writeMinimalWxr();
    writeLog([
      { type: 'processed', url: 'https://example.com/a', slug: 'a', qualityScore: 'high' },
      { type: 'processed', url: 'https://example.com/b', slug: 'b', qualityScore: 'medium' },
      { type: 'processed', url: 'https://example.com/c', slug: 'c', qualityScore: 'low' },
    ]);

    const report = await verifyExtraction(TMP);
    expect(report.qualityScores).toEqual({ high: 1, medium: 1, low: 1 });
  });
});
