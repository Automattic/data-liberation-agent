# Data Liberation Plugin Infrastructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the data-liberation plugin infrastructure — shared libraries, MCP server, CLI, and plugin packaging — so that platform adapters (Wix, Squarespace, etc.) can be plugged in.

**Architecture:** A Node.js ESM package exposing three entry points: MCP server (stdio), standalone CLI, and AI tool plugin (skills/commands). Shared libraries (wxr-builder, detect-platform, sitemap, media) are consumed by platform adapters. The MCP server exposes 5 tools. v1 ships with the Wix adapter (separate plan) but the infrastructure works independently.

**Tech Stack:** Node.js 18+ (ESM), `@modelcontextprotocol/sdk`, Vitest for testing

**Spec:** `docs/superpowers/specs/2026-04-03-data-liberation-plugin-design.md`

---

### Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `vitest.config.js`

This task restructures the existing repo. The current `package.json`, scripts, and prompts are replaced.

- [ ] **Step 1: Create new package.json**

```json
{
  "name": "data-liberation",
  "version": "0.1.0",
  "description": "Extract content from closed web platforms into WordPress-compatible WXR files",
  "type": "module",
  "bin": {
    "data-liberation": "./src/cli.js"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "mcp": "node src/mcp-server.js"
  },
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.0"
  },
  "optionalDependencies": {
    "playwright": "^1.44.0"
  },
  "devDependencies": {
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Update .gitignore**

```
node_modules/
output/
dist/
.liberation-lock
.superpowers/
```

- [ ] **Step 3: Create vitest.config.js**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    exclude: ['test/canary/**'],
  },
});
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`

- [ ] **Step 5: Verify test runner works**

Run: `npx vitest run`
Expected: "No test files found" (no tests yet, but runner works)

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore vitest.config.js package-lock.json
git commit -m "feat: restructure project as data-liberation plugin"
```

---

### Task 2: WXR Builder — Core

**Files:**
- Create: `src/lib/wxr-builder.js`
- Create: `test/wxr-builder.test.js`

The WXR builder is the central library. Build it test-first with addAuthor, addCategory, addTag, addMedia, addPage, addPost, addMenuItem, addRedirect.

- [ ] **Step 1: Write failing tests for core add methods**

```js
// test/wxr-builder.test.js
import { describe, it, expect } from 'vitest';
import { WxrBuilder } from '../src/lib/wxr-builder.js';

