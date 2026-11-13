import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { expect, it } from 'vitest';
import { CapturedResourceStore, installResourceReplay } from './resource-capture.js';
import { captureCollections } from './collection-capture.js';
import { loadForComparison } from './device-mode-probe.js';
import { createSourceContext } from '../browser-kit/source-identity.js';
import { attributeSourcePhase } from '../browser-kit/source-traffic.js';
import { SourceRequestGovernors } from '../source-request-governor.js';

const skipBrowser = Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath());

// About 5 seconds: exercise the real collection and device loaders, not a full capture.
it.skipIf(skipBrowser)('replays shared assets on collection and device probes while preserving their blockers', async () => {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    const path = req.url!;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === '/') {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><link rel="stylesheet" href="/shared.css"><script src="/shared.js"></script>
        <img src="/shared.svg"><main><section><button onclick="fetch('/mutation',{method:'POST'})">Apply</button>
        <ul><li><a href="/a">Alpha</a></li><li><a href="/b">Beta</a></li></ul></section></main>`);
    } else {
      res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      res.setHeader('content-type', path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript');
      res.end(path.endsWith('.css') ? 'li{min-height:20px}' : path.endsWith('.svg') ? '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' : '/* immutable */');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  mkdirSync('.tmp-test', { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), '.tmp-test', 'probe-replay-'));
  const store = new CapturedResourceStore(dir, origin);
  const governors = new SourceRequestGovernors();
  const browser = await chromium.launch({ headless: true });
  const contexts: BrowserContext[] = [];
  try {
    const context = await createSourceContext(browser, {}, { governors, sourceUrl: origin });
    contexts.push(context);
    const page = await context.newPage();
    store.observe(page);
    await installResourceReplay(page, store);
    attributeSourcePhase(page, 'navigate');
    await page.goto(origin);
    await store.settle(page);
    attributeSourcePhase(context, 'collections');
    const blocked: string[] = [];
    await captureCollections(page, undefined, diagnostic => blocked.push(diagnostic.reason), store);
    expect(blocked).toHaveLength(1);
    expect(hits.has('/mutation')).toBe(false);
    for (const mode of ['check', 'probe'] as const) {
      const loaded = await loadForComparison({ browser, url: origin, desktop: {}, phone: {}, publicUrlsOnly: false, resourceStore: store, governors }, {}, 'desktop', mode, contexts);
      expect(await loaded.page.locator('li').count()).toBe(2);
    }
    for (const asset of ['/shared.css', '/shared.js', '/shared.svg']) expect(hits.get(asset), asset).toBe(1);
    const totals = governors.attribution().origins[0].totals;
    expect(totals['desktop/collections hit']).toBe(3);
    // CSS and JS in both modes; image only in the full probe.
    expect(totals['desktop/device-check hit']).toBe(5);
    expect(totals['desktop/collections not_routed'] ?? 0).toBeLessThanOrEqual(1); // at most the document
    expect(totals['desktop/device-check not_routed'] ?? 0).toBeLessThanOrEqual(2); // at most the documents
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 30_000);
