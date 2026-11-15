import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { expect } from 'vitest';
import { it } from '../../../test/browser.js';
import { CapturedResourceStore, installResourceReplay } from './resource-capture.js';

const skipBrowser = Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath());
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// About 3 seconds: a CDN image negotiated on Accept is recorded once and replayed to a later page.
it.skipIf(skipBrowser)('records the browser Accept header for Vary: Accept responses so later loads replay', async ({ newContext }) => {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    hits.set(req.url!, (hits.get(req.url!) ?? 0) + 1);
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><img src="/logo.png" width="1" height="1">');
      return;
    }
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'public, max-age=31557600');
    res.setHeader('vary', 'Accept');
    res.end(PNG);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  mkdirSync('.tmp-test', { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), '.tmp-test', 'vary-accept-'));
  const store = new CapturedResourceStore(dir, origin);

  const contexts: BrowserContext[] = [];
  try {
    for (const replay of [false, true]) {
      const context = await newContext();
      contexts.push(context);
      const page = await context.newPage();
      if (replay) await installResourceReplay(page, store);
      else store.observe(page);
      await page.goto(origin);
      await page.waitForFunction(() => document.images[0]?.complete);
      if (!replay) await store.settle(page);
    }
    expect(hits.get('/logo.png')).toBe(1);
    expect(hits.get('/')).toBe(2);
    // Exact matching still applies: another Accept value is a different representation.
    const reasons: string[] = [];
    expect(store.getReplayableResponse(`${origin}/logo.png`, 'image', { accept: 'image/png' }, outcome => reasons.push(outcome))).toBeUndefined();
    expect(reasons).toEqual(['miss:vary_mismatch']);
  } finally {
    await Promise.all(contexts.map(context => context.close()));

    rmSync(dir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 30_000);
