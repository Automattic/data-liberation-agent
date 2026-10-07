import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectBrowser, desktopContextOptions, __resetSourceSessionsForTests } from './browser-kit.js';
import { captureScreenshots } from '../screenshot/screenshotter.js';

describe.skipIf(process.env.SKIP_BROWSER_TESTS)('source locale (real Chromium)', () => {
  it('negotiates the same language during session harvest and desktop/mobile capture', async () => {
    const requests: Array<{ language?: string; userAgent: string; cookie?: string }> = [];
    const server = createServer((req, res) => {
      if (req.url !== '/') { res.writeHead(404); res.end(); return; }
      requests.push({ language: req.headers['accept-language'], userAgent: req.headers['user-agent'] ?? '', cookie: req.headers.cookie });
      if (!req.headers['accept-language']?.startsWith('en-US')) {
        res.writeHead(406); res.end(); return;
      }
      res.setHeader('set-cookie', 'language-session=ready; Path=/');
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html><head><title>Language source</title>
        <meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body><h1>Negotiated source</h1><p id="language"></p>
        <script>document.querySelector('#language').textContent = navigator.language;</script></body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://localtest.me:${(server.address() as { port: number }).port}/`;
    const parent = join(process.cwd(), '.tmp-test');
    mkdirSync(parent, { recursive: true });
    const outputDir = mkdtempSync(join(parent, 'source-locale-'));
    __resetSourceSessionsForTests();
    try {
      const browser = await connectBrowser({});
      try {
        // Reproduce the source's blank 406 with the existing desktop UA but no locale.
        const identity = await desktopContextOptions(browser);
        const cold = await browser.newContext({ userAgent: identity.userAgent });
        const page = await cold.newPage();
        expect((await page.goto(url))?.status()).toBe(406);
        await cold.close();
        requests.length = 0;
      } finally {
        await browser.close();
      }
      const result = await captureScreenshots({ urls: [url], primaryUrl: url, outputDir, concurrency: 1, settleMs: 0, captureImages: false });
      expect(result.failed).toBe(0);
      expect(requests).toHaveLength(3); // one harvest, one desktop, one mobile
      expect(requests.every((request) => request.language?.startsWith('en-US'))).toBe(true);
      expect(requests[0].userAgent).toContain('Chrome/');
      expect(requests[1].userAgent).not.toContain('HeadlessChrome');
      expect(requests[2].userAgent).toContain('iPhone');
      expect(requests.slice(1).every((request) => request.cookie?.includes('language-session=ready'))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(outputDir, 'screenshots', 'manifest.json'), 'utf8'));
      expect(Object.keys(manifest.entries)).toHaveLength(1);
      // Both serialized documents must contain real negotiated content and the
      // browser's language, rather than accepting an empty error-page capture.
      const entry = Object.values(manifest.entries)[0] as { html: string };
      for (const path of [entry.html, entry.html.replace('html/', 'html-mobile/')]) {
        const html = readFileSync(join(outputDir, path), 'utf8');
        expect(html).toContain('Negotiated source');
        expect(html).toContain('>en-US</p>');
      }
    } finally {
      await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
      rmSync(outputDir, { recursive: true, force: true });
      __resetSourceSessionsForTests();
    }
  }, 30_000);
});
