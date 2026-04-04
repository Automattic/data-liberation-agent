#!/usr/bin/env node
/**
 * import.js — Step 3: Import extracted content to WordPress.com
 *
 * Reads output/ from extract.js and publishes to WordPress.com via XML-RPC.
 * Import order: media → pages → posts
 *
 * Uses XML-RPC (wp.uploadFile, wp.newPost) because WordPress.com's REST API
 * does not support write operations with application passwords.
 *
 * Usage:
 *   node scripts/import.js --site mysite.wordpress.com --user your-wpcom-user --token APP_PASSWORD
 *   node scripts/import.js --site mysite.wordpress.com --user your-wpcom-user --token APP_PASSWORD --dry-run
 *
 * Options:
 *   --site <domain>    WordPress.com site domain (e.g. mysite.wordpress.com)
 *   --user <name>      WordPress.com username that owns the application password
 *   --token <token>    Application password from wordpress.com/me/security/application-passwords
 *   --dry-run          Show what would be imported without actually doing it
 *   --only <type>      Only import 'media', 'pages', or 'posts'
 *
 * Getting your application password:
 *   1. Go to wordpress.com/me/security/application-passwords
 *   2. Create a new application password
 *   3. Copy the password and pass it as --token
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { basename } from 'path';

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

const site = getArg('--site');
const token = getArg('--token');
const user = getArg('--user');
const dryRun = args.includes('--dry-run');
const only = getArg('--only');
const postType = getArg('--post-type'); // e.g. 'photo' for a custom post type

if (!site || !token || !user) {
  console.error('Usage: node scripts/import.js --site <wordpress-site> --user <wp-username> --token <app-password>');
  console.error('  Get your app password at: wordpress.com/me/security/application-passwords');
  process.exit(1);
}

const xmlRpcUrl = `https://${site}/xmlrpc.php`;
const restApiBase = `https://public-api.wordpress.com/rest/v1.1/sites/${site}`;

// ─── XML-RPC helpers ────────────────────────────────────────

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlValue(value) {
  if (value == null) return '<nil/>';
  if (Buffer.isBuffer(value)) return `<base64>${value.toString('base64')}</base64>`;
  if (value instanceof Date) {
    // XML-RPC dateTime.iso8601 must NOT include timezone suffix
    const iso = value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
    return `<dateTime.iso8601>${iso}</dateTime.iso8601>`;
  }
  if (typeof value === 'boolean') return `<boolean>${value ? 1 : 0}</boolean>`;
  if (typeof value === 'number') return Number.isInteger(value) ? `<int>${value}</int>` : `<double>${value}</double>`;
  if (Array.isArray(value)) {
    return `<array><data>${value.map(item => `<value>${xmlValue(item)}</value>`).join('')}</data></array>`;
  }
  if (typeof value === 'object') {
    return `<struct>${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => `<member><name>${escapeXml(key)}</name><value>${xmlValue(item)}</value></member>`)
      .join('')}</struct>`;
  }
  return `<string>${escapeXml(value)}</string>`;
}

function parseXmlRpcResponse(xml) {
  const faultMatch = xml.match(/<fault>[\s\S]*?<name>faultString<\/name>\s*<value><string>([\s\S]*?)<\/string><\/value>[\s\S]*?<\/fault>/);
  if (faultMatch) throw new Error(faultMatch[1]);

  const struct = {};
  const namedStringRegex = /<name>([^<]+)<\/name>\s*<value><string>([\s\S]*?)<\/string><\/value>/g;
  const namedIntRegex = /<name>([^<]+)<\/name>\s*<value><(?:int|i4)>([\s\S]*?)<\/(?:int|i4)><\/value>/g;
  let member;
  while ((member = namedStringRegex.exec(xml))) struct[member[1]] = member[2];
  while ((member = namedIntRegex.exec(xml))) struct[member[1]] = Number(member[2]);
  if (Object.keys(struct).length) return struct;

  const stringMatch = xml.match(/<string>([\s\S]*?)<\/string>/);
  if (stringMatch) return stringMatch[1];
  const intMatch = xml.match(/<(?:int|i4)>([\s\S]*?)<\/(?:int|i4)>/);
  if (intMatch) return Number(intMatch[1]);

  return null;
}

async function xmlRpcCall(methodName, params) {
  const body = `<?xml version="1.0"?><methodCall><methodName>${methodName}</methodName><params>${params
    .map(param => `<param><value>${xmlValue(param)}</value></param>`)
    .join('')}</params></methodCall>`;

  const res = await fetch(xmlRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${methodName} → ${res.status}: ${text}`);
  return parseXmlRpcResponse(text);
}

let cachedBlogId = null;
async function getBlogId() {
  if (cachedBlogId) return cachedBlogId;
  const res = await fetch(restApiBase);
  const data = await res.json().catch(() => ({}));
  if (!data.ID) throw new Error(`Could not determine site ID for ${site}`);
  cachedBlogId = data.ID;
  return cachedBlogId;
}

function guessMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const types = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime' };
  return types[ext] || 'application/octet-stream';
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
  // Instagram posts — caption is the content, images are media attachments
  if (pageData.platform === 'instagram' || pageData.shortcode) {
    return buildInstagramContent(pageData);
  }

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

// Build WordPress block content from an Instagram post
function buildInstagramContent(pageData) {
  const blocks = [];
  const media = pageData.media || [];
  const imageMedia = media.filter(m => m.type !== 'video' || !m.videoUrl);
  const videoMedia = media.filter(m => m.type === 'video' && m.videoUrl);

  // Use a gallery block for carousels (multiple images), single image block otherwise
  if (imageMedia.length > 1) {
    const galleryImages = imageMedia.map(item => {
      const src = item.localFile || item.displayUrl;
      if (!src) return '';
      const alt = item.accessibilityCaption || '';
      return `<!-- wp:image -->\n<figure class="wp-block-image"><img src="${src}" alt="${alt.replace(/"/g, '&quot;')}"/></figure>\n<!-- /wp:image -->`;
    }).filter(Boolean);
    blocks.push(`<!-- wp:gallery {"linkTo":"none"} -->\n<figure class="wp-block-gallery has-nested-images columns-default is-cropped">\n${galleryImages.join('\n')}\n</figure>\n<!-- /wp:gallery -->`);
  } else if (imageMedia.length === 1) {
    const item = imageMedia[0];
    const src = item.localFile || item.displayUrl;
    if (src) {
      const alt = item.accessibilityCaption || pageData.caption?.slice(0, 125) || '';
      blocks.push(`<!-- wp:image -->\n<figure class="wp-block-image"><img src="${src}" alt="${alt.replace(/"/g, '&quot;')}"/></figure>\n<!-- /wp:image -->`);
    }
  }

  // Videos as separate blocks (can't go in gallery)
  for (const item of videoMedia) {
    blocks.push(`<!-- wp:video -->\n<figure class="wp-block-video"><video controls src="${item.videoUrl}"></video></figure>\n<!-- /wp:video -->`);
  }

  // Caption as a paragraph
  if (pageData.caption) {
    // Convert @mentions and #hashtags to links
    let caption = pageData.caption
      .replace(/@(\w+)/g, '<a href="https://www.instagram.com/$1/">@$1</a>')
      .replace(/#(\w+)/g, '<a href="https://www.instagram.com/explore/tags/$1/">#$1</a>');
    blocks.push(`<!-- wp:paragraph -->\n<p>${caption}</p>\n<!-- /wp:paragraph -->`);
  }

  // Link to original Instagram post
  if (pageData.shortcode) {
    const igUrl = `https://www.instagram.com/p/${pageData.shortcode}/`;
    blocks.push(`<!-- wp:paragraph {"className":"instagram-source","fontSize":"small"} -->\n<p class="instagram-source has-small-font-size">Originally posted on <a href="${igUrl}">Instagram</a></p>\n<!-- /wp:paragraph -->`);
  }

  return blocks.join('\n\n');
}

function extractMeta(pageData) {
  // Instagram posts
  if (pageData.platform === 'instagram' || pageData.shortcode) {
    const caption = pageData.caption || '';
    // Title: first line of caption, or first 60 chars, or shortcode
    const title = caption.split('\n')[0]?.slice(0, 80) || `Instagram ${pageData.shortcode}`;
    return {
      title,
      description: caption.slice(0, 300),
      featuredImageUrl: pageData.media?.[0]?.displayUrl || null,
      publishDate: pageData.date || null,
      modifiedDate: null,
      slug: `ig-${pageData.shortcode}`,
    };
  }

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
  const blogId = await getBlogId();
  const result = await xmlRpcCall('wp.uploadFile', [
    blogId,
    user,
    token,
    {
      name: filename,
      type: guessMimeType(filename),
      bits: fileBuffer,
      overwrite: true,
    },
  ]);

  return {
    id: result.id || 0,
    source_url: result.url,
  };
}

async function importMedia() {
  if (!existsSync('output/media')) { console.log('No media folder found.'); return {}; }

  const files = readdirSync('output/media');
  console.log(`\nUploading ${files.length} media files...`);

  const mediaMap = {}; // original filename → { url, id }
  for (const file of files) {
    process.stdout.write(`  ${file}... `);
    try {
      const result = await uploadMedia(`output/media/${file}`, file);
      mediaMap[file] = { url: result.source_url, id: result.id };
      console.log(`✓ ${result.source_url}`);
    } catch (e) {
      console.log(`✗ ${e.message}`);
    }
  }
  return mediaMap;
}

async function importPage(pageData, mediaMap) {
  const meta = extractMeta(pageData);
  let content = extractContent(pageData);

  for (const [filename, media] of Object.entries(mediaMap)) {
    const url = typeof media === 'string' ? media : media.url;
    content = content.replaceAll(filename, url);
  }

  if (dryRun) {
    console.log(`  [dry-run] Would create page: ${meta.title} (${meta.slug})`);
    return { id: 0, link: '#' };
  }

  const blogId = await getBlogId();
  const id = await xmlRpcCall('wp.newPost', [
    blogId, user, token,
    {
      post_type: 'page',
      post_status: 'draft',
      post_title: meta.title,
      post_content: content,
      post_excerpt: meta.description,
      wp_slug: meta.slug,
    },
  ]);

  return { id, link: `https://${site}/wp-admin/post.php?post=${id}&action=edit` };
}

async function importPost(pageData, mediaMap) {
  const meta = extractMeta(pageData);
  let content = extractContent(pageData);

  // Replace local file paths with uploaded WordPress URLs
  for (const [filename, media] of Object.entries(mediaMap)) {
    const url = typeof media === 'string' ? media : media.url;
    content = content.replaceAll(filename, url);
  }

  if (dryRun) {
    console.log(`  [dry-run] Would create post: ${meta.title} (${meta.slug})`);
    return { id: 0, link: '#' };
  }

  const blogId = await getBlogId();

  // Format date as "YYYY-MM-DD HH:MM:SS" string — WordPress.com ignores
  // dateTime.iso8601 typed values but parses string dates correctly
  let postDate;
  if (meta.publishDate) {
    const d = new Date(meta.publishDate);
    postDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
  }

  // Find featured image: first media item's WordPress media ID
  let featuredImageId;
  if (pageData.media?.[0]?.localFile) {
    const firstMediaFile = basename(pageData.media[0].localFile);
    const mediaEntry = mediaMap[firstMediaFile];
    if (mediaEntry?.id) featuredImageId = mediaEntry.id;
  }

  const postData = {
    post_type: postType || 'post',
    post_status: 'publish',
    post_title: meta.title,
    post_content: content,
    post_excerpt: meta.description,
    wp_slug: meta.slug,
    post_date: postDate,
    post_thumbnail: featuredImageId || undefined,
  };

  const id = await xmlRpcCall('wp.newPost', [blogId, user, token, postData]);

  return { id, link: `https://${site}/wp-admin/post.php?post=${id}&action=edit` };
}

async function main() {
  if (dryRun) console.log('[DRY RUN — no changes will be made]\n');

  if (!existsSync('output/pages')) {
    console.error('No output/pages directory found. Run extract.js first.');
    process.exit(1);
  }

  const pageFiles = readdirSync('output/pages').filter(f => f.endsWith('.json'));
  console.log(`Found ${pageFiles.length} extracted pages`);

  // Detect if this is an Instagram import
  let isInstagram = false;
  if (existsSync('output/inventory.json')) {
    const inventory = JSON.parse(readFileSync('output/inventory.json', 'utf8'));
    isInstagram = inventory.platform === 'instagram';
  }

  // Determine content type from inventory if available
  let typeMap = {};
  if (existsSync('output/inventory.json')) {
    const inventory = JSON.parse(readFileSync('output/inventory.json', 'utf8'));
    for (const item of inventory.urls) {
      if (isInstagram) {
        // Instagram uses shortcodes as filenames
        typeMap[item.shortcode] = item.type || 'photo';
      } else {
        const slug = new URL(item.url).pathname.replace(/^\//, '').replace(/\//g, '--') || 'homepage';
        typeMap[slug] = item.type;
      }
    }
  }

  const urlMap = []; // old URL → new WP URL, for redirect map

  // Step 1: Upload media
  let mediaMap = {};
  if (!only || only === 'media') {
    mediaMap = await importMedia();
  }

  // Instagram: all items are posts (not pages)
  if (isInstagram) {
    console.log(`\nImporting ${pageFiles.length} Instagram posts${postType ? ` as "${postType}"` : ''}...`);
    for (const file of pageFiles) {
      const pageData = JSON.parse(readFileSync(`output/pages/${file}`, 'utf8'));
      const shortcode = file.replace('.json', '');
      process.stdout.write(`  ${shortcode}... `);
      try {
        const result = await importPost(pageData, mediaMap);
        console.log(`✓ ${result.link}`);
        if (pageData.sourceUrl) urlMap.push({ old: pageData.sourceUrl, new: result.link });
      } catch (e) {
        console.log(`✗ ${e.message}`);
      }
    }
  } else {
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
      return typeMap[slug] === 'blog-post';
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
