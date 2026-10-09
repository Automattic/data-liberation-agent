import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { hydrateDisclosureContent } from './dynamic-content.js';
import { captureTriggeredDialogs } from './interaction-capture.js';
import { captureScreenshots } from './screenshotter.js';

const skipBrowser = Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath());

it.skipIf(skipBrowser)('keeps chooser recommendations and pose in the baseline, then observes the chooser after serialization', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    for (const role of ['listbox', 'combobox']) {
      await page.setContent(`<!doctype html><style>body{margin:0}#spacer{height:1000px}#recommendation{height:60px}</style>
        <div id="spacer"></div><div><button id="chooser" type="button" role="${role}" aria-expanded="false">Choose unit</button></div>
        <aside id="recommendation"><button>Use suggested unit</button> <button>Keep current unit</button></aside><p id="content">Editorial content</p>
        <script>chooser.onclick=()=>{
          document.getElementById('recommendation')?.remove();
          const open=chooser.getAttribute('aria-expanded')==='false';
          chooser.setAttribute('aria-expanded',String(open));
          document.getElementById('options')?.remove();
          if(open)document.body.insertAdjacentHTML('beforeend','<div id="options" role="listbox"><div role="option">First unit</div><div role="option">Second unit</div></div>');
        }</script>`);
      await page.evaluate(() => scrollTo(0, 700));
      const snapshot = () => page.evaluate(() => ({
        text: document.body.innerText,
        expanded: document.querySelector('#chooser')!.getAttribute('aria-expanded'),
        recommendation: document.querySelector('#recommendation')?.getBoundingClientRect().toJSON(),
        content: document.querySelector('#content')!.getBoundingClientRect().toJSON(),
        pose: { x: scrollX, y: scrollY },
      }));
      const baseline = await snapshot();
      expect(await page.locator('#recommendation').isVisible()).toBe(true);
      const states = await hydrateDisclosureContent(page);
      expect(await snapshot()).toEqual(baseline);
      expect(states).toEqual([]);
      const serialized = await page.content();
      expect(serialized).toContain('Use suggested unit');
      expect(serialized).toContain('Keep current unit');
      // The menu belongs to the existing later interaction lifecycle. A probe
      // may dismiss the recommendation there, after the baseline is immutable.
      const report = await captureTriggeredDialogs(page, 'https://fixture.test/');
      const chooser = report.states.find(state => state.trigger.id === 'chooser');
      expect(chooser?.status).toBe('captured');
      expect(chooser?.dialog?.html).toContain('First unit');
      expect(serialized).toContain('id="recommendation"');
      expect(errors).toEqual([]);
    }
  } finally { await browser.close(); }
}, 30000);

it.skipIf(skipBrowser)('leaves a destructive unassociated mount unproven instead of returning a serializable baseline', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    for (const local of [false, true]) {
      await page.setContent(`<!doctype html><body><div><button id="opener" type="button" aria-expanded="false">Open choices</button></div>
        <aside id="recommendation">Use suggested unit Keep current unit</aside>
        <script>(()=>{const control=document.getElementById('opener');control.onclick=()=>{
          document.getElementById('recommendation')?.remove();
          const open=control.getAttribute('aria-expanded')==='false';control.setAttribute('aria-expanded',String(open));
          document.getElementById('options')?.remove();
          if(open)${local ? 'control.parentElement' : 'document.body'}.insertAdjacentHTML('beforeend','<div id="options" role="menu"><button role="menuitem">First unit</button></div>');
        };})()</script>`);
      expect(await page.locator('#recommendation').isVisible()).toBe(true);
      await expect(hydrateDisclosureContent(page)).rejects.toThrow('Disclosure baseline restoration unproven');
      expect(await page.locator('#recommendation').count()).toBe(0);
      expect(await page.locator('#opener').getAttribute('aria-expanded')).toBe('false');
      expect(await page.locator('[data-dla-hydrated-disclosure]').count()).toBe(0);
      expect(errors).toEqual([]);
    }
    await page.setContent('<div><button id="inert" type="button" aria-expanded="false">Inert opener</button></div><aside>Kept recommendation</aside>');
    const baseline = await page.content();
    const inert = await hydrateDisclosureContent(page);
    expect(inert).toEqual([expect.objectContaining({ status: 'no-dialog', error: 'No unique locally mounted panel; baseline restoration verified.' })]);
    expect(await page.content()).toBe(baseline);
  } finally { await browser.close(); }
}, 10000);

it.skipIf(skipBrowser)('records unproven hydration in the viewport lifecycle without persisting mutated baseline artifacts', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><body><div><button id="opener" type="button" aria-expanded="false">Open choices</button></div>
      <aside id="recommendation">Use suggested unit Keep current unit</aside>
      <script>const control=document.getElementById('opener');control.onclick=()=>{
        document.getElementById('recommendation')?.remove();
        const open=control.getAttribute('aria-expanded')==='false';control.setAttribute('aria-expanded',String(open));
        document.getElementById('options')?.remove();
        if(open)document.body.insertAdjacentHTML('beforeend','<div id="options" role="menu"><button role="menuitem">First unit</button></div>');
      }</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  mkdirSync('.tmp-test', { recursive: true });
  const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'disclosure-baseline-'));
  try {
    const result = await captureScreenshots({ urls: [url], outputDir, concurrency: 1, settleMs: 0,
      viewports: [{ id: 'desktop', width: 1440, height: 900 }], learnFluid: false });
    expect(result.failed).toBe(1);
    const failures = JSON.parse(readFileSync(join(outputDir, 'screenshots/failures.json'), 'utf8'));
    expect(failures).toEqual([expect.objectContaining({ stage: 'content', error: expect.stringContaining('Disclosure baseline restoration unproven') })]);
    const entry = JSON.parse(readFileSync(result.manifestPath, 'utf8')).entries[url];
    expect(entry.html).toBeUndefined();
    expect(entry.desktop).toBeUndefined();
    expect(entry.sections).toBeUndefined();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(outputDir, { recursive: true, force: true });
  }
}, 30000);
