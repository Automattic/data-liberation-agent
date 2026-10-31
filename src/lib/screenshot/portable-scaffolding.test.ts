import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'cheerio';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { capturePageHtml, captureScreenshots } from './screenshotter.js';
import { dismissOverlays } from './page-helpers.js';
import type { ProfileDiagnostic } from './manifest-queue.js';
import { exportWebsiteCapture } from '../capture-export.js';

// One real pipeline pass, expected wall time approximately 10 seconds.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('exports content without dismissed UI, neutral roots or hidden targetless navigation', async () => {
  const fixture = `<!doctype html><html><head><title>Portable scaffolding</title><style>
    body { margin:0 } main { padding:24px } h1 { margin:0 }
    .consent { position:fixed; bottom:0; left:0; width:100%; background:white; z-index:2000 }
    #click-banner { bottom:100px } #mask { position:fixed; inset:0; background:#0003 }
    #styled-root { padding:12px; background:rgb(240,240,240) }
    #dependent > p { color:rgb(30,40,50) }
  </style></head><body><div id="__next"><div id="root"><main><h1>Real heading</h1>
    <p>Real prose stays exactly here.</p><div id="styled-root">Styled content</div>
    <div id="app"><div id="dependent"><p>Selector-dependent content</p></div></div>
    <a id="hidden-top" href="#" style="position:absolute;width:0;height:0;overflow:hidden">Back to top</a>
    <a id="real-link" href="#real-target" style="display:none">Real destination</a><p id="real-target">Target</p>
    <div style="height:1000px">More real content to keep overlays below the page-text threshold.</div>
  </main></div></div>
  <div id="click-banner" class="consent">Cookie preferences <button onclick="this.parentNode.style.display='none'">Accept all</button></div>
  <div id="hide-banner" class="consent">Cookie consent notice without controls</div>
  <dialog id="promo"><h2>Genuine promotional content</h2><p>Keep this dialog content.</p></dialog>
  </body></html>`;
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(fixture); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  mkdirSync('.tmp-test', { recursive: true });
  const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test/scaffolding-'));
  const browser = await chromium.launch();
  try {
    const result = await captureScreenshots({ urls: [url], primaryUrl: url, outputDir, concurrency: 1, deviceMode: 'reflow-only' });
    expect(result.failed).toBe(0);
    exportWebsiteCapture({ outputDir, sourceUrl: url, platform: 'default', summary: {
      routesDiscovered: 1, routesCaptured: result.captured, routesSkipped: result.skipped,
      routesFailed: result.failed, durationMs: result.durationMs,
    }, failures: [] });
    const html = readFileSync(join(outputDir, 'website/index.html'), 'utf8');
    const $ = load(html);
    expect($('#click-banner, #hide-banner, #__next, #root, #app, #hidden-top').length).toBe(0);
    expect($('#styled-root').text()).toBe('Styled content');
    expect($('#real-link').length).toBe(1);
    expect($('#promo').text()).toContain('Genuine promotional content');
    const manifest = JSON.parse(readFileSync(join(outputDir, 'screenshots/manifest.json'), 'utf8'));
    const entry = manifest.entries[url];
    expect(entry.dismissed).toEqual(expect.arrayContaining([
      expect.objectContaining({ selector: 'div#click-banner.consent', method: 'close-click' }),
      expect.objectContaining({ selector: 'div#hide-banner.consent', method: 'hide' }),
    ]));
    const evidence = JSON.stringify(entry);
    for (const code of ['dismissed_overlay_removed', 'app_root_unwrapped', 'hidden_navigation_affordance_removed']) expect(evidence).toContain(code);
    for (const id of ['click-banner', 'hide-banner', '__next', 'root', 'app', 'hidden-top']) expect(evidence).toContain(id);
    // Exercise scored consent (classified as takeover), explicit backdrop,
    // genuine promo retention, selector dependencies and live-node identity.
    const probe = await browser.newPage();
    await probe.setContent(`<!doctype html><style>
      #root p, #app p { color: rgb(10,20,30) }
      .modal {position:fixed;inset:20%;z-index:1000;background:white}
      .backdrop {position:fixed;inset:0;background:#0003}
    </style><div id="root"><div id="app"><main><p>Real page content with enough text to remain the primary document, not an overlay.</p></main></div></div>
    <div><div id="cookie-backdrop" class="backdrop"></div><div id="cookie-dialog" class="modal" role="dialog" aria-modal="true">Cookie consent <button onclick="this.parentNode.style.display='none';document.getElementById('cookie-backdrop').style.display='none'">Accept all</button></div></div>
    <div id="offer" class="modal" role="dialog" aria-modal="true"><h2>Seasonal offer</h2><button aria-label="Close" onclick="this.parentNode.style.display='none'">Close</button></div>`);
    const rootIdentity = await probe.locator('#root').elementHandle();
    await dismissOverlays(probe);
    const diagnostics: ProfileDiagnostic[] = [];
    const projected = await capturePageHtml(probe, diagnostics);
    const parsed = load(projected);
    expect(parsed('#cookie-dialog, #cookie-backdrop').length).toBe(0);
    expect(parsed('#offer').text()).toContain('Seasonal offer');
    expect(parsed('#root').length + parsed('#app').length).toBe(1);
    expect(diagnostics.filter(item => item.code === 'dismissed_overlay_removed')).toHaveLength(2);
    expect(await probe.locator('#root').evaluate((node, original) => node === original, rootIdentity)).toBe(true);
    expect(await probe.locator('#root > #app').count()).toBe(1);
    const selectorCopy = await browser.newPage({ javaScriptEnabled: false });
    await selectorCopy.setContent(projected);
    expect(await selectorCopy.locator('main p').evaluate(node => getComputedStyle(node).color)).toBe('rgb(10, 20, 30)');
    const source = await browser.newPage();
    const copy = await browser.newPage({ javaScriptEnabled: false });
    for (const width of [390, 768, 1440]) {
      await source.setViewportSize({ width, height: 900 });
      await copy.setViewportSize({ width, height: 900 });
      await source.setContent(fixture);
      await copy.setContent(html);
      for (const selector of ['h1', 'main > p', '#styled-root', '#dependent p']) {
        expect(await copy.locator(selector).allTextContents()).toEqual(await source.locator(selector).allTextContents());
        expect(await copy.locator(selector).first().boundingBox()).toEqual(await source.locator(selector).first().boundingBox());
      }
    }
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(outputDir, { recursive: true, force: true });
  }
}, 90_000);
