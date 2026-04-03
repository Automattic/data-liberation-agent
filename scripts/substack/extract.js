#!/usr/bin/env node
/**
 * extract.js — Step 2: Extract all content from a Substack publication
 *
 * Two extraction modes:
 *   1. API mode (default): Fetches each post via Substack's public API.
 *      Fast, no browser needed, but paid posts are truncated.
 *   2. CSV mode (--csv-export): Reads from Substack's ZIP/CSV export.
 *      Gets full content for paid posts but no API metadata.
 *
 * Best results: run both. API for metadata + free posts, CSV for paid content.
 *
 * Usage:
 *   node scripts/substack/extract.js https://yourpub.substack.com
 *   node scripts/substack/extract.js https://yourpub.substack.com --csv-export export.zip
 *   node scripts/substack/extract.js https://yourpub.substack.com --csv-export posts.csv
 *   node scripts/substack/extract.js https://yourpub.substack.com --delay 1000 --limit 10
 *
 * Options:
 *   --csv-export <file>  Path to Substack export ZIP or CSV file
 *   --delay <ms>         Delay between API requests (default: 500)
 *   --limit <n>          Only process first N posts (for testing)
 *   --url-list <file>    Use URL list from discover.js output
 *
 * Output:
 *   output/pages/<slug>.json    — extracted post data (matches import.js format)
 *   output/media/               — downloaded images
 *   output/extraction-log.json  — summary of what was extracted
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync, createWriteStream } from 'fs';
import { basename } from 'path';
import https from 'https';
import http from 'http';

const args = process.argv.slice(2);
const siteUrl = args.find(a => a.startsWith('http'));
if (!siteUrl) {
  console.error('Usage: node scripts/substack/extract.js <substack-url> [options]');
  process.exit(1);
}

const base = siteUrl.replace(/\/$/, '');
const delay = parseInt(args[args.indexOf('--delay') + 1] || '500');
const limitArg = args.indexOf('--limit');
const limit = limitArg !== -1 ? parseInt(args[limitArg + 1]) : Infinity;
const csvArg = args.indexOf('--csv-export');
const csvFile = csvArg !== -1 ? args[csvArg + 1] : null;
const urlListArg = args.indexOf('--url-list');
const urlListFile = urlListArg !== -1 ? args[urlListArg + 1] : null;

mkdirSync('output/pages', { recursive: true });
mkdirSync('output/media', { recursive: true });

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function slugify(url) {
  return new URL(url).pathname.replace(/^\//, '').replace(/\//g, '--') || 'homepage';
}

async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = createWriteStream(destPath);
    proto.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

// Extract original image URL from Substack's CDN wrapper
// substackcdn.com/image/fetch/w_1234,h_567,.../https://substack-post-media.s3.amazonaws.com/...
function unwrapImageUrl(cdnUrl) {
  const match = cdnUrl.match(/substackcdn\.com\/image\/fetch\/[^/]+\/(https?:\/\/.+)/);
  if (match) return decodeURIComponent(match[1]);
  return cdnUrl;
}

// Find all image URLs in HTML content or JSON data
function extractImageUrls(data) {
  const urls = new Set();
  const str = typeof data === 'string' ? data : JSON.stringify(data);

  // Substack CDN images — stop at quotes, whitespace, parentheses, commas, or escaped quotes
  const cdnMatches = str.match(/https:\/\/substackcdn\.com\/image\/fetch\/[^"'\s),\\]+\.(png|jpg|jpeg|gif|webp|svg)(\?[^"'\s),\\]*)?/gi) || [];
  for (const url of cdnMatches) {
    urls.add(url.replace(/\\u002F/g, '/'));
  }

  // Direct S3 images
  const s3Matches = str.match(/https:\/\/substack-post-media\.s3\.amazonaws\.com\/[^"'\s),\\]+\.(png|jpg|jpeg|gif|webp|svg)(\?[^"'\s),\\]*)?/gi) || [];
  for (const url of s3Matches) {
    urls.add(url);
  }

  // Bucketeer (older Substack images)
  const bucketMatches = str.match(/https:\/\/bucketeer-[^"'\s),\\]+\.(png|jpg|jpeg|gif|webp|svg)(\?[^"'\s),\\]*)?/gi) || [];
  for (const url of bucketMatches) {
    urls.add(url);
  }

  return [...urls];
}

// Parse Substack's CSV export
function parseCSV(csvContent) {
  const lines = csvContent.split('\n');
  if (lines.length < 2) return [];

  // Parse header
  const headers = parseCSVLine(lines[0]);
  const posts = [];

  let currentLine = '';
  for (let i = 1; i < lines.length; i++) {
    currentLine += (currentLine ? '\n' : '') + lines[i];
    // Count unescaped quotes — if odd, the line continues
    const quoteCount = (currentLine.match(/"/g) || []).length;
    if (quoteCount % 2 !== 0) continue;

    const values = parseCSVLine(currentLine);
    if (values.length >= headers.length) {
      const post = {};
      for (let j = 0; j < headers.length; j++) {
        post[headers[j]] = values[j] || '';
      }
      posts.push(post);
    }
    currentLine = '';
  }

  return posts;
}

function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

// Extract ZIP file to get CSV (basic ZIP handling for single-file ZIPs)
async function loadCSVExport(filePath) {
  const content = readFileSync(filePath);

  // Check if it's a ZIP
  if (content[0] === 0x50 && content[1] === 0x4B) {
    console.error('ZIP files must be extracted first. Unzip and pass the CSV path:');
    console.error(`  unzip ${filePath} -d substack-export/`);
    console.error('  node scripts/substack/extract.js <url> --csv-export substack-export/posts.csv');
    process.exit(1);
  }

  return parseCSV(content.toString('utf8'));
}

// Fetch a single post via Substack's public API
async function fetchPost(slug) {
  const url = `${base}/api/v1/posts/${slug}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

// Convert a Substack API post to the output format expected by import.js
function apiPostToPageData(post) {
  const url = post.canonical_url || `${base}/p/${post.slug}`;
  return {
    sourceUrl: url,
    slug: `p--${post.slug}`,
    extractedAt: new Date().toISOString(),
    platform: 'substack',
    apiCalls: [{ url: `${base}/api/v1/posts/${post.slug}`, data: post }],
    globals: {
      jsonLd: [{
        '@type': post.type === 'podcast' ? 'PodcastEpisode' : 'BlogPosting',
        headline: post.title,
        description: post.subtitle || post.description || '',
        datePublished: post.post_date,
        dateModified: post.post_date,
        articleBody: post.body_text || '',
        image: post.cover_image ? { url: post.cover_image } : undefined,
        author: post.publishedBylines?.map(b => ({
          '@type': 'Person',
          name: b.name,
        })) || [],
      }],
      meta: {
        title: post.title,
        description: post.subtitle || post.description || '',
        ogTitle: post.title,
        ogDescription: post.subtitle || '',
        ogImage: post.cover_image || null,
        canonical: url,
      },
    },
    content: {
      html: post.body_html || '',
      subtitle: post.subtitle || null,
      audience: post.audience,
      type: post.type,
      wordCount: post.word_count || null,
      podcastUrl: post.podcast_url || null,
      likes: post.reactions?.['❤'] || post.reaction_count || 0,
      commentCount: post.comment_count || 0,
    },
    accessibility: null,
  };
}

// Convert a CSV row to the output format expected by import.js
function csvPostToPageData(row) {
  const url = row.canonical_url || `${base}/p/${row.slug}`;
  return {
    sourceUrl: url,
    slug: `p--${row.slug}`,
    extractedAt: new Date().toISOString(),
    platform: 'substack',
    apiCalls: [],
    globals: {
      jsonLd: [{
        '@type': 'BlogPosting',
        headline: row.title,
        description: row.subtitle || '',
        datePublished: row.post_date,
        dateModified: row.post_date,
        articleBody: '',
        author: [],
      }],
      meta: {
        title: row.title,
        description: row.subtitle || '',
        ogTitle: row.title,
        ogDescription: row.subtitle || '',
        ogImage: null,
        canonical: url,
      },
    },
    content: {
      html: row.body_html || '',
      subtitle: row.subtitle || null,
      audience: row.audience || 'everyone',
      type: row.type || 'newsletter',
      wordCount: parseInt(row.word_count) || null,
      podcastUrl: row.podcast_url || null,
      likes: parseInt(row.reaction_count) || 0,
      commentCount: parseInt(row.comment_count) || 0,
    },
    accessibility: null,
  };
}

async function main() {
  console.log(`Extracting: ${base}`);

  const log = { processed: [], failed: [], mediaDownloaded: [], skippedPaid: [] };
  const allImageUrls = new Set();

  // Load posts to process
  let posts = [];

  if (urlListFile) {
    const inventory = JSON.parse(readFileSync(urlListFile, 'utf8'));
    posts = inventory.urls
      .filter(u => ['post', 'paid-post', 'podcast', 'thread', 'video'].includes(u.type))
      .map(u => ({ slug: u.slug || u.url.split('/p/')[1], url: u.url, ...u }));
  } else {
    // Fetch archive to get all slugs
    console.log('\nFetching post list...');
    let offset = 0;
    while (true) {
      const url = `${base}/api/v1/archive?sort=new&limit=50&offset=${offset}`;
      try {
        const res = await fetch(url);
        if (!res.ok) break;
        const batch = await res.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        posts.push(...batch);
        offset += 50;
        if (batch.length < 50) break;
        await sleep(300);
      } catch { break; }
    }
    console.log(`  Found ${posts.length} posts`);
  }

  posts = posts.slice(0, limit);

  // Load CSV export if provided (for paid content)
  let csvPosts = {};
  if (csvFile) {
    console.log(`\nLoading CSV export from ${csvFile}...`);
    const rows = await loadCSVExport(csvFile);
    for (const row of rows) {
      if (row.slug) csvPosts[row.slug] = row;
    }
    console.log(`  Loaded ${Object.keys(csvPosts).length} posts from CSV`);
  }

  // Extract each post
  console.log(`\nProcessing ${posts.length} posts...\n`);

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const slug = post.slug;
    console.log(`[${i + 1}/${posts.length}] ${slug}`);

    try {
      let pageData;

      // Try API first for rich metadata
      try {
        const apiPost = await fetchPost(slug);
        pageData = apiPostToPageData(apiPost);

        // If this is paid content and we have the CSV, use CSV for full HTML
        if (apiPost.audience !== 'everyone' && csvPosts[slug]) {
          console.log('  Using CSV for full paid content');
          pageData.content.html = csvPosts[slug].body_html || pageData.content.html;
        } else if (apiPost.audience !== 'everyone' && !csvPosts[slug]) {
          console.log('  Paid post — content may be truncated (use --csv-export for full content)');
          log.skippedPaid.push({ slug, title: apiPost.title });
        }
      } catch (apiErr) {
        // Fall back to CSV if API fails
        if (csvPosts[slug]) {
          console.log(`  API failed (${apiErr.message}), using CSV`);
          pageData = csvPostToPageData(csvPosts[slug]);
        } else {
          throw apiErr;
        }
      }

      writeFileSync(`output/pages/${pageData.slug}.json`, JSON.stringify(pageData, null, 2));

      // Collect image URLs
      for (const imgUrl of extractImageUrls(pageData)) {
        allImageUrls.add(imgUrl);
      }

      log.processed.push({ url: pageData.sourceUrl, slug: pageData.slug });
      console.log(`  OK (${pageData.content.wordCount || '?'} words, ${pageData.content.audience})`);
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
      log.failed.push({ slug, error: e.message });
    }

    if (i < posts.length - 1) await sleep(delay);
  }

  // Also process any CSV-only posts not in the API results
  if (csvFile) {
    const apiSlugs = new Set(posts.map(p => p.slug));
    const csvOnly = Object.entries(csvPosts).filter(([slug]) => !apiSlugs.has(slug));
    if (csvOnly.length > 0) {
      console.log(`\nProcessing ${csvOnly.length} CSV-only posts...`);
      for (const [slug, row] of csvOnly) {
        if (row.is_published === 'false') continue;
        const pageData = csvPostToPageData(row);
        writeFileSync(`output/pages/${pageData.slug}.json`, JSON.stringify(pageData, null, 2));
        for (const imgUrl of extractImageUrls(pageData)) {
          allImageUrls.add(imgUrl);
        }
        log.processed.push({ url: pageData.sourceUrl, slug: pageData.slug });
      }
    }
  }

  // Download all media
  console.log(`\nDownloading ${allImageUrls.size} media files...`);
  for (const imgUrl of allImageUrls) {
    // Unwrap CDN URL to get original
    const originalUrl = unwrapImageUrl(imgUrl);
    let urlPath;
    try {
      urlPath = new URL(originalUrl).pathname;
    } catch {
      urlPath = originalUrl.split('?')[0];
    }
    let filename = basename(urlPath) || `image-${Date.now()}.jpg`;
    // Sanitize filename — truncate if too long, remove query artifacts
    filename = filename.split('?')[0].split('&')[0];
    if (filename.length > 200) {
      const ext = filename.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i)?.[0] || '.jpg';
      filename = filename.slice(0, 190) + ext;
    }
    const dest = `output/media/${filename}`;

    // Skip if already downloaded
    if (existsSync(dest)) {
      process.stdout.write('s');
      continue;
    }

    try {
      await downloadFile(originalUrl, dest);
      log.mediaDownloaded.push({ url: imgUrl, originalUrl, file: dest });
      process.stdout.write('.');
    } catch (e) {
      // Try the CDN URL if original fails
      try {
        await downloadFile(imgUrl, dest);
        log.mediaDownloaded.push({ url: imgUrl, file: dest });
        process.stdout.write('.');
      } catch (e2) {
        log.failed.push({ url: imgUrl, error: `Media download: ${e2.message}` });
        process.stdout.write('x');
      }
    }
  }

  writeFileSync('output/extraction-log.json', JSON.stringify(log, null, 2));
  console.log(`\n\nDone.`);
  console.log(`  Posts extracted: ${log.processed.length}`);
  console.log(`  Media downloaded: ${log.mediaDownloaded.length}`);
  console.log(`  Failures: ${log.failed.length}`);
  if (log.skippedPaid.length) {
    console.log(`  Paid posts with truncated content: ${log.skippedPaid.length}`);
    console.log('  Use --csv-export with your Substack export to get full paid content');
  }
  if (log.failed.length) console.log('  See output/extraction-log.json for details');
}

main().catch(e => { console.error(e); process.exit(1); });
