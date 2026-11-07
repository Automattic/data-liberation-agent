import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from '../screenshot/screenshotter.js';
import { sourceRequestContext } from '../source-request-governor.js';
import { downloadMedia } from '../media-fetch/media.js';
import { runWithTrustedOrigins } from '../media-fetch/safe-fetch.js';
import { SourceRequestGovernors } from '../source-request-governor.js';

const skipBrowser = Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath());

// One browser capture per behavior, approximately 15 seconds total on a warm machine.
// Valid uncompressed 1024² BMP: 3 MiB per image, no fixture generator needed.
const image = Buffer.alloc(54 + 1024 * 1024 * 3, 80);
image.write('BM');
image.writeUInt32LE(image.length, 2);
image.fill(0, 6, 54);
image.writeUInt32LE(54, 10);
image.writeUInt32LE(40, 14);
image.writeInt32LE(1024, 18);
image.writeInt32LE(1024, 22);
image.writeUInt16LE(1, 26);
image.writeUInt16LE(24, 28);
const video = readFileSync(new URL('./fixtures/source-traffic.webm', import.meta.url));
it.skipIf(skipBrowser)('captures all routes through a resetting origin and leaves healthy fan-out uncapped', async () => {
  const modes = process.env.SOURCE_TRAFFIC_HEALTHY === undefined ? [true, false] : [process.env.SOURCE_TRAFFIC_HEALTHY === '1'];
  for (const healthy of modes) {
    let active = 0;
    let peak = 0;
    let resets = 0;
    let navigationReset = false;
    let rangeRequests = 0;
    let imageBytes = 0;
    const server = createServer((req, res) => {
      peak = Math.max(peak, ++active);
      res.once('close', () => active--);
      const resetNavigation = !navigationReset && req.url === '/page-2';
      if (!healthy && (active > 6 || resetNavigation)) {
        if (resetNavigation) navigationReset = true;
        resets++;
        req.socket.resetAndDestroy();
        return;
      }
      setTimeout(() => {
        if (req.url?.startsWith('/image')) {
          imageBytes += image.length;
          res.writeHead(200, { 'content-type': 'image/bmp', 'content-length': image.length });
          res.end(image);
        } else if (req.url === '/video.webm') {
          const start = Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] ?? 0);
          if (req.headers.range) rangeRequests++;
          res.writeHead(req.headers.range ? 206 : 200, {
            'content-type': 'video/webm', 'accept-ranges': 'bytes',
            'content-length': video.length - start,
            ...(req.headers.range ? { 'content-range': `bytes ${start}-${video.length - 1}/${video.length}` } : {}),
          });
          res.end(video.subarray(start));
        } else if (req.url?.startsWith('/asset')) {
          res.writeHead(200, { 'content-type': 'text/css' });
          res.end('h1 { color: rgb(0, 70, 0) }');
        } else {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(`<!doctype html><title>Local fixture</title>${Array.from({ length: 12 }, (_, i) => `<link rel="stylesheet" href="/asset-${i}.css">`).join('')}<h1>Local fixture</h1><p>Portable content</p>${healthy ? '<img src="/image-1.bmp" width="40" height="40"><img src="/image-2.bmp" width="40" height="40"><video preload="auto" src="/video.webm" width="160" height="90"></video>' : ''}`);
        }
      }, 40);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    mkdirSync('.tmp-test', { recursive: true });
    const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'source-traffic-'));
    const governors = new SourceRequestGovernors();
    const started = Date.now();
    const loadedStyles: number[] = [];
    try {
      const result = await captureScreenshots({
        urls: Array.from({ length: 3 }, (_, i) => `${origin}/page-${i}`),
        outputDir, governors, force: true, settleMs: 0, learnFluid: false,
        deviceMode: 'dual', concurrency: 3,
        viewports: [{ id: 'desktop', width: 1440, height: 900 }],
        observeSource: async page => {
          expect(await page.locator('h1').textContent()).toContain('Local fixture');
          loadedStyles.push(await page.evaluate(() => [...document.styleSheets].filter(sheet => { try { return sheet.cssRules.length > 0; } catch { return false; } }).length));
        },
      });
      process.stderr.write(JSON.stringify({ peakRssKiB: process.resourceUsage().maxRSS, rangeRequests, imageBytes, healthy, wallMs: Date.now() - started, captured: result.captured, failed: result.failed, resets, peak, loadedStyles, throttles: governors.forOrigin(origin).throttleEvents }) + '\n');
      expect(result).toMatchObject({ captured: 3, failed: 0 });
      expect(loadedStyles).toEqual([12, 12, 12]);
      if (healthy) {
        expect(imageBytes).toBeGreaterThanOrEqual(6 * 1024 * 1024);
        expect(rangeRequests).toBeGreaterThan(0);
        expect(resets).toBe(0);
        expect(peak).toBeGreaterThan(6);
        expect(governors.forOrigin(origin).throttleEvents).toBe(0);
      } else {
        expect(resets).toBeGreaterThan(0);
        expect(governors.forOrigin(origin).throttleEvents).toBeGreaterThan(0);
      }
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
}, 90_000);

// Roughly 10 seconds: one small capture, with the existing local server pattern.
it.skipIf(skipBrowser)('accounts for a reflow capture and reuses document and original requests', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    res.setHeader('content-type', req.url === '/original.bmp' ? 'image/bmp' : 'text/html');
    res.end(req.url === '/original.bmp' ? image : '<!doctype html><title>Fixture</title><h1>Reflow fixture</h1><p>Same document at every width.</p>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  mkdirSync('.tmp-test', { recursive: true });
  const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'request-counts-'));
  const governors = new SourceRequestGovernors();
  try {
    await sourceRequestContext.run(governors, () => runWithTrustedOrigins([origin], async () => {
      const result = await captureScreenshots({
        urls: [`${origin}/`, `${origin}/second`], outputDir, governors,
        force: true, settleMs: 0, learnFluid: false, deviceMode: 'auto', concurrency: 1,
      });
      expect(result).toMatchObject({ captured: 2, failed: 0 });
      const names = new Map<string, number>();
      const results = await Promise.all([1, 2].map(() => downloadMedia(`${origin}/original.bmp`, join(outputDir, 'media'), names, undefined, { preserveOriginal: true })));
      expect(results[0].localPath).toBeTruthy();
      expect(results[1].localPath).toBeTruthy();
    }));
    const stats = governors.forOrigin(origin).stats();
    process.stderr.write(`fixture counts ${JSON.stringify({requests, stats})}\n`);
    expect(stats.requests).toBe(requests);
    expect(stats.requestCounts).toEqual({ document: 1, 'device-check': 4, 'asset-original': 1, subresource: 0, 'refusal-probe': 0, retry: 0 });
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 60_000);
