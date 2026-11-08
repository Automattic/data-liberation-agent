import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { mergeConsentLayouts } from '../consent-banner-layout.js';
import { dismissOverlays } from './page-helpers.js';

it('opens outer bounds and merges only adjacent identical observations in viewport order', () => {
  expect(mergeConsentLayouts([
    { min_width: 1440, max_width: 1440, direction: 'row', button_align: 'end' },
    { min_width: 402, max_width: 402, direction: 'column', button_align: 'end' },
    { min_width: 768, max_width: 768, direction: 'row', button_align: 'end' },
  ])).toEqual([
    { max_width: 402, direction: 'column', button_align: 'end' },
    { min_width: 768, direction: 'row', button_align: 'end' },
  ]);
  expect(mergeConsentLayouts([
    { min_width: 402, max_width: 402, direction: 'row' },
    { min_width: 768, max_width: 768, direction: 'column' },
    { min_width: 1440, max_width: 1440, direction: 'row' },
  ])).toEqual([
    { max_width: 402, direction: 'row' },
    { min_width: 768, max_width: 768, direction: 'column' },
    { min_width: 1440, direction: 'row' },
  ]);
  expect(mergeConsentLayouts([{ min_width: 1440, max_width: 1440, direction: 'row' }]))
    .toEqual([{ direction: 'row' }]);
  expect(mergeConsentLayouts([
    { max_width: 414, direction: 'column' },
    { min_width: 415, direction: 'row' },
    { min_width: 1440, max_width: 1440, direction: 'row' },
  ])).toEqual([{ max_width: 414, direction: 'column' }, { min_width: 415, direction: 'row' }]);
});

it('keeps otherwise identical layouts distinct when message margins differ', () => {
  expect(mergeConsentLayouts([
    { min_width: 390, max_width: 390, direction: 'row', text_margin: '0px 0px 15px' },
    { min_width: 414, max_width: 414, direction: 'row', text_margin: '0px 0px 15px' },
    { min_width: 415, max_width: 415, direction: 'row', text_margin: '0px 15px 0px 0px' },
    { min_width: 1440, max_width: 1440, direction: 'row', text_margin: '0px 15px 0px 0px' },
  ])).toEqual([
    { max_width: 414, direction: 'row', text_margin: '0px 0px 15px' },
    { min_width: 415, direction: 'row', text_margin: '0px 15px 0px 0px' },
  ]);
});

// A consent platform (Usercentrics) renders its banner in the shadow tree of
// an empty host placed after the page content: nothing is parked off-screen.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('reads a shadow-hosted banner without waiting for an entrance', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(`<main style="min-height:1200px"><h1>Page title</h1></main><aside id="usercentrics-cmp-ui"></aside><script>document.querySelector('aside').attachShadow({ mode: 'open' }).innerHTML = '<div style="position:fixed;left:0;right:0;bottom:0;height:240px;padding:24px;background:#fff"><p>This site uses cookies to analyse traffic.</p><button onclick="this.getRootNode().host.remove()">Accept All</button></div>'</script>`);
    const started = Date.now();
    const dismissed = await dismissOverlays(page);
    expect(dismissed.map(item => [item.kind, item.selector])).toEqual([['consent', 'aside#usercentrics-cmp-ui']]);
    // The settle loop's budget is 1.5 s; reading this banner needs none of it.
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    await browser.close();
  }
});

