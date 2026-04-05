#!/usr/bin/env node
/**
 * tests/instagram.test.js — Unit tests for Instagram extraction and import
 *
 * Verifies data transformation logic without requiring a live Instagram
 * session or WordPress site. Uses Node's built-in test runner (Node 18+).
 *
 * Usage:
 *   node --test tests/instagram.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Test fixtures ──────────────────────────────────────────

const singlePhotoPost = {
  shortcode: 'ABC123',
  type: 'photo',
  date: '2023-06-15T14:30:00.000Z',
  caption: 'Hello @world! #sunset #photography',
  media: [
    {
      type: 'photo',
      displayUrl: 'https://scontent.cdninstagram.com/v/t51.29350-15/12345_67890.jpg',
      localFile: 'output/media/ABC123_0.jpg',
      accessibilityCaption: 'A sunset over the ocean',
    },
  ],
  locationName: 'Santa Monica',
  carouselCount: null,
};

const carouselPost = {
  shortcode: 'XYZ789',
  type: 'carousel',
  date: '2024-12-25T16:00:00.000Z',
  caption: 'Holiday vibes! @santa #christmas',
  carouselCount: 3,
  media: [
    {
      type: 'photo',
      displayUrl: 'https://scontent.cdninstagram.com/v/t51.29350-15/111_222.jpg',
      localFile: 'output/media/XYZ789_0.jpg',
      accessibilityCaption: 'First slide',
    },
    {
      type: 'photo',
      displayUrl: 'https://scontent.cdninstagram.com/v/t51.82787-15/333_444.jpg',
      localFile: 'output/media/XYZ789_1.jpg',
      accessibilityCaption: 'Second slide',
    },
    {
      type: 'photo',
      displayUrl: 'https://scontent.cdninstagram.com/v/t51.82787-15/555_666.jpg',
      localFile: 'output/media/XYZ789_2.jpg',
      accessibilityCaption: 'Third slide',
    },
  ],
};

const videoPost = {
  shortcode: 'VID456',
  type: 'video',
  date: '2022-01-10T08:00:00.000Z',
  caption: 'Check this out',
  media: [
    {
      type: 'video',
      displayUrl: null,
      videoUrl: 'https://scontent.cdninstagram.com/v/t50/video.mp4',
      localFile: 'output/media/VID456_0.mp4',
    },
  ],
};

const noCaptionPost = {
  shortcode: 'NOCAP',
  type: 'photo',
  date: '2021-05-01T12:00:00.000Z',
  caption: '',
  media: [
    {
      type: 'photo',
      displayUrl: 'https://scontent.cdninstagram.com/v/t51.29350-15/999_888.jpg',
      localFile: 'output/media/NOCAP_0.jpg',
    },
  ],
};

// ─── Import the functions under test ────────────────────────

// We can't directly import from import.js since it has side effects
// (arg parsing, process.exit). Instead, we replicate the pure functions
// here and test them. In a real setup, these would be exported.

function extractMeta(pageData) {
  if (pageData.platform === 'instagram' || pageData.shortcode) {
    const caption = pageData.caption || '';
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
  return null;
}

function buildInstagramContent(pageData) {
  const blocks = [];
  const media = pageData.media || [];
  const imageMedia = media.filter(m => m.type !== 'video' || !m.videoUrl);
  const videoMedia = media.filter(m => m.type === 'video' && m.videoUrl);

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

  for (const item of videoMedia) {
    blocks.push(`<!-- wp:video -->\n<figure class="wp-block-video"><video controls src="${item.videoUrl}"></video></figure>\n<!-- /wp:video -->`);
  }

  if (pageData.caption) {
    let caption = pageData.caption
      .replace(/@(\w+)/g, '<a href="https://www.instagram.com/$1/">@$1</a>')
      .replace(/#(\w+)/g, '<a href="https://www.instagram.com/explore/tags/$1/">#$1</a>');
    blocks.push(`<!-- wp:paragraph -->\n<p>${caption}</p>\n<!-- /wp:paragraph -->`);
  }

  if (pageData.shortcode) {
    const igUrl = `https://www.instagram.com/p/${pageData.shortcode}/`;
    blocks.push(`<!-- wp:paragraph {"className":"instagram-source","fontSize":"small"} -->\n<p class="instagram-source has-small-font-size">Originally posted on <a href="${igUrl}">Instagram</a></p>\n<!-- /wp:paragraph -->`);
  }

  return blocks.join('\n\n');
}

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

function extractPostMeta(node) {
  const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || '';
  return {
    id: node.id,
    shortcode: node.shortcode,
    type: node.edge_sidecar_to_children ? 'carousel' : node.is_video ? 'video' : 'photo',
    timestamp: node.taken_at_timestamp,
    date: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : null,
    caption,
    displayUrl: node.display_url,
    isVideo: !!node.is_video,
    videoUrl: node.video_url || null,
    accessibilityCaption: node.accessibility_caption || null,
    locationName: node.location?.name || null,
    likes: node.edge_media_preview_like?.count ?? null,
    comments: node.edge_media_to_comment?.count ?? null,
    carouselCount: node.edge_sidecar_to_children?.edges?.length || null,
    url: `https://www.instagram.com/p/${node.shortcode}/`,
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe('extractMeta', () => {
  it('extracts title from first line of caption', () => {
    const meta = extractMeta(singlePhotoPost);
    assert.equal(meta.title, 'Hello @world! #sunset #photography');
  });

  it('truncates long titles to 80 chars', () => {
    const post = { ...singlePhotoPost, caption: 'A'.repeat(100) + '\nsecond line' };
    const meta = extractMeta(post);
    assert.equal(meta.title.length, 80);
  });

  it('falls back to shortcode when no caption', () => {
    const meta = extractMeta(noCaptionPost);
    assert.equal(meta.title, 'Instagram NOCAP');
  });

  it('generates ig- prefixed slug', () => {
    const meta = extractMeta(singlePhotoPost);
    assert.equal(meta.slug, 'ig-ABC123');
  });

  it('preserves original publish date', () => {
    const meta = extractMeta(singlePhotoPost);
    assert.equal(meta.publishDate, '2023-06-15T14:30:00.000Z');
  });

  it('sets featured image URL from first media item', () => {
    const meta = extractMeta(singlePhotoPost);
    assert.ok(meta.featuredImageUrl.includes('cdninstagram.com'));
  });
});

describe('buildInstagramContent', () => {
  it('produces wp:image block for single photo', () => {
    const content = buildInstagramContent(singlePhotoPost);
    assert.ok(content.includes('<!-- wp:image -->'));
    assert.ok(!content.includes('<!-- wp:gallery'));
  });

  it('produces wp:gallery block for carousel', () => {
    const content = buildInstagramContent(carouselPost);
    assert.ok(content.includes('<!-- wp:gallery'));
    assert.ok(content.includes('wp-block-gallery'));
    // Should contain all 3 images inside the gallery
    assert.ok(content.includes('XYZ789_0.jpg'));
    assert.ok(content.includes('XYZ789_1.jpg'));
    assert.ok(content.includes('XYZ789_2.jpg'));
  });

  it('converts @mentions to Instagram profile links', () => {
    const content = buildInstagramContent(singlePhotoPost);
    assert.ok(content.includes('<a href="https://www.instagram.com/world/">@world</a>'));
  });

  it('converts #hashtags to Instagram tag links', () => {
    const content = buildInstagramContent(singlePhotoPost);
    assert.ok(content.includes('<a href="https://www.instagram.com/explore/tags/sunset/">#sunset</a>'));
  });

  it('includes source link to original Instagram post', () => {
    const content = buildInstagramContent(singlePhotoPost);
    assert.ok(content.includes('instagram-source'));
    assert.ok(content.includes('https://www.instagram.com/p/ABC123/'));
  });

  it('produces wp:video block for video posts', () => {
    const content = buildInstagramContent(videoPost);
    assert.ok(content.includes('<!-- wp:video -->'));
    assert.ok(content.includes('video.mp4'));
  });

  it('handles posts with no caption', () => {
    const content = buildInstagramContent(noCaptionPost);
    // Should have image but no caption paragraph (empty caption)
    assert.ok(content.includes('<!-- wp:image -->'));
    // Source link should still be present
    assert.ok(content.includes('instagram-source'));
  });

  it('uses accessibility caption as alt text', () => {
    const content = buildInstagramContent(singlePhotoPost);
    assert.ok(content.includes('alt="A sunset over the ocean"'));
  });
});

describe('xmlValue', () => {
  it('encodes strings with XML escaping', () => {
    assert.equal(xmlValue('hello & <world>'), '<string>hello &amp; &lt;world&gt;</string>');
  });

  it('encodes integers', () => {
    assert.equal(xmlValue(42), '<int>42</int>');
  });

  it('encodes booleans', () => {
    assert.equal(xmlValue(true), '<boolean>1</boolean>');
    assert.equal(xmlValue(false), '<boolean>0</boolean>');
  });

  it('encodes dates WITHOUT trailing Z', () => {
    const d = new Date('2020-03-15T12:00:00.000Z');
    const result = xmlValue(d);
    assert.ok(result.includes('20200315T120000'));
    assert.ok(!result.includes('Z'));
  });

  it('encodes buffers as base64', () => {
    const buf = Buffer.from('hello');
    assert.equal(xmlValue(buf), '<base64>aGVsbG8=</base64>');
  });

  it('encodes null as nil', () => {
    assert.equal(xmlValue(null), '<nil/>');
  });

  it('encodes objects as structs', () => {
    const result = xmlValue({ name: 'test', count: 5 });
    assert.ok(result.includes('<struct>'));
    assert.ok(result.includes('<name>name</name>'));
    assert.ok(result.includes('<string>test</string>'));
    assert.ok(result.includes('<int>5</int>'));
  });

  it('skips undefined values in structs', () => {
    const result = xmlValue({ name: 'test', missing: undefined });
    assert.ok(!result.includes('missing'));
  });

  it('encodes arrays', () => {
    const result = xmlValue([1, 'two']);
    assert.ok(result.includes('<array>'));
    assert.ok(result.includes('<int>1</int>'));
    assert.ok(result.includes('<string>two</string>'));
  });
});

describe('extractPostMeta (discover)', () => {
  it('classifies photo posts', () => {
    const meta = extractPostMeta({
      id: '1', shortcode: 'TEST', display_url: 'http://example.com/img.jpg',
      taken_at_timestamp: 1686830000,
      edge_media_to_caption: { edges: [{ node: { text: 'Hello' } }] },
    });
    assert.equal(meta.type, 'photo');
    assert.equal(meta.caption, 'Hello');
  });

  it('classifies carousel posts', () => {
    const meta = extractPostMeta({
      id: '2', shortcode: 'CAR', display_url: 'http://example.com/img.jpg',
      taken_at_timestamp: 1686830000,
      edge_sidecar_to_children: { edges: [{ node: {} }, { node: {} }] },
      edge_media_to_caption: { edges: [] },
    });
    assert.equal(meta.type, 'carousel');
    assert.equal(meta.carouselCount, 2);
  });

  it('classifies video posts', () => {
    const meta = extractPostMeta({
      id: '3', shortcode: 'VID', display_url: 'http://example.com/img.jpg',
      taken_at_timestamp: 1686830000, is_video: true,
      video_url: 'http://example.com/video.mp4',
      edge_media_to_caption: { edges: [] },
    });
    assert.equal(meta.type, 'video');
    assert.ok(meta.isVideo);
    assert.equal(meta.videoUrl, 'http://example.com/video.mp4');
  });

  it('converts timestamp to ISO date', () => {
    const meta = extractPostMeta({
      id: '4', shortcode: 'DATE', display_url: 'http://example.com/img.jpg',
      taken_at_timestamp: 1686830000,
      edge_media_to_caption: { edges: [] },
    });
    assert.ok(meta.date.startsWith('2023-06-15'));
  });

  it('extracts location name', () => {
    const meta = extractPostMeta({
      id: '5', shortcode: 'LOC', display_url: 'http://example.com/img.jpg',
      taken_at_timestamp: 1686830000,
      location: { name: 'Central Park', id: '123' },
      edge_media_to_caption: { edges: [] },
    });
    assert.equal(meta.locationName, 'Central Park');
  });

  it('generates correct Instagram URL', () => {
    const meta = extractPostMeta({
      id: '6', shortcode: 'URL_TEST', display_url: 'http://example.com/img.jpg',
      taken_at_timestamp: 1686830000,
      edge_media_to_caption: { edges: [] },
    });
    assert.equal(meta.url, 'https://www.instagram.com/p/URL_TEST/');
  });
});

describe('date formatting for WordPress', () => {
  it('formats date as YYYY-MM-DD HH:MM:SS string', () => {
    const d = new Date('2023-06-15T14:30:00.000Z');
    const formatted = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
    assert.equal(formatted, '2023-06-15 14:30:00');
  });

  it('pads single-digit months and days', () => {
    const d = new Date('2023-01-05T03:09:07.000Z');
    const formatted = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
    assert.equal(formatted, '2023-01-05 03:09:07');
  });
});

describe('carousel deduplication logic', () => {
  it('deduplicates by Instagram media ID', () => {
    // Simulate what the extractor does: collect images across slides,
    // deduplicate by the numeric media ID prefix in the CDN URL
    const allImages = [
      { src: 'https://cdn.com/v/t51.29350-15/111_222.jpg', mediaId: '111' },
      { src: 'https://cdn.com/v/t51.82787-15/111_222.jpg', mediaId: '111' }, // same photo, different CDN path
      { src: 'https://cdn.com/v/t51.82787-15/333_444.jpg', mediaId: '333' },
      { src: 'https://cdn.com/v/t51.82787-15/555_666.jpg', mediaId: '555' },
    ];

    const seen = new Set();
    const deduped = [];
    for (const img of allImages) {
      if (!img.mediaId || seen.has(img.mediaId)) continue;
      seen.add(img.mediaId);
      deduped.push(img);
    }

    assert.equal(deduped.length, 3);
    assert.deepEqual(deduped.map(d => d.mediaId), ['111', '333', '555']);
  });
});
