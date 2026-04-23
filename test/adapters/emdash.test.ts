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

import { extractEmDashContent } from '../../src/adapters/emdash.js';
import { extractEmDashMetadata } from '../../src/adapters/emdash.js';
import { extractEmDashAuthors } from '../../src/adapters/emdash.js';

describe('extractEmDashContent', () => {
  it('extracts from <div class="article-content"> (default theme)', () => {
    const html = `
      <html><body>
        <article class="article">
          <header class="article-header">
            <h1 class="article-title">Hello</h1>
          </header>
          <div class="article-content">
            <p>Post body paragraph one.</p>
            <p>Post body paragraph two.</p>
          </div>
          <aside class="article-sidebar">Sidebar noise</aside>
        </article>
      </body></html>
    `;
    const result = extractEmDashContent(html);
    expect(result).toContain('Post body paragraph one');
    expect(result).toContain('Post body paragraph two');
    expect(result).not.toContain('Sidebar noise');
  });

  it('falls back to <article> when article-content is missing', () => {
    const html = `
      <html><body>
        <article>
          <h1>Custom Theme Post</h1>
          <p>Body text.</p>
        </article>
      </body></html>
    `;
    const result = extractEmDashContent(html);
    expect(result).toContain('Body text');
    expect(result).toContain('Custom Theme Post');
  });

  it('falls back to <main> with chrome stripped', () => {
    const html = `
      <html><body>
        <nav>Nav links</nav>
        <main>
          <p>Main content.</p>
          <footer>Inner footer</footer>
        </main>
        <footer>Global footer</footer>
      </body></html>
    `;
    const result = extractEmDashContent(html);
    expect(result).toContain('Main content');
    expect(result).not.toContain('Nav links');
    expect(result).not.toContain('Global footer');
  });

  it('strips widgets, comments, and related-posts section regardless of container', () => {
    const html = `
      <html><body>
        <div class="article-content">
          <p>Real content.</p>
          <emdash-live-search></emdash-live-search>
          <section class="ec-comments">Old comment</section>
          <form data-ec-comment-form>Comment form</form>
          <section class="more-posts">Related post link</section>
          <div class="widget-area"><div class="widget">Widget noise</div></div>
        </div>
      </body></html>
    `;
    const result = extractEmDashContent(html);
    expect(result).toContain('Real content');
    expect(result).not.toContain('Old comment');
    expect(result).not.toContain('Comment form');
    expect(result).not.toContain('Related post link');
    expect(result).not.toContain('Widget noise');
    expect(result).not.toContain('emdash-live-search');
  });
});

describe('extractEmDashMetadata', () => {
  it('extracts title from h1.article-title, excerpt from p.article-excerpt', () => {
    const html = `
      <html><body>
        <article class="article">
          <h1 class="article-title">The Real Title</h1>
          <p class="article-excerpt">The real excerpt.</p>
        </article>
      </body></html>
    `;
    const meta = extractEmDashMetadata(html);
    expect(meta.title).toBe('The Real Title');
    expect(meta.excerpt).toBe('The real excerpt.');
  });

  it('falls back to og:title then <title>', () => {
    const html = `
      <html><head>
        <title>Fallback Title</title>
        <meta property="og:title" content="OG Title">
      </head><body></body></html>
    `;
    const meta = extractEmDashMetadata(html);
    expect(meta.title).toBe('OG Title');
  });

  it('extracts date from article:published_time meta', () => {
    const html = `
      <html><head>
        <meta property="article:published_time" content="2026-03-02T15:00:00.000Z">
        <meta property="article:modified_time" content="2026-03-05T09:00:00.000Z">
      </head><body></body></html>
    `;
    const meta = extractEmDashMetadata(html);
    expect(meta.date).toBe('2026-03-02T15:00:00.000Z');
    expect(meta.modifiedDate).toBe('2026-03-05T09:00:00.000Z');
  });

  it('falls back to JSON-LD datePublished when meta tag missing', () => {
    const html = `
      <html><head>
        <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"BlogPosting","datePublished":"2026-04-22T00:00:00Z"}
        </script>
      </head><body></body></html>
    `;
    const meta = extractEmDashMetadata(html);
    expect(meta.date).toBe('2026-04-22T00:00:00Z');
  });
});

describe('extractEmDashAuthors', () => {
  it('extracts single author from JSON-LD', () => {
    const html = `
      <html><head>
        <script type="application/ld+json">
        {"@type":"BlogPosting","author":{"@type":"Person","name":"Jane Doe"}}
        </script>
      </head></html>
    `;
    expect(extractEmDashAuthors(html)).toEqual(['Jane Doe']);
  });

  it('extracts multiple authors from JSON-LD array', () => {
    const html = `
      <html><head>
        <script type="application/ld+json">
        {"@type":"BlogPosting","author":[
          {"@type":"Person","name":"Alice"},
          {"@type":"Person","name":"Bob"}
        ]}
        </script>
      </head></html>
    `;
    expect(extractEmDashAuthors(html)).toEqual(['Alice', 'Bob']);
  });

  it('falls back to <span class="byline-name"> for multi-author default theme', () => {
    const html = `
      <html><body>
        <div class="bylines">
          <div class="byline"><span class="byline-name">EmDash Editorial</span></div>
          <div class="byline"><span class="byline-name">Guest Contributor</span></div>
        </div>
      </body></html>
    `;
    expect(extractEmDashAuthors(html)).toEqual(['EmDash Editorial', 'Guest Contributor']);
  });

  it('falls back to <meta name="author"> as last resort', () => {
    const html = `<html><head><meta name="author" content="Matt TK Taylor"></head></html>`;
    expect(extractEmDashAuthors(html)).toEqual(['Matt TK Taylor']);
  });

  it('returns empty array when no author found', () => {
    expect(extractEmDashAuthors('<html></html>')).toEqual([]);
  });
});

