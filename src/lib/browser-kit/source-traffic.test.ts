import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureScreenshots } from '../screenshot/screenshotter.js';
import { SourceRequestGovernors } from '../source-request-governor.js';

const skipBrowser = Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath());

// One browser capture per behavior, approximately 12 seconds total on a warm machine.
it.skipIf(skipBrowser)('captures all routes through a resetting origin and leaves healthy fan-out uncapped', async () => {
  const modes = process.env.SOURCE_TRAFFIC_HEALTHY === undefined ? [true, false] : [process.env.SOURCE_TRAFFIC_HEALTHY === '1'];
  for (const healthy of modes) {
    let active = 0;
    let peak = 0;
    let resets = 0;
    let navigationReset = false;
    const server = createServer((req, res) => {
      peak = Math.max(peak, ++active);
      res.once('close', () => active--);
      const resetNavigation = !navigationReset && req.url === '/page-2';
      if (!healthy && (active > 3 || resetNavigation)) {
        if (resetNavigation) navigationReset = true;
        resets++;
        req.socket.resetAndDestroy();
        return;
      }
      setTimeout(() => {
        if (req.url?.startsWith('/asset')) {
          res.writeHead(200, { 'content-type': 'text/css' });
          res.end('h1 { color: rgb(0, 70, 0) }');
        } else {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(`<!doctype html><title>Local fixture</title>${Array.from({ length: 12 }, (_, i) => `<link rel="stylesheet" href="/asset-${i}.css">`).join('')}<h1>Local fixture ${req.url}</h1><p>Portable content</p>`);
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
      process.stderr.write(JSON.stringify({ healthy, wallMs: Date.now() - started, captured: result.captured, failed: result.failed, resets, peak, loadedStyles, throttles: governors.forOrigin(origin).throttleEvents }) + '\n');
      expect(result).toMatchObject({ captured: 3, failed: 0 });
      expect(loadedStyles).toEqual([12, 12, 12]);
      if (healthy) {
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
