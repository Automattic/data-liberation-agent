#!/usr/bin/env node
// scripts/shopify/extract.js
// Extracts full content for each item in output/inventory.json via CDP interception.
// Usage: node scripts/shopify/extract.js <store-domain> [--inventory output/inventory.json] [--cdp-port 9222] [--delay 1500]

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, createWriteStream } from 'fs';
import { parseArgs } from 'util';
import { extname, basename } from 'path';
import { createHash } from 'crypto';
import { pipeline } from 'stream/promises';

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    'cdp-port':  { type: 'string', default: '9222' },
    'inventory': { type: 'string', default: 'output/inventory.json' },
    'delay':     { type: 'string', default: '1500' },
  },
});

const [storeDomain] = positionals;
if (!storeDomain) {
  console.error('Usage: node scripts/shopify/extract.js <store-domain> [--inventory output/inventory.json] [--cdp-port 9222]');
  process.exit(1);
}

const cdpPort       = values['cdp-port'];
const inventoryPath = values['inventory'];
const delayMs       = parseInt(values['delay'], 10);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function downloadMedia(url) {
  try {
    const hash = createHash('md5').update(url).digest('hex').slice(0, 8);
    const ext  = extname(new URL(url).pathname).split('?')[0] || '.jpg';
    const dest = `output/media/${hash}${ext}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return { original: url, local: null };
    await pipeline(res.body, createWriteStream(dest));
    return { original: url, local: dest };
  } catch {
    return { original: url, local: null };
  }
}

async function extractItemCaptures(page, adminUrl) {
  const captured = [];

  const handler = async (response) => {
    const respUrl = response.url();
    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('application/json')) return;
    if (!respUrl.includes('/admin/internal/web/graphql/core')) return;
    try {
      const data = await response.json();
      if (data?.data) captured.push({ url: respUrl, data });
    } catch {}
  };

  page.on('response', handler);
  try {
    await page.goto(adminUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(delayMs);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await sleep(500);
  } catch (e) {
    console.error(`  Navigation failed: ${e.message}`);
  }
  page.off('response', handler);
  return captured;
}

function scoreNode(node) {
  // Higher score = richer content — used to pick the best node across all captured responses
  return (
    (node.bodyHtml?.length        ?? 0) +
    (node.body?.length            ?? 0) +
    (node.descriptionHtml?.length ?? 0) +
    (node.title                   ? 20 : 0) +
    (node.handle                  ? 10 : 0) +
    (node.seo                     ? 10 : 0)
  );
}

function extractImages(node) {
  const images = [];
  const add = (url) => { if (url && !images.includes(url)) images.push(url); };

  // Product / blog featured image
  add(node.featuredImage?.url);
  add(node.image?.url);

  // Product images connection
  for (const edge of node.images?.edges ?? []) add(edge?.node?.url ?? edge?.node?.src);

  // Inline images from HTML body
  const html = node.bodyHtml ?? node.body ?? node.descriptionHtml ?? '';
  for (const m of html.matchAll(/src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|gif|webp)[^"]*)"/gi)) {
    add(m[1]);
  }

  return images;
}

function normalizeContent(captures, item) {
  let best      = null;
  let bestScore = -1;

  for (const { data } of captures) {
    const root = data?.data;
    if (!root || typeof root !== 'object') continue;
    for (const key of Object.keys(root)) {
      const node = root[key];
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
      const score = scoreNode(node);
      if (score > bestScore) { bestScore = score; best = node; }
    }
  }

  if (!best) return null;

  const content = best.bodyHtml ?? best.body ?? best.descriptionHtml ?? '';
  return {
    id:          item.id,
    type:        item.type,
    title:       best.title     ?? item.title,
    slug:        best.handle    ?? item.handle ?? item.id.toString().split('/').pop(),
    adminUrl:    item.adminUrl,
    content,
    publishedAt: best.publishedAt ?? best.createdAt ?? item.publishedAt,
    status:      best.status      ?? item.status,
    seo: {
      title:       best.seo?.title       ?? best.title ?? '',
      description: best.seo?.description ?? '',
    },
    images: extractImages(best),
    _raw:   best,
  };
}

async function main() {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const { items } = inventory;
  console.log(`Loaded ${items.length} items from ${inventoryPath}`);

  console.log(`Connecting to Chrome on CDP port ${cdpPort}...`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page    = await context.newPage();

  mkdirSync('output/pages', { recursive: true });
  mkdirSync('output/media', { recursive: true });

  const mediaLog = [];
  let succeeded  = 0;
  let failed     = 0;

  for (const item of items) {
    const idx = succeeded + failed + 1;
    console.log(`[${idx}/${items.length}] ${item.type}: ${item.title}`);

    const captures   = await extractItemCaptures(page, item.adminUrl);
    const normalized = normalizeContent(captures, item);

    if (!normalized || normalized.content.length < 10) {
      const numericId = item.id.toString().split('/').pop();
      console.warn(`  ⚠ Sparse content (${normalized?.content?.length ?? 0} chars, ${captures.length} response(s))`);
      if (captures.length > 0) {
        writeFileSync(`output/pages/${numericId}-raw.json`, JSON.stringify(captures, null, 2));
        console.warn(`    Raw captures saved to output/pages/${numericId}-raw.json`);
      }
      failed++;
      continue;
    }

    // Download images and rewrite URLs in content
    for (const imgUrl of normalized.images) {
      const result = await downloadMedia(imgUrl);
      mediaLog.push(result);
      if (result.local) {
        normalized.content = normalized.content.replaceAll(imgUrl, result.local);
      }
    }

    writeFileSync(`output/pages/${normalized.slug}.json`, JSON.stringify(normalized, null, 2));
    succeeded++;
    await sleep(500);
  }

  await browser.close();

  writeFileSync('output/extraction-log.json', JSON.stringify(mediaLog, null, 2));
  console.log(`\nExtraction complete: ${succeeded} succeeded, ${failed} failed`);

  if (failed > 0) {
    console.log(`Check output/pages/*-raw.json to inspect GraphQL response shapes for failed items.`);
    console.log(`Field names may need adjusting in normalizeContent() and extractImages().`);
  }

  console.log('\nNext steps:');
  console.log('  Blog/pages: node scripts/import.js --site <wp-site> --username <user> --token <app-password>');
  console.log('  Products:   node scripts/shopify/import-products.js --site <wp-site> --username <user> --token <app-password> --wc-key <key> --wc-secret <secret>');
}

main().catch(e => { console.error(e); process.exit(1); });
