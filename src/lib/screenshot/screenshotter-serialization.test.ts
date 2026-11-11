import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { capturePageHtml } from './screenshotter.js';
import { sanitizeFrozenHtml } from './freeze.js';
import { load } from 'cheerio';

describe('capturePageHtml stylesheet serialization', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  // One browser pass, two serializations; expected wall time is a few seconds.
  it('keeps unchanged font sheets intact and settles runtime measurements after CSSOM rewrites', async () => {
    const page = await browser.newPage();
    try {
      await page.route('https://fonts.example.test/fixture.woff2', route => route.fulfill({
        path: 'test/fixtures/resource-assets/roboto-latin-400-normal.woff2',
        contentType: 'font/woff2',
      }));
      await page.setContent(`<!doctype html><style id="font-sheet">
        /* Authored formatting must survive an unchanged CSSOM. */
        @font-face { font-family: Fixture; src: url(https://fonts.example.test/fixture.woff2); }
        #label { font: 40px Fixture, monospace; display: inline-block; white-space: nowrap; }
      </style><span id="label">Measured navigation</span><script>
        const label = document.querySelector('#label');
        const measure = () => {
          const range = document.createRange();
          range.selectNodeContents(label);
          label.style.width = range.getBoundingClientRect().width + 'px';
        };
        document.fonts.addEventListener('loading', measure);
        document.fonts.addEventListener('loadingdone', () => setTimeout(measure, 100));
        document.fonts.ready.then(measure);
        const sheet = document.querySelector('#font-sheet');
        new MutationObserver(records => {
          sheet.dataset.writes = String(Number(sheet.dataset.writes || 0) + records.length);
        }).observe(sheet, { childList: true, characterData: true, subtree: true });
      </script>`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(200);
      const webfontWidth = await page.locator('#label').evaluate(element => (element as HTMLElement).style.width);
      const authored = await page.locator('#font-sheet').textContent();
      const unchanged = load(await capturePageHtml(page));
      expect.soft(unchanged('#label').css('width')).toBe(webfontWidth);
      expect.soft(await page.locator('#font-sheet').getAttribute('data-writes')).toBeNull();
      expect.soft(unchanged('#font-sheet').text()).toBe(authored);

      await page.evaluate(() => {
        (document.querySelector('#font-sheet') as HTMLStyleElement).sheet!.insertRule('#label { color: rgb(1, 2, 3); }');
        const sheet = new CSSStyleSheet();
        sheet.replaceSync('#label { background-color: rgb(4, 5, 6); }');
        document.adoptedStyleSheets = [sheet];
        // Model a runtime that updates geometry on a later task after font readiness.
        document.fonts.addEventListener('loadingdone', () => {
          document.querySelector<HTMLElement>('#label')!.style.width = '1px';
        });
      });
      const mutated = load(await capturePageHtml(page));
      expect(mutated('#font-sheet').text()).toContain('color: rgb(1, 2, 3)');
      expect(mutated('[data-blocks-engine-capture-constructed-stylesheet]').text()).toContain('background-color: rgb(4, 5, 6)');
      expect(mutated('#label').css('width')).toBe(webfontWidth);
    } finally { await page.close(); }
  });

  it('omits runtime styles with no matching selectors and records byte and rule evidence', async () => {
    const page = await browser.newPage();
    try {
      const server = '<!doctype html><html><head></head><body><main><p>Body</p></main></body></html>';
      await page.setContent(server);
      await page.evaluate(() => {
        const prefix = `W_${Date.now()}_`;
        const style = document.createElement('style');
        style.textContent = `span.${prefix}grid{width:100%}span.${prefix}grid .${prefix}hd{height:55px}`;
        document.head.append(style);
      });
      const diagnostics: Array<{code:string;reason:string}> = [];
      const html = await capturePageHtml(page, diagnostics, server);
      expect(html).not.toContain('W_');
      expect(diagnostics).toContainEqual(expect.objectContaining({code:'runtime_stylesheet_omitted', reason:expect.stringMatching(/bytes, 2 rules/)}));
      await page.setContent(server.replace('<main>', '<main><span class="W_placeholder_grid">'));
      await page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = 'span.W_placeholder_grid{width:100%}';
        document.head.append(style);
      });
      expect(await capturePageHtml(page, [], server)).toContain('W_placeholder_grid');
    } finally { await page.close(); }
  });

  it('preserves adjacent runtime text-node shaping through HTML and frozen serialization without mutating the source', async () => {
    const source = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const copy = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await source.setContent(`<!doctype html><style>
        p { font: 12px/16px ui-sans-serif, system-ui, sans-serif; margin: 0; }
      </style><p></p><textarea></textarea><script type="application/json"></script>`);
      await source.evaluate(() => {
        document.querySelector('p')!.append('© ', '2026', ' Example Behavioral Consulting Group. All rights reserved.');
        document.querySelector('textarea')!.append('editable ', 'value');
        document.querySelector('script')!.append('{"value":', '1}');
      });
      const nodes = await source.locator('p').evaluate(element => Array.from(element.childNodes).map(node => ({ type: node.nodeType, text: node.textContent })));
      const html = await capturePageHtml(source);
      for (const width of [390, 768, 1440]) {
        await source.setViewportSize({ width, height: 900 });
        await copy.setViewportSize({ width, height: 900 });
        const expected = await source.locator('p').screenshot();
        for (const serialized of [html, sanitizeFrozenHtml(html)]) {
          await copy.setContent(serialized);
          expect((await copy.locator('p').screenshot()).equals(expected), `${width}px serialized text paints exactly like the independent live DOM`).toBe(true);
          expect(await copy.locator('p').evaluate(element => Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent)))
            .toEqual(['© ', '2026', ' Example Behavioral Consulting Group. All rights reserved.']);
          expect(await copy.locator('textarea').inputValue()).toBe('editable value');
        }
      }
      expect(await source.locator('p').evaluate(element => Array.from(element.childNodes).map(node => ({ type: node.nodeType, text: node.textContent })))).toEqual(nodes);
      expect(html).toContain('<script type="application/json">{"value":1}</script>');
      expect(html).toMatch(/<textarea[^>]*>editable value<\/textarea>/);
    } finally {
      await source.close();
      await copy.close();
    }
  });

  it('records a quirks-mode source on the captured root', async () => {
    const page = await browser.newPage();
    try {
      for (const [doctype, expected] of [['<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">', 'BackCompat'], ['', 'BackCompat'], ['<!DOCTYPE html>', null]] as const) {
        await page.setContent(`${doctype}<html><body><p><font size="-2">Line</font></p></body></html>`);
        const root = load(await capturePageHtml(page))('html');
        expect(root.attr('data-blocks-engine-capture-compat-mode') ?? null, doctype || 'no DOCTYPE').toBe(expected);
      }
    } finally {
      await page.close();
    }
  });

  it('keeps script-built paragraph letters parser-stable and restores the live elements', async () => {
    const source = await browser.newPage();
    const copy = await browser.newPage({ javaScriptEnabled: false });
    try {
      await source.setContent(`<!doctype html><style>
        .lead { font: 700 64px/1 serif; }
      </style><p class="lead"></p><script>
        for (const letter of 'Hello') {
          const element = document.createElement('div');
          element.style.display = 'inline-block';
          element.dataset.letter = letter;
          element.textContent = letter;
          document.querySelector('.lead').append(element);
        }
        const block = document.createElement('div');
        block.id = 'block';
        const nested = document.createElement('section');
        nested.textContent = 'Text';
        block.append(nested);
        document.querySelector('.lead').append(block);
      </script>`);
      const originals = await source.locator('p.lead').evaluateHandle(element => Array.from(element.querySelectorAll('*')));
      const before = await source.locator('p.lead').innerHTML();
      const html = await capturePageHtml(source);
      await copy.setContent(html);
      expect(await copy.locator('[data-letter]').count()).toBe(5);
      expect(await copy.locator('[data-letter]').evaluateAll(elements => elements.map(element => ({
        inside: element.parentElement?.matches('p.lead'),
        fontSize: getComputedStyle(element).fontSize,
        display: getComputedStyle(element).display,
        tag: element.localName,
        letter: element.textContent,
      })))).toEqual(Array.from('Hello', letter => ({ inside: true, fontSize: '64px', display: 'inline-block', tag: 'span', letter })));
      expect(await copy.locator('p.lead > #block > span').textContent()).toBe('Text');
      expect(await copy.locator('#block').evaluate(element => getComputedStyle(element).display)).toBe('block');
      expect(await copy.locator('#block > span').evaluate(element => getComputedStyle(element).display)).toBe('block');
      expect(await source.locator('p.lead').innerHTML()).toBe(before);
      expect(await source.locator('p.lead').evaluate((element, nodes) =>
        Array.from(element.querySelectorAll('*')).every((node, index) => node === nodes[index]), originals)).toBe(true);
      await originals.dispose();
    } finally {
      await source.close();
      await copy.close();
    }
  });

  it('preserves rendered image geometry when localization changes intrinsic dimensions', async () => {
    const source = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const copy = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const svg = (width: number, height: number) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="red"/></svg>`;
    await source.route('https://source.example.test/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg(900, 581) }),
    );
    await copy.route('https://local.example.test/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg(1000, 581) }),
    );
    try {
      await source.setContent(`<!doctype html><style>
        .owner { width: 554px; }
        .owner img { display: block; width: 100%; aspect-ratio: auto 900 / 581; }
      </style><div class="owner"><img src="https://source.example.test/a.svg"></div>`);
      await source.locator('img').evaluate((image) => (image as HTMLImageElement).decode());
      const sourceHeight = await source.locator('img').evaluate((image) => image.getBoundingClientRect().height);
      const html = await capturePageHtml(source);
      expect(html).toMatch(/<img[^>]+style="[^"]*aspect-ratio:\s*\d+(?:\.\d+)?\s*\/\s*\d+/);
      expect(html).not.toMatch(/<img[^>]+style="[^"]*aspect-ratio:\s*auto/);

      await copy.setContent(html.replaceAll('https://source.example.test/a.svg', 'https://local.example.test/a.svg'));
      await copy.locator('img').evaluate((image) => (image as HTMLImageElement).decode());
      const copyHeight = await copy.locator('img').evaluate((image) => image.getBoundingClientRect().height);
      expect(copyHeight).toBeCloseTo(sourceHeight, 1);
    } finally {
      await source.close();
      await copy.close();
    }
  });

  it('keeps an authored fixed image ratio responsive when its owner grows beyond capture width', async () => {
    const source = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const copy = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const image = '<svg xmlns="http://www.w3.org/2000/svg" width="542" height="104"><rect width="542" height="104" fill="red"/></svg>';
    for (const page of [source, copy]) {
      await page.route('https://cdn.example.test/logo.svg', (route) =>
        route.fulfill({ status: 200, contentType: 'image/svg+xml', body: image })
      );
    }
    try {
      await source.setContent(`<!doctype html><style>
        .owner { width: calc((100vw - 96px) / 3); }
        .owner img { width: auto; height: 104px; max-width: 100%; aspect-ratio: 542 / 104; }
      </style><div class="owner"><img src="https://cdn.example.test/logo.svg"></div>`);
      await source.locator('img').evaluate((element) => (element as HTMLImageElement).decode());
      const html = await capturePageHtml(source);
      await copy.setContent(html);
      await copy.locator('img').evaluate((element) => (element as HTMLImageElement).decode());

      for (const width of [1440, 1600, 1728]) {
        await source.setViewportSize({ width, height: 900 });
        await copy.setViewportSize({ width, height: 900 });
        const expected = await source.locator('img').evaluate((element) => element.getBoundingClientRect().width);
        const actual = await copy.locator('img').evaluate((element) => element.getBoundingClientRect().width);
        expect(actual, `${width}px preserves the authored ratio under a fluid owner`).toBeCloseTo(expected, 0);
      }
    } finally {
      await source.close();
      await copy.close();
    }
  });

  it('keeps a var() animation shorthand whose re-spaced selector collapsed to empty longhands', async () => {
    const source = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const copy = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      // Chromium serializes this selector as `.a :is(#x, [id^="x__"])` and the shorthand,
      // followed by its own animation-composition / animation-timeline longhands, as empty longhands.
      await source.setContent(`<!doctype html><style>@keyframes enter{from{opacity:0}to{opacity:1}}
.a{--anim:enter 1s linear 0s 1 paused both}
.a :is(#x,[id^="x__"]){animation:var(--anim);animation-composition:replace;animation-timeline:auto}</style>
<div class="a"><p id="x">Hero</p></div>`);
      expect(await source.evaluate(() => Array.from(document.styleSheets[0].cssRules).map(rule => rule.cssText).join('\n'))).toContain('animation-name: ;');
      const html = await capturePageHtml(source);
      expect(html).toContain('animation:var(--anim)');
      expect(html).not.toContain('animation-name: ;');
      await copy.setContent(html);
      expect(await copy.locator('#x').evaluate(element => getComputedStyle(element).animationName)).toBe('enter');
    } finally {
      await source.close();
      await copy.close();
    }
  });

  it('preserves linked stylesheet source text and responsive layout', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.setContent(`
      <style data-href="https://cdn.example.test/forms.css">.grid{display:grid;grid-template-columns:repeat(12,1fr)}@media(max-width:500px){.field{grid-column:1 / span 12;width:100%}}</style>
      <form class="grid"><input class="field"></form>
    `);
    const before = await page.locator('.field').evaluate((element) => element.getBoundingClientRect().width);
    const html = await capturePageHtml(page);
    const after = await page.locator('.field').evaluate((element) => element.getBoundingClientRect().width);
    expect(after).toBe(before);
    expect(html).toContain('.grid{display:grid;grid-template-columns:repeat(12,1fr)}@media(max-width:500px){.field{grid-column:1 / span 12;width:100%}}');
    await page.close();
  });

  it('omits empty custom elements that neither paint nor shape layout, and keeps the live page intact', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.setContent(`
      <style>cookie-manager{display:block;width:100px;height:100px}.slot{display:flex;width:100px;height:100px}</style>
      <main><p>a</p><cookie-manager ready="1"></cookie-manager><p>b</p>
      <div class="slot"><cookie-manager ready="2"></cookie-manager></div>
      <text-widget>Hello</text-widget>
      <spacer-box style="display:block;height:40px"></spacer-box><p>c</p>
      <painted-box style="display:block;width:10px;height:10px;background:red;position:absolute"></painted-box>
      <shadow-card style="position:absolute"></shadow-card>
      <svg><font-face></font-face></svg></main>
    `);
    await page.evaluate(() => {
      document.querySelector('shadow-card')!.attachShadow({ mode: 'open' }).innerHTML = '<p style="margin:0">Card</p>';
    });
    const liveBefore = await page.evaluate(() => document.querySelector('main')!.innerHTML);

    const html = await capturePageHtml(page);

    // The first cookie-manager pushes <p>b</p> down, so it shapes layout and stays;
    // the second sits in a parent that keeps its own size, so it is left out.
    expect(html.match(/<cookie-manager/g)).toHaveLength(1);
    expect(html).toContain('<cookie-manager ready="1">');
    expect(html).toContain('<div class="slot"></div>');
    expect(html).toContain('<text-widget>Hello</text-widget>');
    expect(html).toContain('<spacer-box');
    expect(html).toContain('<painted-box');
    expect(html).toContain('<shadow-card');
    expect(html).toContain('<font-face>');
    expect(await page.evaluate(() => document.querySelector('main')!.innerHTML)).toBe(liveBefore);
    await page.close();
  });

  it('writes the loaded image onto a placeholder or density-list src after hydration', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    await page.route('https://cdn.example.test/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: png })
    );
    const placeholder = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    await page.setContent(`<!doctype html><html><body style="height:2400px">
      <picture>
        <source media="(min-width: 0px)" srcset="https://cdn.example.test/item-1.jpg 1x, https://cdn.example.test/item-1-2x.jpg 2x">
        <img id="gallery" alt="Item 1" src="https://cdn.example.test/item-1.jpg 1x, https://cdn.example.test/item-1-2x.jpg 2x">
      </picture>
      <img id="kept" alt="Item 3" src="https://cdn.example.test/kept.jpg">
      <img id="lazy" alt="Item 2" style="margin-top:1800px" src="${placeholder}" data-src="https://cdn.example.test/item-2.jpg">
      <script>
        addEventListener('scroll', () => {
          const image = document.getElementById('lazy');
          if (!image || image.dataset.hydrated) return;
          const picture = document.createElement('picture');
          const source = document.createElement('source');
          source.srcset = image.getAttribute('data-src');
          image.replaceWith(picture);
          picture.append(source, image);
          image.dataset.hydrated = 'true';
        }, { once: true });
      </script>
    </body></html>`);
    await page.evaluate(() => window.scrollTo(0, 2000));
    await page.waitForFunction(() => document.getElementById('lazy')?.dataset.hydrated === 'true');
    await page.locator('#gallery').evaluate((image) => (image instanceof HTMLImageElement ? image.decode().catch(() => undefined) : undefined));

    const html = await capturePageHtml(page);

    expect(html).toMatch(/<img id="gallery"[^>]*src="https:\/\/cdn\.example\.test\/item-1\.jpg"/);
    expect(html).not.toMatch(/<img id="gallery"[^>]*\ssrc="[^"]*\s1x/);
    expect(html).toContain('srcset="https://cdn.example.test/item-1.jpg 1x, https://cdn.example.test/item-1-2x.jpg 2x"');
    expect(html).toContain('src="https://cdn.example.test/item-2.jpg"');
    expect(html).not.toContain('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=');
    expect(html).toContain('src="https://cdn.example.test/kept.jpg"');
    expect(await page.locator('#gallery').getAttribute('src')).toContain('1x,');
    await page.close();
  });

  it('paints the data-bg image of a lazy background the source never loaded', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    const gif = 'data:image/gif;id=1;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
    await page.setContent(`<!doctype html><html><head><base href="https://site.example.test/"></head><body>
      <div id="placeholder" class="lazy" data-bg="/media/card.jpg" style="background-image:url(&quot;${gif}&quot;);background-size:cover"></div>
      <div id="unentered" class="lazy" data-bg="https://cdn.example.test/tile.webp"></div>
      <div id="loaded" class="lazy" data-bg="/media/other.jpg" style="background-image:url(/media/loaded.jpg)"></div>
    </body></html>`);
    const liveBefore = await page.evaluate(() => document.body.innerHTML);

    const doc = load(await capturePageHtml(page));

    expect(doc('#placeholder').attr('style')).toContain('background-image: url("https://site.example.test/media/card.jpg")');
    expect(doc('#placeholder').attr('style')).toContain('background-size: cover');
    expect(doc('#unentered').attr('style')).toContain('background-image: url("https://cdn.example.test/tile.webp")');
    expect(doc('#loaded').attr('style')).toContain('/media/loaded.jpg');
    expect(await page.evaluate(() => document.body.innerHTML)).toBe(liveBefore);
    await page.close();
  });
});