describe('WxrBuilder', () => {
  it('constructs with site metadata', () => {
    const wxr = new WxrBuilder({ title: 'My Site', url: 'https://example.com' });
    expect(wxr).toBeDefined();
  });

  it('addAuthor returns auto-incrementing ID', () => {
    const wxr = new WxrBuilder({ title: 'My Site', url: 'https://example.com' });
    const id1 = wxr.addAuthor({ login: 'admin' });
    const id2 = wxr.addAuthor({ login: 'editor', email: 'ed@example.com', displayName: 'Editor' });
    expect(id1).toBe(1);
    expect(id2).toBe(2);
  });

  it('addCategory returns ID and handles parent', () => {
    const wxr = new WxrBuilder({ title: 'My Site', url: 'https://example.com' });
    const id = wxr.addCategory({ slug: 'tech', name: 'Technology' });
    expect(id).toBe(1);
    const childId = wxr.addCategory({ slug: 'js', name: 'JavaScript', parent: 'tech' });
    expect(childId).toBe(2);
  });

  it('addTag returns ID', () => {
    const wxr = new WxrBuilder({ title: 'My Site', url: 'https://example.com' });
    const id = wxr.addTag({ slug: 'tutorial', name: 'Tutorial' });
    expect(id).toBe(1);
  });

  it('addMedia returns ID', () => {
    const wxr = new WxrBuilder({ title: 'My Site', url: 'https://example.com' });
    const id = wxr.addMedia({
      url: 'https://cdn.example.com/photo.jpg',
      localPath: 'output/media/photo.jpg',
      title: 'A photo',
      altText: 'Photo description',
    });
    expect(id).toBe(1);
  });

  it('addPage returns ID', () => {
    const wxr = new WxrBuilder({ title: 'My Site', url: 'https://example.com' });
    const id = wxr.addPage({
      title: 'About',
      slug: 'about',
      content: '<p>About us</p>',
    });
    expect(id).toBe(1);
  });

  it('addPost returns ID and accepts categories, tags, featuredMediaId', () => {
    const wxr = new WxrBuilder({ title: 'My Site', url: 'https://example.com' });
    wxr.addCategory({ slug: 'tech', name: 'Technology' });
    wxr.addTag({ slug: 'tutorial', name: 'Tutorial' });
    const mediaId = wxr.addMedia({
      url: 'https://cdn.example.com/hero.jpg',
      localPath: 'output/media/hero.jpg',
    });
    const postId = wxr.addPost({
      title: 'Hello World',
      slug: 'hello-world',
      content: '<p>First post</p>',
      date: '2026-01-15T10:00:00Z',
      categories: ['tech'],
      tags: ['tutorial'],
      featuredMediaId: mediaId,
      seoTitle: 'Hello World - My Site',
      seoDescription: 'My first blog post',
    });
    expect(postId).toBe(2); // media was ID 1
  });

  it('addMenuItem does not return an ID', () => {
    const wxr = new WxrBuilder({ title: 'My Site', url: 'https://example.com' });
    const result = wxr.addMenuItem({
      title: 'Home',
      url: 'https://example.com/',
      menuSlug: 'main-menu',
      order: 1,
    });
    expect(result).toBeUndefined();
  });

  it('addRedirect stores redirect mapping', () => {
    const wxr = new WxrBuilder({ title: 'My Site', url: 'https://example.com' });
    wxr.addRedirect({ from: '/old-path', to: '/new-slug' });
    // Redirect map is verified in serialize tests
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/wxr-builder.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement WxrBuilder class with core add methods**

```js
// src/lib/wxr-builder.js

function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(str) {
  if (!str) return '<![CDATA[]]>';
  return `<![CDATA[${str.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

export class WxrBuilder {
  constructor(siteMeta) {
    this.siteMeta = {
      title: siteMeta.title || 'Untitled',
      url: siteMeta.url || '',
      description: siteMeta.description || '',
      language: siteMeta.language || 'en-US',
    };
    this._nextId = 1;
    this.authors = [];
    this.categories = [];
    this.tags = [];
    this.items = []; // posts, pages, media, menu items
    this.redirects = [];
  }

  _id() {
    return this._nextId++;
  }

  addAuthor(author) {
    const id = this._id();
    this.authors.push({ id, login: author.login, email: author.email || '', displayName: author.displayName || author.login });
    return id;
  }

  addCategory(cat) {
    const id = this._id();
    this.categories.push({ id, slug: cat.slug, name: cat.name, parent: cat.parent || '' });
    return id;
  }

  addTag(tag) {
    const id = this._id();
    this.tags.push({ id, slug: tag.slug, name: tag.name });
    return id;
  }

  addMedia(media) {
    const id = this._id();
    this.items.push({
      id,
      type: 'attachment',
      title: media.title || '',
      url: media.url,
      localPath: media.localPath,
      altText: media.altText || '',
      caption: media.caption || '',
    });
    return id;
  }

  addPage(page) {
    const id = this._id();
    this.items.push({
      id,
      type: 'page',
      title: page.title,
      slug: page.slug,
      content: page.content || '',
      excerpt: page.excerpt || '',
      date: page.date || '',
      parent: page.parent || 0,
      menuOrder: page.menuOrder || 0,
      seoTitle: page.seoTitle || '',
      seoDescription: page.seoDescription || '',
    });
    return id;
  }

  addPost(post) {
    const id = this._id();
    this.items.push({
      id,
      type: 'post',
      title: post.title,
      slug: post.slug,
      content: post.content || '',
      excerpt: post.excerpt || '',
      date: post.date || '',
      categories: post.categories || [],
      tags: post.tags || [],
      featuredMediaId: post.featuredMediaId || 0,
      author: post.author || '',
      seoTitle: post.seoTitle || '',
      seoDescription: post.seoDescription || '',
    });
    return id;
  }

  addMenuItem(item) {
    this.items.push({
      id: this._id(),
      type: 'nav_menu_item',
      title: item.title,
      url: item.url,
      menuSlug: item.menuSlug,
      parent: item.parent || 0,
      menuOrder: item.order || 0,
    });
    // no return — spec says addMenuItem returns void
  }

  addRedirect(redirect) {
    this.redirects.push({ from: redirect.from, to: redirect.to });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/wxr-builder.test.js`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/wxr-builder.js test/wxr-builder.test.js
git commit -m "feat: add WxrBuilder core with add methods"
```

---

### Task 3: WXR Builder — Validate + Serialize

**Files:**
- Modify: `src/lib/wxr-builder.js`
- Modify: `test/wxr-builder.test.js`

Add `validate()` and `serialize()`. Validate checks referential integrity. Serialize writes WXR 1.2 XML + redirect-map.json.

- [ ] **Step 1: Write failing tests for validate**

```js
// append to test/wxr-builder.test.js

describe('WxrBuilder.validate', () => {
  it('returns valid for well-formed data', () => {
    const wxr = new WxrBuilder({ title: 'Test', url: 'https://example.com' });
    wxr.addCategory({ slug: 'news', name: 'News' });
    wxr.addPost({ title: 'Post', slug: 'post', content: '<p>Hello</p>', categories: ['news'] });
    const result = wxr.validate();
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('warns about orphaned featuredMediaId', () => {
    const wxr = new WxrBuilder({ title: 'Test', url: 'https://example.com' });
    wxr.addPost({ title: 'Post', slug: 'post', content: '<p>Hello</p>', featuredMediaId: 999 });
    const result = wxr.validate();
    expect(result.valid).toBe(true); // warnings, not errors
    expect(result.warnings.some(w => w.includes('999'))).toBe(true);
  });

  it('warns about unknown category references', () => {
    const wxr = new WxrBuilder({ title: 'Test', url: 'https://example.com' });
    wxr.addPost({ title: 'Post', slug: 'post', content: '<p>Hello</p>', categories: ['nonexistent'] });
    const result = wxr.validate();
    expect(result.warnings.some(w => w.includes('nonexistent'))).toBe(true);
  });

  it('warns about empty content', () => {
    const wxr = new WxrBuilder({ title: 'Test', url: 'https://example.com' });
    wxr.addPost({ title: 'Post', slug: 'post', content: '' });
    const result = wxr.validate();
    expect(result.warnings.some(w => w.includes('empty content'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/wxr-builder.test.js`
Expected: FAIL — validate is not a function

- [ ] **Step 3: Implement validate()**

Add to the `WxrBuilder` class in `src/lib/wxr-builder.js`:

```js
validate() {
  const warnings = [];
  const mediaIds = new Set(this.items.filter(i => i.type === 'attachment').map(i => i.id));
  const categorySlugs = new Set(this.categories.map(c => c.slug));
  const tagSlugs = new Set(this.tags.map(t => t.slug));

  for (const item of this.items) {
    if ((item.type === 'post' || item.type === 'page') && !item.content) {
      warnings.push(`"${item.title}" (${item.slug}) has empty content`);
    }
    if (item.type === 'post') {
      if (item.featuredMediaId && !mediaIds.has(item.featuredMediaId)) {
        warnings.push(`"${item.title}" references featuredMediaId ${item.featuredMediaId} which does not exist`);
      }
      for (const cat of item.categories || []) {
        if (!categorySlugs.has(cat)) {
          warnings.push(`"${item.title}" references category "${cat}" which was not added`);
        }
      }
      for (const tag of item.tags || []) {
        if (!tagSlugs.has(tag)) {
          warnings.push(`"${item.title}" references tag "${tag}" which was not added`);
        }
      }
    }
  }

  return { valid: true, warnings };
}
```

- [ ] **Step 4: Run validate tests**

Run: `npx vitest run test/wxr-builder.test.js`
Expected: All tests PASS

- [ ] **Step 5: Write failing tests for serialize**

```js
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('WxrBuilder.serialize', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wxr-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a valid WXR XML file', () => {
    const wxr = new WxrBuilder({ title: 'My Site', url: 'https://example.com', description: 'A test site' });
    wxr.addCategory({ slug: 'news', name: 'News' });
    wxr.addTag({ slug: 'featured', name: 'Featured' });
    wxr.addPost({
      title: 'Hello World',
      slug: 'hello-world',
      content: '<p>First post</p>',
      date: '2026-01-15T10:00:00Z',
      categories: ['news'],
      tags: ['featured'],
    });

    const wxrPath = join(tempDir, 'output.wxr');
    wxr.serialize(wxrPath);

    expect(existsSync(wxrPath)).toBe(true);
    const xml = readFileSync(wxrPath, 'utf8');
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('xmlns:wp="http://wordpress.org/export/1.2/"');
    expect(xml).toContain('<title>My Site</title>');
    expect(xml).toContain('<wp:cat_name><![CDATA[News]]></wp:cat_name>');
    expect(xml).toContain('<wp:tag_name><![CDATA[Featured]]></wp:tag_name>');
    expect(xml).toContain('<title>Hello World</title>');
    expect(xml).toContain('<wp:post_type>post</wp:post_type>');
    expect(xml).toContain('<![CDATA[<p>First post</p>]]>');
    expect(xml).toContain('<wp:post_name>hello-world</wp:post_name>');
  });

  it('writes SEO custom fields as post meta', () => {
    const wxr = new WxrBuilder({ title: 'Site', url: 'https://example.com' });
    wxr.addPost({
      title: 'SEO Post',
      slug: 'seo-post',
      content: '<p>Content</p>',
      seoTitle: 'Custom SEO Title',
      seoDescription: 'Custom SEO description',
    });

    const wxrPath = join(tempDir, 'output.wxr');
    wxr.serialize(wxrPath);
    const xml = readFileSync(wxrPath, 'utf8');

    expect(xml).toContain('<wp:meta_key>_seo_title</wp:meta_key>');
    expect(xml).toContain('<wp:meta_value><![CDATA[Custom SEO Title]]></wp:meta_value>');
    expect(xml).toContain('<wp:meta_key>_seo_description</wp:meta_key>');
  });

  it('writes redirect-map.json alongside the WXR', () => {
    const wxr = new WxrBuilder({ title: 'Site', url: 'https://example.com' });
    wxr.addRedirect({ from: '/old', to: '/new' });
    wxr.addRedirect({ from: '/about-us', to: '/about' });

    const wxrPath = join(tempDir, 'output.wxr');
    wxr.serialize(wxrPath);

    const redirectPath = join(tempDir, 'redirect-map.json');
    expect(existsSync(redirectPath)).toBe(true);
    const redirects = JSON.parse(readFileSync(redirectPath, 'utf8'));
    expect(redirects).toEqual([
      { from: '/old', to: '/new' },
      { from: '/about-us', to: '/about' },
    ]);
  });

  it('escapes XML-hostile characters in content', () => {
    const wxr = new WxrBuilder({ title: 'Site', url: 'https://example.com' });
    wxr.addPost({
      title: 'Post with <special> & "chars"',
      slug: 'special',
      content: '<p>Content with ]]> CDATA end</p>',
    });

    const wxrPath = join(tempDir, 'output.wxr');
    wxr.serialize(wxrPath);
    const xml = readFileSync(wxrPath, 'utf8');

    // Title should be escaped in XML attributes but CDATA in content
    expect(xml).not.toContain(']]>CDATA');
    // File should be valid (not throw on read)
    expect(xml.length).toBeGreaterThan(0);
  });

  it('includes media attachments with alt text', () => {
    const wxr = new WxrBuilder({ title: 'Site', url: 'https://example.com' });
    wxr.addMedia({
      url: 'https://cdn.example.com/photo.jpg',
      localPath: 'media/photo.jpg',
      title: 'Beach Photo',
      altText: 'A sunny beach',
      caption: 'Summer 2025',
    });

    const wxrPath = join(tempDir, 'output.wxr');
    wxr.serialize(wxrPath);
    const xml = readFileSync(wxrPath, 'utf8');

    expect(xml).toContain('<wp:post_type>attachment</wp:post_type>');
    expect(xml).toContain('<wp:attachment_url>https://cdn.example.com/photo.jpg</wp:attachment_url>');
  });
});
```

- [ ] **Step 6: Run serialize tests to verify they fail**

Run: `npx vitest run test/wxr-builder.test.js`
Expected: FAIL — serialize is not a function

- [ ] **Step 7: Implement serialize()**

Add to `WxrBuilder` class in `src/lib/wxr-builder.js`:

```js
serialize(outputPath) {
  const validation = this.validate();
  const { title, url, description, language } = this.siteMeta;

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/"
>
<channel>
  <title>${escapeXml(title)}</title>
  <link>${escapeXml(url)}</link>
  <description>${escapeXml(description)}</description>
  <language>${escapeXml(language)}</language>
  <wp:wxr_version>1.2</wp:wxr_version>
`;

  // Authors
  for (const author of this.authors) {
    xml += `  <wp:author>
    <wp:author_id>${author.id}</wp:author_id>
    <wp:author_login>${cdata(author.login)}</wp:author_login>
    <wp:author_email>${cdata(author.email)}</wp:author_email>
    <wp:author_display_name>${cdata(author.displayName)}</wp:author_display_name>
  </wp:author>\n`;
  }

  // Categories
  for (const cat of this.categories) {
    xml += `  <wp:category>
    <wp:term_id>${cat.id}</wp:term_id>
    <wp:category_nicename>${cdata(cat.slug)}</wp:category_nicename>
    <wp:category_parent>${cdata(cat.parent)}</wp:category_parent>
    <wp:cat_name>${cdata(cat.name)}</wp:cat_name>
  </wp:category>\n`;
  }

  // Tags
  for (const tag of this.tags) {
    xml += `  <wp:tag>
    <wp:term_id>${tag.id}</wp:term_id>
    <wp:tag_slug>${cdata(tag.slug)}</wp:tag_slug>
    <wp:tag_name>${cdata(tag.name)}</wp:tag_name>
  </wp:tag>\n`;
  }

  // Items (posts, pages, attachments, nav_menu_items)
  for (const item of this.items) {
    xml += `  <item>\n`;
    xml += `    <title>${escapeXml(item.title)}</title>\n`;
    xml += `    <wp:post_id>${item.id}</wp:post_id>\n`;
    xml += `    <wp:post_name>${escapeXml(item.slug || '')}</wp:post_name>\n`;
    xml += `    <wp:post_type>${item.type}</wp:post_type>\n`;
    xml += `    <wp:status>draft</wp:status>\n`;

    if (item.date) {
      xml += `    <wp:post_date>${escapeXml(item.date)}</wp:post_date>\n`;
    }

    if (item.type === 'post' || item.type === 'page') {
      xml += `    <content:encoded>${cdata(item.content)}</content:encoded>\n`;
      xml += `    <excerpt:encoded>${cdata(item.excerpt)}</excerpt:encoded>\n`;

      if (item.parent) {
        xml += `    <wp:post_parent>${item.parent}</wp:post_parent>\n`;
      }
      if (item.menuOrder) {
        xml += `    <wp:menu_order>${item.menuOrder}</wp:menu_order>\n`;
      }
      if (item.author) {
        xml += `    <dc:creator>${cdata(item.author)}</dc:creator>\n`;
      }

      // Categories
      for (const cat of item.categories || []) {
        xml += `    <category domain="category" nicename="${escapeXml(cat)}"><![CDATA[${cat}]]></category>\n`;
      }
      // Tags
      for (const tag of item.tags || []) {
        xml += `    <category domain="post_tag" nicename="${escapeXml(tag)}"><![CDATA[${tag}]]></category>\n`;
      }

      // Featured image
      if (item.featuredMediaId) {
        xml += `    <wp:postmeta>\n`;
        xml += `      <wp:meta_key>_thumbnail_id</wp:meta_key>\n`;
        xml += `      <wp:meta_value>${item.featuredMediaId}</wp:meta_value>\n`;
        xml += `    </wp:postmeta>\n`;
      }

      // SEO meta
      if (item.seoTitle) {
        xml += `    <wp:postmeta>\n`;
        xml += `      <wp:meta_key>_seo_title</wp:meta_key>\n`;
        xml += `      <wp:meta_value>${cdata(item.seoTitle)}</wp:meta_value>\n`;
        xml += `    </wp:postmeta>\n`;
      }
      if (item.seoDescription) {
        xml += `    <wp:postmeta>\n`;
        xml += `      <wp:meta_key>_seo_description</wp:meta_key>\n`;
        xml += `      <wp:meta_value>${cdata(item.seoDescription)}</wp:meta_value>\n`;
        xml += `    </wp:postmeta>\n`;
      }
    }

    if (item.type === 'attachment') {
      xml += `    <wp:attachment_url>${escapeXml(item.url)}</wp:attachment_url>\n`;
      if (item.altText) {
        xml += `    <wp:postmeta>\n`;
        xml += `      <wp:meta_key>_wp_attachment_image_alt</wp:meta_key>\n`;
        xml += `      <wp:meta_value>${cdata(item.altText)}</wp:meta_value>\n`;
        xml += `    </wp:postmeta>\n`;
      }
    }

    if (item.type === 'nav_menu_item') {
      xml += `    <wp:postmeta>\n`;
      xml += `      <wp:meta_key>_menu_item_url</wp:meta_key>\n`;
      xml += `      <wp:meta_value>${escapeXml(item.url)}</wp:meta_value>\n`;
      xml += `    </wp:postmeta>\n`;
      xml += `    <wp:postmeta>\n`;
      xml += `      <wp:meta_key>_menu_item_type</wp:meta_key>\n`;
      xml += `      <wp:meta_value>custom</wp:meta_value>\n`;
      xml += `    </wp:postmeta>\n`;
      if (item.menuOrder) {
        xml += `    <wp:menu_order>${item.menuOrder}</wp:menu_order>\n`;
      }
      if (item.parent) {
        xml += `    <wp:post_parent>${item.parent}</wp:post_parent>\n`;
      }
    }

    xml += `  </item>\n`;
  }

  xml += `</channel>\n</rss>\n`;

  // Write WXR file
  const { writeFileSync } = await import('fs');
  const { dirname, join } = await import('path');
  const { mkdirSync } = await import('fs');

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, xml, 'utf8');

  // Write redirect map alongside WXR
  if (this.redirects.length > 0) {
    const redirectPath = join(dirname(outputPath), 'redirect-map.json');
    writeFileSync(redirectPath, JSON.stringify(this.redirects, null, 2), 'utf8');
  }

  return { validation, wxrPath: outputPath };
}
```

Note: `serialize` needs to be sync. Move the imports to the top of the file:

```js
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
```

And remove the `await import()` calls from `serialize()`, using the top-level imports directly.

- [ ] **Step 8: Run all tests**

Run: `npx vitest run test/wxr-builder.test.js`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add src/lib/wxr-builder.js test/wxr-builder.test.js
git commit -m "feat: add WxrBuilder validate + serialize with WXR 1.2 output"
```

---

### Task 4: Platform Detection

**Files:**
- Create: `src/lib/detect-platform.js`
- Create: `test/detect-platform.test.js`

Two-tier detection: URL heuristics (instant) + HTTP fingerprinting (one request).

- [ ] **Step 1: Write failing tests**

```js
// test/detect-platform.test.js
import { describe, it, expect, vi } from 'vitest';
import { detectFromUrl, detectFromHttp } from '../src/lib/detect-platform.js';

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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/detect-platform.test.js`
Expected: FAIL

- [ ] **Step 3: Implement detect-platform.js**

```js
// src/lib/detect-platform.js

const URL_PATTERNS = [
  { pattern: /wixsite\.com|wix\.com/i, platform: 'wix' },
  { pattern: /squarespace\.com/i, platform: 'squarespace' },
  { pattern: /webflow\.io|webflow\.com/i, platform: 'webflow' },
  { pattern: /myshopify\.com|shopify\.com/i, platform: 'shopify' },
];

const HTTP_SIGNALS = [
  { header: 'x-wix-request-id', platform: 'wix', signal: 'X-Wix-Request-Id header' },
  { header: 'x-servedby', value: 'squarespace', platform: 'squarespace', signal: 'X-ServedBy: squarespace header' },
  { header: 'x-powered-by', value: 'webflow', platform: 'webflow', signal: 'X-Powered-By: Webflow header' },
  { header: 'x-shopid', platform: 'shopify', signal: 'X-ShopId header' },
];

const SOURCE_SIGNALS = [
  { pattern: /wixstatic\.com/i, platform: 'wix', signal: 'wixstatic.com in page source' },
  { pattern: /cdn\.shopify\.com/i, platform: 'shopify', signal: 'cdn.shopify.com in page source' },
];

export function detectFromUrl(url) {
  const normalized = url.includes('://') ? url : `https://${url}`;
  for (const { pattern, platform } of URL_PATTERNS) {
    if (pattern.test(normalized)) return platform;
  }
  return null;
}

export async function detectFromHttp(url) {
  const signals = [];
  let platform = 'unknown';
  let confidence = 'low';

  try {
    const normalized = url.includes('://') ? url : `https://${url}`;
    const response = await fetch(normalized, {
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });

    // Check headers
    for (const sig of HTTP_SIGNALS) {
      const headerVal = response.headers.get(sig.header);
      if (headerVal && (!sig.value || headerVal.toLowerCase().includes(sig.value))) {
        platform = sig.platform;
        confidence = 'high';
        signals.push(sig.signal);
      }
    }

    // Check page source if no header match
    if (platform === 'unknown') {
      const html = await response.text();
      for (const sig of SOURCE_SIGNALS) {
        if (sig.pattern.test(html)) {
          platform = sig.platform;
          confidence = 'medium';
          signals.push(sig.signal);
        }
      }
    }
  } catch {
    // Network error — return unknown
  }

  return { platform, confidence, signals };
}

export async function detect(url) {
  const urlResult = detectFromUrl(url);
  if (urlResult) {
    return {
      url,
      platform: urlResult,
      confidence: 'high',
      signals: [`URL contains ${urlResult} domain`],
    };
  }

  const httpResult = await detectFromHttp(url);
  return { url, ...httpResult };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/detect-platform.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/detect-platform.js test/detect-platform.test.js
git commit -m "feat: add platform detection with URL heuristics and HTTP fingerprinting"
```

---

### Task 5: Sitemap Parser

**Files:**
- Create: `src/lib/sitemap.js`
- Create: `test/sitemap.test.js`

Shared sitemap fetcher that handles standard XML sitemaps, sitemap indexes, and fallback to homepage link crawling.

- [ ] **Step 1: Write failing tests**

```js
// test/sitemap.test.js
import { describe, it, expect, vi } from 'vitest';
import { parseSitemapXml, classifyUrl } from '../src/lib/sitemap.js';

describe('parseSitemapXml', () => {
  it('extracts URLs from a standard sitemap', () => {
    const xml = `<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/</loc></url>
      <url><loc>https://example.com/about</loc></url>
      <url><loc>https://example.com/blog/post-1</loc></url>
    </urlset>`;
    const urls = parseSitemapXml(xml);
    expect(urls).toEqual([
      'https://example.com/',
      'https://example.com/about',
      'https://example.com/blog/post-1',
    ]);
  });

  it('extracts sub-sitemap URLs from a sitemap index', () => {
    const xml = `<?xml version="1.0"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
      <sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap>
    </sitemapindex>`;
    const urls = parseSitemapXml(xml);
    expect(urls).toEqual([
      'https://example.com/sitemap-pages.xml',
      'https://example.com/sitemap-posts.xml',
    ]);
  });

  it('returns empty array for invalid XML', () => {
    const urls = parseSitemapXml('not xml at all');
    expect(urls).toEqual([]);
  });
});

describe('classifyUrl', () => {
  it('classifies blog paths as post', () => {
    expect(classifyUrl('https://example.com/blog/my-post')).toBe('post');
    expect(classifyUrl('https://example.com/post/my-post')).toBe('post');
  });

  it('classifies product paths', () => {
    expect(classifyUrl('https://example.com/product/widget')).toBe('product');
    expect(classifyUrl('https://example.com/store/item')).toBe('product');
  });

  it('classifies root as homepage', () => {
    expect(classifyUrl('https://example.com/')).toBe('homepage');
    expect(classifyUrl('https://example.com')).toBe('homepage');
  });

  it('classifies unknown paths as page', () => {
    expect(classifyUrl('https://example.com/about')).toBe('page');
    expect(classifyUrl('https://example.com/contact')).toBe('page');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/sitemap.test.js`
Expected: FAIL

- [ ] **Step 3: Implement sitemap.js**

```js
// src/lib/sitemap.js

export function parseSitemapXml(xml) {
  const urls = [];
  const locMatches = xml.match(/<loc>([^<]+)<\/loc>/g);
  if (!locMatches) return urls;
  for (const match of locMatches) {
    const url = match.replace(/<\/?loc>/g, '').trim();
    if (url) urls.push(url);
  }
  return urls;
}

export function classifyUrl(url) {
  let path;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase();
  }

  if (path === '/' || path === '') return 'homepage';
  if (/\/(blog|post|posts|article|articles)\//.test(path)) return 'post';
  if (/\/(product|store|shop)\//.test(path)) return 'product';
  if (/\/(gallery|portfolio)/.test(path)) return 'gallery';
  if (/\/(event|events)/.test(path)) return 'event';
  return 'page';
}

export async function fetchSitemap(baseUrl) {
  const sitemapUrl = `${baseUrl.replace(/\/$/, '')}/sitemap.xml`;
  const allUrls = [];

  async function fetchAndParse(url) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) return;
      const xml = await response.text();
      const urls = parseSitemapXml(xml);

      for (const u of urls) {
        if (u.endsWith('.xml')) {
          await fetchAndParse(u); // Recurse into sitemap indexes
        } else {
          allUrls.push(u);
        }
      }
    } catch {
      // Sitemap fetch failed — caller should fall back to crawling
    }
  }

  await fetchAndParse(sitemapUrl);
  return allUrls;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/sitemap.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/sitemap.js test/sitemap.test.js
git commit -m "feat: add sitemap parser with URL classification"
```

---

### Task 6: Media Downloader

**Files:**
- Create: `src/lib/media.js`
- Create: `test/media.test.js`

Downloads media files with filename collision handling and path traversal guard.

- [ ] **Step 1: Write failing tests**

```js
// test/media.test.js
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { safeFilename, resolveMediaPath } from '../src/lib/media.js';

describe('safeFilename', () => {
  it('returns filename for first occurrence', () => {
    const seen = new Map();
    expect(safeFilename('photo.jpg', seen)).toBe('photo.jpg');
  });

  it('appends sequential suffix on collision', () => {
    const seen = new Map();
    expect(safeFilename('photo.jpg', seen)).toBe('photo.jpg');
    expect(safeFilename('photo.jpg', seen)).toBe('photo-2.jpg');
    expect(safeFilename('photo.jpg', seen)).toBe('photo-3.jpg');
  });

  it('handles filenames without extensions', () => {
    const seen = new Map();
    expect(safeFilename('readme', seen)).toBe('readme');
    expect(safeFilename('readme', seen)).toBe('readme-2');
  });

  it('handles empty filename', () => {
    const seen = new Map();
    const result = safeFilename('', seen);
    expect(result).toMatch(/^image-\d+$/);
  });
});

describe('resolveMediaPath', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'media-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves a safe path within outputDir', () => {
    const result = resolveMediaPath('photo.jpg', tempDir);
    expect(result).toBe(join(tempDir, 'photo.jpg'));
  });

  it('rejects path traversal attempts', () => {
    expect(() => resolveMediaPath('../../etc/passwd', tempDir)).toThrow('Path traversal');
  });

  it('rejects absolute paths', () => {
    expect(() => resolveMediaPath('/etc/passwd', tempDir)).toThrow('Path traversal');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/media.test.js`
Expected: FAIL

- [ ] **Step 3: Implement media.js**

```js
// src/lib/media.js
import { createWriteStream, mkdirSync } from 'fs';
import { basename, extname, join, resolve } from 'path';
import { pipeline } from 'stream/promises';

export function safeFilename(filename, seenNames) {
  if (!filename) {
    filename = `image-${Date.now()}`;
  }

  if (!seenNames.has(filename)) {
    seenNames.set(filename, 1);
    return filename;
  }

  const count = seenNames.get(filename) + 1;
  seenNames.set(filename, count);

  const ext = extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  return ext ? `${base}-${count}${ext}` : `${base}-${count}`;
}

export function resolveMediaPath(filename, outputDir) {
  const resolved = resolve(outputDir, filename);
  if (!resolved.startsWith(resolve(outputDir))) {
    throw new Error(`Path traversal detected: ${filename}`);
  }
  return resolved;
}

export async function downloadMedia(url, outputDir, seenNames) {
  try {
    const urlObj = new URL(url);
    const rawFilename = basename(urlObj.pathname) || `image-${Date.now()}.jpg`;
    const filename = safeFilename(rawFilename, seenNames);
    const destPath = resolveMediaPath(filename, outputDir);

    mkdirSync(outputDir, { recursive: true });

    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const fileStream = createWriteStream(destPath);
    // @ts-ignore — response.body is a ReadableStream in Node 18+
    await pipeline(response.body, fileStream);

    return { url, localPath: destPath, filename, error: null };
  } catch (err) {
    return { url, localPath: null, filename: null, error: err.message };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/media.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/media.js test/media.test.js
git commit -m "feat: add media downloader with collision handling and path traversal guard"
```

---

### Task 7: JSONL Extraction Log

**Files:**
- Create: `src/lib/extraction-log.js`
- Create: `test/extraction-log.test.js`

JSONL log writer/reader with crash-safe resume support and lock file management.

- [ ] **Step 1: Write failing tests**

```js
// test/extraction-log.test.js
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ExtractionLog } from '../src/lib/extraction-log.js';

describe('ExtractionLog', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'log-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('appends entries as JSONL lines', () => {
    const log = new ExtractionLog(tempDir);
    log.logProcessed({ url: 'https://example.com/page1', slug: 'page1', durationMs: 1200, qualityScore: 'high' });
    log.logProcessed({ url: 'https://example.com/page2', slug: 'page2', durationMs: 800, qualityScore: 'medium' });

    const content = readFileSync(join(tempDir, 'extraction-log.jsonl'), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).url).toBe('https://example.com/page1');
    expect(JSON.parse(lines[0]).type).toBe('processed');
    expect(JSON.parse(lines[1]).qualityScore).toBe('medium');
  });

  it('logs failures', () => {
    const log = new ExtractionLog(tempDir);
    log.logFailed({ url: 'https://example.com/broken', error: 'timeout' });

    const content = readFileSync(join(tempDir, 'extraction-log.jsonl'), 'utf8');
    const entry = JSON.parse(content.trim());
    expect(entry.type).toBe('failed');
    expect(entry.error).toBe('timeout');
  });

  it('reads processed URLs for resume', () => {
    const logPath = join(tempDir, 'extraction-log.jsonl');
    writeFileSync(logPath, [
      JSON.stringify({ type: 'processed', url: 'https://example.com/page1', slug: 'page1' }),
      JSON.stringify({ type: 'failed', url: 'https://example.com/page2', error: 'timeout' }),
      JSON.stringify({ type: 'processed', url: 'https://example.com/page3', slug: 'page3' }),
    ].join('\n') + '\n');

    const log = new ExtractionLog(tempDir);
    const processed = log.getProcessedUrls();
    expect(processed).toEqual(new Set(['https://example.com/page1', 'https://example.com/page3']));
  });

  it('skips incomplete last line on resume', () => {
    const logPath = join(tempDir, 'extraction-log.jsonl');
    writeFileSync(logPath,
      JSON.stringify({ type: 'processed', url: 'https://example.com/page1', slug: 'page1' }) +
      '\n{"type":"processed","url":"https://example.com/page2","slug":"pa' // truncated
    );

    const log = new ExtractionLog(tempDir);
    const processed = log.getProcessedUrls();
    expect(processed).toEqual(new Set(['https://example.com/page1']));
  });

  it('returns empty set when no log file exists', () => {
    const log = new ExtractionLog(tempDir);
    const processed = log.getProcessedUrls();
    expect(processed).toEqual(new Set());
  });
});

describe('ExtractionLog lock file', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lock-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('acquires and releases lock', () => {
    const log = new ExtractionLog(tempDir);
    expect(log.acquireLock()).toBe(true);
    log.releaseLock();
  });

  it('rejects if lock already held by running process', () => {
    // Write a lock with our own PID (simulates active lock)
    writeFileSync(join(tempDir, '.liberation-lock'), JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
    const log = new ExtractionLog(tempDir);
    expect(log.acquireLock()).toBe(false);
  });

  it('clears stale lock from dead process', () => {
    // PID 999999 almost certainly doesn't exist
    writeFileSync(join(tempDir, '.liberation-lock'), JSON.stringify({ pid: 999999, timestamp: Date.now() }));
    const log = new ExtractionLog(tempDir);
    expect(log.acquireLock()).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/extraction-log.test.js`
Expected: FAIL

- [ ] **Step 3: Implement extraction-log.js**

```js
// src/lib/extraction-log.js
import { appendFileSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

export class ExtractionLog {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.logPath = join(outputDir, 'extraction-log.jsonl');
    this.lockPath = join(outputDir, '.liberation-lock');
  }

  logProcessed(entry) {
    const line = JSON.stringify({
      type: 'processed',
      url: entry.url,
      slug: entry.slug,
      durationMs: entry.durationMs,
      qualityScore: entry.qualityScore,
      timestamp: new Date().toISOString(),
    });
    appendFileSync(this.logPath, line + '\n');
  }

  logFailed(entry) {
    const line = JSON.stringify({
      type: 'failed',
      url: entry.url,
      error: entry.error,
      timestamp: new Date().toISOString(),
    });
    appendFileSync(this.logPath, line + '\n');
  }

  logMedia(entry) {
    const line = JSON.stringify({
      type: entry.error ? 'media_failed' : 'media_downloaded',
      url: entry.url,
      localPath: entry.localPath || null,
      error: entry.error || null,
      timestamp: new Date().toISOString(),
    });
    appendFileSync(this.logPath, line + '\n');
  }

  getProcessedUrls() {
    const urls = new Set();
    if (!existsSync(this.logPath)) return urls;

    const content = readFileSync(this.logPath, 'utf8');
    const lines = content.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'processed') {
          urls.add(entry.url);
        }
      } catch {
        // Incomplete line (Ctrl+C during write) — skip
      }
    }

    return urls;
  }

  getSummary() {
    const processed = [];
    const failed = [];
    const mediaDownloaded = [];
    const mediaFailed = [];

    if (!existsSync(this.logPath)) {
      return { processed, failed, mediaDownloaded, mediaFailed };
    }

    const content = readFileSync(this.logPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        switch (entry.type) {
          case 'processed': processed.push(entry); break;
          case 'failed': failed.push(entry); break;
          case 'media_downloaded': mediaDownloaded.push(entry); break;
          case 'media_failed': mediaFailed.push(entry); break;
        }
      } catch { /* skip incomplete lines */ }
    }

    return { processed, failed, mediaDownloaded, mediaFailed };
  }

  acquireLock() {
    if (existsSync(this.lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(this.lockPath, 'utf8'));
        // Check if the PID is still running
        try {
          process.kill(lock.pid, 0); // signal 0 = check existence
          return false; // Process is still running — lock is valid
        } catch {
          // Process is dead — stale lock, remove it
          unlinkSync(this.lockPath);
        }
      } catch {
        // Corrupt lock file — remove it
        unlinkSync(this.lockPath);
      }
    }

    writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));

    // Clean up lock on exit
    const cleanup = () => {
      try { unlinkSync(this.lockPath); } catch {}
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });

    return true;
  }

  releaseLock() {
    try { unlinkSync(this.lockPath); } catch {}
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/extraction-log.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/extraction-log.js test/extraction-log.test.js
git commit -m "feat: add JSONL extraction log with resume support and lock file"
```

---

### Task 8: MCP Server

**Files:**
- Create: `src/mcp-server.js`

Exposes 5 tools: `liberate_detect`, `liberate_discover`, `liberate_inspect`, `liberate_extract`, `liberate_status`. In v1, only the Wix adapter is imported. Tools that require an adapter return an error if the platform is unsupported.

- [ ] **Step 1: Implement MCP server**

```js
// src/mcp-server.js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { detect } from './lib/detect-platform.js';

// Static adapter imports — add new adapters here
// import { wixAdapter } from './adapters/wix.js';
// const adapters = [wixAdapter];
const adapters = []; // No adapters in infrastructure-only — Wix adapter added in Plan 2

function findAdapter(platform) {
  return adapters.find(a => a.id === platform) || null;
}

function textResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

const server = new Server(
  { name: 'data-liberation', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'liberate_detect',
      description: 'Detect the platform of a website (Wix, Squarespace, Webflow, Shopify, or unknown)',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL of the website to detect' },
        },
        required: ['url'],
      },
    },
    {
      name: 'liberate_discover',
      description: 'Inventory a website: fetch sitemap, categorize URLs, extract navigation structure',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL of the website to inventory' },
          token: { type: 'string', description: 'API token for platforms requiring auth' },
          cdpPort: { type: 'number', description: 'CDP port for browser-based extraction' },
          verbose: { type: 'boolean', description: 'Enable detailed logging' },
        },
        required: ['url'],
      },
    },
    {
      name: 'liberate_inspect',
      description: 'Probe a site to assess extractability: detect platform, check sitemap, probe sample pages',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL of the website to inspect' },
          token: { type: 'string', description: 'API token if needed' },
          cdpPort: { type: 'number', description: 'CDP port for browser-based inspection' },
        },
        required: ['url'],
      },
    },
    {
      name: 'liberate_extract',
      description: 'Extract all content from a website. Produces WXR file + media directory + redirect map. Long-running — sends progress via logging.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL of the website to extract' },
          outputDir: { type: 'string', description: 'Directory to write WXR, media, and logs' },
          token: { type: 'string', description: 'API token for platforms requiring auth' },
          cdpPort: { type: 'number', description: 'CDP port for browser-based extraction' },
          delay: { type: 'number', description: 'Delay between requests in ms (default: 500)' },
          resume: { type: 'boolean', description: 'Resume a previous extraction' },
          dryRun: { type: 'boolean', description: 'Extract 2-3 pages and report without writing WXR' },
          verbose: { type: 'boolean', description: 'Enable detailed per-page logging' },
        },
        required: ['url', 'outputDir'],
      },
    },
    {
      name: 'liberate_status',
      description: 'Check progress of a running or completed extraction',
      inputSchema: {
        type: 'object',
        properties: {
          outputDir: { type: 'string', description: 'The output directory of the extraction' },
        },
        required: ['outputDir'],
      },
    },
  ],
}));