import { extractEmDashTaxonomy } from '../../src/adapters/emdash.js';
import { extractEmDashMediaUrls, resolveRelativeUrls, stripDuplicateTitle } from '../../src/adapters/emdash.js';

describe('extractEmDashTaxonomy', () => {
  it('extracts tags from /tag/{slug} links', () => {
    const html = `
      <html><body>
        <div class="meta-tags">
          <a href="/tag/opinion" class="meta-tag">Opinion</a>
          <a href="/tag/webdev" class="meta-tag">Web Development</a>
        </div>
      </body></html>
    `;
    const tax = extractEmDashTaxonomy(html);
    expect(tax.tags).toEqual(['Opinion', 'Web Development']);
    expect(tax.categories).toEqual([]);
  });

  it('extracts categories from /category/{slug} links', () => {
    const html = `
      <html><body>
        <ul class="widget-categories">
          <li><a href="/category/design" class="widget-categories__link">Design</a></li>
          <li><a href="/category/development" class="widget-categories__link">Development</a></li>
        </ul>
      </body></html>
    `;
    const tax = extractEmDashTaxonomy(html);
    expect(tax.categories).toEqual(['Design', 'Development']);
    expect(tax.tags).toEqual([]);
  });

  it('deduplicates by normalized slug (case-insensitive)', () => {
    const html = `
      <html><body>
        <a href="/tag/foo">Foo</a>
        <a href="/tag/foo">foo</a>
        <a href="/tag/FOO">FOO</a>
      </body></html>
    `;
    expect(extractEmDashTaxonomy(html).tags.length).toBe(1);
  });
});

describe('extractEmDashMediaUrls', () => {
  it('recognizes /_emdash/api/media/file/{ULID} as image regardless of extension', () => {
    const html = `
      <html><body>
        <img src="/_emdash/api/media/file/01ABC123">
        <img src="/_emdash/api/media/file/01DEF456.png">
      </body></html>
    `;
    const urls = extractEmDashMediaUrls(html, 'https://example.com');
    expect(urls).toContain('https://example.com/_emdash/api/media/file/01ABC123');
    expect(urls).toContain('https://example.com/_emdash/api/media/file/01DEF456.png');
  });

  it('passes through external CDN URLs (Unsplash, R2, WP)', () => {
    const html = `
      <html><body>
        <img src="https://images.unsplash.com/photo-123?w=1200">
        <img src="https://cdn.example.com/pic.jpg">
      </body></html>
    `;
    const urls = extractEmDashMediaUrls(html, 'https://example.com');
    expect(urls).toContain('https://images.unsplash.com/photo-123?w=1200');
    expect(urls).toContain('https://cdn.example.com/pic.jpg');
  });

  it('filters out non-image CDN URLs by extension', () => {
    const html = `
      <html><body>
        <img src="https://cdn.example.com/script.js">
        <img src="https://cdn.example.com/font.woff2">
      </body></html>
    `;
    expect(extractEmDashMediaUrls(html, 'https://example.com')).toEqual([]);
  });

  it('includes og:image', () => {
    const html = `<html><head><meta property="og:image" content="/_emdash/api/media/file/01XYZ.jpg"></head></html>`;
    const urls = extractEmDashMediaUrls(html, 'https://example.com');
    expect(urls).toContain('https://example.com/_emdash/api/media/file/01XYZ.jpg');
  });
});

describe('resolveRelativeUrls', () => {
  it('resolves relative src and href to absolute', () => {
    const html = '<img src="/_emdash/api/media/file/01ABC"><a href="/pages/about">About</a>';
    const out = resolveRelativeUrls(html, 'https://example.com');
    expect(out).toContain('src="https://example.com/_emdash/api/media/file/01ABC"');
    expect(out).toContain('href="https://example.com/pages/about"');
  });

  it('leaves absolute URLs untouched', () => {
    const html = '<img src="https://cdn.example.com/pic.jpg">';
    const out = resolveRelativeUrls(html, 'https://mysite.com');
    expect(out).toContain('src="https://cdn.example.com/pic.jpg"');
  });

  it('strips srcset and sizes attributes from img and source tags', () => {
    const html = '<img src="/foo.jpg" srcset="/foo-1x.jpg 1x, /foo-2x.jpg 2x" sizes="100vw">';
    const out = resolveRelativeUrls(html, 'https://example.com');
    expect(out).not.toContain('srcset');
    expect(out).not.toContain('sizes');
    expect(out).toContain('src="https://example.com/foo.jpg"');
  });
});

describe('stripDuplicateTitle', () => {
  it('strips the first h1 when it matches the post title', () => {
    const html = '<div><h1>My Title</h1><p>Body</p></div>';
    expect(stripDuplicateTitle(html, 'My Title')).not.toContain('<h1>My Title</h1>');
  });

  it('leaves h1 when it does not match the title', () => {
    const html = '<div><h1>Different Heading</h1><p>Body</p></div>';
    expect(stripDuplicateTitle(html, 'Post Title')).toContain('<h1>Different Heading</h1>');
  });

  it('matches case-insensitively with normalized whitespace', () => {
    const html = '<div><h1>  MY   TITLE  </h1><p>Body</p></div>';
    expect(stripDuplicateTitle(html, 'my title')).not.toContain('MY   TITLE');
  });
});
