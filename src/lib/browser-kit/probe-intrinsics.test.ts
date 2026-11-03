import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { captureScreenshots } from '../screenshot/screenshotter.js';
import { createReferenceCollector, type FidelityReference } from '../fidelity/reference.js';
import { chromium, type Browser } from 'playwright';
import { createSourceContext } from './source-identity.js';
import { learnAndApplyFluidGeometry } from '../screenshot/fluid-capture.js';
import { captureNativeViewTimelines } from '../screenshot/native-view-timelines.js';

let browser: Browser;
let server: Server;
let url: string;
beforeAll(async () => {
  browser = await chromium.launch();
  server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(readFileSync(new URL('../screenshot/fixtures/clobbered-builtins.html', import.meta.url)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });

// One real fluid sweep (~2s). No source globals are repaired by the probe.
it('protects page, locator and retained-handle probes across navigation', async () => {
  const context = await createSourceContext(browser);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url);
    expect(await page.evaluate(() => typeof window.Number.parseFloat)).toBe('undefined');
    expect(await page.evaluate(() => Number.parseFloat('12.5'))).toBe(12.5);
    expect(await page.evaluate(() => JSON.stringify(Object.keys({ a: 1 })))).toBe('["a"]');
    expect(await page.evaluate(() => Array.from([1, 2]).filter(Number.isFinite))).toEqual([1, 2]);
    expect(await page.evaluate('Math.max(parseFloat("3.5"), 2)')).toBe(3.5);
    expect(await page.locator('.box').evaluate(node => Number.parseFloat(getComputedStyle(node).paddingLeft))).toBeGreaterThan(0);
    const handle = await page.evaluateHandle(() => ({ value: () => Number.parseFloat('8.5') }));
    expect(await handle.evaluate(state => state.value() + Number.parseFloat('1'))).toBe(9.5);
    await handle.dispose();
    const result = await learnAndApplyFluidGeometry(page, { settleMs: 10 });
    expect(result).toBeDefined();
    expect(result.sampledWidths.length).toBeGreaterThan(0);
    expect(result.applied).toBeGreaterThan(0);
    const timelines = await captureNativeViewTimelines(page, 'desktop');
    expect(timelines.failures).toEqual([]);
    expect(await page.locator('.box > div').evaluateAll(nodes => nodes.map(node => Number.isFinite(node.getBoundingClientRect().width)))).toEqual([true, true, true]);
    await page.goto(url + '/next');
    expect(await page.evaluate(() => Number.isFinite(Number.parseFloat('1')))).toBe(true);
    expect(await page.evaluate(() => window.Number.name)).toBe('Number');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 30_000);

// One route with frozen reference evidence (~15s), exercising production wiring.
it('captures the fixture without probe errors or unready reference cells', async () => {
  mkdirSync('.tmp-test', { recursive: true });
  const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'clobbered-builtins-'));
  try {
    const collector = createReferenceCollector(outputDir, url, [url]);
    const result = await captureScreenshots({ urls: [url], outputDir, concurrency: 1, captureImages: false, deviceMode: 'reflow-only',
      observeSource: (...args) => collector.observe(...args),
    });
    const receipt = join(outputDir, 'receipt.json');
    writeFileSync(receipt, JSON.stringify({ routes: [] }));
    const reference = JSON.parse(readFileSync(collector.finalize(receipt), 'utf8')) as FidelityReference;
    expect(reference.entries).toHaveLength(3);
    expect(reference.entries.map(entry => entry.readiness)).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ ready: true, reasons: [] })));
    const manifest = readFileSync(join(outputDir, 'screenshots/manifest.json'), 'utf8');
    expect(result.failed, manifest).toBe(0);
    expect(manifest).not.toMatch(/not a function|fluid learning failed|Capture probe evaluation/);
  } finally { rmSync(outputDir, { recursive: true, force: true }); }
}, 60_000);
