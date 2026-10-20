import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'cheerio';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { capturePageHtml } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { sanitizeFrozenHtml } from './freeze.js';

it('ports a rendered Google map through portable export without freezing its tiles or changing the live map', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // The provider view link belongs to this rendered map. Business copy and
    // unrelated links outside it must never be used to invent its location.
    await page.setContent(`<!doctype html><style>
      .map { position:relative; width:min(100%,640px); height:320px }
      .gm-style { position:absolute; inset:0; overflow:hidden }
    </style><main><p>Example workshop</p><div class="map"><div class="gm-style">
      <div role="region" aria-label="Map"><div class="tiles">Runtime tile content</div></div>
      <a href="https://maps.google.com/maps?ll=-33.8651437,151.2099002&z=12&amp;t=m&amp;hl=en-AU&amp;mapclient=apiv3">Open this area in Google Maps</a>
    </div></div></main>`);
    const before = await page.locator('main').innerHTML();
    const captured = await capturePageHtml(page);
    const $ = load(captured);
    expect($('.gm-style iframe').attr('src')).toBe('https://maps.google.com/maps?ll=-33.8651437%2C151.2099002&z=12&t=m&hl=en-AU&output=embed');
    expect($('.gm-style iframe').attr('title')).toBe('Google Maps');
    expect($('.gm-style iframe').attr('data-blocks-engine-capture-visual-iframe-width')).toBe('640');
    expect($('.gm-style iframe').attr('data-blocks-engine-capture-visual-iframe-height')).toBe('320');
    expect($('.gm-style .tiles')).toHaveLength(0);
    expect(await page.locator('main').innerHTML()).toBe(before);
    const frozen = load(sanitizeFrozenHtml(captured));
    expect(frozen('.gm-style iframe').attr('src')).toBe('https://maps.google.com/maps?ll=-33.8651437%2C151.2099002&z=12&t=m&hl=en-AU&output=embed');

    mkdirSync('.tmp-test', { recursive:true });
    const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'google-map-'));
    mkdirSync(join(outputDir, 'html'));
    mkdirSync(join(outputDir, 'screenshots'));
    writeFileSync(join(outputDir, 'html', 'homepage.html'), captured);
    writeFileSync(join(outputDir, 'screenshots', 'manifest.json'), JSON.stringify({version:1, entries:{
      'https://example.test/': {slug:'homepage',html:'html/homepage.html'},
    }}));
    exportWebsiteCapture({outputDir,sourceUrl:'https://example.test/',platform:'unknown',summary:{},failures:[]});
    const portable = load(readFileSync(join(outputDir, 'website', 'index.html'), 'utf8'));
    expect(portable('iframe').attr('src')).toBe('https://maps.google.com/maps?ll=-33.8651437%2C151.2099002&z=12&t=m&hl=en-AU&output=embed');
    expect(portable('iframe').attr('width')).toBe('640');
    expect(portable('iframe').attr('height')).toBe('320');
    expect(portable('.tiles')).toHaveLength(0);
    const copy = await browser.newPage();
    await copy.route('https://maps.google.com/**', route => route.fulfill({contentType:'text/html',body:'<p>Map service</p>'}));
    await copy.setContent(portable.html());
    for (const width of [390,768,1440]) {
      await copy.setViewportSize({width,height:900});
      expect(await copy.locator('iframe').evaluate(frame => frame.getBoundingClientRect().width)).toBe(
        await copy.locator('.map').evaluate(owner => owner.getBoundingClientRect().width),
      );
      expect(await copy.locator('iframe').evaluate(frame => frame.getBoundingClientRect().height)).toBe(320);
    }
  } finally {
    await browser.close();
  }
});

it('uses each map own observed view and leaves hidden, conflicting and unlocated maps alone', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const link = (href:string) => `<a href="${href}">Open map</a>`;
    const map = (id:string, contents:string, style='') => `<div id="${id}" class="gm-style" style="width:280px;height:160px;${style}">${contents}</div>`;
    await page.setContent(`<!doctype html>
      ${link('https://maps.google.com/maps?ll=1,2&z=9')}
      ${map('unlocated', '<p>No location</p>')}
      ${map('spoofed', link('https://maps.google.com.evil.test/maps?ll=1,2'))}
      ${map('malformed', link('https://maps.google.com/maps?ll=,&z=10'))}
      ${map('out-of-range', link('https://maps.google.com/maps?ll=91,2'))}
      ${map('conflicting', link('https://maps.google.com/maps?ll=1,2')+link('https://maps.google.com/maps?ll=3,4'))}
      ${map('hidden', link('https://maps.google.com/maps?ll=1,2'), 'display:none')}
      ${map('transparent', link('https://maps.google.com/maps?ll=1,2'), 'opacity:0')}
      ${map('first', link('https://maps.google.com/maps?ll=51.5,-0.12&z=10'))}
      ${map('second', link('https://www.google.com/maps?ll=0,0&z=8'))}
    `);
    const captured = load(await capturePageHtml(page));
    expect(captured('iframe')).toHaveLength(2);
    expect(captured('#first iframe').attr('src')).toBe('https://maps.google.com/maps?ll=51.5%2C-0.12&z=10&output=embed');
    expect(captured('#second iframe').attr('src')).toBe('https://maps.google.com/maps?ll=0%2C0&z=8&output=embed');
    for (const id of ['unlocated','spoofed','malformed','out-of-range','conflicting','hidden','transparent']) {
      expect(captured(`#${id} iframe`)).toHaveLength(0);
      expect(captured(`#${id}`).html()).toBe(await page.locator(`#${id}`).innerHTML());
    }
  } finally {
    await browser.close();
  }
});