server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'liberate_detect': {
      const result = await detect(args.url);
      return textResult(result);
    }

    case 'liberate_discover': {
      const detection = await detect(args.url);
      const adapter = findAdapter(detection.platform);
      if (!adapter) {
        return errorResult(`No adapter available for platform: ${detection.platform}. Supported: ${adapters.map(a => a.id).join(', ') || 'none (install an adapter)'}`);
      }
      // SECURITY: never log opts directly — token must be redacted from all logs and responses
      const opts = { token: args.token, cdpPort: args.cdpPort, verbose: args.verbose };
      const inventory = await adapter.discover(args.url, opts);
      return textResult(inventory);
    }

    case 'liberate_inspect': {
      const detection = await detect(args.url);
      // Inspect is a lightweight probe — even without an adapter we return detection info
      const result = {
        url: args.url,
        platform: detection.platform,
        confidence: detection.confidence,
        signals: detection.signals,
        sitemapFound: false,
        urlCount: 0,
        counts: {},
        probeResults: [],
        authRequired: false,
        extractionFeasibility: detection.platform === 'unknown' ? 'limited' : 'ready',
      };

      // Try sitemap regardless of adapter
      const { fetchSitemap, classifyUrl } = await import('./lib/sitemap.js');
      const urls = await fetchSitemap(args.url);
      result.sitemapFound = urls.length > 0;
      result.urlCount = urls.length;

      const counts = {};
      for (const url of urls) {
        const type = classifyUrl(url);
        counts[type] = (counts[type] || 0) + 1;
      }
      result.counts = counts;

      // If adapter exists, probe a few pages
      const adapter = findAdapter(detection.platform);
      if (adapter && typeof adapter.probe === 'function') {
        const opts = { token: args.token, cdpPort: args.cdpPort };
        result.probeResults = await adapter.probe(args.url, urls.slice(0, 3), opts);
      }

      return textResult(result);
    }

    case 'liberate_extract': {
      const detection = await detect(args.url);
      const adapter = findAdapter(detection.platform);
      if (!adapter) {
        return errorResult(`No adapter available for platform: ${detection.platform}`);
      }

      const { ExtractionLog } = await import('./lib/extraction-log.js');
      const { WxrBuilder } = await import('./lib/wxr-builder.js');
      const { mkdirSync } = await import('fs');
      const { join } = await import('path');

      mkdirSync(args.outputDir, { recursive: true });

      const log = new ExtractionLog(args.outputDir);

      if (!log.acquireLock()) {
        return errorResult('Extraction already in progress in this directory. Use a different outputDir or wait for the current extraction to complete.');
      }

      try {
        // Discover first
        // SECURITY: never log opts directly — token must be redacted from all logs and responses
        const opts = {
          token: args.token,
          cdpPort: args.cdpPort,
          delay: args.delay,
          resume: args.resume,
          dryRun: args.dryRun,
          verbose: args.verbose,
          outputDir: args.outputDir,
        };

        const inventory = await adapter.discover(args.url, opts);
        const wxr = new WxrBuilder({
          title: inventory.siteMeta?.title || 'Imported Site',
          url: args.url,
          description: inventory.siteMeta?.tagline || '',
          language: inventory.siteMeta?.language || 'en-US',
        });

        const extractionLog = await adapter.extract(inventory, wxr, opts, {
          log,
          server, // for progress logging
        });

        // Serialize WXR
        const wxrPath = join(args.outputDir, 'output.wxr');
        if (!args.dryRun) {
          wxr.serialize(wxrPath);
        }

        const summary = log.getSummary();
        const validation = args.dryRun ? { valid: true, warnings: [] } : wxr.validate();

        const qualityScores = { high: 0, medium: 0, low: 0 };
        for (const entry of summary.processed) {
          if (entry.qualityScore) qualityScores[entry.qualityScore]++;
        }

        return textResult({
          wxrPath: args.dryRun ? null : wxrPath,
          redirectMapPath: wxr.redirects.length > 0 ? join(args.outputDir, 'redirect-map.json') : null,
          outputDir: args.outputDir,
          summary: {
            pagesExtracted: summary.processed.filter(p => p.slug).length,
            postsExtracted: summary.processed.length,
            mediaDownloaded: summary.mediaDownloaded.length,
            mediaFailed: summary.mediaFailed.length,
            categoriesFound: wxr.categories.length,
            tagsFound: wxr.tags.length,
            menuItemsFound: wxr.items.filter(i => i.type === 'nav_menu_item').length,
            failedUrls: summary.failed.length,
            qualityScores,
          },
          failures: summary.failed.map(f => ({ url: f.url, error: f.error })),
          wxrValidation: validation,
          dryRun: !!args.dryRun,
        });
      } finally {
        log.releaseLock();
      }
    }

    case 'liberate_status': {
      const { ExtractionLog } = await import('./lib/extraction-log.js');
      const { existsSync } = await import('fs');
      const { join } = await import('path');

      const lockPath = join(args.outputDir, '.liberation-lock');
      const running = existsSync(lockPath);

      const log = new ExtractionLog(args.outputDir);
      const summary = log.getSummary();

      return textResult({
        running,
        processed: summary.processed.length,
        remaining: 0, // We don't know total without the inventory
        failed: summary.failed.length,
        currentUrl: null,
        elapsedMs: null,
        estimatedRemainingMs: null,
      });
    }

    default:
      return errorResult(`Unknown tool: ${name}`);
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(transport);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify MCP server starts**