// Regression for builder card banners (GoDaddy): a heading title above block-flow
// prose, a stretched control, and a card that slides in by transform to rest at
// one edge on desktop but spans the viewport on mobile.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('reads a titled card banner with its resting edge, width and stretched control', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(`<style>.banner{position:fixed;right:0;bottom:-500px;width:400px;margin:24px;box-sizing:border-box;padding:24px;background:#898989;border-radius:7px;box-shadow:0 2px 6px rgba(0,0,0,.3);color:#000;transition:transform .3s}.banner.in{transform:translateY(-500px)}.banner h4{margin:0;padding-bottom:8px;font-size:22px;line-height:27.5px}.banner p{margin:0 0 16px;font-size:16px}.banner button{display:block;width:100%;min-height:40px;margin:24px 0 4px;font-weight:700;letter-spacing:1px}@media (max-width:767px){.banner{left:0;width:auto;margin:0;border-radius:0}}</style><main style="min-height:1200px"><h1>Page title</h1></main><div class="banner" id="cookie-banner"><h4>This website uses cookies.</h4><p>We use cookies to analyze website traffic.</p><button onclick="this.parentNode.remove()">ACCEPT</button></div><script>requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector('.banner').classList.add('in')))</script>`);
    const dismissed = await dismissOverlays(page, { consentViewports: [{ width: 390, height: 844 }] });
    const banner = dismissed.find(item => item.consentBanner)?.consentBanner;
    expect(banner?.title).toBe('This website uses cookies.');
    expect(banner?.text).toBe('We use cookies to analyze website traffic.');
    expect(banner?.presentation).toMatchObject({ edge_offset: '24px', font_size: '16px', box_shadow: 'rgba(0, 0, 0, 0.3) 0px 2px 6px 0px', title: { font_size: '22px', line_height: '27.5px', margin: '0px', padding: '0px 0px 8px' },
      button: { font_weight: '700', letter_spacing: '1px', min_height: '40px', margin: '24px 0px 4px' } });
    expect(banner?.presentation?.layout).toEqual([
      expect.objectContaining({ direction: 'column', button_align: 'stretch', span: 'full', edge_offset: '0px' }),
      expect.objectContaining({ direction: 'column', button_align: 'stretch', span: 'inset', inline: 'end', width: 400, inline_offset: 24, edge_offset: '24px', border_radius: '7px' }),
    ]);
  } finally {
    await browser.close();
  }
});

