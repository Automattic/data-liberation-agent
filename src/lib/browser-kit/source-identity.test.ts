import { createServer, type IncomingHttpHeaders } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices } from 'playwright';
import { expect, it } from 'vitest';
import { connectBrowser, desktopContextOptions, __resetSourceSessionsForTests } from './browser-kit.js';
import { createSourceContext } from './source-identity.js';
import { captureScreenshots } from '../screenshot/screenshotter.js';

const skipBrowser = Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath());

it.skipIf(skipBrowser)('captures consistent desktop and phone identities on the wire, including opted-in hints and redirects', async () => {
  const requests: Array<{ path: string; headers: IncomingHttpHeaders; status: number }> = [];
  const server = createServer((req, res) => {
    const headers = req.headers;
    const ua = headers['user-agent'] ?? '';
    const hints = Object.keys(headers).filter(name => name.startsWith('sec-ch-ua'));
    const inconsistent = (!/Chrome\//.test(ua) && hints.length > 0) || hints.some(name => String(headers[name]).includes('HeadlessChrome'));
    const status = inconsistent ? 403 : req.url === '/redirect' ? 302 : 200;
    requests.push({ path: req.url!, headers, status });
    res.writeHead(status, {
      'content-type': req.url === '/style.css' ? 'text/css' : 'text/html',
      'accept-ch': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model',
      ...(status === 302 ? { location: '/frame' } : {}),
    });
    res.end(req.url === '/' ? `<!doctype html><meta name="viewport" content="width=device-width"><title>Identity</title>
      <link rel="stylesheet" href="/style.css"><h1>Consistent identity</h1><iframe src="/redirect"></iframe>` : req.url === '/style.css' ? 'h1 { color: green }' : '<!doctype html><title>Child</title><p>Child</p>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  mkdirSync('.tmp-test', { recursive: true });
  const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'source-identity-'));
  __resetSourceSessionsForTests();
  try {
    const result = await captureScreenshots({
      urls: [url], outputDir, force: true, settleMs: 0, learnFluid: false,
      viewports: [{ id: 'desktop', width: 1440, height: 900 }, { id: 'mobile', width: 390, height: 844 }],
      observeSource: async page => {
        const identity = await page.evaluate(async () => {
          const data = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(keys: string[]): Promise<unknown> } }).userAgentData;
          return { ua: navigator.userAgent, platform: navigator.platform, data: data ? await data.getHighEntropyValues(['fullVersionList', 'platformVersion']) : null };
        });
        if (identity.ua.includes('iPhone')) {
          expect(identity.platform).toBe('iPhone');
          expect(identity.data).toBeNull();
        } else {
          expect(identity.data).toMatchObject({ mobile: false, brands: expect.arrayContaining([{ brand: 'Google Chrome', version: expect.any(String) }]) });
          expect(JSON.stringify(identity.data)).not.toContain('HeadlessChrome');
        }
      },
    });
    expect(result).toMatchObject({ captured: 1, failed: 0 });
    expect(existsSync(join(outputDir, 'screenshots/failures.json'))).toBe(false);
    for (const mobile of [false, true]) {
      const profile = requests.filter(request => request.headers['user-agent']!.includes('iPhone') === mobile);
      for (const path of ['/', '/style.css', '/redirect', '/frame']) expect(profile.some(request => request.path === path)).toBe(true);
      expect(profile.every(request => request.status !== 403)).toBe(true);
      if (mobile) expect(profile.every(request => !Object.keys(request.headers).some(name => name.startsWith('sec-ch-ua')))).toBe(true);
      else {
        expect(profile.some(request => request.headers['sec-ch-ua-full-version-list'])).toBe(true);
        for (const request of profile) {
          const version = request.headers['user-agent']!.match(/Chrome\/(\d+)/)![1];
          expect(request.headers['sec-ch-ua']).toContain(`"Google Chrome";v="${version}"`);
          expect(request.headers['sec-ch-ua-mobile']).toBe('?0');
          if (request.headers['sec-ch-ua-full-version-list']) {
            expect(request.headers['sec-ch-ua-full-version-list']).toContain(`"Google Chrome";v="${request.headers['user-agent']!.match(/Chrome\/([\d.]+)/)![1]}"`);
          }
        }
      }
    }
    // A future Chrome device follows the same policy, not an iPhone-specific exception.
    const browser = await connectBrowser({});
    try {
      const { defaultBrowserType: _, ...device } = devices['Pixel 7'];
      const context = await createSourceContext(browser, { ...await desktopContextOptions(browser), ...device });
      const page = await context.newPage();
      expect((await page.goto(url))?.status()).toBe(200);
      const popupPromise = context.waitForEvent('page');
      await page.evaluate(url => { window.open(url); }, url);
      const popup = await popupPromise;
      await popup.waitForLoadState();
      expect(await popup.title()).toBe('Identity');
      expect(await popup.evaluate(() => JSON.stringify((navigator as Navigator & { userAgentData?: unknown }).userAgentData))).not.toContain('HeadlessChrome');
      await context.close();
      const android = requests.filter(request => request.headers['user-agent']?.includes('Android'));
      expect(android.length).toBeGreaterThan(0);
      for (const request of android) {
        expect(request.status, JSON.stringify(request)).not.toBe(403);
        expect(request.headers['sec-ch-ua']).toContain(`"Google Chrome";v="${device.userAgent.match(/Chrome\/(\d+)/)![1]}"`);
        expect(request.headers['sec-ch-ua-mobile']).toBe('?1');
        expect(request.headers['sec-ch-ua-platform']).toBe('"Android"');
      }
    } finally { await browser.close(); }
  } finally {
    __resetSourceSessionsForTests();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(outputDir, { recursive: true, force: true });
  }
}, 60_000);
