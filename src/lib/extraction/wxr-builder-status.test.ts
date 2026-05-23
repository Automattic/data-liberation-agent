import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WxrBuilder } from './wxr-builder.js';

const SITE = 'https://example.com';
const TMP = join(process.cwd(), '.tmp-test');
mkdirSync(TMP, { recursive: true });

function buildXml(): string {
  const dir = mkdtempSync(join(TMP, 'wxr-status-'));
  try {
    const w = new WxrBuilder({ title: 'Example', url: SITE, language: 'en-US' });
    w.addPage({ title: 'About', slug: 'about', content: '<p>a</p>', sourceUrl: `${SITE}/about` });
    w.addPost({ title: 'Hello', slug: 'hello', content: '<p>h</p>', sourceUrl: `${SITE}/hello` });
    w.addMedia({ title: 'Img', slug: 'img', url: `${SITE}/img.jpg`, altText: '', caption: '' });
    w.addMenuItem({ title: 'Home', url: SITE, menuSlug: 'primary' });
    const out = join(dir, 'output.wxr');
    w.serialize(out);
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('WxrBuilder post status', () => {
  it('emits no draft pages/posts (was hardcoded draft → 404 nav targets)', () => {
    const xml = buildXml();
    const draftCount = (xml.match(/<wp:status>draft<\/wp:status>/g) || []).length;
    expect(draftCount).toBe(0);
  });

  it('publishes pages; attachments use WP inherit convention', () => {
    const xml = buildXml();
    const pageIdx = xml.indexOf('<wp:post_type>page</wp:post_type>');
    expect(pageIdx).toBeGreaterThan(-1);
    expect(xml.slice(pageIdx - 700, pageIdx + 60)).toContain('<wp:status>publish</wp:status>');

    const attIdx = xml.indexOf('<wp:post_type>attachment</wp:post_type>');
    expect(attIdx).toBeGreaterThan(-1);
    expect(xml.slice(attIdx - 700, attIdx + 60)).toContain('<wp:status>inherit</wp:status>');

    expect(xml).toContain('<wp:status>publish</wp:status>');
  });
});
