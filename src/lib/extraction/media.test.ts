import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { sanitizeMediaFilename, deriveFilenameFromUrl, downloadMedia } from './media.js';
import { Readable } from 'stream';

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
