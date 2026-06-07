import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { sanitizeMediaFilename, deriveFilenameFromUrl, downloadMedia, upgradeMediaUrl, isFontUrl } from './media.js';
import { Readable } from 'stream';

describe('isFontUrl', () => {
  it('detects font files by extension (woff2/woff/ttf/otf/eot), with query/fragment', () => {
    expect(isFontUrl('https://static.parastorage.com/fonts/v2/x/madefor-text.woff2')).toBe(true);
    expect(isFontUrl('//static.parastorage.com/fonts/x.woff')).toBe(true);
    expect(isFontUrl('https://cdn/x.ttf?v=2')).toBe(true);
    expect(isFontUrl('https://cdn/x.otf#a')).toBe(true);
  });
  it('detects Wix /ufonts/ paths even when the basename looks generic', () => {
    expect(isFontUrl('https://static.wixstatic.com/ufonts/8fbd8c_abc/woff2/file.woff2')).toBe(true);
  });
  it('is false for images and non-font assets', () => {
    expect(isFontUrl('https://static.wixstatic.com/media/abc~mv2.png/v1/fill/w_10/x.png')).toBe(false);
    expect(isFontUrl('https://cdn/x.jpg')).toBe(false);
    expect(isFontUrl('https://cdn/x.css')).toBe(false);
  });
});

// Build a minimal fetch Response stub that downloadMedia can stream from.
function stubResponse(contentType: string, body = 'fake-image-bytes'): Response {
  const stream = Readable.from([Buffer.from(body)]) as Readable & { cancel?: () => Promise<void> };
  // Real fetch bodies expose a WHATWG ReadableStream with cancel(); the guard
  // calls response.body?.cancel() before bailing on a non-image content-type.
  stream.cancel = async () => { stream.destroy(); };
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    body: stream as unknown as ReadableStream,
  } as unknown as Response;
}

describe('sanitizeMediaFilename', () => {
  it('slugifies spaces and %-encoding, preserves extension', () => {
    expect(sanitizeMediaFilename('logo white_edited.png')).toBe('logo-white_edited.png');
    expect(sanitizeMediaFilename('logo%20white_edited.png')).toBe('logo-white_edited.png');
    expect(sanitizeMediaFilename('Al%20pic.avif')).toBe('Al-pic.avif');
  });
  it('leaves already-safe names unchanged', () => {
    expect(sanitizeMediaFilename('hero-image.jpg')).toBe('hero-image.jpg');
    expect(sanitizeMediaFilename('follow_guidelines.jpg')).toBe('follow_guidelines.jpg');
  });
  it('collapses parens / special chars to single dashes', () => {
    expect(sanitizeMediaFilename('photo (1).JPG')).toBe('photo-1.JPG');
  });
  it('falls back to "image" when the base reduces to nothing', () => {
    expect(sanitizeMediaFilename('%20.png')).toBe('image.png');
  });
});

describe('upgradeMediaUrl', () => {
  it('doubles a Wix fill transform (retina) while preserving aspect, under the cap', () => {
    const u = 'https://static.wixstatic.com/media/abc~mv2.jpg/v1/fill/w_679,h_381,al_c,q_80,enc_avif/x.jpg';
    const up = upgradeMediaUrl(u);
    expect(up).toContain('w_1358');
    expect(up).toContain('h_762');
    // aspect preserved: 1358/762 ≈ 679/381
    expect(Math.round((1358 / 762) * 100)).toBe(Math.round((679 / 381) * 100));
  });
  it('caps the longest edge at 2000 and scales both dimensions by the same factor', () => {
    // longest=1500 -> scale=min(2, 2000/1500)=1.333 -> w=2000, h=1333 (aspect kept)
    const u = 'https://static.wixstatic.com/media/abc~mv2.jpg/v1/fill/w_1500,h_1000,al_c/x.jpg';
    const up = upgradeMediaUrl(u);
    expect(up).toContain('w_2000');
    expect(up).toContain('h_1333');
  });
  it('leaves a URL already at/above the cap unchanged', () => {
    const u = 'https://static.wixstatic.com/media/abc~mv2.jpg/v1/fill/w_2400,h_1200,al_c/x.jpg';
    expect(upgradeMediaUrl(u)).toBe(u);
  });
  it('is a no-op for non-Wix URLs and Wix URLs without a w_/h_ transform', () => {
    expect(upgradeMediaUrl('https://cdn.shopify.com/s/files/1/x_600x400.jpg')).toBe('https://cdn.shopify.com/s/files/1/x_600x400.jpg');
    expect(upgradeMediaUrl('https://static.wixstatic.com/media/abc~mv2.jpg')).toBe('https://static.wixstatic.com/media/abc~mv2.jpg');
  });
  it('scales the FILL output dims, never the /crop/ region coords', () => {
    // The crop segment `w_500,h_160` is a region of the master image — scaling it
    // pushes the crop out of bounds and the CDN returns a garbage fragment. Only
    // the trailing fill output (`w_153,h_49`) may be upscaled for retina.
    const u =
      'https://static.wixstatic.com/media/abc~mv2.png/v1/crop/x_0,y_167,w_500,h_160/fill/w_153,h_49,al_c,q_85,enc_avif/Logo%20(1).png';
    const up = upgradeMediaUrl(u);
    // crop region MUST be untouched
    expect(up).toContain('crop/x_0,y_167,w_500,h_160/');
    // fill output doubled (longest=153, scale=2)
    expect(up).toContain('fill/w_306,h_98,');
    // no out-of-bounds w_1000 anywhere
    expect(up).not.toContain('w_1000');
  });
});

