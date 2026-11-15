import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { CapturedResourceStore } from './resource-capture.js';
import { createSourceContext } from '../browser-kit/source-identity.js';
import { attributeSourceDevice, attributeSourcePhase, attributeSourceReplay } from '../browser-kit/source-traffic.js';
import { SourceRequestGovernors } from '../source-request-governor.js';

const skipBrowser = Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath());

// About 3 seconds: drive the replay/store seam without a full screenshot pipeline.
it.skipIf(skipBrowser)('replays immutable prefetches across routes and identities without exporting speculation', async () => {
  const hits = new Map<string, number>();
  const types = new Map<string, string>();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64');
  const prefetches = Array.from({ length: 12 }, (_, i) => `/cdn/runtime/chunk-${i}.js`);
  const server = createServer((req, res) => {
    const url = req.url!;
    hits.set(url, (hits.get(url) ?? 0) + 1);
    if (url.startsWith('/route-')) {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><meta name="viewport" content="width=device-width">
        <link rel="stylesheet" href="/cdn/theme.css"><script src="/cdn/theme.js"></script>
        <img src="/cdn/shop/files/x.jpg?v=123&width=390" srcset="/cdn/shop/files/x.jpg?v=123&width=390 390w, /cdn/shop/files/x.jpg?v=123&width=768 768w, /cdn/shop/files/x.jpg?v=123&width=1440 1440w" sizes="100vw">
        ${[...prefetches, '/uncached.js'].map(url => `<link rel="prefetch" href="${url}">`).join('')}`);
      return;
    }
    res.setHeader('cache-control', url === '/uncached.js' ? 'no-store' : 'public, max-age=31536000, immutable');
    res.setHeader('vary', url.includes('.jpg') ? 'Accept' : 'Accept-Encoding, Available-Dictionary');
    res.setHeader('content-type', url.includes('.jpg') ? 'image/png' : url.endsWith('.css') ? 'text/css' : 'text/javascript');
    res.end(url.includes('.jpg') ? png : url.endsWith('.css') ? 'img{width:100vw}' : '/* shared asset */');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  mkdirSync('.tmp-test', { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), '.tmp-test', 'prefetch-replay-'));
  const store = new CapturedResourceStore(dir, origin);
  const browser = await chromium.launch({ headless: true });
  const governors = new SourceRequestGovernors();
  try {
    for (let routeIndex = 0; routeIndex < 3; routeIndex++) {
      for (const mobile of [false, true]) {
        const context = await createSourceContext(browser, {
          viewport: { width: mobile ? 390 : 1440, height: 900 },
          userAgent: mobile ? 'Mozilla/5.0 Chrome/130.0.0.0 Mobile' : 'Mozilla/5.0 Chrome/130.0.0.0',
          deviceScaleFactor: 1,
        }, { governors, sourceUrl: origin });
        try {
          const page = await context.newPage();
          store.observe(page);
          attributeSourceDevice(context, mobile ? 'mobile' : 'desktop');
          attributeSourcePhase(page, routeIndex === 0 ? 'navigate' : 'baseline');
          await page.route('**/*', async route => {
            const request = route.request();
            types.set(new URL(request.url()).pathname, request.resourceType());
            const headers = request.headers();
            const replay = request.method() === 'GET' && !headers.range && !headers.authorization
              ? store.getReplayableResponse(request.url(), request.resourceType(), headers, outcome => {
                if (request.resourceType() !== 'document') attributeSourceReplay(context, request, outcome);
              }) : undefined;
            if (replay) await route.fulfill({ path: replay.path, contentType: replay.contentType, headers: replay.headers });
            else await route.fallback();
          });
          // Routing disables Chromium's HTTP cache, just as in capture.
          await page.goto(`${origin}/route-${routeIndex}`);
          for (const width of [390, 768, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            await page.locator('img').evaluate(image => (image as HTMLImageElement).decode());
          }
          await page.waitForLoadState('networkidle');
          await store.settle(page);
        } finally { await context.close(); }
      }
    }
    // A governed context with no replay handler still contributes to the same ledger.
    const unrouted = await createSourceContext(browser, { userAgent: 'Mozilla/5.0 Chrome/130.0.0.0' }, { governors, sourceUrl: origin });
    try {
      attributeSourcePhase(unrouted, 'template-groups');
      const page = await unrouted.newPage();
      await page.goto(`${origin}/not-routed.css`);
      await page.waitForLoadState('networkidle');
      await page.addStyleTag({ url: `${origin}/not-routed.css` });
      await page.waitForLoadState('networkidle');
    } finally { await unrouted.close(); }
    const attribution = governors.attribution();
    const totals = attribution.origins[0].totals;
    console.info('fixture attribution', totals);
    expect(totals['desktop/template-groups not_routed']).toBeGreaterThanOrEqual(2);
    expect(totals['desktop/navigate miss:no_entry']).toBeGreaterThan(0);
    expect(totals['mobile/navigate hit']).toBeGreaterThan(0);
    expect(totals['desktop/baseline hit']).toBeGreaterThan(0);
    expect(totals['mobile/baseline hit']).toBeGreaterThan(0);
    expect(totals['desktop/baseline miss:uncacheable']).toBeGreaterThan(0);
    expect(totals['desktop/navigate not_routed']).toBe(1); // document
    const repeated = attribution.repeatedUrls.find(entry => entry.url === `${origin}/cdn/theme.css`)!;
    expect(repeated.count).toBe(6);
    expect(repeated.phases).toEqual({ 'desktop/navigate': 1, 'mobile/navigate': 1, 'desktop/baseline': 2, 'mobile/baseline': 2 });
    expect(types.get(prefetches[0])).toBe('other');
    console.info('fixture origin hits', Object.fromEntries(hits));
    expect(prefetches.map(url => hits.get(url))).toEqual(prefetches.map(() => 1));
    expect(hits.get('/cdn/theme.css')).toBe(1);
    expect(hits.get('/cdn/theme.js')).toBe(1);
    // Each responsive rendition is legitimately unique, but none is downloaded
    // again on the next route/identity after the first context settles.
    for (const width of [390, 768, 1440]) expect(hits.get(`/cdn/shop/files/x.jpg?v=123&width=${width}`)).toBe(1);
    expect(hits.get('/uncached.js')).toBe(6);
    expect(store.getReplayableResponse(`${origin}${prefetches[0]}`, 'other')).toBeUndefined();
    expect(store.getReplayableResponse(`${origin}/cdn/shop/files/x.jpg?v=123&width=390`, 'image', { accept: 'different' })).toBeUndefined();
    const cacheableHits = [...hits].filter(([url]) => url.startsWith('/cdn/')).reduce((sum, [, count]) => sum + count, 0);
    expect(cacheableHits).toBe(17); // 12 speculative chunks + CSS/JS + 3 image widths
    // A later real script load must still enter the portable manifest.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      store.observe(page);
      await page.goto(`${origin}/route-final`);
      await page.addScriptTag({ url: `${origin}${prefetches[0]}` });
      await store.settle(page);
    } finally { await context.close(); }
    await store.flush();
    const manifest = JSON.parse(readFileSync(join(dir, 'resources/manifest.json'), 'utf8'));
    expect(manifest.resources[`${origin}${prefetches[0]}`]).toBeDefined();
    expect(manifest.resources[`${origin}${prefetches[1]}`]).toBeUndefined();
    expect(manifest.resources[`${origin}/uncached.js`]).toBeUndefined();
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 30_000);
