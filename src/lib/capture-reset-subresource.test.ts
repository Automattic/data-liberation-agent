import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it, vi } from 'vitest';
import { captureWebsite } from '../index.js';

// Neutral reduced page: the stylesheet controls authored text via a load-time
// script. Later asset localization cannot repair a baseline captured without it.
// One public conversion, approximately 15 seconds on a warm machine.
it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))('public capture awaits a stylesheet reset by the source before freezing its baseline', async () => {
  let resets = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/style.css')) {
      // Fail every native retry of the first document in each browsing tab.
      if (req.url.includes('first=1')) {
        resets++;
        req.socket.resetAndDestroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('h1 { --source-ready: ready; color: rgb(0, 70, 0) }');
      return;
    }
    if (req.url !== '/') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Source recovery</title><script>const first = sessionStorage.getItem('loaded') ? 0 : 1; sessionStorage.setItem('loaded', '1'); document.write('<link rel="stylesheet" href="/style.css?first=' + first + '">');</script></head><body><h1>Waiting</h1><script>const heading = document.querySelector('h1'); heading.textContent = getComputedStyle(heading).getPropertyValue('--source-ready').trim() === 'ready' ? 'Styles ready' : 'Styles missing';</script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://localtest.me:${(server.address() as { port: number }).port}/`;
  // The public API rejects literal loopback URLs. Disable Chromium's local
  // network permission gate only in this loopback-backed fixture.
  const launch = chromium.launch.bind(chromium);
  const launchSpy = vi.spyOn(chromium, 'launch').mockImplementation(options => launch({
    ...options, args: [...(options?.args ?? []), '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults,PrivateNetworkAccessSendPreflights'],
  }));
  mkdirSync('.tmp-test', { recursive: true });
  const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'reset-subresource-'));
  try {
    const result = await captureWebsite({ url, outputDir, captureImages: false, learnFluid: false, deviceMode: 'dual' }, {
      findAdapter: () => ({ id: 'neutral', detect: () => true, discover: async () => ({ urls: [] }) }),
    });
    expect(resets).toBeGreaterThan(0);
    expect(result.summary.routesFailed).toBe(0);
    const html = readFileSync(join(outputDir, 'website', 'index.html'), 'utf8');
    expect(html).toContain('Styles ready');
    expect(html).not.toContain('Styles missing');
  } finally {
    launchSpy.mockRestore();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(outputDir, { recursive: true, force: true });
  }
}, 120_000);
