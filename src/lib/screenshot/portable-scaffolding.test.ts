import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'cheerio';

import { expect } from 'vitest';
import { it } from '../../../test/browser.js';
import { capturePageHtml, captureScreenshots } from './screenshotter.js';
import { cleanPortableScaffolding } from './portable-scaffolding.js';
import { captureBoxTree, type BoxTreeObservation } from './box-tree.js';
import { dismissOverlays } from './page-helpers.js';
import type { ProfileDiagnostic } from './manifest-queue.js';
import { exportWebsiteCapture } from '../capture-export.js';

// One real pipeline pass, expected wall time approximately 10 seconds.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('exports content without dismissed UI, neutral roots or hidden targetless navigation', async ({ serve, newPage }) => {
  const fixture = `<!doctype html><html><head><title>Portable scaffolding</title><style>
    body { margin:0 } main { padding:24px } h1 { margin:0 }
    .consent { position:fixed; bottom:0; left:0; width:100%; background:white; z-index:2000 }
    #click-banner { bottom:100px } #mask { position:fixed; inset:0; background:#0003 }
    #styled-root { padding:12px; background:rgb(240,240,240) }
    #dependent > p { color:rgb(30,40,50) }
    #menu-toggle { display:none } @media (max-width: 767px) { #menu-toggle { display:flex; width:40px; height:40px } }
  </style></head><body><div id="__next"><div id="root"><main><h1>Real heading</h1>
    <p>Real prose stays exactly here.</p><div id="styled-root">Styled content</div>
    <div id="app"><div id="dependent"><p>Selector-dependent content</p></div></div>
    <a id="hidden-top" href="#" style="position:absolute;width:0;height:0;overflow:hidden">Back to top</a>
    <a id="real-link" href="#real-target" style="display:none">Real destination</a><p id="real-target">Target</p>
    <a id="menu-toggle" href="#" role="button" aria-haspopup="menu" aria-expanded="false" aria-label="Open menu"><svg viewBox="0 0 24 24" width="40" height="40"><path d="M4 8h16V6H4z"></path></svg></a>
    <div style="height:1000px">More real content to keep overlays below the page-text threshold.</div>
  </main></div></div>
  <div id="click-banner" class="consent">Cookie preferences <button onclick="this.parentNode.style.display='none'">Accept all</button></div>
  <div id="hide-banner" class="consent">Cookie consent notice without controls</div>
  <dialog id="promo"><h2>Genuine promotional content</h2><p>Keep this dialog content.</p></dialog>
  </body></html>`;
  const { server } = await serve((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(fixture); });

  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  mkdirSync('.tmp-test', { recursive: true });
  const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test/scaffolding-'));

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
    // A targetless link with control semantics hidden only at the capture width stays for its phone rules.
    expect($('#menu-toggle[aria-haspopup="menu"]').length).toBe(1);
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
    // Exercise scored consent, explicit backdrop,
    // genuine promo retention, selector dependencies and live-node identity.
    const probe = await newPage();
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
    const selectorCopy = await newPage({ javaScriptEnabled: false });
    await selectorCopy.setContent(projected);
    expect(await selectorCopy.locator('main p').evaluate(node => getComputedStyle(node).color)).toBe('rgb(10, 20, 30)');
    const source = await newPage();
    const copy = await newPage({ javaScriptEnabled: false });
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

    rmSync(outputDir, { recursive: true, force: true });
  }
}, 90_000);

// #1984: one page, expected wall time under 2 seconds.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('keeps script-rendered fragment links without a target inside a hidden page', async ({ newPage }) => {
  const page = await newPage();
  await page.setContent(`<!doctype html><body><main><h1>Shop</h1></main>
    <section class="page" style="display:none"><div class="card"><div class="name">Alpha</div><div class="price">$150</div></div></section>
    <a id="hidden-top" href="#top" style="position:absolute;width:0;height:0;overflow:hidden">Back to top</a>
    <script>document.querySelectorAll('.name').forEach(n=>{const t=n.textContent;n.innerHTML='';const a=document.createElement('a');a.href='#detail';a.textContent=t.toUpperCase();n.append(a);});</script></body>`);
  const diagnostics: ProfileDiagnostic[] = [];
  const $ = load(await capturePageHtml(page, diagnostics));
  expect($('.name > a[href="#detail"]').text()).toBe('ALPHA');
  expect($('#hidden-top').length).toBe(0);
  expect(diagnostics.filter(item => item.code === 'hidden_navigation_affordance_removed').map(item => item.reason)).toEqual(['a#hidden-top: hidden in-page link without a content target']);
}, 30_000);

