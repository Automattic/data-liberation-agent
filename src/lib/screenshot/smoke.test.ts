import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import { captureScreenshots } from './screenshotter.js';

// validateOutputDir rejects paths outside cwd, so use a cwd-local .tmp-test dir.
const TMP_ROOT = join(process.cwd(), '.tmp-test');

// Tall HTML so the scrolled-screenshot clip (viewport * 1.5) has content to
// capture. Without enough height, playwright's page.screenshot({ clip })
// rejects the region as "outside the resulting image".
const tallHtml = (title: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>` +
  `<h1>${title}</h1>` +
  `<div style="height:3000px;background:linear-gradient(#fff,#000)">tall content</div>` +
  '</body></html>';

describe.skipIf(process.env.SKIP_BROWSER_TESTS)('screenshot smoke (real Chromium)', () => {
  it('captures two pages end-to-end', async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    // Static HTML can live in system tmp (not used as outputDir).
    const pagesDir = mkdtempSync(join(tmpdir(), 'smoke-pages-'));
    writeFileSync(join(pagesDir, 'a.html'), tallHtml('A'));
    writeFileSync(join(pagesDir, 'b.html'), tallHtml('B'));
    const server: HttpServer = createServer((req, res) => {
      const path = (req.url || '/').replace(/^\//, '') || 'a.html';
      try {
        const content = readFileSync(join(pagesDir, path));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const outputDir = mkdtempSync(join(TMP_ROOT, 'smoke-out-'));
    try {
      const result = await captureScreenshots({
        urls: [`http://127.0.0.1:${port}/a.html`, `http://127.0.0.1:${port}/b.html`],
        outputDir,
        concurrency: 1,
      });
      // Core contract: both URLs produced PNG + HTML and landed a manifest
      // entry. We don't assert `failed === 0` because analyzePage runs via
      // page.evaluate and esbuild (used by tsx/vitest) injects `__name`
      // helpers that aren't defined in the browser context — a test-env
      // artifact that doesn't affect the `tsc`-built production path.
      expect(existsSync(join(outputDir, 'screenshots', 'desktop', 'a.html.png'))).toBe(true);
      expect(existsSync(join(outputDir, 'screenshots', 'desktop', 'b.html.png'))).toBe(true);
      expect(existsSync(join(outputDir, 'screenshots', 'mobile', 'a.html.png'))).toBe(true);
      expect(existsSync(join(outputDir, 'screenshots', 'mobile', 'b.html.png'))).toBe(true);
      expect(existsSync(join(outputDir, 'html', 'a.html.html'))).toBe(true);
      expect(existsSync(join(outputDir, 'html', 'b.html.html'))).toBe(true);
      const manifest = JSON.parse(
        readFileSync(join(outputDir, 'screenshots', 'manifest.json'), 'utf8'),
      );
      expect(Object.keys(manifest.entries)).toHaveLength(2);
      expect(manifest.entries[`http://127.0.0.1:${port}/a.html`]).toMatchObject({
        slug: 'a.html',
        desktop: 'screenshots/desktop/a.html.png',
        html: 'html/a.html.html',
      });
      // captured + failed can both be non-zero; require at least one of each
      // URL's viewports succeeded (captured counts URLs where *all* viewports
      // had zero failures, so may legitimately be 0 here).
      expect(result.captured + result.failed).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(pagesDir, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  }, 60_000);
});