Run: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}}}' | node src/mcp-server.js 2>/dev/null | head -1`
Expected: JSON response with `"result":{"serverInfo":{"name":"data-liberation"...}`

- [ ] **Step 3: Commit**

```bash
git add src/mcp-server.js
git commit -m "feat: add MCP server with 5 liberation tools"
```

---

### Task 9: Standalone CLI

**Files:**
- Create: `src/cli.js`

Standalone CLI: `npx data-liberation <url>` for users without AI tools.

- [ ] **Step 1: Implement CLI**

```js
#!/usr/bin/env node
// src/cli.js
import { detect } from './lib/detect-platform.js';
import { fetchSitemap, classifyUrl } from './lib/sitemap.js';

const args = process.argv.slice(2);

if (args[0] === 'mcp') {
  // Start MCP server mode
  await import('./mcp-server.js');
} else if (args[0] === '--version') {
  console.log('0.1.0');
} else if (args[0] === '--help' || args.length === 0) {
  console.log(`
  data-liberation — Extract content from closed web platforms into WXR files

  Usage:
    data-liberation <url>              Extract content from a website
    data-liberation mcp                Start MCP server (stdio transport)
    data-liberation --version          Show version

  Options:
    --output <dir>    Output directory (default: ./liberation-output)
    --dry-run         Extract 2-3 pages and report without writing WXR
    --resume          Resume a previous extraction
    --token <token>   API token for platforms requiring auth
    --delay <ms>      Delay between requests (default: 500)
    --verbose         Detailed extraction logging

  Environment:
    LIBERATION_TOKEN  API token (alternative to --token flag)
