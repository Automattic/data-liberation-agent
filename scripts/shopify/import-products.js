#!/usr/bin/env node
// scripts/shopify/import-products.js
// Imports Shopify products from output/pages/*.json into WooCommerce.
// Usage:
//   node scripts/shopify/import-products.js \
//     --site yoursite.wordpress.com \
//     --username your-wpcom-user \
//     --token YOUR_APP_PASSWORD \
//     --wc-key ck_xxxx \
//     --wc-secret cs_xxxx
//
// WooCommerce credentials: WooCommerce → Settings → Advanced → REST API (Read/Write)

import { readdirSync, readFileSync, existsSync } from 'fs';
import { parseArgs } from 'util';
import { basename } from 'path';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    site:         { type: 'string' },
    username:     { type: 'string' },
    token:        { type: 'string' },
    'wc-key':     { type: 'string' },
    'wc-secret':  { type: 'string' },
    'input-dir':  { type: 'string', default: 'output/pages' },
  },
});

const { site, username, token } = values;
const wcKey     = values['wc-key'];
const wcSecret  = values['wc-secret'];
const inputDir  = values['input-dir'];

if (!site || !username || !token || !wcKey || !wcSecret) {
  console.error(
    'Usage: node scripts/shopify/import-products.js\n' +
    '  --site <site> --username <user> --token <app-password>\n' +
    '  --wc-key <ck_xxx> --wc-secret <cs_xxx>'
  );
  process.exit(1);
}

const siteBase = site.startsWith('http') ? site : `https://${site}`;
const wpAuth   = 'Basic ' + Buffer.from(`${username}:${token}`).toString('base64');
const wcAuth   = 'Basic ' + Buffer.from(`${wcKey}:${wcSecret}`).toString('base64');

// Build CDN URL → local file path map from extraction log
const cdnToLocal = {};
if (existsSync('output/extraction-log.json')) {
  const log = JSON.parse(readFileSync('output/extraction-log.json', 'utf8'));
  for (const entry of log) {
    if (entry.original && entry.local) cdnToLocal[entry.original] = entry.local;
  }
}