// #2042: one page, expected wall time under 3 seconds.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('unwraps only wrappers proven inert, without changing a pixel', async ({ newPage }) => {
  const fixture = `<!doctype html><html><head><style>
    body { margin:0; font:16px/1.4 sans-serif } section { padding:16px }
    .a > .b { color:rgb(200,0,0) }
    .list > :first-child { font-weight:700 }
    .nth > :nth-child(2) { color:rgb(0,120,0) }
    .pad { padding:8px } .bg { background:rgb(240,240,240) }
    @media (max-width:600px) { .narrow { padding:4px } }
  </style></head><body><section>
    <div class="w1"><div class="w2"><div class="w3" style="display:contents"><p class="text">Stacked <span class="sw"><span><em>inline</em></span></span> text</p></div></div></div>
    <div class="a"><div class="childwrap"><p class="b">Child combinator</p></div></div>
    <div class="list"><div class="firstwrap"><p>One</p><p>Two</p></div></div>
    <div class="nth"><p>x</p><div class="nthwrap"><p>y1</p><p>y2</p></div><p>z</p></div>
    <div class="pad"><p>Padded</p></div><div class="bg"><p>Background</p></div>
    <div class="narrow"><p>Narrow padding</p></div>
  </section><section><div class="grouped" role="group"><p>Role</p></div></section></body></html>`;
  const source = await newPage();
  await source.setViewportSize({ width: 1280, height: 800 });
  await source.setContent(fixture);
  const diagnostics: ProfileDiagnostic[] = [];
  const projected = await capturePageHtml(source, diagnostics);
  const $ = load(projected);
  // `.a` itself is inert; its child wrapper is not, because `.a > .b` would then match.
  expect($('.w1, .w2, .w3, .sw, .text span, .a').length).toBe(0);
  expect($('section > p.text > em').text()).toBe('inline');
  for (const kept of ['.childwrap', '.firstwrap', '.nthwrap', '.pad', '.bg', '.grouped', '.narrow']) expect($(kept).length, kept).toBe(1);
  const summary = diagnostics.find(item => item.code === 'inert_wrappers_unwrapped');
  expect(summary?.reason).toMatch(/ 6 unwrapped, 5 kept by proof, .* max depth 9 -> 5$/);
  // The live page is restored, element for element.
  expect(await source.locator('.w1 > .w2 > .w3 > p.text > .sw > span > em').count()).toBe(1);
  const copy = await newPage({ javaScriptEnabled: false });
  await copy.setViewportSize({ width: 1280, height: 800 });
  await copy.setContent(projected);
  expect(Buffer.compare(await copy.screenshot({ fullPage: true }), await source.screenshot({ fullPage: true }))).toBe(0);

  // Box-tree widths observed later see through the wrappers the live page still has.
  let observation: BoxTreeObservation | undefined;
  const stamped = await capturePageHtml(source, [], undefined, observed => { observation = observed; });
  expect(observation && 'unwrapped' in observation ? observation.unwrapped : []).toHaveLength(6);
  const tree = await captureBoxTree(source, stamped, { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 800 } },
    { name: 'desktop', ...(observation as Extract<BoxTreeObservation, { nodes: unknown }>) });
  expect(Object.keys(tree?.viewports ?? {})).toEqual(['desktop', 'mobile']);

  // Exhausted work leaves the remaining candidates in place and says so.
  const limited = await source.evaluate(({ clean }) => {
    (globalThis as typeof globalThis & { __name?: (fn: unknown) => unknown }).__name ??= fn => fn;
    const run = new Function(`return (${clean})`)() as typeof cleanPortableScaffolding;
    const snapshot = document.documentElement.cloneNode(true) as HTMLElement;
    return { findings: run(document, snapshot, { workBudget: 1 }).findings, wrappers: snapshot.querySelectorAll('.w1, .w2, .w3').length };
  }, { clean: cleanPortableScaffolding.toString() });
  expect(limited.wrappers).toBe(3);
  expect(limited.findings.map(finding => finding.code)).toEqual(['inert_wrappers_unwrapped', 'inert_wrapper_budget_exhausted']);
}, 30_000);