`);
} else {
  const url = args.find(a => !a.startsWith('-'));
  if (!url) {
    console.error('Error: URL required. Run with --help for usage.');
    process.exit(1);
  }

  function getArg(name) {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : null;
  }

  const outputDir = getArg('--output') || './liberation-output';
  const dryRun = args.includes('--dry-run');
  const resume = args.includes('--resume');
  const verbose = args.includes('--verbose');
  const delay = getArg('--delay') ? parseInt(getArg('--delay')) : 500;
  const token = getArg('--token') || process.env.LIBERATION_TOKEN || null;

  console.log(`\n  Detecting platform...`);
  const detection = await detect(url);
  console.log(`  ${detection.platform !== 'unknown' ? detection.platform : 'Unknown platform'} (${detection.confidence} confidence)`);

  if (detection.platform === 'unknown') {
    console.log(`\n  Could not detect platform. Extraction may be limited.`);
    console.log(`  Supported platforms: Wix, Squarespace, Webflow, Shopify\n`);
  }

  console.log(`  Discovering content...`);
  const urls = await fetchSitemap(url);

  if (urls.length === 0) {
    console.log(`  No sitemap found or empty site.`);
    console.log(`  Try opening the site in your browser to verify it's accessible.\n`);
    process.exit(1);
  }

  const counts = {};
  for (const u of urls) {
    const type = classifyUrl(u);
    counts[type] = (counts[type] || 0) + 1;
  }

  console.log(`  Found ${urls.length} URLs: ${Object.entries(counts).map(([k, v]) => `${v} ${k}s`).join(', ')}`);

  // Full extraction requires an adapter — for now, print what we found
  console.log(`\n  To extract content, install the platform adapter and re-run.`);
  console.log(`  Output will be written to: ${outputDir}\n`);
}
```

- [ ] **Step 2: Verify CLI runs**

Run: `node src/cli.js --help`
Expected: Help text printed

Run: `node src/cli.js --version`
Expected: `0.1.0`

- [ ] **Step 3: Commit**

```bash
git add src/cli.js
git commit -m "feat: add standalone CLI entry point"
```

---

### Task 10: Plugin Manifests + Skills

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `codex.md`
- Create: `skills/liberate/SKILL.md`
- Create: `commands/liberate.md`

- [ ] **Step 1: Create Claude Code plugin manifest**

```json
// .claude-plugin/plugin.json
{
  "name": "data-liberation",
  "version": "0.1.0",
  "description": "Extract content from closed web platforms (Wix, Squarespace, Webflow, Shopify) into WordPress-compatible WXR files",
  "mcp": {
    "command": "node",
    "args": ["src/mcp-server.js"]
  }
}
```

- [ ] **Step 2: Create Codex instructions**

```markdown
<!-- codex.md -->
# data-liberation

