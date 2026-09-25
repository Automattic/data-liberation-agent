import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { lockMainFrameNavigation } from './screenshotter.js';

// A probe can trigger a script-driven navigation (a swatch assigning
// `location`) that no click handler can cancel. While locked, the document and
// its in-page capture evidence must survive; once released, navigation works.
describe('lockMainFrameNavigation', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it('keeps the current document when a script navigates away', async () => {
    const page = await browser.newPage();
    await page.route('https://shop.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p>Product page</p>' }));
    await page.goto('https://shop.test/');
    await page.evaluate(() => { (window as unknown as { evidence: boolean }).evidence = true; });

    const release = await lockMainFrameNavigation(page);
    await page.evaluate(() => { location.assign('/products/cat?variant=1'); });
    await page.waitForTimeout(300);

    expect(page.url()).toBe('https://shop.test/');
    expect(await page.evaluate(() => (window as unknown as { evidence?: boolean }).evidence)).toBe(true);

    await release();
    await page.evaluate(() => { location.assign('/products/cat'); });
    await page.waitForURL('https://shop.test/products/cat');
    await page.close();
  });
});
