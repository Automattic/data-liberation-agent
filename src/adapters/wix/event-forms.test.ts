import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eventFormRedirect } from './event-forms.js';
import { capture } from './capture.js';
import { captureScreenshots } from '../../lib/screenshot/screenshotter.js';
import { exportWebsiteCapture } from '../../lib/capture-export.js';

const site = 'https://www.cwctu.org';

describe('Wix event form navigation', () => {
  it('recognizes only a form that settled on its own parent event', () => {
    const expired = `${site}/event-details/annual-dinner/form`;
    const parent = `${site}/event-details/annual-dinner`;
    expect(eventFormRedirect(expired, parent)).toBe(parent);
    expect(eventFormRedirect(expired, expired)).toBeUndefined();
    expect(eventFormRedirect(expired, `${site}/event-details/other`)).toBeUndefined();
    expect(eventFormRedirect(expired, 'https://elsewhere.example/event-details/annual-dinner')).toBeUndefined();
    expect(eventFormRedirect(`${site}/event-details/annual-dinner`, parent)).toBeUndefined();
  });

  it('keeps the active form and parent event, while receipting the expired form as an alias', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const path = req.url || '/';
      if (path === '/event-details/expired/form') {
        res.end('<h1>Loading registration</h1><script>setTimeout(() => history.replaceState({}, "", "/event-details/expired"), 100)</script>');
      } else if (path === '/event-details/active/form') {
        res.end('<h1>Registration Form</h1><form><input name="email"><button>Submit</button></form>');
      } else {
        res.end(`<h1>${path === '/event-details/expired' ? 'Expired event details' : 'Home'}</h1><a href="/event-details/expired/form">Register</a>`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const root = join(process.cwd(), '.tmp-test');
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, 'wix-event-forms-'));
    try {
      const urls = ['/', '/event-details/expired/form', '/event-details/active/form']
        .map((path) => `${origin}${path}`);
      const result = await captureScreenshots({ urls, primaryUrl: urls[0], outputDir: dir,
        concurrency: 2, settleMs: 0, learnFluid: false,
        resolveClientRedirect: capture.resolveClientRedirect });
      const manifest = JSON.parse(readFileSync(join(dir, 'screenshots', 'manifest.json'), 'utf8'));
      expect(result.skipped).toBe(1);
      expect(result.failed).toBe(0);
      expect(manifest.entries[urls[1]]).toMatchObject({ redirectedTo: `${origin}/event-details/expired` });
      expect(manifest.entries[urls[1]].html).toBeUndefined();
      expect(manifest.entries[`${origin}/event-details/expired`].html).toBeTruthy();
      expect(manifest.entries[urls[2]].html).toBeTruthy();
      const sourceDiagnostic = { code: 'wix_sitemap_fetch_failed', url: `${origin}/blog-posts-sitemap.xml`, reason: 'HTTP 503' };
      const receipt = JSON.parse(readFileSync(exportWebsiteCapture({ outputDir: dir, sourceUrl: urls[0],
        platform: 'wix', summary: { routesDiscovered: result.urls.length, routesCaptured: result.captured,
          routesSkipped: result.skipped, routesFailed: result.failed }, failures: [],
        discoveryDiagnostics: [sourceDiagnostic] }), 'utf8'));
      expect(receipt.summary.routesSkipped).toBe(1);
      expect(receipt.summary.complete).toBe(true);
      expect(receipt.duplicateRoutes).toContainEqual({ url: urls[1],
        canonicalUrl: `${origin}/event-details/expired`, path: 'website/event-details/expired/index.html' });
      expect(receipt.routes.map((route: { url: string }) => route.url)).toContain(urls[2]);
      expect(receipt.discoveryDiagnostics).toEqual([sourceDiagnostic]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
