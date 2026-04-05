#!/usr/bin/env node
// scripts/shopify/import.js
// Imports Shopify-extracted content into WordPress.com.
//   - blog_post → WordPress posts
//   - page      → WordPress pages
//   - product   → skipped (use import-products.js instead)
//
// Usage:
//   node scripts/shopify/import.js \
//     --site yoursite.wordpress.com \
//     --username your-wpcom-user \
//     --token YOUR_APP_PASSWORD

import { readdirSync, readFileSync, existsSync } from 'fs';
import { parseArgs } from 'util';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    site:        { type: 'string' },
    username:    { type: 'string' },
    token:       { type: 'string' },
    'input-dir': { type: 'string', default: 'output/pages' },
  },
});

const { site, username, token } = values;
const inputDir = values['input-dir'];

if (!site || !username || !token) {
  console.error(
    'Usage: node scripts/shopify/import.js\n' +
    '  --site <site> --username <wpcom-user> --token <app-password>'
  );
  process.exit(1);
}

const siteBase = site.startsWith('http') ? site : `https://${site}`;
const apiBase  = `${siteBase}/wp-json/wp/v2`;
const auth     = 'Basic ' + Buffer.from(`${username}:${token}`).toString('base64');

async function wpPost(endpoint, body) {
  const res = await fetch(`${apiBase}${endpoint}`, {
    method:  'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} — ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function uploadMedia(localPath, filename) {
  const data = readFileSync(localPath);
  const ext  = filename.split('.').pop().toLowerCase();
  const mime = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png',  gif: 'image/gif',
    webp: 'image/webp',
  }[ext] ?? 'image/jpeg';

  const res = await fetch(`${apiBase}/media`, {
    method:  'POST',
    headers: {
      Authorization:         auth,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Type':        mime,
    },
    body:   data,
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} — ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function main() {
  if (!existsSync(inputDir)) {
    console.error(`No ${inputDir} directory found. Run extract.js first.`);
    process.exit(1);
  }

  const allItems = readdirSync(inputDir)
    .filter(f => f.endsWith('.json') && !f.endsWith('-raw.json'))
    .map(f => {
      try { return JSON.parse(readFileSync(`${inputDir}/${f}`, 'utf8')); } catch { return null; }
    })
    .filter(Boolean);

  const pages    = allItems.filter(i => i.type === 'page');
  const posts    = allItems.filter(i => i.type === 'blog_post');
  const products = allItems.filter(i => i.type === 'product');

  console.log(`Found: ${pages.length} pages, ${posts.length} blog posts, ${products.length} products`);
  if (products.length > 0) {
    console.log(`  → Products skipped. Run import-products.js for those.`);
  }

  // Step 1: Upload all media files and build two maps:
  //   localPath  → { wpId, wpUrl }   (for rewriting content and setting featured image)
  //   cdnUrl     → { wpId, wpUrl }   (extraction-log maps cdnUrl → localPath)
  const localToWp = {};  // 'output/media/abc.jpg' → { id, url }

  const mediaDir = 'output/media';
  if (existsSync(mediaDir)) {
    const mediaFiles = readdirSync(mediaDir);
    console.log(`\nUploading ${mediaFiles.length} media file(s)...`);
    for (const filename of mediaFiles) {
      const localPath = `${mediaDir}/${filename}`;
      process.stdout.write(`  ${filename}... `);
      try {
        const uploaded = await uploadMedia(localPath, filename);
        localToWp[localPath] = { id: uploaded.id, url: uploaded.source_url };
        console.log(`✓ ${uploaded.source_url}`);
      } catch (e) {
        console.log(`✗ ${e.message}`);
      }
    }
  }

  // Build cdnUrl → wpId map using extraction-log (which records original URL → local path)
  const cdnToWpId = {};
  if (existsSync('output/extraction-log.json')) {
    const log = JSON.parse(readFileSync('output/extraction-log.json', 'utf8'));
    for (const entry of log) {
      if (entry.original && entry.local && localToWp[entry.local]) {
        cdnToWpId[entry.original] = localToWp[entry.local].id;
      }
    }
  }

  function rewriteContent(content) {
    let out = content;
    for (const [local, { url }] of Object.entries(localToWp)) {
      out = out.replaceAll(local, url);
    }
    return out;
  }

  function featuredMediaId(item) {
    // item.images contains the original CDN URLs from Shopify
    for (const cdnUrl of item.images ?? []) {
      if (cdnToWpId[cdnUrl]) return cdnToWpId[cdnUrl];
    }
    return null;
  }

  // Step 2: Import pages
  console.log(`\nImporting ${pages.length} page(s)...`);
  for (const item of pages) {
    process.stdout.write(`  ${item.slug}... `);
    try {
      const result = await wpPost('/pages', {
        title:   item.title,
        slug:    item.slug,
        content: rewriteContent(item.content ?? ''),
        status:  'draft',
      });
      console.log(`✓ ${result.link}`);
    } catch (e) {
      console.log(`✗ ${e.message}`);
    }
  }

  // Step 3: Import blog posts
  console.log(`\nImporting ${posts.length} blog post(s)...`);
  for (const item of posts) {
    process.stdout.write(`  ${item.slug}... `);
    try {
      const body = {
        title:   item.title,
        slug:    item.slug,
        content: rewriteContent(item.content ?? ''),
        excerpt: item._raw?.summary ?? '',
        status:  'draft',
        date:    item.publishedAt ?? undefined,
      };

      const fmId = featuredMediaId(item);
      if (fmId) body.featured_media = fmId;

      const result = await wpPost('/posts', body);
      console.log(`✓ ${result.link}`);
    } catch (e) {
      console.log(`✗ ${e.message}`);
    }
  }

  console.log('\nDone. All content created as drafts — review and publish from WordPress admin.');
  console.log(`  ${siteBase}/wp-admin/`);
  console.log('\nNext: import products with:');
  console.log('  node scripts/shopify/import-products.js --site <site> --username <user> --token <token> --wc-key <key> --wc-secret <secret>');
}

main().catch(e => { console.error(e); process.exit(1); });