// Multi-level consent dialogs (Cookiebot shape): a display-font heading over
// body copy, a screen-reader legend, category toggles, a logo link and several
// opt-in buttons. The message is the heading and body, set in the body's type;
// "Accept all" is the accept control and the logo is not a policy link.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('reads a multi-level consent dialog as its message and accept-all control', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(`<style>#CookieDialog{position:fixed;top:200px;left:220px;width:1000px;z-index:1000;background:#fff;font:15px Arial,sans-serif;border-radius:16px}
      h2{font:23px Georgia,serif;margin:0}.body{font-size:14px}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}</style>
      <main><h1>Page title</h1><p>${'Ordinary page copy. '.repeat(60)}</p></main>
      <div id="CookieDialog" role="dialog"><a href="https://vendor.example/about-consent" aria-label="Vendor - opens in a new window"><svg width="80" height="20"></svg></a>
      <h2>This website uses cookies</h2><span class="body">We use cookies to personalise content and ads and to analyse our traffic.</span>
      <fieldset><span class="sr">Consent Selection</span><label><input type="checkbox" checked> Necessary</label><label><input type="checkbox"> Marketing</label></fieldset>
      <button>Decline</button><button>Allow selection</button><button>Accept all</button></div>`);
    const dismissed = await dismissOverlays(page);
    const banner = dismissed.find(item => item.consentBanner)?.consentBanner;
    expect(banner?.title).toBe('This website uses cookies');
    expect(banner?.text).toBe('We use cookies to personalise content and ads and to analyse our traffic.');
    expect(banner?.presentation?.font_size).toBe('14px');
    expect(banner?.presentation?.font_family).toBe('Arial, sans-serif');
    expect(banner?.accept_label).toBe('Accept all');
    expect(banner?.reject_label).toBe('Decline');
    expect(banner?.policy_link).toBeUndefined();
  } finally {
    await browser.close();
  }
});

// One Chromium session (~1 second): a transparent full-viewport wrapper must not
// obscure the painted panel, and inline links must remain part of the prose.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('reads a painted panel inside a transparent wrapper and preserves inline link labels', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const fixture = readFileSync(new URL('./fixtures/consent-panel.html', import.meta.url), 'utf8');
    await page.setContent(fixture.replace('</style>', '#cs-banner .cs-panel{background:rgb(3,26,78)}#cs-banner .cs-text{color:#f8f8f8}</style>'));
    const dismissed = await dismissOverlays(page);
    const banner = dismissed.find(item => item.consentBanner)?.consentBanner;
    expect(banner?.text).toBe('We collect personal information as specified in the privacy policy and use cookies as specified in the cookie policy. You can change your choice in the preferences panel.');
    expect(banner?.position).toBe('bottom');
    expect(banner?.presentation?.span).toBe('inset');
    expect(banner?.presentation?.edge_offset).toBe('16px');
    expect(banner?.presentation?.padding).toBe('24px');
    expect(banner?.colors?.background).toBe('rgb(3, 26, 78)');
    expect(banner?.colors?.text).toBe('rgb(248, 248, 248)');
    expect(banner?.accept_label).toBe('Accept');
    expect(banner?.reject_label).toBe('Reject');
  } finally {
    await browser.close();
  }
});

// One Chromium session (~1 second), through the real readConsentBanner path.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('reads consent controls independently of their language and anchor fragments', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    // A real document URL matters: on about:blank, fragment anchors do not
    // resolve to HTTP(S), so the original misclassification would go unnoticed.
    await page.route('https://example.com/page', route => route.fulfill({ body: '<main>Page title</main>', contentType: 'text/html' }));
    await page.goto('https://example.com/page');
    const policy = { label: 'Privacy', href: 'https://example.com/privacy' };
    for (const fixture of [
      {
        controls: `<a href="https://www.dgti.uerj.br/politica-de-privacidade/" id="CONSTANT_OPEN_URL" target="_blank" class="medium cli-plugin-button cli-plugin-main-link">Política de Privacidade</a>
          <a id="wt-cli-accept-all-btn" tabindex="0" role="button" data-cli_action="accept_all" class="wt-cli-element medium cli-plugin-button wt-cli-accept-all-btn cookie_action_close_header cli_action_button">Aceitar Cookies</a>`,
        accept: 'Aceitar Cookies',
        policy: { label: 'Política de Privacidade', href: 'https://www.dgti.uerj.br/politica-de-privacidade/' },
      },
      ...['#', '#accept', 'https://example.com/page#accept', 'javascript:void(0)', 'https://example.com/accept'].map(href => ({
        controls: `<a href="${href}">Got it</a><a href="https://example.com/privacy">Privacy</a>`,
        accept: 'Got it', policy,
      })),
    ]) {
      await page.setContent(`<style>
        #cookie-law-info-bar { position:fixed;bottom:0;left:0;width:100%;padding:20px;background:white }
      </style><main><h1>Page title</h1></main>
      <div id="cookie-law-info-bar"><span><div class="cli-bar-container cli-style-v2">
        <div class="cli-bar-message">Usamos cookies … Ao clicar em “Aceitar Cookies” …</div>
        <div class="cli-bar-btn_container">${fixture.controls}</div>
      </div></span></div>`);
      const dismissed = await dismissOverlays(page);
      const banner = dismissed.find(item => item.consentBanner)?.consentBanner;
      expect(banner?.accept_label).toBe(fixture.accept);
      expect(banner?.policy_link).toEqual(fixture.policy);
    }
  } finally {
    await browser.close();
  }
});

// One Chromium session (~1 second) covers border omission, gaps and margin-only bisection.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('omits invisible borders and bisects margin-only layout changes', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 768, height: 900 } });
    const fixture = readFileSync(new URL('./fixtures/consent-banner.html', import.meta.url), 'utf8');
    for (const [border, gap, expectedGap] of [
      ['none', 'normal', '0px'],
      ['0px solid red', '8px', '8px'],
      ['none', 'normal 8px', '0px 8px'],
    ]) {
      await page.setContent(fixture.replace('</style>', `
        .cc-window { flex-direction:row; align-items:center; gap:${gap} }
        .cc-window button { border:${border}; align-self:auto !important }
      </style>`));
      const dismissed = await dismissOverlays(page, { consentViewports: [{ width: 390, height: 844 }] });
      const presentation = dismissed.find(item => item.consentBanner)?.consentBanner?.presentation;
      // The inset stays near zero even while the slide-in transform moves the box.
      expect(presentation?.edge_offset).toBe('0px');
      expect(presentation?.padding).toBe('12px');
      expect(presentation?.button?.padding).toBe('8px 40px');
      expect(presentation?.gap).toBe(expectedGap);
      expect(presentation?.button).toBeDefined();
      for (const field of ['border_width', 'border_style', 'border_color']) {
        expect(presentation?.button).not.toHaveProperty(field);
      }
      expect(presentation?.layout).toEqual([
        { max_width: 414, direction: 'row', align_items: 'center', button_align: 'end', text_margin: '0px 0px 15px', edge_offset: '0px', span: 'full' },
        { min_width: 415, direction: 'row', align_items: 'center', button_align: 'end', text_margin: '0px 15px 0px 0px', edge_offset: '0px', span: 'full' },
      ]);
    }
  } finally {
    await browser.close();
  }
});

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
    const result = await captureScreenshots({ urls: [url, `${url}other`, `${url}privacy`], primaryUrl: url, outputDir, concurrency: 1, deviceMode: 'dual', viewports: [
      { id: 'desktop', width: 1440, height: 900 }, { id: 'mobile', width: 390, height: 844 },
    ] });
    expect(result.failed).toBe(0);
    const exportSite = () => exportWebsiteCapture({ outputDir, sourceUrl: url, platform: 'default', summary: {
      routesDiscovered: 3, routesCaptured: result.captured, routesSkipped: result.skipped,
      routesFailed: result.failed, durationMs: result.durationMs,
    }, failures: [] });
    exportSite();
    const fact = JSON.parse(readFileSync(join(outputDir, 'website/consent-banner.json'), 'utf8'));
    expect(fact).toEqual({ schema: 'static-site-importer/consent-banner/v1',
      text: 'This website uses cookies for analytics.', accept_label: 'Accept', reject_label: 'Reject',
      policy_link: { label: 'Privacy policy', href: '/privacy/index.html' }, position: 'bottom',
      colors: { background: 'rgb(34, 34, 34)', text: 'rgb(255, 255, 255)', button_background: 'rgb(153, 153, 153)', button_text: 'rgb(255, 255, 255)' },
      presentation: {
        span: 'full', edge_offset: '0px', padding: '12px', gap: '8px',
        font_family: 'Calibri, sans-serif', font_size: '15px', line_height: '18px', text_margin: '0px 15px 0px 0px',
        layout: [
          { max_width: 414, direction: 'column', align_items: 'stretch', button_align: 'end', text_margin: '0px 0px 15px', edge_offset: '0px', span: 'full' },
          { min_width: 415, direction: 'row', align_items: 'center', button_align: 'end', text_margin: '0px 15px 0px 0px', edge_offset: '0px', span: 'full' },
        ],
        button: { border_radius: '5px', border_width: '2px', border_style: 'solid', border_color: 'rgb(255, 255, 255)', padding: '8px 40px', font_size: '13.5px', font_family: 'Calibri, sans-serif', line_height: '16.2px', font_weight: '400' },
      },
      source_selector: 'div.cc-window.cc-banner',
    });
    for (const route of ['index.html', 'other/index.html', 'privacy/index.html']) {
      expect(readFileSync(join(outputDir, 'website', route), 'utf8')).not.toContain('This website uses cookies');
    }
    const receipt = JSON.parse(readFileSync(join(outputDir, 'capture-receipt.json'), 'utf8'));
    expect(receipt.discoveryDiagnostics).toContainEqual(expect.objectContaining({ code: 'consent_banner_differs', url: `${url}other` }));
    // Republishing without consent evidence must not retain a stale site-level fact.
    const manifestPath = join(outputDir, 'screenshots/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.entries[url].dismissed[0].kind).toBe('consent');
    // The same export keeps an uncaptured policy URL absolute.
    const uncapturedPolicyUrl = `${url}uncaptured-policy`;
    for (const entry of Object.values(manifest.entries) as Array<{ dismissed: Array<{ consentBanner?: { policy_link?: { href: string } } }> }>) {
      for (const overlay of entry.dismissed) {
        if (overlay.consentBanner?.policy_link) overlay.consentBanner.policy_link.href = uncapturedPolicyUrl;
      }
    }
    writeFileSync(manifestPath, JSON.stringify(manifest));
    exportSite();
    expect(JSON.parse(readFileSync(join(outputDir, 'website/consent-banner.json'), 'utf8')).policy_link.href).toBe(uncapturedPolicyUrl);
    for (const entry of Object.values(manifest.entries) as Array<{ dismissed: unknown[] }>) entry.dismissed = [];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    exportSite();
    expect(existsSync(join(outputDir, 'website/consent-banner.json'))).toBe(false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(outputDir, { recursive: true, force: true });
  }
}, 60_000);
