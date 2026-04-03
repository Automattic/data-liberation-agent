#!/usr/bin/env node
/**
 * import.js — Step 3: Import extracted content to WordPress.com
 *
 * Reads output/ from extract.js and publishes to WordPress.com via REST API.
 * Import order: media → pages → posts → menus
 *
 * Usage:
 *   node scripts/import.js --site mysite.wordpress.com --token APP_PASSWORD
 *   node scripts/import.js --site mysite.wordpress.com --token APP_PASSWORD --dry-run
 *   node scripts/import.js --site mysite.com --user admin --token APP_PASSWORD --self-hosted
 *
 * Options:
 *   --site <domain>    WordPress site domain (e.g. mysite.wordpress.com)
 *   --token <token>    Application password
 *   --user <username>  WordPress username (required for --self-hosted, default: "wix-escape" for WP.com)
 *   --self-hosted      Use direct WP REST API instead of WordPress.com proxy
 *   --dry-run          Show what would be imported without actually doing it
 *   --only <type>      Only import 'media', 'pages', or 'posts'
 *
 * Getting your application password:
 *   WordPress.com: wordpress.com/me/security/application-passwords
 *   Self-hosted/Atomic: WP Admin > Users > Profile > Application Passwords
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { createReadStream } from 'fs';
import { basename } from 'path';

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

const site = getArg('--site');
const token = getArg('--token');
const user = getArg('--user');
const selfHosted = args.includes('--self-hosted');
const dryRun = args.includes('--dry-run');
const only = getArg('--only');

if (!site || !token) {
  console.error('Usage: node scripts/import.js --site <wordpress-site> --token <app-password>');
  console.error('  WordPress.com:  node scripts/import.js --site mysite.wordpress.com --token APP_PASSWORD');
  console.error('  Self-hosted:    node scripts/import.js --site mysite.com --user admin --token APP_PASSWORD --self-hosted');
  process.exit(1);
}

if (selfHosted && !user) {
  console.error('--self-hosted requires --user <username>');
  process.exit(1);
}

const apiBase = selfHosted
  ? `https://${site}/wp-json/wp/v2`
  : `https://public-api.wordpress.com/wp/v2/sites/${site}`;
const authUser = user || 'wix-escape';
const authHeader = `Basic ${Buffer.from(`${authUser}:${token}`).toString('base64')}`;

async function wpRequest(method, endpoint, body, isFormData = false) {
  const headers = { Authorization: authHeader };
  if (!isFormData) headers['Content-Type'] = 'application/json';

  const options = { method, headers };
  if (body) options.body = isFormData ? body : JSON.stringify(body);

  const res = await fetch(`${apiBase}${endpoint}`, options);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`${method} ${endpoint} → ${res.status}: ${data.message || JSON.stringify(data)}`);
  }
  return data;
}

// Extract clean text content from accessibility tree nodes
function buildContentFromAccessibility(nodes) {
  if (!nodes?.length) return '';
  const blocks = [];
  for (const node of nodes) {
    if (!node.name) continue;
    if (node.role === 'heading') {
      // Guess heading level from name length (crude but works as fallback)
      blocks.push(`<h2>${node.name}</h2>`);
    } else if (['paragraph', 'StaticText', 'article', 'section'].includes(node.role)) {
      blocks.push(`<p>${node.name}</p>`);
    } else if (node.role === 'img' && node.description) {
      blocks.push(`<!-- image: ${node.description} -->`);
    }
  }
  return blocks.join('\n');
}

// Extract the best available content from a page JSON file
function extractContent(pageData) {
  // Platform-specific content field (e.g. Substack stores HTML directly)
  if (pageData.content?.html) return pageData.content.html;

  // Priority: Wix blog API response > JSON-LD > accessibility tree
  for (const call of pageData.apiCalls || []) {
    // Blog post body is typically in post.content or post.richContent
    const body = call.data?.post?.content?.plainText ||
                 call.data?.post?.richContent ||
                 call.data?.content?.plainText;
    if (body) return typeof body === 'string' ? `<p>${body}</p>` : JSON.stringify(body);
  }

  // JSON-LD article body
  const article = pageData.globals?.jsonLd?.find(j => j['@type'] === 'Article' || j['@type'] === 'BlogPosting');
  if (article?.articleBody) return `<p>${article.articleBody}</p>`;

  // Fallback to accessibility tree
  return buildContentFromAccessibility(pageData.accessibility);
}

function extractMeta(pageData) {
  const meta = pageData.globals?.meta || {};
  const jsonLd = pageData.globals?.jsonLd || [];
  const article = jsonLd.find(j => ['Article', 'BlogPosting', 'WebPage'].includes(j['@type']));

  return {
    title: meta.ogTitle || meta.title || article?.headline || pageData.slug,
    description: meta.description || meta.ogDescription || article?.description || '',
    featuredImageUrl: meta.ogImage || article?.image?.url || null,
    publishDate: article?.datePublished || null,
    modifiedDate: article?.dateModified || null,
    slug: pageData.slug,
  };
}

async function uploadMedia(filePath, filename) {
  if (dryRun) {
    console.log(`  [dry-run] Would upload: ${filename}`);
    return { id: 0, source_url: `https://example.com/wp-content/uploads/${filename}` };
  }

  const fileBuffer = readFileSync(filePath);
  const ext = filename.split('.').pop().toLowerCase();
  const mimeTypes = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  };

  const res = await fetch(`${apiBase}/media`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
    },
    body: fileBuffer,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Media upload failed: ${err.message || res.status}`);
  }
  return res.json();
}

async function importMedia() {
  if (!existsSync('output/media')) { console.log('No media folder found.'); return {}; }

  const files = readdirSync('output/media');
  console.log(`\nUploading ${files.length} media files...`);

  const mediaMap = {}; // original filename → WP media URL
  for (const file of files) {
    process.stdout.write(`  ${file}... `);
    try {
      const result = await uploadMedia(`output/media/${file}`, file);
      mediaMap[file] = result.source_url;
      console.log(`✓ ${result.source_url}`);
    } catch (e) {
      console.log(`✗ ${e.message}`);
    }
  }
  return mediaMap;
}

// Replace image URLs in content with uploaded WordPress media URLs
function replaceImageUrls(content, mediaMap) {
  let result = content;

  // First pass: replace full CDN wrapper URLs (must run before filename replacement)
  // CDN format: https://substackcdn.com/image/fetch/<params>/https%3A%2F%2Fsubstack-post-media.../<filename>
  result = result.replace(
    /https:\/\/substackcdn\.com\/image\/fetch\/[^"'\s>]+/g,
    (cdnUrl) => {
      for (const [filename, wpUrl] of Object.entries(mediaMap)) {
        if (cdnUrl.includes(filename) || cdnUrl.includes(encodeURIComponent(filename))) {
          return wpUrl;
        }
      }
      return cdnUrl;
    }
  );

  // Second pass: replace direct S3 URLs
  result = result.replace(
    /https:\/\/substack-post-media\.s3\.amazonaws\.com\/[^"'\s>]+/g,
    (s3Url) => {
      for (const [filename, wpUrl] of Object.entries(mediaMap)) {
        if (s3Url.includes(filename)) {
          return wpUrl;
        }
      }
      return s3Url;
    }
  );

  // Third pass: replace remaining bare filenames (Wix-style and other platforms)
  for (const [filename, wpUrl] of Object.entries(mediaMap)) {
    result = result.replaceAll(filename, wpUrl);
  }

  return result;
}

async function importPage(pageData, mediaMap) {
  const meta = extractMeta(pageData);
  let content = extractContent(pageData);

  content = replaceImageUrls(content, mediaMap);

  const body = {
    title: meta.title,
    content,
    excerpt: meta.description,
    slug: meta.slug,
    status: 'draft', // Start as draft — user publishes manually after review
  };

  if (dryRun) {
    console.log(`  [dry-run] Would create page: ${meta.title} (${meta.slug})`);
    return { id: 0, link: '#' };
  }

  return wpRequest('POST', '/pages', body);
}

async function importPost(pageData, mediaMap) {
  const meta = extractMeta(pageData);
  let content = extractContent(pageData);

  content = replaceImageUrls(content, mediaMap);

  const body = {
    title: meta.title,
    content,
    excerpt: meta.description,
    slug: meta.slug,
    status: 'draft',
    date: meta.publishDate || undefined,
    modified: meta.modifiedDate || undefined,
  };

  if (dryRun) {
    console.log(`  [dry-run] Would create post: ${meta.title} (${meta.slug})`);
    return { id: 0, link: '#' };
  }

  return wpRequest('POST', '/posts', body);
}

async function main() {
  if (dryRun) console.log('[DRY RUN — no changes will be made]\n');

  if (!existsSync('output/pages')) {
    console.error('No output/pages directory found. Run extract.js first.');
    process.exit(1);
  }

  const pageFiles = readdirSync('output/pages').filter(f => f.endsWith('.json'));
  console.log(`Found ${pageFiles.length} extracted pages`);

  // Determine content type from inventory if available
  let typeMap = {};
  if (existsSync('output/inventory.json')) {
    const inventory = JSON.parse(readFileSync('output/inventory.json', 'utf8'));
    for (const item of inventory.urls) {
      const slug = new URL(item.url).pathname.replace(/^\//, '').replace(/\//g, '--') || 'homepage';
      typeMap[slug] = item.type;
    }
  }

  const urlMap = []; // old URL → new WP URL, for redirect map

  // Step 1: Upload media
  let mediaMap = {};
  if (!only || only === 'media') {
    mediaMap = await importMedia();
  }

  // Step 2: Import pages
  const pages = pageFiles.filter(f => {
    const slug = f.replace('.json', '');
    return !typeMap[slug] || typeMap[slug] === 'page' || typeMap[slug] === 'homepage';
  });

  if (!only || only === 'pages') {
    console.log(`\nImporting ${pages.length} pages...`);
    for (const file of pages) {
      const pageData = JSON.parse(readFileSync(`output/pages/${file}`, 'utf8'));
      const slug = file.replace('.json', '');
      process.stdout.write(`  ${slug}... `);
      try {
        const result = await importPage(pageData, mediaMap);
        console.log(`✓ ${result.link}`);
        if (pageData.sourceUrl) urlMap.push({ old: pageData.sourceUrl, new: result.link });
      } catch (e) {
        console.log(`✗ ${e.message}`);
      }
    }
  }

  // Step 3: Import posts
  const posts = pageFiles.filter(f => {
    const slug = f.replace('.json', '');
    const type = typeMap[slug];
    return type === 'blog-post' || type === 'post' || type === 'paid-post' || type === 'podcast' || type === 'thread' || type === 'video';
  });

  if (!only || only === 'posts') {
    console.log(`\nImporting ${posts.length} blog posts...`);
    for (const file of posts) {
      const pageData = JSON.parse(readFileSync(`output/pages/${file}`, 'utf8'));
      const slug = file.replace('.json', '');
      process.stdout.write(`  ${slug}... `);
      try {
        const result = await importPost(pageData, mediaMap);
        console.log(`✓ ${result.link}`);
        if (pageData.sourceUrl) urlMap.push({ old: pageData.sourceUrl, new: result.link });
      } catch (e) {
        console.log(`✗ ${e.message}`);
      }
    }
  }

  // Output redirect map
  if (urlMap.length) {
    const { writeFileSync } = await import('fs');
    writeFileSync('output/redirect-map.json', JSON.stringify(urlMap, null, 2));
    console.log(`\nRedirect map written to output/redirect-map.json`);
    console.log('Use this to set up 301 redirects from your old Wix URLs to WordPress.');
  }

  console.log('\nImport complete. All content created as drafts — review in WordPress admin before publishing.');
  console.log(`https://${site}/wp-admin/`);
}

main().catch(e => { console.error(e); process.exit(1); });
