import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { collectBodyFragment, collectStylesheets, collectHeadLinks, collectScripts } from './dom-capture.js';

const FIXTURE = `<!DOCTYPE html><html><head>
  <style>.hero{color:red}</style>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css?family=X">
</head><body class="home dark">
  <header>chrome</header>
  <main><h1>Title</h1><img src="https://src.test/a.png" srcset="https://src.test/a2.png 2x"></main>
  <script src="https://src.test/app.js"></script>
  <script>window.__x = 1;</script>
</body></html>`;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

describe('dom-capture', () => {
  it('serializes the body fragment keeping image URLs', async () => {
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    const frag = await collectBodyFragment(page);
    expect(frag).toContain('https://src.test/a.png');
    expect(frag).toContain('srcset="https://src.test/a2.png 2x"');
    expect(frag).not.toContain('<body');
    await page.close();
  });
  it('collects same-origin stylesheet cssText', async () => {
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    const css = await collectStylesheets(page);
    expect(css).toContain('.hero');
    await page.close();
  });
  it('lists head <link> stylesheet hrefs', async () => {
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    const links = await collectHeadLinks(page);
    expect(links.some((l) => l.includes('fonts.googleapis.com'))).toBe(true);
    await page.close();
  });
  it('lists scripts in order (external src + inline)', async () => {
    const page = await browser.newPage();
    await page.setContent(FIXTURE);
    const scripts = await collectScripts(page);
    expect(scripts.some((s) => s.src && s.src.includes('src.test/app.js'))).toBe(true);
    expect(scripts.some((s) => s.inline && s.inline.includes('__x'))).toBe(true);
    await page.close();
  });
});
