import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { applySourceCleanup, cleanupPolicy } from '../../lib/source-cleanup.js';
import { capture } from './capture.js';
import { shopifyAdapter } from './index.js';

describe('shopify capture', () => {
  it('declares the app-widget removal selectors', () => {
    expect(capture.removeSelectors).toEqual(
      expect.arrayContaining(['#upCart', '#upCartStickyButton', '[class*="kl-teaser"]']),
    );
  });
  it('is attached to the adapter', () => {
    expect(shopifyAdapter.liberation).toBe(capture);
  });
});

describe.skipIf(process.env.SKIP_BROWSER_TESTS)('Shopify provider-service cleanup', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser.close(); });

  it('removes Inbox chat and Shop Pay cart-sync with shadow roots, keeping owner content', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><html><body>
        <main><h1>Owner storefront</h1><p>Owner product description</p></main>
        <shopify-chat view="chat"></shopify-chat>
        <shop-cart-sync data-instance-id="x"></shop-cart-sync>
        <script>
          document.querySelector('shopify-chat').attachShadow({ mode: 'open' }).innerHTML = '<button part="activator">Chat</button>';
          document.querySelector('shop-cart-sync').attachShadow({ mode: 'open' }).innerHTML = '<iframe hidden></iframe>';
        </script>
      </body></html>`);
      expect(await page.locator('shopify-chat, shop-cart-sync').evaluateAll(
        (elements) => elements.every((element) => element.shadowRoot?.mode === 'open'),
      )).toBe(true);

      const report = await applySourceCleanup(page, cleanupPolicy(shopifyAdapter.liberation?.cleanupRules));

      expect(await page.locator('shopify-chat').count()).toBe(0);
      expect(await page.locator('shop-cart-sync').count()).toBe(0);
      expect(await page.locator('main').innerText()).toBe('Owner storefront\n\nOwner product description');
      expect(report.removed).toBe(2);
      expect(report.records).toHaveLength(2);
      expect(report.records).toEqual([
        expect.objectContaining({ category: 'provider-service', action: 'remove' }),
        expect.objectContaining({ category: 'provider-service', action: 'remove' }),
      ]);
    } finally {
      await page.close();
    }
  });
});
