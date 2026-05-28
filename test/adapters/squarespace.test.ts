import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { squarespaceAdapter } from '../../src/adapters/squarespace.js';
import { WxrBuilder } from '../../src/lib/extraction/wxr-builder.js';

describe('squarespaceAdapter', () => {
  it('has id "squarespace"', () => {
    expect(squarespaceAdapter.id).toBe('squarespace');
  });

  it('detects squarespace.com URLs', () => {
    expect(squarespaceAdapter.detect('https://mysite.squarespace.com')).toBe(true);
    expect(squarespaceAdapter.detect('https://www.squarespace.com/mysite')).toBe(true);
  });

  it('does not detect non-Squarespace URLs', () => {
    expect(squarespaceAdapter.detect('https://www.example.com')).toBe(false);
    expect(squarespaceAdapter.detect('https://mysite.wixsite.com/blog')).toBe(false);
  });

  it('has discover method', () => {
    expect(typeof squarespaceAdapter.discover).toBe('function');
  });

  it('has extract method', () => {
    expect(typeof squarespaceAdapter.extract).toBe('function');
  });
});

describe('Squarespace adapter WXR integration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sqs-e2e-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('builds valid WXR from fixture page data', () => {
    const fixture = JSON.parse(readFileSync('test/fixtures/squarespace-page.json', 'utf8'));

    const wxr = new WxrBuilder({
      title: fixture.website.siteTitle,
      url: 'https://mountaincoffee.squarespace.com',
      description: fixture.website.siteTagLine,
      language: fixture.website.language,
    });

    // Add the blog post from fixture item data
    const item = fixture.item;
    wxr.addPost({
      title: item.title,
      slug: item.urlId,
      content: item.body,
      excerpt: item.excerpt,
      date: new Date(item.publishOn).toISOString(),
      seoTitle: item.seoData.seoTitle,
      seoDescription: item.seoData.seoDescription,
      categories: item.categories,
      tags: item.tags,
    });

    // Register categories and tags so validation is clean
    for (const cat of item.categories) {
      wxr.addCategory({ slug: cat, name: cat });
    }
    for (const tag of item.tags) {
      wxr.addTag({ slug: tag, name: tag });
    }

    // Add a page from the collection mainContent pattern
    wxr.addPage({
      title: 'About',
      slug: 'about',
      content: '<p>Mountain Coffee Roasters was founded in 2018 in the highlands of Colombia.</p>',
      excerpt: 'Our story',
      seoTitle: 'About | Mountain Coffee Roasters',
      seoDescription: 'Learn about our story and mission.',
    });

    // Add media from the fixture
    wxr.addMedia({
      url: item.assetUrl,
      localPath: 'media/pour-over-hero.jpg',
      title: 'pour-over-hero.jpg',
    });

    wxr.addRedirect({ from: '/blog/the-art-of-pour-over-coffee', to: '/the-art-of-pour-over-coffee' });

    wxr.addMenuItem({
      title: 'Home',
      url: 'https://mountaincoffee.squarespace.com',
      menuSlug: 'main-menu',
      order: 1,
    });
    wxr.addMenuItem({
      title: 'Blog',
      url: 'https://mountaincoffee.squarespace.com/blog',
      menuSlug: 'main-menu',
      order: 2,
    });

    const wxrPath = join(tempDir, 'output.wxr');
    const { validation } = wxr.serialize(wxrPath);

    expect(existsSync(wxrPath)).toBe(true);
    const xml = readFileSync(wxrPath, 'utf8');

    // Verify structure
    expect(xml).toContain('<wp:wxr_version>1.2</wp:wxr_version>');
    expect(xml).toContain('<title>Mountain Coffee Roasters</title>');

    // Verify blog post content
    expect(xml).toContain('<title>The Art of Pour Over Coffee</title>');
    expect(xml).toContain('<wp:post_type>post</wp:post_type>');
    expect(xml).toContain('Pour over coffee');

    // Verify page
    expect(xml).toContain('<title>About</title>');
    expect(xml).toContain('<wp:post_type>page</wp:post_type>');

    // Verify SEO meta
    expect(xml).toContain('<wp:meta_key>_seo_title</wp:meta_key>');
    expect(xml).toContain('Mountain Coffee Roasters');

    // Verify categories and tags
    expect(xml).toContain('Brewing Guides');
    expect(xml).toContain('brewing');

    // Verify media
    expect(xml).toContain('<wp:post_type>attachment</wp:post_type>');
    expect(xml).toContain('squarespace-cdn.com');

    // Verify nav menu items
    expect(xml).toContain('<wp:post_type>nav_menu_item</wp:post_type>');

    // Verify redirect map
    const redirectPath = join(tempDir, 'redirect-map.json');
    expect(existsSync(redirectPath)).toBe(true);
    const redirects = JSON.parse(readFileSync(redirectPath, 'utf8'));
    expect(redirects).toHaveLength(1);
    expect(redirects[0].from).toBe('/blog/the-art-of-pour-over-coffee');

    // Validate
    expect(validation.valid).toBe(true);
  });
});

import { detectBlogPrefixes } from '../../src/adapters/squarespace.js';

describe('detectBlogPrefixes', () => {
  it('picks up date-based blog prefixes', () => {
    const urls = [
      { url: 'https://example.com/', type: 'homepage' },
      { url: 'https://example.com/walkabout-chronicles/2024/3/1/post-a', type: 'post' },
      { url: 'https://example.com/walkabout-chronicles/2024/3/15/post-b', type: 'post' },
      { url: 'https://example.com/walkabout-chronicles/2024/4/2/post-c', type: 'post' },
      { url: 'https://example.com/about', type: 'page' },
    ];
    const prefixes = detectBlogPrefixes(urls);
    expect(prefixes).toContain('/walkabout-chronicles');
  });

  it('picks up conventional blog paths', () => {
    const urls = [
      { url: 'https://example.com/', type: 'homepage' },
      { url: 'https://example.com/blog/post-a', type: 'post' },
      { url: 'https://example.com/blog/post-b', type: 'post' },
    ];
    expect(detectBlogPrefixes(urls)).toContain('/blog');
  });

  it('orders date-based prefixes ahead of conventional fallbacks', () => {
    const urls = [
      { url: 'https://example.com/journal/2024/3/1/a', type: 'post' },
      { url: 'https://example.com/journal/2024/3/2/b', type: 'post' },
      { url: 'https://example.com/blog/c', type: 'post' },
    ];
    const prefixes = detectBlogPrefixes(urls);
    expect(prefixes[0]).toBe('/journal');
  });

  it('requires at least 2 hits for a date-based prefix', () => {
    const urls = [
      { url: 'https://example.com/one-off/2024/3/1/lonely-post', type: 'post' },
      { url: 'https://example.com/about', type: 'page' },
    ];
    expect(detectBlogPrefixes(urls)).not.toContain('/one-off');
  });

  it('returns empty array when no blog-like URLs are present', () => {
    const urls = [
      { url: 'https://example.com/', type: 'homepage' },
      { url: 'https://example.com/about', type: 'page' },
      { url: 'https://example.com/contact', type: 'page' },
    ];
    expect(detectBlogPrefixes(urls)).toHaveLength(0);
  });
});