Extract content from closed web platforms into WordPress-compatible WXR files.

## MCP Server

Register with: `codex mcp add data-liberation -- node src/mcp-server.js`

## Available Tools

- `liberate_detect` — detect the platform of a website
- `liberate_discover` — inventory a site's content
- `liberate_inspect` — probe a site's extractability
- `liberate_extract` — extract all content into WXR + media
- `liberate_status` — check extraction progress
```

- [ ] **Step 3: Create /liberate skill**

```markdown
<!-- skills/liberate/SKILL.md -->
---
name: liberate
description: Extract content from a closed web platform (Wix, Squarespace, Webflow, Shopify) into a WordPress-compatible WXR file
---

# Liberate a website

Help the user extract their content from a closed web platform.

## Workflow

1. Ask for the URL of the site to liberate (if not already provided)
2. Call `liberate_detect` to identify the platform
3. Call `liberate_discover` to inventory the site — show the counts to the user
4. Confirm with the user before proceeding
5. Call `liberate_extract` with an appropriate outputDir
6. Report the results: content extracted, quality scores, any failures
7. If there are failures, offer to retry specific URLs or investigate

## Notes

- The extraction produces a WXR file (WordPress import format) + a media directory + a redirect map
- All content is imported as drafts — the user reviews and publishes manually
- For Wix sites: extraction uses a browser and may take several minutes for large sites
- For platforms requiring auth (Webflow, Shopify): ask the user for their API token
```

- [ ] **Step 4: Create /liberate slash command**

```markdown
<!-- commands/liberate.md -->
---
name: liberate
description: Extract content from a website into a WordPress-compatible WXR file
---

