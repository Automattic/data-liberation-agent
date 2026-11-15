import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { applySourceCleanup, cleanupPolicy } from '../../lib/source-cleanup.js';
import { godaddyWmAdapter } from './index.js';

it('removes a nested GoDaddy acquisition overlay without discarding its spacer or owner content', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(`<!doctype html><html><head><style>body{margin:0}</style></head><body>
      <div class="site-root"><div id="freemium-ad-12345">
        <div data-freemium-ad="true" style="position:fixed;height:50px">Start for free on GoDaddy</div>
        <div style="height:50px"></div>
      </div><main style="display:flow-root"><h1>Owner site</h1></main></div></body></html>`);
    await applySourceCleanup(page, cleanupPolicy(godaddyWmAdapter.liberation?.cleanupRules));
    expect(await page.locator('[data-freemium-ad]').count()).toBe(0);
    expect(await page.locator('#freemium-ad-12345 > div').count()).toBe(1);
    expect(await page.locator('main').innerText()).toBe('Owner site');
    expect(await page.locator('main').evaluate((element) => element.getBoundingClientRect().top)).toBe(50);
  } finally {
    await browser.close();
  }
});
