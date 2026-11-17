import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { captureScreenshots } from '../screenshotter.ts';

const server = createServer((_request, response) => {
  response.end('<!doctype html><html><body><main><h1>Deadline fixture</h1></main></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
mkdirSync('.tmp-test', { recursive: true });
const outputDir = mkdtempSync('.tmp-test/abandoned-profile-');
let attempts = 0;
let observerReturned;
const unwound = new Promise(resolve => { observerReturned = resolve; });
try {
  const result = await captureScreenshots({
    urls: [url], primaryUrl: url, outputDir, routeDeadlineMs: 8000,
    settleMs: 0, learnFluid: false, viewports: [{ id: 'desktop', width: 800, height: 600 }],
    observeSource: async page => {
      attempts++;
      // The route deadline closes the source context, but an asynchronous
      // observer need not settle until after the capture browser is closed.
      const browser = page.context().browser();
      await new Promise(resolve => browser.once('disconnected', () => setTimeout(resolve, 100)));
      observerReturned();
      throw new Error('fixture observer abandoned');
    },
  });
  assert.equal(attempts, 1, 'the deadline must reach observe-source');
  assert.deepEqual(result.routeDiagnostics.map(row => row.code), ['route_capture_timeout']);
  assert.match(result.routeDiagnostics[0].reason, /observe-source/);
  // Match capture.ts: the dynamic import between finalizing and export is
  // allowed to yield to the abandoned profile. Export must still report why
  // the homepage is missing, and the process must exit without a new browser.
  const { exportWebsiteCapture } = await import('../../capture-export.ts');
  assert.throws(() => exportWebsiteCapture({
    outputDir, sourceUrl: url, platform: 'generic', summary: {}, failures: [],
    discoveryDiagnostics: result.routeDiagnostics,
  }), /Source homepage .* was not captured: route capture deadline 8000ms/);
  await unwound;
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(attempts, 1, 'an abandoned profile must never retry');
  console.log('route_capture_timeout: exited after finalizing');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(outputDir, { recursive: true, force: true });
}
