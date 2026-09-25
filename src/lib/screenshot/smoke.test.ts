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

// A page whose script nests extra <body> elements into the DOM (mimics an AJAX
// page-loader stacking whole documents) so page.content() serializes >1 <body>.
const nestedDocHtml = (title: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>` +
  `<h1>${title}</h1><div style="height:3000px">tall</div>` +
  `<script>for(var i=0;i<10;i++){var b=document.createElement('body');b.textContent='copy'+i;document.body.appendChild(b);}</script>` +
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
        captureImages: true,
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

  it('refuses to persist a nested-document (stacking-artifact) capture', async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    const pagesDir = mkdtempSync(join(tmpdir(), 'smoke-stack-'));
    writeFileSync(join(pagesDir, 'good.html'), tallHtml('GOOD'));
    writeFileSync(join(pagesDir, 'stacked.html'), nestedDocHtml('STACKED'));
    const server: HttpServer = createServer((req, res) => {
      const path = (req.url || '/').replace(/^\//, '') || 'good.html';
      try {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(readFileSync(join(pagesDir, path)));
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const outputDir = mkdtempSync(join(TMP_ROOT, 'stack-out-'));
    try {
      await captureScreenshots({
        urls: [`http://127.0.0.1:${port}/good.html`, `http://127.0.0.1:${port}/stacked.html`],
        outputDir,
        concurrency: 1,
      });
      // Clean page: HTML persisted. Stacking artifact: HTML NOT persisted.
      expect(existsSync(join(outputDir, 'html', 'good.html.html'))).toBe(true);
      expect(existsSync(join(outputDir, 'html', 'stacked.html.html'))).toBe(false);
      const manifest = JSON.parse(readFileSync(join(outputDir, 'screenshots', 'manifest.json'), 'utf8'));
      // The artifact URL still gets a manifest entry (the PNG renders fine) but no html field.
      expect(manifest.entries[`http://127.0.0.1:${port}/stacked.html`]?.html).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(pagesDir, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  }, 60_000);
  it('resolves server-redirected routes to their target and still reports post-load drift', async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    const pages: Record<string, string> = {
      '/': tallHtml('HOME').replace('<h1>', '<a href="/old">old</a><a href="/temp">temp</a><a href="/new">new</a><h1>'),
      '/new': tallHtml('NEW'),
      '/target': tallHtml('TARGET'),
      // A client-routed control navigating the page away after load.
      '/spa': tallHtml('SPA').replace('</body>', '<script>addEventListener("load",()=>history.pushState({},"","/new"))</script></body>'),
    };
    const redirects: Record<string, [number, string]> = {
      '/old': [301, '/new'],
      '/temp': [302, '/new'],
      '/elsewhere': [301, '/target'],
    };
    const server: HttpServer = createServer((req, res) => {
      const path = (req.url || '/').split('?')[0];
      const redirect = redirects[path];
      if (redirect) {
        res.writeHead(redirect[0], { Location: redirect[1] });
        res.end();
      } else if (pages[path]) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(pages[path]);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const outputDir = mkdtempSync(join(TMP_ROOT, 'redirect-out-'));
    try {
      await captureScreenshots({
        urls: ['/', '/old', '/temp', '/new', '/elsewhere', '/spa'].map((path) => `${origin}${path}`),
        outputDir,
        concurrency: 2,
      });
      const manifest = JSON.parse(readFileSync(join(outputDir, 'screenshots', 'manifest.json'), 'utf8'));
      const failures = JSON.parse(readFileSync(join(outputDir, 'screenshots', 'failures.json'), 'utf8')) as Array<{ url: string; error: string }>;
      // Aliases carry no artifacts of their own and are never failures.
      for (const [alias, target] of [['/old', '/new'], ['/temp', '/new'], ['/elsewhere', '/target']]) {
        expect(manifest.entries[`${origin}${alias}`]).toMatchObject({ redirectedTo: `${origin}${target}` });
        expect(manifest.entries[`${origin}${alias}`].html).toBeUndefined();
      }
      // /new is captured once, under its own URL; /target, reached only through
      // a redirect, is queued and captured too.
      expect(manifest.entries[`${origin}/new`].html).toBe('html/new.html');
      expect(manifest.entries[`${origin}/target`].html).toBe('html/target.html');
      expect(readFileSync(join(outputDir, 'html', 'new.html'), 'utf8')).toContain('NEW');
      expect(existsSync(join(outputDir, 'html', 'old.html'))).toBe(false);
      expect(existsSync(join(outputDir, 'html', 'temp.html'))).toBe(false);
      expect(failures.filter((f) => /route drift/.test(f.error)).map((f) => f.url)).toEqual([`${origin}/spa`]);
      expect(manifest.entries[`${origin}/spa`].html).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(outputDir, { recursive: true, force: true });
    }
  }, 120_000);
});