Run the liberate skill to extract content from a closed web platform.
```

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/ codex.md skills/ commands/
git commit -m "feat: add plugin manifests, skill, and command for Claude Code, Codex, and Gemini"
```

---

### Task 11: Update AGENTS.md and README.md

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`

Update documentation to reflect the new plugin architecture.

- [ ] **Step 1: Rewrite AGENTS.md**

Replace the entire file with updated instructions covering: plugin architecture, adapter interface, wxr-builder API, how to add a new platform, MCP tool reference. See spec for the content areas to cover.

- [ ] **Step 2: Update README.md**

Update to reflect the three entry points (plugin, MCP, CLI), current platform support (Wix in v1), and the `npx data-liberation <url>` usage. Remove references to the old `scripts/` structure.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: update AGENTS.md and README.md for plugin architecture"
```

---

### Task 12: Clean Up Old Files

**Files:**
- Remove: `scripts/import.js` (import moves to Studio)
- Remove: `prompts/wix.md` (replaced by /liberate skill)
- Remove: `cli.js` (old interactive CLI, replaced by `src/cli.js`)
- Remove: `start.sh` (old bootstrap script)
- Keep: `scripts/wix/` (refactored into adapter in Plan 2)
- Keep: `DISCOVERIES.md`, `CONTRIBUTING.md`

- [ ] **Step 1: Remove obsolete files**

```bash
git rm scripts/import.js prompts/wix.md cli.js start.sh
```

- [ ] **Step 2: Move old Wix scripts to reference location**

```bash
mkdir -p reference
git mv scripts/wix/discover.js reference/wix-discover-original.js
git mv scripts/wix/extract.js reference/wix-extract-original.js
git mv scripts/wix/probe.js reference/wix-probe-original.js
git mv scripts/wix/map-apis.js reference/wix-map-apis-original.js
```

- [ ] **Step 3: Remove empty scripts directory**

```bash
rmdir scripts/wix scripts 2>/dev/null || true
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove old scripts, keep originals in reference/"
```