async function wcPost(path, body) {
  const res = await fetch(`${siteBase}${path}`, {
    method:  'POST',
    headers: { Authorization: wcAuth, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function findOrUploadImage(cdnUrl) {
  try {
    // Resolve CDN URL to local file (downloaded during extraction), or fetch directly
    const localPath = cdnToLocal[cdnUrl];
    let fileData, filename;

    if (localPath && existsSync(localPath)) {
      fileData = readFileSync(localPath);
      filename = basename(localPath);
    } else {
      // Not cached locally — download from CDN now
      const fetchRes = await fetch(cdnUrl, { signal: AbortSignal.timeout(30000) });
      if (!fetchRes.ok) return null;
      const buf = await fetchRes.arrayBuffer();
      fileData = Buffer.from(buf);
      filename = basename(new URL(cdnUrl).pathname).split('?')[0] || 'image.jpg';
    }

    // Check if this file was already uploaded to WordPress (e.g. by import.js)
    // Search by slug, which WP derives from the filename without extension
    const slug = filename.replace(/\.[^.]+$/, '');
    const searchRes = await fetch(
      `${siteBase}/wp-json/wp/v2/media?slug=${encodeURIComponent(slug)}&per_page=1`,
      { headers: { Authorization: wpAuth }, signal: AbortSignal.timeout(15000) }
    );
    if (searchRes.ok) {
      const existing = await searchRes.json();
      if (existing[0]?.id) {
        return { id: existing[0].id, url: existing[0].source_url };
      }
    }

    // Not found — upload fresh
    const ext  = filename.split('.').pop().toLowerCase();
    const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] ?? 'image/jpeg';

    const res = await fetch(`${siteBase}/wp-json/wp/v2/media`, {
      method:  'POST',
      headers: {
        Authorization:         wpAuth,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Type':        mime,
      },
      body:   fileData,
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { id: data.id, url: data.source_url };
  } catch {
    return null;
  }
}

async function ensureCategory(name, categoryCache) {
  if (categoryCache.has(name)) return categoryCache.get(name);

  // Try to create — if it already exists, WooCommerce returns 400 with term_exists
  try {
    const created = await wcPost('/wp-json/wc/v3/products/categories', { name });
    categoryCache.set(name, created.id);
    return created.id;
  } catch {
    // Search for existing
    try {
      const res = await fetch(
        `${siteBase}/wp-json/wc/v3/products/categories?search=${encodeURIComponent(name)}`,
        { headers: { Authorization: wcAuth } }
      );
      const existing = await res.json();
      const id = existing[0]?.id ?? null;
      if (id) categoryCache.set(name, id);
      return id;
    } catch {
      return null;
    }
  }
}

function mapStatus(shopifyStatus) {
  return (shopifyStatus === 'ACTIVE' || shopifyStatus === 'active') ? 'publish' : 'draft';
}

function isVariable(raw) {
  // Admin API stores variants under _variantNodes (nodes) not variants.edges
  const variantCount = raw?._variantNodes?.length ?? raw?.variants?.edges?.length ?? 0;
  return Array.isArray(raw?.options) && raw.options.length > 0 && variantCount > 1;
}

function buildAttributes(raw) {
  return (raw?.options ?? []).map(opt => ({
    name:      opt.name,
    visible:   true,
    variation: true,
    // Admin API may use optionValues[].name instead of values[]
    options:   opt.values ?? (opt.optionValues ?? []).map(v => v.name),
  }));
}

function buildVariation(variantNode, productOptions) {
  // Admin API nests selected option value under optionValue.name; correlate with product options by position
  const attributes = (variantNode.selectedOptions ?? []).map((o, i) => ({
    attribute: productOptions?.[i]?.name ?? `option${i + 1}`,
    option:    o.optionValue?.name ?? o.value ?? o.name ?? '',
  }));
  return {
    regular_price:  variantNode.price          ?? '0',
    sale_price:     variantNode.compareAtPrice ?? '',
    sku:            variantNode.sku            ?? '',
    stock_quantity: variantNode.inventoryQuantity ?? null,
    manage_stock:   variantNode.inventoryQuantity != null,
    status:         'publish',
    attributes,
  };
}

async function importProduct(item, categoryCache) {
  const raw = item._raw ?? {};

  // Upload images to WP media library (item.images contains original Shopify CDN URLs)
  const wcImages = [];
  for (const cdnUrl of item.images ?? []) {
    const uploaded = await findOrUploadImage(cdnUrl);
    if (uploaded) wcImages.push({ id: uploaded.id });
    else console.warn(`    ⚠ Could not upload image: ${cdnUrl.slice(0, 80)}`);
  }

  // Resolve product type category
  const categories = [];
  if (raw.productType) {
    const catId = await ensureCategory(raw.productType, categoryCache);
    if (catId) categories.push({ id: catId });
  }

  const tags     = (raw.tags ?? []).map(t => ({ name: t }));
  const variable = isVariable(raw);
  // Admin API stores variants under _variantNodes; fall back to variants.edges for compatibility
  const variants = raw._variantNodes ?? (raw.variants?.edges ?? []).map(e => e?.node ?? e);
  const first    = variants[0] ?? {};

  const productBody = {
    name:          item.title,
    slug:          item.slug,
    status:        mapStatus(item.status),
    description:   item.content ?? '',
    type:          variable ? 'variable' : 'simple',
    sku:           variable ? '' : (first.sku            ?? ''),
    regular_price: variable ? '' : (first.price          ?? ''),
    sale_price:    variable ? '' : (first.compareAtPrice ?? ''),
    stock_quantity: variable ? null : (first.inventoryQuantity ?? null),
    manage_stock:  variable ? false : (first.inventoryQuantity != null),
    images:        wcImages,
    categories,
    tags,
    attributes:    variable ? buildAttributes(raw) : [],
  };

  const created = await wcPost('/wp-json/wc/v3/products', productBody);
  console.log(`  Created product #${created.id}: ${created.name}`);

  if (variable) {
    for (const variantNode of variants) {
      await wcPost(`/wp-json/wc/v3/products/${created.id}/variations`, buildVariation(variantNode, raw.options));
    }
    console.log(`    + ${variants.length} variation(s)`);
  }

  return created.id;
}

async function main() {
  const files = readdirSync(inputDir)
    .filter(f => f.endsWith('.json') && !f.endsWith('-raw.json'))
    .map(f => {
      try { return JSON.parse(readFileSync(`${inputDir}/${f}`, 'utf8')); } catch { return null; }
    })
    .filter(item => item?.type === 'product');

  if (files.length === 0) {
    console.log(`No product items found in ${inputDir}`);
    console.log('Run extract.js first to populate output/pages/ with product data.');
    process.exit(0);
  }

  console.log(`Importing ${files.length} product(s) to ${siteBase}...`);
  console.log('WooCommerce endpoint:', `${siteBase}/wp-json/wc/v3/products`);

  const categoryCache = new Map();
  let succeeded = 0;
  let failed    = 0;

  for (const item of files) {
    console.log(`[${succeeded + failed + 1}/${files.length}] ${item.title}`);
    try {
      await importProduct(item, categoryCache);
      succeeded++;
    } catch (e) {
      console.error(`  ✗ Failed: ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDone: ${succeeded} imported, ${failed} failed`);
  if (failed > 0) {
    console.log('Check error messages above. Common causes:');
    console.log('  - WooCommerce not installed or REST API disabled');
    console.log('  - Consumer key/secret lacks Write permission');
    console.log('  - Duplicate SKU (re-running after partial success)');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
