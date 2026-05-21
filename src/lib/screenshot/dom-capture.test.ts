import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { collectBodyFragment, collectStylesheets, collectHeadLinks, collectScripts, collectBodyAndChrome } from './dom-capture.js';

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

const CHROME_FIXTURE = `<!DOCTYPE html><html><head>
  <style>
    header { display: flex; width: 100%; height: 60px; background: #333; }
    footer { display: block; width: 100%; height: 40px; background: #222; }
  </style>
</head><body style="margin:0">
  <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
  <main><h1>Content</h1><p>Body text</p></main>
  <footer><p>foot &copy; 2025</p></footer>
</body></html>`;

// A fixture with a position:fixed header to verify de-pin behaviour.
const FIXED_CHROME_FIXTURE = `<!DOCTYPE html><html><head>
  <style>
    header { position: fixed; top: 0; left: 0; width: 100%; height: 60px; background: #333; }
    footer { display: block; width: 100%; height: 40px; background: #222; }
  </style>
</head><body style="margin:0;padding-top:60px">
  <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
  <main><h1>Content</h1><p>Body text</p></main>
  <footer><p>foot &copy; 2025</p></footer>
</body></html>`;

describe('collectBodyAndChrome', () => {
  it('extracts header + footer and removes them from the body fragment', async () => {
    const page = await browser.newPage();
    await page.setContent(CHROME_FIXTURE);
    const { bodyFragmentHtml, headerHtml, footerHtml } = await collectBodyAndChrome(page);

    // Header was detected and contains nav link text
    expect(headerHtml).not.toBeNull();
    expect(headerHtml).toContain('Home');

    // Footer was detected and contains footer text
    expect(footerHtml).not.toBeNull();
    expect(footerHtml).toContain('foot');

    // Chrome elements were removed from the body fragment
    expect(bodyFragmentHtml).not.toContain('Home');
    expect(bodyFragmentHtml).not.toContain('foot');

    // Main content is still present
    expect(bodyFragmentHtml).toContain('Content');
    await page.close();
  });

  it('chrome outerHTML contains inline baked styles (display, height) from the fixup pipeline', async () => {
    const page = await browser.newPage();
    await page.setContent(CHROME_FIXTURE);
    const { headerHtml, footerHtml } = await collectBodyAndChrome(page);

    // After bakeComputedLayout the outerHTML should carry inline style attributes
    // with the computed layout values frozen.
    expect(headerHtml).not.toBeNull();
    expect(headerHtml).toMatch(/style=/);
    expect(headerHtml).toMatch(/display:/);
    expect(headerHtml).toMatch(/height:/);

    expect(footerHtml).not.toBeNull();
    expect(footerHtml).toMatch(/style=/);
    expect(footerHtml).toMatch(/display:/);
    await page.close();
  });

  it('chrome outerHTML has position:static for originally-fixed header', async () => {
    const page = await browser.newPage();
    await page.setContent(FIXED_CHROME_FIXTURE);
    const { headerHtml } = await collectBodyAndChrome(page);

    expect(headerHtml).not.toBeNull();
    // The header was position:fixed — the fixup pipeline must have de-pinned it.
    expect(headerHtml).toMatch(/position:\s*static/);
    // Must NOT contain position:fixed after fixup.
    expect(headerHtml).not.toMatch(/position:\s*fixed/);
    await page.close();
  });

  it('returns null chrome when no header/footer elements exist', async () => {
    const page = await browser.newPage();
    await page.setContent('<!DOCTYPE html><html><body><main><p>Only content</p></main></body></html>');
    const { bodyFragmentHtml, headerHtml, footerHtml } = await collectBodyAndChrome(page);
    // No semantic header/footer — chrome should be null (heuristic requires score > 2)
    expect(headerHtml).toBeNull();
    expect(footerHtml).toBeNull();
    expect(bodyFragmentHtml).toContain('Only content');
    await page.close();
  });
});
