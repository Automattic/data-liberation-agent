import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractGoogleFontCssUrls, selfHostGoogleFonts } from './google-fonts.js';

const FIXTURE_TMP = join(process.cwd(), '.tmp-test');

const CSS2_URL = 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400;900&display=swap';
const GOOGLE_CSS = `
/* latin */
@font-face {
  font-family: 'Fraunces';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/fraunces/v1/abc400.woff2) format('woff2');
}
@font-face {
  font-family: 'Fraunces';
  font-style: normal;
  font-weight: 900;
  src: url(https://fonts.gstatic.com/s/fraunces/v1/abc900.woff2) format('woff2');
}
`;

describe('extractGoogleFontCssUrls', () => {
  it('finds css2 urls in <link> tags and CSS @import', () => {
    const html = `<link rel="stylesheet" href="${CSS2_URL}">`;
    const css = `@import url('${CSS2_URL}'); body { color: red; }`;
    expect(extractGoogleFontCssUrls([html, css])).toEqual([CSS2_URL]); // deduped
  });

  it('returns empty for sources without google fonts', () => {
    expect(extractGoogleFontCssUrls(['<link href="styles.css">', 'body{}'])).toEqual([]);
  });
});

describe('selfHostGoogleFonts', () => {
  it('fetches css, downloads woff2 faces into themeDir, returns LocalFontFaces', async () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const themeDir = mkdtempSync(join(FIXTURE_TMP, 'fonts-'));
    const fetched: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      fetched.push(u);
      if (u.startsWith('https://fonts.googleapis.com')) {
        return new Response(GOOGLE_CSS, { status: 200 });
      }
      return new Response(new Uint8Array([0x77, 0x4f, 0x46, 0x32]), { status: 200 }); // "wOF2"
    }) as typeof fetch;
    try {
      const result = await selfHostGoogleFonts([CSS2_URL], { themeDir, fetchImpl });
      expect(result.errors).toEqual([]);
      expect(result.faces).toHaveLength(2);
      expect(result.faces[0].family).toBe('Fraunces');
      expect(result.faces.map((f) => f.weight).sort()).toEqual(['400', '900']);
      for (const face of result.faces) {
        expect(face.localPath.startsWith('assets/fonts/')).toBe(true);
        expect(existsSync(join(themeDir, face.localPath))).toBe(true);
        expect(readFileSync(join(themeDir, face.localPath)).subarray(0, 4).toString()).toBe('wOF2');
      }
    } finally {
      rmSync(themeDir, { recursive: true, force: true });
    }
  });

  it('collects per-face errors without throwing', async () => {
    mkdirSync(FIXTURE_TMP, { recursive: true });
    const themeDir = mkdtempSync(join(FIXTURE_TMP, 'fonts-err-'));
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://fonts.googleapis.com')) return new Response(GOOGLE_CSS, { status: 200 });
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    try {
      const result = await selfHostGoogleFonts([CSS2_URL], { themeDir, fetchImpl });
      expect(result.faces).toEqual([]);
      expect(result.errors.length).toBe(2);
    } finally {
      rmSync(themeDir, { recursive: true, force: true });
    }
  });
});
