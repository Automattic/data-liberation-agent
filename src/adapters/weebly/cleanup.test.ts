import { readFile } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySourceCleanup, cleanupPolicy } from '../../lib/source-cleanup.js';
import { weeblyAdapter } from './index.js';

describe.skipIf(process.env.SKIP_BROWSER_TESTS)('Square Online provider-service cleanup', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser.close(); });

  it('removes checkout and chat with evidence while retaining content and a working navigation drawer', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(await readFile('test/fixtures/closed-commerce-drawer.html', 'utf8'));
      const main = await page.locator('main').innerHTML();
      const nav = await page.locator('#nav').evaluate((element) => element.outerHTML);
      expect(await page.locator('.cko').isVisible()).toBe(false);
      expect(await page.locator('.cko img').count()).toBe(5);

      const report = await applySourceCleanup(page, cleanupPolicy(weeblyAdapter.liberation?.cleanupRules));

      expect(await page.locator('.cko.cko--flyover, messages-plugin').count()).toBe(0);
      expect(await page.locator('body').innerHTML()).not.toMatch(/Back to Cart|Secure checkout|role="banner"|fixture-key/);
      expect(await page.locator('main').innerHTML()).toBe(main);
      expect(await page.locator('#nav').evaluate((element) => element.outerHTML)).toBe(nav);
      expect(await page.locator('#nav').isVisible()).toBe(false);
      await page.locator('#toggle').click();
      expect(await page.locator('#nav a').isVisible()).toBe(true);
      expect(await page.locator('#nav a').getAttribute('href')).toBe('/shop');
      expect(report.removed).toBe(2);
      expect(report.records).toEqual([
        expect.objectContaining({ rule: 'square-checkout-flyover', category: 'provider-service', action: 'remove', evidence: expect.stringMatching(/Square.*runtime/) }),
        expect.objectContaining({ rule: 'square-messages-chat', category: 'provider-service', action: 'remove', evidence: expect.stringMatching(/Square.*backend/) }),
      ]);
      expect(report.failures).toEqual([]);
    } finally { await page.close(); }
  });
});
