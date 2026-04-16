import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  instagramAdapter,
  parseInstagramUsername,
  captionToHtml,
  extractHashtags,
  buildInstagramPostContent,
  titleFromCaption,
  extractPostMeta,
  type InstagramInventory,
} from '../../src/adapters/instagram.js';
import { WxrBuilder } from '../../src/lib/extraction/wxr-builder.js';
import { ExtractionLog } from '../../src/lib/extraction/extraction-log.js';

describe('instagramAdapter', () => {
  it('has id "instagram"', () => {
    expect(instagramAdapter.id).toBe('instagram');
  });

  it('detects instagram URLs', () => {
    expect(instagramAdapter.detect('https://www.instagram.com/foo')).toBe(true);
    expect(instagramAdapter.detect('https://instagram.com/foo')).toBe(true);
    expect(instagramAdapter.detect('https://www.example.com')).toBe(false);
    expect(instagramAdapter.detect('https://mysite.squarespace.com')).toBe(false);
  });

  it('discover requires cdpPort', async () => {
    await expect(instagramAdapter.discover('https://www.instagram.com/foo', {})).rejects.toThrow(/cdp-port/i);
  });
});

describe('parseInstagramUsername', () => {
  it('extracts username from full URL', () => {
    expect(parseInstagramUsername('https://www.instagram.com/mountaincoffee/')).toBe('mountaincoffee');
  });

  it('strips @ from a bare handle', () => {
    expect(parseInstagramUsername('@mountaincoffee')).toBe('mountaincoffee');
  });

  it('passes through a bare username', () => {
    expect(parseInstagramUsername('mountaincoffee')).toBe('mountaincoffee');
  });
});

describe('captionToHtml', () => {
  it('linkifies hashtags and mentions', () => {
    const html = captionToHtml('Loving #coffee from @baristadaily');
    expect(html).toContain('<a href="https://www.instagram.com/explore/tags/coffee/">#coffee</a>');
    expect(html).toContain('<a href="https://www.instagram.com/baristadaily/">@baristadaily</a>');
  });

  it('escapes HTML in captions', () => {
    expect(captionToHtml('a < b & "c"')).toContain('&lt;');
    expect(captionToHtml('a < b & "c"')).toContain('&amp;');
  });

  it('preserves line breaks as <br />', () => {
    expect(captionToHtml('line1\nline2')).toContain('<br />');
  });
});

describe('extractHashtags', () => {
  it('returns hashtags without the #', () => {
    expect(extractHashtags('one #two #three')).toEqual(['two', 'three']);
  });

  it('returns empty for no caption', () => {
    expect(extractHashtags('')).toEqual([]);
  });
});

describe('titleFromCaption', () => {
  it('uses the first line', () => {
    expect(titleFromCaption('Hello world\nmore', 'ABC')).toBe('Hello world');
  });

  it('truncates long captions', () => {
    const long = 'a'.repeat(200);
    const t = titleFromCaption(long, 'ABC');
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t.endsWith('…')).toBe(true);
  });

  it('falls back to shortcode if caption is empty', () => {
    expect(titleFromCaption('', 'ABC')).toBe('Instagram post ABC');
  });
});

describe('buildInstagramPostContent', () => {
  it('renders a single image as wp:image', () => {
    const html = buildInstagramPostContent({
      type: 'photo',
      caption: 'Hello',
      sourceUrl: 'https://www.instagram.com/p/ABC/',
      media: [{ url: 'https://example.com/photo.jpg', alt: 'A photo' }],
    });
    expect(html).toContain('<!-- wp:image');
    expect(html).toContain('src="https://example.com/photo.jpg"');
    expect(html).toContain('alt="A photo"');
    expect(html).toContain('View on Instagram');
  });

  it('renders carousels as wp:gallery with nested wp:image blocks', () => {
    const html = buildInstagramPostContent({
      type: 'carousel',
      caption: '',
      sourceUrl: 'https://www.instagram.com/p/ABC/',
      media: [
        { url: 'https://example.com/1.jpg', id: 1 },
        { url: 'https://example.com/2.jpg', id: 2 },
      ],
    });
    expect(html).toContain('<!-- wp:gallery');
    expect(html).toContain('"ids":[1,2]');
    expect(html.match(/<!-- wp:image/g)?.length).toBe(2);
  });

  it('renders videos as wp:video', () => {
    const html = buildInstagramPostContent({
      type: 'video',
      caption: '',
      sourceUrl: 'https://www.instagram.com/p/ABC/',
      media: [{ url: 'https://example.com/video.mp4' }],
    });
    expect(html).toContain('<!-- wp:video');
    expect(html).toContain('<video controls src="https://example.com/video.mp4"');
  });
});

describe('extractPostMeta', () => {
  it('classifies a sidecar node as carousel', () => {
    const post = extractPostMeta({
      shortcode: 'ABC',
      __typename: 'GraphSidecar',
      edge_sidecar_to_children: { edges: [{}, {}, {}] },
      taken_at_timestamp: 1700000000,
      edge_media_to_caption: { edges: [{ node: { text: 'hi' } }] },
    });
    expect(post.type).toBe('carousel');
    expect(post.carouselCount).toBe(3);
    expect(post.url).toBe('https://www.instagram.com/p/ABC/');
    expect(post.caption).toBe('hi');
  });

  it('classifies a video node', () => {
    const post = extractPostMeta({ shortcode: 'V', is_video: true, video_url: 'https://x/v.mp4' });
    expect(post.type).toBe('video');
  });
});

describe('Instagram adapter WXR integration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ig-e2e-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('extracts a fixture inventory into a valid WXR (dry run)', async () => {
    const inventory = JSON.parse(
      readFileSync('test/fixtures/instagram-inventory.json', 'utf8')
    ) as InstagramInventory;

    const wxr = new WxrBuilder({
      title: inventory.profile?.fullName || inventory.username,
      url: `https://www.instagram.com/${inventory.username}/`,
      description: inventory.profile?.biography || '',
      language: 'en-US',
    });

    const log = new ExtractionLog(tempDir);

    // dryRun=true skips the browser session entirely and uses inventory media URLs
    const result = (await instagramAdapter.extract(
      inventory,
      wxr,
      { dryRun: true, outputDir: '' },
      // The adapter only calls server.sendLoggingMessage if present — pass a stub.
      { log, server: undefined as never }
    )) as { postsExtracted: number; failed: number };

    expect(result.failed).toBe(0);
    expect(result.postsExtracted).toBe(3);

    const wxrPath = join(tempDir, 'output.wxr');
    const { validation } = wxr.serialize(wxrPath);
    expect(existsSync(wxrPath)).toBe(true);
    expect(validation.valid).toBe(true);

    const xml = readFileSync(wxrPath, 'utf8');
    expect(xml).toContain('<wp:wxr_version>1.2</wp:wxr_version>');
    // All three posts present
    expect(xml).toContain('<wp:post_name>cabc123</wp:post_name>');
    expect(xml).toContain('<wp:post_name>cdef456</wp:post_name>');
    expect(xml).toContain('<wp:post_name>cghi789</wp:post_name>');
    // Hashtags as tags
    expect(xml).toContain('coffee');
    expect(xml).toContain('colombia');
    // Source links back to Instagram
    expect(xml).toContain('View on Instagram');
  });
});
