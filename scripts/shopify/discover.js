#!/usr/bin/env node
// scripts/shopify/discover.js
// Inventories a Shopify store via CDP session interception (no API keys).
// Usage: node scripts/shopify/discover.js <store-domain> [--cdp-port 9222]

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { parseArgs } from 'util';

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    'cdp-port': { type: 'string', default: '9222' },
    'debug':    { type: 'boolean', default: false },
  },
});

const [storeDomain] = positionals;
if (!storeDomain) {
  console.error('Usage: node scripts/shopify/discover.js <store-domain> [--cdp-port 9222]');
  process.exit(1);
}

const cdpPort   = values['cdp-port'];
const debug     = values['debug'];
const adminBase = `https://${storeDomain}/admin`;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function interceptSection(page, url, label) {
  const captured = [];

  const handler = async (response) => {
    const respUrl = response.url();
    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('application/json')) return;
    if (debug) console.log(`  [debug] JSON response: ${respUrl}`);
    if (!respUrl.includes('admin.shopify.com/api/operations/')) return;
    try {
      const data = await response.json();
      if (data?.data) captured.push({ url: respUrl, data });
    } catch {}
  };

  page.on('response', handler);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await sleep(1000);
  } catch (e) {
    console.error(`  Navigation failed for ${label}: ${e.message}`);
  }
  page.off('response', handler);
  console.log(`  ${label}: captured ${captured.length} GraphQL response(s)`);
  return captured;
}

function extractItems(captures, type) {
  const seen  = new Set();
  const items = [];

  for (const { data } of captures) {
    const root = data?.data;
    if (!root || typeof root !== 'object') continue;

    // Walk all top-level fields — Shopify uses various keys (products, productList, etc.)
    for (const key of Object.keys(root)) {
      const field = root[key];
      if (!field || typeof field !== 'object') continue;

      // Handle both edges/nodes (GraphQL connections) and plain arrays
      const edges =
        field?.edges ??
        (Array.isArray(field) ? field.map(n => ({ node: n })) : null);

      if (!Array.isArray(edges)) continue;

      for (const edge of edges) {
        const node = edge?.node ?? edge;
        if (!node?.id || seen.has(node.id)) continue;
        seen.add(node.id);

        const numericId = node.id.toString().split('/').pop();
        items.push({
          id:          node.id,
          type,
          title:       node.title ?? node.name ?? '(untitled)',
          handle:      node.handle ?? null,
          adminUrl:    buildAdminUrl(type, numericId),
          publishedAt: node.publishedAt ?? node.createdAt ?? null,
          status:      node.status ?? null,
        });
      }
    }
  }

  return items;
}

function buildAdminUrl(type, numericId) {
  const paths = {
    product:   `${adminBase}/products/${numericId}`,
    page:      `${adminBase}/pages/${numericId}`,
    blog_post: `${adminBase}/blog_posts/${numericId}`,
  };
  return paths[type] ?? `${adminBase}/${type}s/${numericId}`;
}

async function main() {
  console.log(`Connecting to Chrome on CDP port ${cdpPort}...`);
  const browser  = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const context  = browser.contexts()[0] ?? (await browser.newContext());
  const page     = await context.newPage();

  console.log(`Inventorying ${adminBase}...`);

  const productCaptures = await interceptSection(page, `${adminBase}/products`,   'products');
  const pageCaptures    = await interceptSection(page, `${adminBase}/pages`,       'pages');
  const blogCaptures    = await interceptSection(page, `${adminBase}/blogs`,  'blog posts');

  await browser.close();

  const products  = extractItems(productCaptures, 'product');
  const pages     = extractItems(pageCaptures,    'page');
  const blogPosts = extractItems(blogCaptures,    'blog_post');

  const inventory = {
    source:       storeDomain,
    extractedAt:  new Date().toISOString(),
    counts: {
      products:   products.length,
      pages:      pages.length,
      blog_posts: blogPosts.length,
      total:      products.length + pages.length + blogPosts.length,
    },
    items: [...products, ...pages, ...blogPosts],
    // Raw captures preserved so field names can be inspected and refined if needed
    _rawCaptures: {
      products:   productCaptures,
      pages:      pageCaptures,
      blog_posts: blogCaptures,
    },
  };

  mkdirSync('output', { recursive: true });
  writeFileSync('output/inventory.json', JSON.stringify(inventory, null, 2));

  console.log(`\nInventory written to output/inventory.json`);
  console.log(`  Products:   ${products.length}`);
  console.log(`  Pages:      ${pages.length}`);
  console.log(`  Blog posts: ${blogPosts.length}`);

  if (inventory.counts.total === 0) {
    console.warn('\n⚠  No items found. Check output/inventory.json → _rawCaptures to inspect');
    console.warn('   the raw GraphQL responses and confirm the URL patterns are correct.');
  } else {
    console.log('\nReview output/inventory.json and confirm before running extract.js');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
