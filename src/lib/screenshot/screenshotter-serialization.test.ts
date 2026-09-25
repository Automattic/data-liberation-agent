import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { capturePageHtml } from './screenshotter.js';

describe('capturePageHtml stylesheet serialization', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('preserves linked stylesheet source text and responsive layout', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.setContent(`
      <style data-href="https://cdn.example.test/forms.css">.grid{display:grid;grid-template-columns:repeat(12,1fr)}@media(max-width:500px){.field{grid-column:1 / span 12;width:100%}}</style>
      <form class="grid"><input class="field"></form>
    `);
    const before = await page.locator('.field').evaluate((element) => element.getBoundingClientRect().width);
    const html = await capturePageHtml(page);
    const after = await page.locator('.field').evaluate((element) => element.getBoundingClientRect().width);
    expect(after).toBe(before);
    expect(html).toContain('.grid{display:grid;grid-template-columns:repeat(12,1fr)}@media(max-width:500px){.field{grid-column:1 / span 12;width:100%}}');
    await page.close();
  });

  it('omits empty custom elements that neither paint nor shape layout, and keeps the live page intact', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.setContent(`
      <style>cookie-manager{display:block;width:100px;height:100px}.slot{display:flex;width:100px;height:100px}</style>
      <main><p>a</p><cookie-manager ready="1"></cookie-manager><p>b</p>
      <div class="slot"><cookie-manager ready="2"></cookie-manager></div>
      <text-widget>Hello</text-widget>
      <spacer-box style="display:block;height:40px"></spacer-box><p>c</p>
      <painted-box style="display:block;width:10px;height:10px;background:red;position:absolute"></painted-box>
      <shadow-card style="position:absolute"></shadow-card>
      <svg><font-face></font-face></svg></main>
    `);
    await page.evaluate(() => {
      document.querySelector('shadow-card')!.attachShadow({ mode: 'open' }).innerHTML = '<p style="margin:0">Card</p>';
    });
    const liveBefore = await page.evaluate(() => document.querySelector('main')!.innerHTML);

    const html = await capturePageHtml(page);

    // The first cookie-manager pushes <p>b</p> down, so it shapes layout and stays;
    // the second sits in a parent that keeps its own size, so it is left out.
    expect(html.match(/<cookie-manager/g)).toHaveLength(1);
    expect(html).toContain('<cookie-manager ready="1">');
    expect(html).toContain('<div class="slot"></div>');
    expect(html).toContain('<text-widget>Hello</text-widget>');
    expect(html).toContain('<spacer-box');
    expect(html).toContain('<painted-box');
    expect(html).toContain('<shadow-card');
    expect(html).toContain('<font-face>');
    expect(await page.evaluate(() => document.querySelector('main')!.innerHTML)).toBe(liveBefore);
    await page.close();
  });

  it('writes the loaded image onto a placeholder or density-list src after hydration', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    await page.route('https://cdn.example.test/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: png })
    );
    const placeholder = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    await page.setContent(`<!doctype html><html><body style="height:2400px">
      <picture>
        <source media="(min-width: 0px)" srcset="https://cdn.example.test/item-1.jpg 1x, https://cdn.example.test/item-1-2x.jpg 2x">
        <img id="gallery" alt="Item 1" src="https://cdn.example.test/item-1.jpg 1x, https://cdn.example.test/item-1-2x.jpg 2x">
      </picture>
      <img id="kept" alt="Item 3" src="https://cdn.example.test/kept.jpg">
      <img id="lazy" alt="Item 2" style="margin-top:1800px" src="${placeholder}" data-src="https://cdn.example.test/item-2.jpg">
      <script>
        addEventListener('scroll', () => {
          const image = document.getElementById('lazy');
          if (!image || image.dataset.hydrated) return;
          const picture = document.createElement('picture');
          const source = document.createElement('source');
          source.srcset = image.getAttribute('data-src');
          image.replaceWith(picture);
          picture.append(source, image);
          image.dataset.hydrated = 'true';
        }, { once: true });
      </script>
    </body></html>`);
    await page.evaluate(() => window.scrollTo(0, 2000));
    await page.waitForFunction(() => document.getElementById('lazy')?.dataset.hydrated === 'true');
    await page.locator('#gallery').evaluate((image) => (image instanceof HTMLImageElement ? image.decode().catch(() => undefined) : undefined));

    const html = await capturePageHtml(page);

    expect(html).toMatch(/<img id="gallery"[^>]*src="https:\/\/cdn\.example\.test\/item-1\.jpg"/);
    expect(html).not.toMatch(/<img id="gallery"[^>]*\ssrc="[^"]*\s1x/);
    expect(html).toContain('srcset="https://cdn.example.test/item-1.jpg 1x, https://cdn.example.test/item-1-2x.jpg 2x"');
    expect(html).toContain('src="https://cdn.example.test/item-2.jpg"');
    expect(html).not.toContain('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=');
    expect(html).toContain('src="https://cdn.example.test/kept.jpg"');
    expect(await page.locator('#gallery').getAttribute('src')).toContain('1x,');
    await page.close();
  });
});
