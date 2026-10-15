import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { CAPTURE_DOCUMENT_MARKER, clientRouteSubstitution, markCaptureDocument } from './document-integrity.js';

// A source's own client router can substitute a route through the History API
// (a gated route redirecting itself to its auth page) with no main-frame
// request, so navigation locking never sees it. The serialize-time identity
// check must distinguish that substitution — the marked document is still the
// one the screenshot paired with — from a replaced document, which stays drift.
describe('clientRouteSubstitution', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it('accepts a History-API substitution of the marked document', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('https://app.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p>route content</p>' }));
    await page.goto('https://app.test/dashboard');
    await markCaptureDocument(page);
    await page.evaluate(() => { history.replaceState({}, '', '/login?from_url=%2Fdashboard'); });
    expect(page.url()).toBe('https://app.test/login?from_url=%2Fdashboard');
    expect(await clientRouteSubstitution(page, page.url(), 'https://app.test/dashboard')).toBe(page.url());
    await context.close();
  });

  it('refuses a substituted document that was replaced, off-origin or unmarkable', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('https://app.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p>route content</p>' }));
    // Without markCaptureDocument the identity is unknown: fail closed.
    await page.goto('https://app.test/dashboard');
    expect(await clientRouteSubstitution(page, 'https://app.test/login', 'https://app.test/dashboard')).toBeUndefined();
    // Marked, then a real document replacement: still drift.
    await markCaptureDocument(page);
    await page.evaluate(() => { location.assign('/login?from_url=%2Fdashboard'); });
    await page.waitForURL('https://app.test/login?from_url=%2Fdashboard');
    expect(await clientRouteSubstitution(page, page.url(), 'https://app.test/dashboard')).toBeUndefined();
    // Off-origin captured URL: never a substitution.
    await page.goto('https://app.test/dashboard');
    await markCaptureDocument(page);
    expect(await clientRouteSubstitution(page, 'https://elsewhere.test/login', 'https://app.test/dashboard')).toBeUndefined();
    await context.close();
  });

  it('exposes the marker through the window property it checks', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('about:blank');
    await markCaptureDocument(page);
    expect(await page.evaluate((token: string) => (window as unknown as Record< string, unknown >)[token] === 1, CAPTURE_DOCUMENT_MARKER)).toBe(true);
    await context.close();
  });
});
