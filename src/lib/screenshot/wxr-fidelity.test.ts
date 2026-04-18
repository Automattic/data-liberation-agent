import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { XMLParser } from 'fast-xml-parser';
import { readWxr } from '../extraction/wxr-reader.js';
import { WxrBuilder } from '../extraction/wxr-builder.js';

/**
 * Tier 2 stamping round-trips WXR via WxrReader → WxrBuilder → serialize.
 * This test guards that round-trip. If it fails, do NOT ship Tier 2 stamping
 * until either WxrBuilder is enhanced to emit the missing elements, OR
 * stamping switches to direct XML mutation (see design spec E1C).
 *
 * This complements the per-field round-trips in test/wxr-reader.test.ts by
 * asserting that a full read-modify-serialize cycle produces structurally
 * identical output — which is the path Tier 2 stamping will use to inject
 * _liberation_* postmeta.
 */
describe('WxrReader → WxrBuilder round-trip fidelity', () => {
  it('preserves site metadata, authors, taxonomies, pages, posts, attachments, and redirects through round-trip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxr-fidelity-'));

    // Build a non-trivial WXR by using WxrBuilder (the only way to produce a
    // canonical input — we're testing that round-trip produces the same output).
    const original = new WxrBuilder({
      title: 'Fidelity Test Site',
      url: 'https://origin.example.com',
      description: 'A test site',
      language: 'en-US',
    });
    original.addAuthor({ login: 'alice', displayName: 'Alice', email: 'alice@example.com' });
    original.addCategory({ slug: 'news', name: 'News' });
    original.addTag({ slug: 'featured', name: 'Featured' });
    const mediaId = original.addMedia({
      url: 'https://origin.example.com/image.jpg',
      localPath: 'media/image.jpg',
      title: 'An image',
      altText: 'A picture',
    });
    original.addPage({
      title: 'About & Contact <em>us</em>',
      slug: 'about',
      content: 'Hello <strong>world</strong>',
      excerpt: 'Hello',
      date: '2025-01-01T00:00:00Z',
      seoTitle: 'About Us',
      seoDescription: 'Learn more',
      sourceUrl: 'https://origin.example.com/about/',
    });
    original.addPost({
      title: 'Post With "Quotes" & <entities>',
      slug: 'my-post',
      content: 'Body text',
      excerpt: 'Excerpt',
      date: '2025-01-02T00:00:00Z',
      categories: ['news'],
      tags: ['featured'],
      featuredMediaId: mediaId,
      author: 'alice',
      sourceUrl: 'https://origin.example.com/my-post/',
    });
    original.addRedirect({ from: '/old', to: '/new' });

    const wxr1Path = join(dir, 'original.wxr');
    original.serialize(wxr1Path);
    const wxr1 = readFileSync(wxr1Path, 'utf8');

    // Now round-trip: read it back, feed each piece into a new builder, serialize.
    const data = readWxr(wxr1Path);

    const rebuilt = new WxrBuilder({
      title: data.site.title,
      url: data.site.url,
      description: data.site.description,
      language: data.site.language,
    });
    for (const a of data.authors) {
      rebuilt.addAuthor({
        login: a.login,
        email: a.email,
        displayName: a.displayName,
        firstName: a.firstName,
        lastName: a.lastName,
      });
    }
    for (const c of data.categories) {
      rebuilt.addCategory({
        slug: c.slug,
        name: c.name,
        parent: c.parent,
        description: c.description,
      });
    }
    for (const t of data.tags) {
      rebuilt.addTag({
        slug: t.slug,
        name: t.name,
        description: t.description,
      });
    }
    for (const it of data.items) {
      if (it.type === 'attachment') {
        rebuilt.addMedia({
          url: it.url,
          localPath: it.localPath,
          title: it.title,
          slug: it.slug,
          altText: it.altText,
          caption: it.caption,
        });
      } else if (it.type === 'page') {
        rebuilt.addPage({
          title: it.title,
          slug: it.slug,
          content: it.content,
          excerpt: it.excerpt,
          date: it.date,
          parent: it.parent,
          menuOrder: it.menuOrder,
          author: it.author,
          seoTitle: it.seoTitle,
          seoDescription: it.seoDescription,
          sourceUrl: it.sourceUrl,
        });
      } else if (it.type === 'post') {
        rebuilt.addPost({
          title: it.title,
          slug: it.slug,
          content: it.content,
          excerpt: it.excerpt,
          date: it.date,
          categories: it.categories,
          tags: it.tags,
          featuredMediaId: it.featuredMediaId,
          author: it.author,
          seoTitle: it.seoTitle,
          seoDescription: it.seoDescription,
          sourceUrl: it.sourceUrl,
          customTerms: it.customTerms,
        });
      }
    }
    for (const r of data.redirects) {
      rebuilt.addRedirect({
        from: r.from,
        to: r.to,
      });
    }

    const wxr2Path = join(dir, 'rebuilt.wxr');
    rebuilt.serialize(wxr2Path);
    const wxr2 = readFileSync(wxr2Path, 'utf8');

    // Structural comparison via XML parse: byte-equality is too strict (element order,
    // whitespace, namespace prefixes may legitimately vary). Parse both and compare the
    // resulting structures.
    const parser = new XMLParser({
      ignoreAttributes: false,
      cdataPropName: '__cdata',
      isArray: (name) => ['item', 'wp:author', 'wp:category', 'wp:tag', 'wp:term', 'wp:comment', 'wp:postmeta', 'category'].includes(name),
    });
    const parsed1 = parser.parse(wxr1);
    const parsed2 = parser.parse(wxr2);
    expect(parsed2).toEqual(parsed1);

    rmSync(dir, { recursive: true, force: true });
  });

  it.todo('preserves custom post meta keys added via future stamping work');
});
