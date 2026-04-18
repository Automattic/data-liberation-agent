import { describe, it, expect, beforeAll } from 'vitest';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { startPreview, stopPreview, pidFilePath } from './playground-server.js';

const ENABLED = process.env.RUN_PLAYGROUND_TESTS === '1';
const FIXTURE = resolve('test/fixtures/preview/content-only');

const CI_BUDGET_MS = 120_000;

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', timeout: 10_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

describe.skipIf(!ENABLED)('playground integration — content-only', () => {
  beforeAll(() => {
    expect(existsSync(join(FIXTURE, 'output.wxr'))).toBe(true);
  });

  it('starts Playground, serves HTML, and stops cleanly', async () => {
    const started = await startPreview({ outputDir: FIXTURE, detached: true });
    try {
      expect(started.status).toBe('ready');
      expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const home = await httpGet(`${started.url}/`);
      expect(home.status).toBeGreaterThanOrEqual(200);
      expect(home.status).toBeLessThan(500);
      expect(home.body).toMatch(/<html/i);

      const hello = await httpGet(`${started.url}/?p=1`);
      expect(hello.status).toBeGreaterThanOrEqual(200);
      expect(hello.status).toBeLessThan(500);
    } finally {
      const stopped = await stopPreview({ outputDir: FIXTURE });
      expect(stopped.status === 'stopped' || stopped.status === 'not-running').toBe(true);
      expect(existsSync(pidFilePath(FIXTURE))).toBe(false);
    }
  }, CI_BUDGET_MS);
});

const PRODUCTS_FIXTURE = resolve('test/fixtures/preview/with-products');

describe.skipIf(!ENABLED)('playground integration — with-products', () => {
  it('installs WooCommerce and imports products', async () => {
    const started = await startPreview({ outputDir: PRODUCTS_FIXTURE, detached: true });
    try {
      expect(started.status).toBe('ready');
      const shop = await httpGet(`${started.url}/shop/`);
      expect(shop.status).toBeGreaterThanOrEqual(200);
      expect(shop.status).toBeLessThan(500);
    } finally {
      await stopPreview({ outputDir: PRODUCTS_FIXTURE });
    }
  }, CI_BUDGET_MS);
});
