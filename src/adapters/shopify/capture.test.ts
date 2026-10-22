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

  it('removes the shipping estimator and its dedicated disclosure, keeping owner content', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><html><body>
        <main><h1>Owner product</h1><p>Owner product description</p></main>
        <details id="shipping"><summary>Estimate shipping</summary>
          <div class="accordion__content"><shipping-estimator role="form">
            <select aria-label="Country"><option>Canada</option></select>
            <select aria-label="Province"><option>Ontario</option></select>
            <input aria-label="Zip"><button>Calculate</button>
          </shipping-estimator></div>
        </details>
        <details id="owner"><summary>Product details</summary><p>Owner specifications</p></details>
      </body></html>`);

      const report = await applySourceCleanup(page, cleanupPolicy(shopifyAdapter.liberation?.cleanupRules));

      expect(await page.locator('shipping-estimator, #shipping').count()).toBe(0);
      expect(await page.locator('#owner').textContent()).toContain('Owner specifications');
      expect(await page.locator('main').innerText()).toBe('Owner product\n\nOwner product description');
      expect(report.failures).toEqual([]);
      expect(report.removed).toBe(1);
      expect(report.records).toEqual([
        expect.objectContaining({ category: 'provider-service', action: 'remove', selector: '#shipping' }),
      ]);
    } finally {
      await page.close();
    }
  });

  it('keeps mixed disclosures while removing their shipping estimators', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><html><body>
        <details id="mixed"><summary>Shipping information</summary>
          <div class="accordion__content"><p>Owner shipping policy</p><shipping-estimator role="form"></shipping-estimator></div>
        </details>
        <details id="sibling"><summary>Delivery</summary>
          <div class="accordion__content"><shipping-estimator role="form"></shipping-estimator></div>
          <p>Owner delivery information</p>
        </details>
        <details id="direct"><summary>Estimate shipping</summary><shipping-estimator role="form"></shipping-estimator></details>
      </body></html>`);

      const report = await applySourceCleanup(page, cleanupPolicy(shopifyAdapter.liberation?.cleanupRules));

      expect(await page.locator('shipping-estimator, #direct').count()).toBe(0);
      expect(await page.locator('#mixed').textContent()).toContain('Owner shipping policy');
      expect(await page.locator('#sibling').textContent()).toContain('Owner delivery information');
      expect(report.failures).toEqual([]);
    } finally {
      await page.close();
    }
  });

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
