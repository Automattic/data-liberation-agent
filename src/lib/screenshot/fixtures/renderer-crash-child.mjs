import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { captureScreenshots } from '../screenshotter.ts';

const persistent = process.argv[2] === 'persistent';
const server = createServer((request, response) => {
  if (request.url === '/pending') {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.write('unfinished body');
    request.on('close', () => response.destroy());
    return;
  }
  response.end(`<!doctype html><html><head><title>Neutral fixture</title></head><body><header>Fixture header</header><main><h1>${request.url === '/healthy' ? 'Healthy later route' : 'Crash route'}</h1></main></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
mkdirSync('.tmp-test', { recursive: true });
const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test/renderer-crash-'));
let crashes = 0;
let attempts = 0;
let browser;
const pending = [];
const cleanup = [];
const logs = [];
try {
  const result = await captureScreenshots({
    urls: [origin + '/', origin + '/healthy'], primaryUrl: origin + '/', outputDir,
    concurrency: 1, settleMs: 0, evaluateTimeoutMs: 1000, captureImages: true,
    viewports: [{ id: 'desktop', width: 800, height: 600 }],
    server: { sendLoggingMessage: message => logs.push(message.data) },
    observeSource: async page => {
      browser = page.context().browser();
      if (page.url() !== origin + '/') return;
      attempts++;
      if (!persistent && attempts > 1) return;
      const cdp = await page.context().newCDPSession(page);
      const response = page.waitForResponse(origin + '/pending');
      pending.push(page.evaluate(() => fetch('/pending').then(r => r.text())).then(() => 'resolved', e => e.message));
      pending.push((await response).body().then(() => 'resolved', e => e.message));
      pending.push(page.evaluate(() => {
        window.pendingEvaluationStarted = true;
        return new Promise(() => {});
      }).then(() => 'resolved', e => e.message));
      await page.waitForFunction(() => window.pendingEvaluationStarted);
      const crash = new Promise(resolve => page.once('crash', resolve));
      pending.push(cdp.send('Page.crash').then(() => 'resolved', e => e.message));
      await crash;
      crashes++;
      assert.equal(browser.isConnected(), true, 'only the renderer must fail');
    },
    onProgress: () => cleanup.push(browser.contexts().length),
  });
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
  const failurePath = join(outputDir, 'screenshots/failures.json');
  const failures = existsSync(failurePath) ? JSON.parse(readFileSync(failurePath, 'utf8')) : [];
  const healthy = manifest.entries[origin + '/healthy'];
  assert.match(readFileSync(join(outputDir, healthy.html), 'utf8'), /Healthy later route/);
  assert.ok(healthy.desktop, 'later route screenshot must exist');
  const pendingOutcomes = await Promise.all(pending);
  assert.ok(pendingOutcomes.every(message => /crashed|closed/i.test(message)), 'all pending work must reject and settle');
  assert.deepEqual(cleanup, [0, 0], 'every route must close its contexts');
  assert.equal(browser.isConnected(), false, 'capture must close its browser');
  const require = createRequire(import.meta.url);
  console.log(JSON.stringify({
    node: process.version, platform: process.platform, playwright: require('playwright/package.json').version,
    persistent, attempts, crashes, result, failures, cleanup, pendingOutcomes, logs,
    entry: manifest.entries[origin + '/'], healthy,
  }));
} finally {
  await browser?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(outputDir, { recursive: true, force: true });
}
