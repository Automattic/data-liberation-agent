import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { installPost } from './post-install.js';
import type { WxrItem, PageItem, PostItem, MediaItem } from '../extraction/wxr-builder.js';

const FIXTURE_TMP = join(process.cwd(), '.tmp-test');
mkdirSync(FIXTURE_TMP, { recursive: true });

function makePage(overrides: Partial<PageItem> = {}): PageItem {
  return {
    id: 1,
    type: 'page',
    title: 'About',
    slug: 'about',
    content: '<p>About us</p>',
    excerpt: '',
    date: '2026-04-29T12:00:00.000Z',
    parent: 0,
    menuOrder: 0,
    author: 'admin',
    seoTitle: '',
    seoDescription: '',
    sourceUrl: 'https://example.com/about',
    ...overrides,
  };
}

describe('installPost', () => {
  it('returns null for non-post items (attachment, nav menu, etc.)', async () => {
    const attachment: MediaItem = {
      id: 1,
      type: 'attachment',
      title: 'image.png',
      slug: 'image-png',
      url: 'https://example.com/image.png',
      altText: '',
      caption: '',
    };
    const result = await installPost({
      item: attachment,
      outputDir: FIXTURE_TMP,
      studioSitePath: '/tmp/site',
    });
    expect(result).toBeNull();
  });

  it('errors when sourceUrl meta is missing', async () => {
    const page = makePage({ sourceUrl: '' });
    const result = await installPost({
      item: page,
      outputDir: FIXTURE_TMP,
      studioSitePath: '/tmp/site',
    });
    expect(result?.action).toBe('error');
    expect(result?.error).toMatch(/sourceUrl/);
  });
});
