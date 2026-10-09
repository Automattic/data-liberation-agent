import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { captureScreenshots } from './screenshotter.js';

// A page whose own script takes over the main thread once it is scrolled: the
// renderer never answers another evaluate, and never crashes either.
const SPIN_ON_SCROLL = `<!doctype html><html><body>
  <h1>Heading</h1>
  <div style="height:4000px">tall content</div>
  <script>
    addEventListener('scroll', function () { for (;;) {} }, { once: true });
  </script>
</body></html>`;

describe('captureScreenshots — page whose script never yields (real Chromium)', () => {
  it.skipIf(process.env.SKIP_BROWSER_TESTS)('records a bounded, accurate failure instead of hanging', async () => {
    const root = join(process.cwd(), '.tmp-test');
    mkdirSync(root, { recursive: true });
    const outputDir = mkdtempSync(join(root, 'unresponsive-'));
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(SPIN_ON_SCROLL);
    });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    try {
      const started = Date.now();
      await captureScreenshots({ urls: [url], outputDir, settleMs: 0, evaluateTimeoutMs: 100 });
      expect(Date.now() - started).toBeLessThan(90_000);

      const failures = JSON.parse(readFileSync(join(outputDir, 'screenshots', 'failures.json'), 'utf8'));
      expect(failures.map((f: { viewport: string }) => f.viewport).sort()).toEqual(['desktop', 'mobile']);
      for (const f of failures) {
        expect(f.stage).toBe('evaluate');
        expect(f.error).toMatch(/stopped responding/);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(outputDir, { recursive: true, force: true });
    }
  }, 150_000);
});