describe('deriveFilenameFromUrl', () => {
  it('derives a safe filename from a Wix transform URL with a spaced name', () => {
    const u = new URL('https://static.wixstatic.com/media/e20b04_hash~mv2.png/v1/fill/w_111,h_48,enc_avif/logo%20white_edited.png');
    expect(deriveFilenameFromUrl(u)).toBe('logo-white_edited.png');
  });
  it('truncates at the Wix /:/ transform marker', () => {
    const u = new URL('https://static.wixstatic.com/media/abc.jpg/:/cr=t:0/file.jpg');
    expect(deriveFilenameFromUrl(u)).toBe('abc.jpg');
  });
});

describe('downloadMedia — extension-less page-builder CDN URLs', () => {
  let tmp: string;
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('derives the extension from content-type for an extension-less URL (Replo)', async () => {
    tmp = mkdtempSync(join(process.cwd(), '.tmp-test-media-'));
    global.fetch = vi.fn(async () => stubResponse('image/png')) as unknown as typeof fetch;
    const res = await downloadMedia(
      'https://assets.replocdn.com/projects/p/4ad58ef3-8bf7-4614-b56e-d08d197fd0e9?width=820',
      tmp,
      new Map(),
    );
    expect(res.error).toBeNull();
    expect(res.filename).toMatch(/\.png$/);
    expect(res.bytes).toBeGreaterThan(0);
  });

  it('rejects an extension-less URL whose content-type is NOT an image', async () => {
    tmp = mkdtempSync(join(process.cwd(), '.tmp-test-media-'));
    global.fetch = vi.fn(async () => stubResponse('text/html', '<html>nope</html>')) as unknown as typeof fetch;
    const res = await downloadMedia('https://assets.replocdn.com/projects/p/redirect', tmp, new Map());
    expect(res.localPath).toBeNull();
    expect(res.error).toMatch(/non-image content-type/);
  });
});

describe('downloadMedia — SSRF + size guards', () => {
  let tmp: string;
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('rejects an internal-host media URL without fetching', async () => {
    tmp = mkdtempSync(join(process.cwd(), '.tmp-test-media-'));
    const spy = vi.fn(async () => stubResponse('image/png'));
    global.fetch = spy as unknown as typeof fetch;
    const res = await downloadMedia('http://169.254.169.254/x.png', tmp, new Map());
    expect(res.localPath).toBeNull();
    expect(res.error).toMatch(/internal|loopback|not allowed/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) scheme media URL', async () => {
    tmp = mkdtempSync(join(process.cwd(), '.tmp-test-media-'));
    global.fetch = vi.fn(async () => stubResponse('image/png')) as unknown as typeof fetch;
    const res = await downloadMedia('file:///etc/passwd', tmp, new Map());
    expect(res.localPath).toBeNull();
    expect(res.error).toMatch(/scheme/i);
  });

  it('aborts an over-size body via Content-Length and leaves no partial file', async () => {
    tmp = mkdtempSync(join(process.cwd(), '.tmp-test-media-'));
    const huge = String(26 * 1024 * 1024); // > 25 MB cap
    global.fetch = vi.fn(async () => {
      const stream = Readable.from([Buffer.from('x')]) as Readable & { cancel?: () => Promise<void> };
      stream.cancel = async () => { stream.destroy(); };
      return {
        ok: true,
        status: 200,
        headers: {
          get: (h: string) => {
            const k = h.toLowerCase();
            if (k === 'content-type') return 'image/png';
            if (k === 'content-length') return huge;
            return null;
          },
        },
        body: stream as unknown as ReadableStream,
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const res = await downloadMedia('https://cdn.example.com/huge.png', tmp, new Map());
    expect(res.localPath).toBeNull();
    expect(res.error).toMatch(/exceeds max/i);
  });
});
