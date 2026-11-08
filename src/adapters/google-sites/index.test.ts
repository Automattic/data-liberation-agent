import { readFileSync, existsSync } from 'node:fs';
import { load } from 'cheerio';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { findAdapter } from '../index.js';
import { applyCaptureRemovals } from '../../lib/screenshot/apply-removals.js';
import { googleSitesAdapter, canonicalizeGoogleSitesHtml, authoredEmbedDocument } from './index.js';
import { detection } from './detection.js';

const fixture = readFileSync(new URL('./fixture.html', import.meta.url), 'utf8');

function assertPortable(html: string) {
  const $ = load(html);
  expect($('body').text()).not.toMatch(/Skip to|Site actions|Report abuse|Submit|Cancel/);
  expect($('a[href*="viewer_footer"]').length).toBe(0);
  expect($('#ow11, [data-last-updated-at-time]').length).toBe(0);
  expect($('#atIdViewHeader h1').text()).toBe('Community garden');
  expect($('nav a').attr('href')).toBe('/about');
  expect($('main p').text()).toBe('Grow together.');
  expect($('#owner-footer').text()).toBe('Garden volunteers');
  expect($('#owner-button').text()).toBe('Page details');
  expect($('a[href="https://sites.google.com/view/garden"]').text()).toBe('Our Google Sites guide');
  expect($('[jscontroller],[jsaction],[jsname],[jsmodel],[jsshadow],[jsslot],[jsowner],[data-idom-class]').length).toBe(0);
}

describe('Google Sites adapter', () => {
  it('registers the adapter and identifies document markers on custom domains', () => {
    expect(findAdapter('google-sites')).toBe(googleSitesAdapter);
    for (const html of [fixture, '<body data-legacy-theme-name="Simple">', '<header id="atIdViewHeader">']) {
      expect(detection.sourceSignals!.some(({ pattern }) => pattern.test(html))).toBe(true);
    }
    for (const html of ['<p>Google Sites</p>', '<a href="https://sites.google.com/view/example">Example</a>', '<div jscontroller="OtherGoogleApp">']) {
      expect(detection.sourceSignals!.some(({ pattern }) => pattern.test(html))).toBe(false);
    }
    expect(detection.urlPatterns![0].test('https://sites.google.com/view/garden')).toBe(true);
    expect(detection.urlPatterns![0].test('https://sites.google.com.evil.test/')).toBe(false);
  });

  it('uses authored full-page embed HTML but leaves ordinary pages unchanged', () => {
    const embedded = authoredEmbedDocument(fixture, 'https://garden.example/full-page-embed');
    expect(embedded).toContain('<base href="https://garden.example/full-page-embed">');
    const $embedded = load(embedded!);
    expect($embedded('h1').text()).toBe('Fixture heading');
    expect($embedded('p').text()).toBe('Fixture paragraph.');
    expect(authoredEmbedDocument('<html><body><p>Ordinary</p></body></html>', 'https://garden.example/')).toBeUndefined();
  });

  it('removes only viewer chrome and frozen runtime attributes', () => {
    const $ = load(fixture);
    for (const selector of googleSitesAdapter.liberation!.removeSelectors!) $(selector).remove();
    const html = canonicalizeGoogleSitesHtml($.html());
    assertPortable(html);
    expect(canonicalizeGoogleSitesHtml(html)).toBe(html);
    const panel = canonicalizeGoogleSitesHtml('<div jscontroller="Panel"><a jsaction="click:go" href="/about">About</a></div>');
    expect(panel).toBe('<div><a href="/about">About</a></div>');
  });
});

// One browser pass (~1 second): exercise the actual pre-probe removal seam.
describe.skipIf(!existsSync(chromium.executablePath()))('Google Sites browser cleanup', () => {
  it('removes viewer controls before capture without disabling the live runtime', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(fixture);
      await applyCaptureRemovals(page, {
        removeSelectors: googleSitesAdapter.liberation!.removeSelectors,
        ctx: { url: 'https://garden.example/', viewport: 'desktop' },
      });
      expect(await page.locator('nav').getAttribute('jsname')).toBe('Nav');
      assertPortable(canonicalizeGoogleSitesHtml(await page.content()));
    } finally {
      await browser.close();
    }
  });
});
