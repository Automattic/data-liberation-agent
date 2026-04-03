#!/usr/bin/env node
/**
 * extract.js — Step 2: Extract full content from Instagram posts
 *
 * Takes the inventory from discover.js and visits each post individually
 * to get full-resolution images, carousel slides, video URLs, and comments.
 *
 * Usage:
 *   node scripts/instagram/extract.js <username> --cdp-port 9222
 *   node scripts/instagram/extract.js <username> --cdp-port 9222 --limit 10
 *   node scripts/instagram/extract.js <username> --cdp-port 9222 --skip-media
 *
 * Options:
 *   --cdp-port <port>   CDP port of your running browser (required)
 *   --delay <ms>        Delay between posts (default: 1500)
 *   --limit <n>         Only process first N posts (for testing)
 *   --skip-media        Extract metadata only, don't download images/videos
 *   --url-list <file>   Use inventory from discover.js (default: output/inventory.json)
 *
 * Output:
 *   output/pages/<shortcode>.json  — extracted post data
 *   output/media/                  — downloaded images and videos
 *   output/extraction-log.json     — summary of what was extracted
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync, existsSync, createWriteStream } from 'fs';
import { basename } from 'path';
import https from 'https';
import http from 'http';

const args = process.argv.slice(2);
const username = args.find(a => !a.startsWith('--'));
if (!username) {
  console.error('Usage: node scripts/instagram/extract.js <username> --cdp-port <port>');
  process.exit(1);
}

function parseIntArg(name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  const val = parseInt(args[idx + 1], 10);
  if (!Number.isFinite(val)) {
    console.error(`Error: ${name} requires a numeric value.`);
    process.exit(1);
  }
  return val;
}

const cdpPort = parseIntArg('--cdp-port', null);
if (!cdpPort) {
  console.error('Error: --cdp-port is required.');
  process.exit(1);
}

const delay = parseIntArg('--delay', 1500);
const limit = parseIntArg('--limit', Infinity);
const skipMedia = args.includes('--skip-media');
const urlListArg = args.indexOf('--url-list');
const urlListFile = urlListArg !== -1 ? args[urlListArg + 1] : 'output/inventory.json';

mkdirSync('output/pages', { recursive: true });
mkdirSync('output/media', { recursive: true });

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function downloadFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
    if (!url.startsWith('https://')) return reject(new Error(`Refused non-HTTPS URL: ${url}`));

    const file = createWriteStream(destPath);
    file.on('error', reject);

    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume(); // consume response to free socket
        file.close();
        const location = res.headers.location;
        if (!location?.startsWith('https://')) return reject(new Error(`Redirect to non-HTTPS: ${location}`));
        return downloadFile(location, destPath, redirectsLeft - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        file.close();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

// Sanitize shortcode for safe use as filename
function safeShortcode(sc) {
  return sc.replace(/[^a-zA-Z0-9_-]/g, '');
}

// Generate a sane filename from an Instagram CDN URL
function mediaFilename(url, shortcode, index) {
  const ext = url.match(/\.(jpg|jpeg|png|webp|mp4|mov)/i)?.[1] || 'jpg';
  return `${safeShortcode(shortcode)}_${index}.${ext.toLowerCase()}`;
}

async function extractPostData(page, shortcode, isCarousel = false, carouselCount = 10) {
  const postUrl = `https://www.instagram.com/p/${shortcode}/`;
  const captured = { apiCalls: [], globals: null };

  // Intercept API responses for this post
  const responseHandler = async (response) => {
    const url = response.url();
    if (!url.includes('/graphql/query') && !url.includes('/api/v1/media/')) return;

    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('application/json') && !ct.includes('text/javascript')) return;

    try {
      const body = await response.json();
      captured.apiCalls.push({ url, data: body });
    } catch {}
  };

  page.on('response', responseHandler);

  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for the main post image or GraphQL response to land
    await page.waitForSelector('article img[src*="cdninstagram.com"]', { timeout: 10000 }).catch(() => {});
  } catch (e) {
    console.error(`  Navigation failed: ${e.message}`);
  }

  page.off('response', responseHandler);

  // Extract data from the page — Instagram embeds post data in script tags and window objects
  captured.globals = await page.evaluate(() => {
    const result = {};

    // JSON-LD (Instagram provides this for public posts)
    result.jsonLd = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]')
    ).map(s => {
      try { return JSON.parse(s.textContent); } catch { return null; }
    }).filter(Boolean);

    // Check specific known globals (avoid enumerating all of window)
    for (const key of ['__additionalDataLoaded', '__NEXT_DATA__', '_sharedData']) {
      if (window[key]) {
        try { result[key] = window[key]; } catch {}
      }
    }

    // Meta tags — Instagram sets good OG tags
    result.meta = {
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content,
      ogTitle: document.querySelector('meta[property="og:title"]')?.content,
      ogDescription: document.querySelector('meta[property="og:description"]')?.content,
      ogImage: document.querySelector('meta[property="og:image"]')?.content,
      ogType: document.querySelector('meta[property="og:type"]')?.content,
    };

    return result;
  });

  // Try to find the post's media from the captured API calls
  let postDetail = null;
  for (const call of captured.apiCalls) {
    const data = call.data;

    // Look for the post in various response shapes
    const media = data?.data?.xdt_shortcode_media ||
                  data?.graphql?.shortcode_media ||
                  data?.data?.shortcode_media ||
                  data?.items?.[0];

    if (media && (media.shortcode === shortcode || media.code === shortcode)) {
      postDetail = media;
      break;
    }
  }

  // For carousel posts: click through the carousel arrows to capture each slide's
  // full-res image. Instagram's carousel arrows are button[aria-label="Next"] and
  // are NOT inside the article element — they're in a parent container.
  const carouselSlides = [];
  if (isCarousel) {
    // Strategy: Instagram supports ?img_index=N to load a specific carousel slide.
    // Navigate to each slide directly and grab the main post image.
    const expectedSlides = carouselCount || 10;

    const getMainPostImage = async () => {
      return page.evaluate(() => {
        const allImgs = document.querySelectorAll('img');
        let best = null;
        let bestSize = 0;
        for (const img of allImgs) {
          const src = img.src || '';
          if (!src.includes('cdninstagram.com/v/t51.')) continue;
          if (img.alt?.includes('User avatar')) continue;
          const rect = img.getBoundingClientRect();
          if (rect.width < 400) continue;
          const size = rect.width * rect.height;
          if (size > bestSize) { bestSize = size; best = src; }
        }
        // Also check for video on this slide
        const video = document.querySelector('video[src], video source');
        const videoUrl = video?.src || video?.querySelector?.('source')?.src || null;
        return { imageUrl: best, videoUrl };
      });
    };

    for (let slideIdx = 1; slideIdx <= expectedSlides; slideIdx++) {
      try {
        const slideUrl = `https://www.instagram.com/p/${shortcode}/?img_index=${slideIdx}`;
        await page.goto(slideUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
        await sleep(800);

        const { imageUrl, videoUrl } = await getMainPostImage();
        if (imageUrl || videoUrl) {
          // Check for duplicates (means we've gone past the last slide)
          const isDupe = carouselSlides.some(s => s.displayUrl === imageUrl && imageUrl);
          if (isDupe) break;

          carouselSlides.push({
            type: videoUrl ? 'video' : 'photo',
            displayUrl: imageUrl,
            videoUrl: videoUrl,
          });
        } else {
          break; // No image found = past the end
        }
      } catch {
        break;
      }
    }

    if (carouselSlides.length > 1) {
      console.log(`  Carousel: ${carouselSlides.length} slides captured`);
    }
  }

  return { captured, postDetail, carouselSlides };
}

function buildPostOutput(shortcode, inventoryPost, postDetail, globals, carouselSlides = []) {
  const output = {
    shortcode,
    sourceUrl: `https://www.instagram.com/p/${shortcode}/`,
    extractedAt: new Date().toISOString(),
    // Start with inventory data as baseline
    ...inventoryPost,
    // Enrich with detail data if we got it
    media: [],
    tags: [],
    mentionedUsers: [],
  };

  if (postDetail) {
    // Full caption (inventory might have truncated it)
    output.caption = postDetail.edge_media_to_caption?.edges?.[0]?.node?.text ||
                     postDetail.caption?.text ||
                     output.caption;

    // Location details
    if (postDetail.location) {
      output.location = {
        name: postDetail.location.name,
        id: postDetail.location.id || postDetail.location.pk,
        slug: postDetail.location.slug || null,
        lat: postDetail.location.lat || null,
        lng: postDetail.location.lng || null,
        address: (() => {
          try { return postDetail.location.address_json ? JSON.parse(postDetail.location.address_json) : null; }
          catch { return null; }
        })(),
      };
    }

    // Tagged users
    const taggedEdges = postDetail.edge_media_to_tagged_user?.edges || [];
    output.mentionedUsers = taggedEdges.map(e => ({
      username: e.node?.user?.username,
      fullName: e.node?.user?.full_name,
      x: e.node?.x,
      y: e.node?.y,
    }));

    // Extract all media items (handles single posts, carousels, and videos)
    if (postDetail.edge_sidecar_to_children?.edges) {
      // Carousel post
      for (const edge of postDetail.edge_sidecar_to_children.edges) {
        const child = edge.node;
        output.media.push({
          type: child.is_video ? 'video' : 'photo',
          displayUrl: child.display_url || child.display_resources?.slice(-1)?.[0]?.src,
          videoUrl: child.video_url || null,
          dimensions: child.dimensions || null,
          accessibilityCaption: child.accessibility_caption || null,
        });
      }
    } else if (postDetail.carousel_media) {
      // Newer API format for carousels
      for (const child of postDetail.carousel_media) {
        output.media.push({
          type: child.video_versions ? 'video' : 'photo',
          displayUrl: child.image_versions2?.candidates?.[0]?.url,
          videoUrl: child.video_versions?.[0]?.url || null,
          dimensions: child.original_width && child.original_height
            ? { width: child.original_width, height: child.original_height } : null,
          accessibilityCaption: child.accessibility_caption || null,
        });
      }
    } else {
      // Single photo or video
      output.media.push({
        type: postDetail.is_video ? 'video' : 'photo',
        displayUrl: postDetail.display_url ||
                    postDetail.image_versions2?.candidates?.[0]?.url,
        videoUrl: postDetail.video_url ||
                  postDetail.video_versions?.[0]?.url || null,
        dimensions: postDetail.dimensions ||
          (postDetail.original_width && postDetail.original_height
            ? { width: postDetail.original_width, height: postDetail.original_height } : null),
        accessibilityCaption: postDetail.accessibility_caption || null,
      });
    }
  } else {
    // No detail data — fall back to what discover gave us
    if (inventoryPost?.displayUrl) {
      output.media.push({
        type: inventoryPost.isVideo ? 'video' : 'photo',
        displayUrl: inventoryPost.displayUrl,
        videoUrl: inventoryPost.videoUrl || null,
        dimensions: inventoryPost.dimensions || null,
        accessibilityCaption: inventoryPost.accessibilityCaption || null,
      });
    }
  }

  // For carousels: if we only got 1 media item from the API but we have
  // carousel slides from clicking through the UI, use those instead
  if (carouselSlides.length > 1 && output.media.length <= 1) {
    output.media = carouselSlides.map(slide => ({
      ...slide,
      dimensions: null,
      accessibilityCaption: null,
    }));
  }

  // Extract hashtags and @mentions from caption
  if (output.caption) {
    output.tags = [...output.caption.matchAll(/#(\w+)/g)].map(m => m[1]);
    const mentions = [...output.caption.matchAll(/@(\w+)/g)].map(m => m[1]);
    // Merge with tagged users
    for (const mention of mentions) {
      if (!output.mentionedUsers.find(u => u.username === mention)) {
        output.mentionedUsers.push({ username: mention });
      }
    }
  }

  // Add OG image as fallback if we have no media
  if (output.media.length === 0 && globals?.meta?.ogImage) {
    output.media.push({
      type: 'photo',
      displayUrl: globals.meta.ogImage,
      videoUrl: null,
      dimensions: null,
      accessibilityCaption: null,
    });
  }

  return output;
}

async function main() {
  console.log(`Extracting Instagram posts for: ${username}`);

  // Load inventory
  if (!existsSync(urlListFile)) {
    console.error(`Inventory file not found: ${urlListFile}`);
    console.error('Run discover.js first.');
    process.exit(1);
  }

  const inventory = JSON.parse(readFileSync(urlListFile, 'utf8'));
  const postsToProcess = (inventory.posts || []).slice(0, limit);
  console.log(`Processing ${postsToProcess.length} posts from inventory...\n`);

  // Connect to browser
  console.log(`Connecting to browser on CDP port ${cdpPort}...`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  console.log('Connected.\n');

  const log = { processed: [], failed: [], mediaDownloaded: [] };
  const allMediaUrls = []; // { url, filename } pairs

  for (let i = 0; i < postsToProcess.length; i++) {
    const inventoryPost = postsToProcess[i];
    const shortcode = inventoryPost.shortcode;
    console.log(`[${i + 1}/${postsToProcess.length}] ${inventoryPost.url || shortcode}`);

    try {
      const isCarousel = inventoryPost.type === 'carousel';
      const { captured, postDetail, carouselSlides } = await extractPostData(
        page, shortcode, isCarousel, inventoryPost.carouselCount
      );
      const output = buildPostOutput(shortcode, inventoryPost, postDetail, captured.globals, carouselSlides);
      const safeCode = safeShortcode(shortcode);

      // Queue media for download and set local file paths before writing
      for (let j = 0; j < output.media.length; j++) {
        const item = output.media[j];
        const downloadUrl = item.videoUrl || item.displayUrl;
        if (downloadUrl) {
          const filename = mediaFilename(downloadUrl, shortcode, j);
          allMediaUrls.push({ url: downloadUrl, filename });
          item.localFile = `output/media/${filename}`;
        }
      }

      writeFileSync(`output/pages/${safeCode}.json`, JSON.stringify(output, null, 2));

      log.processed.push({ url: output.sourceUrl, shortcode });
      console.log(`  Media items: ${output.media.length}, Tags: ${output.tags.length}`);
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
      log.failed.push({ shortcode, error: e.message });
    }

    if (i < postsToProcess.length - 1) await sleep(delay);
  }

  await page.close();
  await browser.disconnect();

  // Download all media (parallel with concurrency limit)
  if (!skipMedia && allMediaUrls.length > 0) {
    const CONCURRENCY = 8;
    console.log(`\nDownloading ${allMediaUrls.length} media files (${CONCURRENCY} concurrent)...`);
    let idx = 0;

    async function downloadWorker() {
      while (idx < allMediaUrls.length) {
        const i = idx++;
        const { url, filename } = allMediaUrls[i];
        const dest = `output/media/${filename}`;
        try {
          await downloadFile(url, dest);
          log.mediaDownloaded.push({ url, file: dest });
          process.stdout.write('.');
        } catch (e) {
          log.failed.push({ url, error: `Media download: ${e.message}` });
          process.stdout.write('x');
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => downloadWorker()));
    console.log('');
  } else if (skipMedia) {
    console.log('\nSkipping media download (--skip-media)');
  }

  writeFileSync('output/extraction-log.json', JSON.stringify(log, null, 2));
  console.log(`\nDone.`);
  console.log(`  Posts extracted: ${log.processed.length}`);
  console.log(`  Media downloaded: ${log.mediaDownloaded.length}`);
  console.log(`  Failures: ${log.failed.length}`);
  if (log.failed.length) console.log('  See output/extraction-log.json for details');
}

main().catch(e => { console.error(e); process.exit(1); });
