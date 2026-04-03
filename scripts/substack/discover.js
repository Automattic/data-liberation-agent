#!/usr/bin/env node
/**
 * discover.js — Step 1: Inventory a Substack publication
 *
 * Uses Substack's public API and sitemap to find all content.
 * No browser or authentication needed — Substack's API is publicly accessible.
 *
 * Usage:
 *   node scripts/substack/discover.js https://yourpub.substack.com
 *   node scripts/substack/discover.js https://customdomain.com
 *
 * Output:
 *   output/inventory.json — categorized list of all content URLs
 */

import { writeFileSync, mkdirSync } from 'fs';

const args = process.argv.slice(2);
const siteUrl = args.find(a => a.startsWith('http'));
if (!siteUrl) {
  console.error('Usage: node scripts/substack/discover.js <substack-url>');
  process.exit(1);
}

const base = siteUrl.replace(/\/$/, '');
mkdirSync('output', { recursive: true });

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Classify a Substack URL into a content type
function classify(url, apiPost) {
  if (apiPost) {
    if (apiPost.type === 'podcast') return 'podcast';
    if (apiPost.type === 'thread') return 'thread';
    if (apiPost.type === 'video') return 'video';
    if (apiPost.audience !== 'everyone') return 'paid-post';
    return 'post';
  }
  const path = new URL(url).pathname.toLowerCase();
  if (path.startsWith('/p/')) return 'post';
  if (path === '/about' || path === '/about/') return 'page';
  if (path === '/archive' || path.startsWith('/archive')) return 'archive';
  if (path === '/' || path === '') return 'homepage';
  if (path === '/podcast' || path.startsWith('/podcast')) return 'podcast';
  return 'page';
}

// Fetch all posts via Substack's undocumented public API
async function fetchAllPosts() {
  const posts = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const url = `${base}/api/v1/archive?sort=new&limit=${limit}&offset=${offset}`;
    console.log(`  Fetching posts (offset ${offset})...`);

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`  API returned ${res.status} at offset ${offset}`);
        break;
      }
      const batch = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      posts.push(...batch);
      offset += limit;
      if (batch.length < limit) break;
      await sleep(500);
    } catch (e) {
      console.error(`  API fetch failed: ${e.message}`);
      break;
    }
  }

  return posts;
}

// Fetch sitemap for any additional URLs
async function fetchSitemap() {
  const urls = [];
  try {
    const res = await fetch(`${base}/sitemap.xml`);
    if (!res.ok) return urls;
    const text = await res.text();
    const locs = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
    for (const loc of locs) {
      if (loc.endsWith('.xml')) {
        // Recurse into sitemap indexes
        try {
          const subRes = await fetch(loc);
          if (subRes.ok) {
            const subText = await subRes.text();
            const subLocs = [...subText.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
            urls.push(...subLocs.filter(l => !l.endsWith('.xml')));
          }
        } catch {}
      } else {
        urls.push(loc);
      }
    }
  } catch (e) {
    console.error(`  Sitemap fetch failed: ${e.message}`);
  }
  return urls;
}

async function main() {
  console.log(`Discovering: ${base}`);

  // Fetch posts via API
  console.log('\nFetching posts via API...');
  const apiPosts = await fetchAllPosts();
  console.log(`  Found ${apiPosts.length} posts via API`);

  // Fetch sitemap for additional URLs
  console.log('\nFetching sitemap...');
  const sitemapUrls = await fetchSitemap();
  console.log(`  Found ${sitemapUrls.length} URLs in sitemap`);

  // Build inventory from API posts (primary source)
  const inventory = {
    siteUrl: base,
    discoveredAt: new Date().toISOString(),
    platform: 'substack',
    navigation: [
      { text: 'Home', href: base },
      { text: 'Archive', href: `${base}/archive` },
      { text: 'About', href: `${base}/about` },
    ],
    counts: {},
    urls: [],
    apiPostCount: apiPosts.length,
  };

  const seen = new Set();

  // Add API posts with rich metadata
  for (const post of apiPosts) {
    const url = post.canonical_url || `${base}/p/${post.slug}`;
    if (seen.has(url)) continue;
    seen.add(url);

    const type = classify(url, post);
    inventory.urls.push({
      url,
      type,
      slug: post.slug,
      title: post.title,
      subtitle: post.subtitle || null,
      date: post.post_date,
      audience: post.audience,
      wordCount: post.word_count || null,
      hasPodcast: !!post.podcast_url,
    });
    inventory.counts[type] = (inventory.counts[type] || 0) + 1;
  }

  // Add any sitemap URLs not already covered
  for (const url of sitemapUrls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const type = classify(url);
    if (type === 'archive' || type === 'homepage') continue;
    inventory.urls.push({ url, type });
    inventory.counts[type] = (inventory.counts[type] || 0) + 1;
  }

  writeFileSync('output/inventory.json', JSON.stringify(inventory, null, 2));

  console.log('\nInventory summary:');
  for (const [type, count] of Object.entries(inventory.counts)) {
    console.log(`  ${type}: ${count}`);
  }
  console.log(`\nTotal: ${inventory.urls.length} URLs`);
  console.log('Written to output/inventory.json');
  console.log('\nReview this inventory before running extract.js');

  // Warn about paid content
  const paidCount = inventory.counts['paid-post'] || 0;
  if (paidCount > 0) {
    console.log(`\nNote: ${paidCount} paid posts detected. The public API only returns`);
    console.log('free preview content for these. To get full paid content, use the');
    console.log('Substack export (Settings > Exports) and pass the ZIP to extract.js');
    console.log('with --csv-export.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
