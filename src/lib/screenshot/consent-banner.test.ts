import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';

// One real capture/export pass (~15 seconds), no mocked browser or export seams.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('exports consent intent before a click removes the banner, but never banner DOM', async () => {
  const fixture = readFileSync(new URL('./fixtures/consent-banner.html', import.meta.url), 'utf8');
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/other' ? fixture.replace('This website uses cookies for analytics.', 'This website uses cookies for preferences.') : fixture);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  mkdirSync('.tmp-test', { recursive: true });
  const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test/consent-'));
  try {
    const result = await captureScreenshots({ urls: [url, `${url}other`], primaryUrl: url, outputDir, concurrency: 1, deviceMode: 'reflow-only' });
    expect(result.failed).toBe(0);
    const exportSite = () => exportWebsiteCapture({ outputDir, sourceUrl: url, platform: 'default', summary: {
      routesDiscovered: 2, routesCaptured: result.captured, routesSkipped: result.skipped,
      routesFailed: result.failed, durationMs: result.durationMs,
    }, failures: [] });
    exportSite();
    const fact = JSON.parse(readFileSync(join(outputDir, 'website/consent-banner.json'), 'utf8'));
    expect(fact).toEqual({ schema: 'static-site-importer/consent-banner/v1',
      text: 'This website uses cookies for analytics.', accept_label: 'Accept', reject_label: 'Reject',
      policy_link: { label: 'Privacy policy', href: `${url}privacy` }, position: 'bottom',
      colors: { background: 'rgb(34, 34, 34)', text: 'rgb(255, 255, 255)', button_background: 'rgb(153, 153, 153)', button_text: 'rgb(255, 255, 255)' },
      source_selector: 'div.cc-window.cc-banner',
    });
    for (const route of ['index.html', 'other/index.html']) {
      expect(readFileSync(join(outputDir, 'website', route), 'utf8')).not.toContain('This website uses cookies');
    }
    const receipt = JSON.parse(readFileSync(join(outputDir, 'capture-receipt.json'), 'utf8'));
    expect(receipt.discoveryDiagnostics).toContainEqual(expect.objectContaining({ code: 'consent_banner_differs', url: `${url}other` }));
    // Republishing without consent evidence must not retain a stale site-level fact.
    const manifestPath = join(outputDir, 'screenshots/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.entries[url].dismissed[0].kind).toBe('consent');
    for (const entry of Object.values(manifest.entries) as Array<{ dismissed: unknown[] }>) entry.dismissed = [];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    exportSite();
    expect(existsSync(join(outputDir, 'website/consent-banner.json'))).toBe(false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(outputDir, { recursive: true, force: true });
  }
}, 60_000);
