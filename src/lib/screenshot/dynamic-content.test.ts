import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { assessBody, expandCollapsedContent, hydrateDisclosureContent, waitForAppWidgets, readPngHeight, classifyEmptyBodies, KNOWN_WIDGETS, type PageStat } from './dynamic-content.js';
import { extractFaqsFromHtml } from '../replicate/faq-extract.js';
import { wireCapturedDialogs } from '../static-dialogs.js';

// Fictional content only (no source-site data).
const wrap = (bodyInner: string) =>
  `<html><body><header><nav>Home Shop About</nav></header>${bodyInner}<footer>(c) Acme Co</footer></body></html>`;

describe('assessBody (Phase 0)', () => {
  it('passes a page with real main content', () => {
    const html = wrap(`<main>${'Lorem ipsum dolor sit amet consectetur. '.repeat(20)}</main>`);
    expect(assessBody(html)).toMatchObject({ empty: false, reason: 'ok' });
  });

  it('flags a cross-origin iframe body as empty/iframe', () => {
    const html = wrap('<main><iframe src="https://help.widget-app.example/embed"></iframe></main>');
    expect(assessBody(html, 'https://shop.example')).toMatchObject({ empty: true, reason: 'iframe' });
  });

  it('does NOT treat a same-origin iframe as the cross-origin case', () => {
    const html = wrap('<main><iframe src="https://shop.example/embed"></iframe></main>');
    expect(assessBody(html, 'https://shop.example').reason).not.toBe('iframe');
  });

  it('flags a known empty content widget (Loox) by name', () => {
    const html = wrap('<main><div id="looxReviews"></div></main>');
    expect(assessBody(html)).toMatchObject({ empty: true, reason: 'app-widget', detail: 'loox' });
  });

  it('flags a chrome-only page (header to footer, no body) as empty', () => {
    const html = '<html><body><header><nav>Home</nav></header><footer>(c) Acme</footer></body></html>';
    expect(assessBody(html).empty).toBe(true);
  });

  it('reports a thin body as reason "thin"', () => {
    expect(assessBody(wrap('<main>tiny</main>'))).toMatchObject({ empty: true, reason: 'thin' });
  });
});

describe('readPngHeight (rendered-height signal)', () => {
  it('reads height from a PNG IHDR without decoding', () => {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(0x89504e47, 0);
    buf.writeUInt32BE(0x0d0a1a0a, 4);
    buf.writeUInt32BE(13, 8);
    buf.write('IHDR', 12);
    buf.writeUInt32BE(800, 16); // width
    buf.writeUInt32BE(630, 20); // height
    const p = join(tmpdir(), `dla-png-${process.pid}.png`);
    writeFileSync(p, buf);
    expect(readPngHeight(p)).toBe(630);
    rmSync(p);
  });

  it('returns null for a missing file or non-PNG', () => {
    expect(readPngHeight('/no/such/file.png')).toBeNull();
    const p = join(tmpdir(), `dla-notpng-${process.pid}.txt`);
    writeFileSync(p, 'not a png at all');
    expect(readPngHeight(p)).toBeNull();
    rmSync(p);
  });

  it('rejects a corrupt/implausible height (would otherwise poison the page-set median)', () => {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(0x89504e47, 0);
    buf.writeUInt32BE(0x0d0a1a0a, 4);
    buf.writeUInt32BE(13, 8);
    buf.write('IHDR', 12);
    buf.writeUInt32BE(800, 16);
    buf.writeUInt32BE(0xffffffff, 20); // garbage huge height
    const p = join(tmpdir(), `dla-png-huge-${process.pid}.png`);
    writeFileSync(p, buf);
    expect(readPngHeight(p)).toBeNull();
    rmSync(p);
  });

  it('returns null when the first chunk is not IHDR (valid signature, junk chunk)', () => {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(0x89504e47, 0);
    buf.write('JUNK', 12); // not IHDR
    buf.writeUInt32BE(630, 20);
    const p = join(tmpdir(), `dla-png-junk-${process.pid}.png`);
    writeFileSync(p, buf);
    expect(readPngHeight(p)).toBeNull();
    rmSync(p);
  });
});

describe('classifyEmptyBodies (Phase 0 page-set decision)', () => {
  // A page-set median of ~3000px: tall content pages plus a few short ones.
  const stat = (slug: string, height: number | null, mainTextLen: number, over?: Partial<PageStat['assess']>): PageStat => ({
    slug,
    height,
    assess: { empty: mainTextLen < 200, reason: 'ok', widget: null, crossOriginIframe: false, mainTextLen, ...over },
  });

  it('flags a chrome-only page (short render, thin text) and not the tall content pages', () => {
    const stats = [stat('home', 3200, 5000), stat('about', 2800, 4000), stat('faqs', 639, 326)];
    const flagged = classifyEmptyBodies(stats);
    expect(flagged.map((f) => f.slug)).toEqual(['faqs']);
    expect(flagged[0].reason).toBe('short-render');
    expect(flagged[0].detail).toMatch(/639px vs median/);
  });

  it('RESCUES a short-but-text-rich page (real policy copy renders compact)', () => {
    // returns: rendered short (under median*0.5) but carries 1597 chars of real text.
    const stats = [stat('home', 3200, 5000), stat('about', 2800, 4000), stat('returns', 1439, 1597)];
    expect(classifyEmptyBodies(stats).map((f) => f.slug)).toEqual([]);
  });

  it('names the reason from the widget / iframe signal even on a short render', () => {
    const stats = [
      stat('home', 3200, 5000),
      stat('about', 2800, 4000),
      stat('reviews', 639, 326, { widget: 'loox', reason: 'app-widget' }),
      stat('help', 639, 326, { crossOriginIframe: true, reason: 'iframe', detail: 'cross-origin <iframe> body' }),
    ];
    const bySlug = Object.fromEntries(classifyEmptyBodies(stats).map((f) => [f.slug, f]));
    expect(bySlug.reviews.reason).toBe('app-widget');
    expect(bySlug.reviews.detail).toBe('loox');
    expect(bySlug.help.reason).toBe('iframe');
  });

  it('falls back to the text signal when a page has no screenshot height', () => {
    const stats = [stat('home', 3200, 5000), stat('about', 2800, 4000), stat('ghost', null, 12)];
    const flagged = classifyEmptyBodies(stats);
    expect(flagged.map((f) => f.slug)).toEqual(['ghost']);
    expect(flagged[0].reason).toBe('thin');
  });
});

describe('KNOWN_WIDGETS registry', () => {
  it('has named, non-empty widget entries', () => {
    expect(KNOWN_WIDGETS.length).toBeGreaterThan(3);
    for (const w of KNOWN_WIDGETS) {
      expect(w.name).toBeTruthy();
      expect(w.selector).toBeTruthy();
    }
  });
});

describe('interaction + wait helpers (Phase 1/2, browser)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it('expandCollapsedContent opens <details>', async () => {
    const page = await browser.newPage();
    await page.setContent('<details><summary>Q</summary><p>A</p></details>');
    await expandCollapsedContent(page);
    expect(await page.evaluate(() => document.querySelector('details')?.open)).toBe(true);
    await page.close();
  });

  // Force-opening an exported dialog disclosure overlays the document with its
  // fixed panel and flips the toggle the interactivity probe later measures —
  // a working menu reported as dead. A collapsed dialog is interactive state,
  // not hidden page content.
  it('leaves dialog-bearing disclosures closed for interactivity probing', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <details class="dla-disclosure">
        <summary data-dla-disclosure-label="Open Menu">Menu</summary>
        <div class="dla-dialog" role="dialog" aria-modal="true"><nav>Home</nav></div>
      </details>
      <details><summary>Ordinary</summary><p>Content</p></details>
    `);
    await expandCollapsedContent(page);
    expect(await page.evaluate(() => document.querySelector<HTMLDetailsElement>('details.dla-disclosure')?.open)).toBe(false);
    expect(await page.evaluate(() => document.querySelector<HTMLDetailsElement>('details:not(.dla-disclosure)')?.open)).toBe(true);
    // The probe toggle still works: the summary opens and closes its panel.
    expect(
      await page.evaluate(() => {
        const details = document.querySelector<HTMLDetailsElement>('details.dla-disclosure');
        const summary = details?.querySelector('summary');
        summary?.click();
        return details?.open ?? false;
      })
    ).toBe(true);
    await page.close();
  });

  it('expands in-page disclosures without activating navigation menus or links', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <a href="https://destination.test/menu" aria-expanded="false" aria-controls="menu" aria-haspopup="true">Menu</a>
      <nav id="menu"></nav>
      <a href="https://destination.test/link" aria-expanded="false" aria-controls="linked-region">Linked section</a>
      <div id="linked-region" role="region"></div>
      <a href="" aria-expanded="false" aria-controls="reload-region">Reloading section</a>
      <div id="reload-region" role="region"></div>
      <button aria-expanded="false" aria-controls="answer">Question?</button>
      <div id="answer" role="region" hidden>Answer.</div>
      <script>
        window.linkActivations = 0;
        document.querySelectorAll('a').forEach((link) => link.addEventListener('click', (event) => {
          event.preventDefault();
          window.linkActivations++;
        }));
        document.querySelector('button').addEventListener('click', (event) => {
          const button = event.currentTarget;
          button.setAttribute('aria-expanded', 'true');
          document.getElementById('answer').hidden = false;
        });
      </script>
    `);

    await expandCollapsedContent(page);

    expect(await page.evaluate(() => (window as unknown as { linkActivations: number }).linkActivations)).toBe(0);
    expect(await page.locator('button').getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator('#answer').isVisible()).toBe(true);
    await page.close();
  });

  it('keeps a show-more disclosure collapsed in the serialized document and records the opened form', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <style>.clamp { max-height: 2.4em; overflow: hidden; }</style>
      <section id="about">
        <p id="blurb" class="clamp">Item 1 is a longer description the author keeps behind a disclosure so the first view stays short.</p>
        <button type="button" id="more" aria-expanded="false" aria-controls="blurb">Show more</button>
      </section>
      <script>
        document.getElementById('more').addEventListener('click', () => {
          document.getElementById('more').setAttribute('aria-expanded', 'true');
          document.getElementById('more').textContent = 'Show less';
          document.getElementById('blurb').classList.remove('clamp');
        });
      </script>
    `);

    await expandCollapsedContent(page);
    const recorded = await hydrateDisclosureContent(page);
    const html = await page.content();
    const button = html.match(/<button[^>]*id="more"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';

    expect(button).toContain('Show more');
    expect(button).not.toContain('Show less');
    expect(button).not.toContain('aria-expanded="true"');
    expect(html).toMatch(/id="blurb"[^>]*class="clamp"/);
    const opened = recorded.find((state) => state.kind === 'disclosure' && state.status === 'captured');
    expect(opened?.trigger.label).toBe('Show more');
    expect(opened?.dialog?.html).toContain('Show less');
    expect(opened?.dialog?.html).not.toContain('class="clamp"');
    await page.close();
  });

  it('never activates a control that would submit a form', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <form action="/search" method="get" role="search">
        <input type="search" name="q">
        <button class="search-button">View all</button>
      </form>
      <button aria-expanded="false" aria-controls="more">Details</button>
      <div id="more" hidden>More.</div>
      <script>
        window.submissions = 0;
        document.querySelector('form').addEventListener('submit', (event) => {
          event.preventDefault();
          window.submissions++;
        });
        document.querySelector('[aria-controls]').addEventListener('click', (event) => {
          event.currentTarget.setAttribute('aria-expanded', 'true');
          document.getElementById('more').hidden = false;
        });
      </script>
    `);

    await expandCollapsedContent(page);

    expect(await page.evaluate(() => (window as unknown as { submissions: number }).submissions)).toBe(0);
    expect(await page.locator('#more').isVisible()).toBe(true);
    await page.close();
  });

  it('hydrates locally mounted disclosure answers without IDs or panel associations', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <section>${['First', 'Second', 'Third'].map(label => `<article><button type="button" aria-expanded="false">${label} question</button></article>`).join('')}</section>
      <button type="button" aria-expanded="false" aria-haspopup="dialog">Open dialog</button>
      <script>
        document.querySelectorAll('article button').forEach(button => button.onclick = () => {
          const opening = button.getAttribute('aria-expanded') === 'false';
          document.querySelectorAll('article').forEach(item => {
            item.querySelector('button').setAttribute('aria-expanded', 'false');
            item.querySelector('div')?.remove();
          });
          if (opening) {
            button.setAttribute('aria-expanded', 'true');
            const panel = document.createElement('div');
            panel.innerHTML = '<p>' + button.textContent.replace('question', 'lazy answer') + '</p>';
            button.after(panel);
          }
        });
      </script>`);
    const records = await hydrateDisclosureContent(page);
    expect(records).toHaveLength(3);
    expect(records.every(record => record.status === 'captured')).toBe(true);
    expect(await page.locator('article').allTextContents()).toEqual([
      'First questionFirst lazy answer', 'Second questionSecond lazy answer', 'Third questionThird lazy answer',
    ]);
    expect(await page.locator('article button[aria-expanded="false"]').count()).toBe(3);
    expect(await page.locator('article [hidden]').count()).toBe(3);
    for (const record of records) {
      expect(record.trigger.ariaControls).toBeTruthy();
      expect(record.dialog?.html).toContain('lazy answer');
    }
    const offline = wireCapturedDialogs((await page.content()).replace(/<script>[\s\S]*?<\/script>/g, ''), records);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(offline);
      await page.locator('article button').nth(0).click();
      expect(await page.locator('article [role="region"]').nth(0).isVisible()).toBe(true);
      await page.locator('article button').nth(1).click();
      expect(await page.locator('article [role="region"]').nth(0).isVisible()).toBe(false);
      expect(await page.locator('article [role="region"]').nth(1).isVisible()).toBe(true);
      await page.locator('article button').nth(1).click();
      expect(await page.locator('article [role="region"]').nth(1).isVisible()).toBe(false);
    }
    await page.close();
  });

  it('hydrates every lazy single-open disclosure while restoring closed state', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <style>[role="region"][aria-hidden="true"]{display:none}</style>
      <button aria-expanded="false" aria-controls="answer-1">Question one?</button>
      <div id="answer-1" role="region" aria-hidden="true"></div>
      <button aria-expanded="false" aria-controls="answer-2">Question two?</button>
      <div id="answer-2" role="region" aria-hidden="true"></div>
      <script>
        const answers = { 'answer-1': '<p>First lazy answer.</p>', 'answer-2': '<p>Second lazy answer.</p>' };
        document.querySelectorAll('button[aria-controls]').forEach((button) => {
          button.addEventListener('click', () => {
            const opening = button.getAttribute('aria-expanded') === 'false';
            document.querySelectorAll('button[aria-controls]').forEach((other) => {
              other.setAttribute('aria-expanded', 'false');
              const panel = document.getElementById(other.getAttribute('aria-controls'));
              panel.setAttribute('aria-hidden', 'true');
              panel.innerHTML = '';
            });
            if (!opening) return;
            const panel = document.getElementById(button.getAttribute('aria-controls'));
            button.setAttribute('aria-expanded', 'true');
            panel.setAttribute('aria-hidden', 'false');
            setTimeout(() => { panel.innerHTML = answers[panel.id]; }, 50);
          });
        });
      </script>
    `);

    const hydrated = await hydrateDisclosureContent(page);
    expect(hydrated).toHaveLength(2);
    expect(hydrated.every((record) => record.status === 'captured' && record.kind === 'disclosure')).toBe(true);
    const state = await page.evaluate(() => ({
      expanded: Array.from(document.querySelectorAll('button')).map((button) => button.getAttribute('aria-expanded')),
      answers: Array.from(document.querySelectorAll<HTMLElement>('[role="region"]')).map((panel) => ({
        text: panel.textContent?.trim(),
        hidden: panel.getAttribute('aria-hidden'),
        display: getComputedStyle(panel).display,
        hydrated: panel.dataset.dlaHydratedDisclosure,
      })),
    }));
    expect(state.expanded).toEqual(['false', 'false']);
    expect(state.answers).toEqual([
      { text: 'First lazy answer.', hidden: 'true', display: 'none', hydrated: 'true' },
      { text: 'Second lazy answer.', hidden: 'true', display: 'none', hydrated: 'true' },
    ]);
    expect(extractFaqsFromHtml(await page.content())).toEqual([
      { question: 'Question one?', answer: 'First lazy answer.' },
      { question: 'Question two?', answer: 'Second lazy answer.' },
    ]);
    await page.close();
  });

  it('leaves popup controls and already populated regions untouched', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <button aria-expanded="false" aria-controls="menu" aria-haspopup="menu">Menu</button>
      <div id="menu" role="region">Navigation</div>
      <button aria-expanded="false" aria-controls="answer">Question?</button>
      <div id="answer" role="region">Existing answer.</div>
    `);
    expect(await hydrateDisclosureContent(page)).toHaveLength(0);
    expect(await page.locator('[data-dla-hydrated-disclosure]').count()).toBe(0);
    await page.close();
  });

  it('normalizes a populated disclosure concealed by a reversing ancestor onto the local hidden contract', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <header id="site-header" style="height:64px;overflow:hidden">Site header</header>
      <div id="tablet-frame" style="height:480px">
        <div id="irrelevant-clip" style="height:0;overflow:hidden"></div>
        <section id="primary">
          <div class="item">
            <button type="button" id="q1" aria-expanded="false" aria-controls="a1">First kept question</button>
            <div class="clip" style="height:0;overflow:hidden"><div class="inner" style="display:none;opacity:0"><div id="a1" role="region" aria-hidden="true">First kept answer.</div></div></div>
            <div class="decoy" style="height:0;overflow:hidden"></div>
          </div>
          <div class="item">
            <button type="button" id="q2" aria-expanded="true" aria-controls="a2">Second kept question</button>
            <div class="clip" style="height:auto;overflow:visible"><div class="inner" style="display:block;opacity:1"><div id="a2" role="region" aria-hidden="false">Second kept answer.</div></div></div>
          </div>
        </section>
        <section id="scoped">
          <div class="item">
            <button type="button" id="q1" aria-expanded="false" aria-controls="a1">First kept question</button>
            <div class="clip" style="height:0;overflow:hidden"><div class="inner" style="display:none;opacity:0"><div id="a1" role="region" aria-hidden="true">Scoped first answer.</div></div></div>
          </div>
          <div class="item">
            <button type="button" id="q2" aria-expanded="false" aria-controls="a2">Second kept question</button>
            <div class="clip" style="height:0;overflow:hidden"><div class="inner" style="display:none;opacity:0"><div id="a2" role="region" aria-hidden="true">Scoped second answer.</div></div></div>
          </div>
        </section>
        <section id="independent">
          <div class="item">
            <button type="button" id="iq1" aria-expanded="false" aria-controls="ia1">Independent question</button>
            <div class="clip" style="height:0;overflow:hidden"><div class="inner" style="display:none;opacity:0"><div id="ia1" role="region" aria-hidden="true">Independent answer.</div></div></div>
          </div>
          <div class="item">
            <button type="button" id="iq2" aria-expanded="false" aria-controls="ia2">Independent sibling</button>
            <div class="clip" style="height:0;overflow:hidden"><div class="inner" style="display:none;opacity:0"><div id="ia2" role="region" aria-hidden="true">Independent sibling answer.</div></div></div>
          </div>
        </section>
        <section id="one-way">
          <div class="item">
            <button type="button" id="ow" aria-expanded="false" aria-controls="owa">Unsupported question</button>
            <div class="clip" style="height:0;overflow:hidden"><div class="inner" style="display:none;opacity:0"><div id="owa" role="region" aria-hidden="true">Unsupported answer.</div></div></div>
          </div>
        </section>
      </div>
      <script>
        function setState(item, open) {
          const button = item.querySelector('button');
          const clip = item.querySelector('.clip');
          const inner = item.querySelector('.inner');
          const panel = item.querySelector('[role="region"]');
          button.setAttribute('aria-expanded', open ? 'true' : 'false');
          clip.style.height = open ? 'auto' : '0px';
          clip.style.overflow = open ? 'visible' : 'hidden';
          inner.style.display = open ? 'block' : 'none';
          inner.style.opacity = open ? '1' : '0';
          panel.setAttribute('aria-hidden', open ? 'false' : 'true');
        }
        function bind(section, exclusive) {
          section.querySelectorAll('button').forEach((button) => {
            button.addEventListener('click', () => {
              const item = button.closest('.item');
              const opening = button.getAttribute('aria-expanded') !== 'true';
              if (button.id === 'ow' && !opening) return;
              if (exclusive && opening) section.querySelectorAll('.item').forEach((other) => { if (other !== item) setState(other, false); });
              setState(item, opening);
            });
          });
        }
        bind(document.getElementById('primary'), true);
        bind(document.getElementById('scoped'), true);
        bind(document.getElementById('independent'), false);
        bind(document.getElementById('one-way'), false);
      </script>
    `);

    const records = await hydrateDisclosureContent(page);
    expect(records.filter((record) => record.status === 'captured')).toHaveLength(6);
    expect(await page.locator('#one-way [data-dla-local-disclosure]').count()).toBe(0);
    expect(await page.locator('#one-way button').getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator('#one-way .clip').getAttribute('style')).toContain('height:0');
    expect(await page.locator('#primary[data-dla-exclusive-disclosures]').count()).toBe(1);
    expect(await page.locator('#scoped[data-dla-exclusive-disclosures]').count()).toBe(1);
    expect(await page.locator('#independent[data-dla-exclusive-disclosures]').count()).toBe(0);
    expect(await page.locator('#site-header').getAttribute('style')).toBe('height:64px;overflow:hidden');
    expect(await page.locator('#tablet-frame').getAttribute('style')).toBe('height:480px');
    expect(await page.locator('#irrelevant-clip').getAttribute('style')).toBe('height:0;overflow:hidden');
    expect(await page.locator('#primary .decoy').getAttribute('style')).toBe('height:0;overflow:hidden');
    const resting = await page.evaluate(() => ({
      primary: [...document.querySelectorAll('#primary button')].map((button) => button.getAttribute('aria-expanded')),
      answers: [...document.querySelectorAll('[role="region"]')].map((panel) => panel.textContent),
    }));
    expect(resting.primary).toEqual(['false', 'true']);
    expect(resting.answers).toEqual([
      'First kept answer.',
      'Second kept answer.',
      'Scoped first answer.',
      'Scoped second answer.',
      'Independent answer.',
      'Independent sibling answer.',
      'Unsupported answer.',
    ]);
    expect(await page.locator('#primary [role="region"]').nth(0).isVisible()).toBe(false);
    expect(await page.locator('#primary [role="region"]').nth(1).isVisible()).toBe(true);

    const offline = wireCapturedDialogs((await page.content()).replace(/<script>[\s\S]*?<\/script>/g, ''), records);
    expect(offline).toContain('data-dla-local-disclosure-runtime');
    expect(offline).not.toContain('data-dla-inline-disclosure');
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(offline);
      const primary = page.locator('#primary');
      const scoped = page.locator('#scoped');
      const independent = page.locator('#independent');
      expect(await primary.locator('[role="region"]').nth(1).isVisible()).toBe(true);
      expect(await primary.locator('[role="region"]').nth(0).isVisible()).toBe(false);
      await primary.locator('button').nth(0).click();
      expect(await primary.locator('[role="region"]').nth(0).innerText()).toBe('First kept answer.');
      expect(await primary.locator('[role="region"]').nth(0).isVisible()).toBe(true);
      expect(await primary.locator('[role="region"]').nth(1).isVisible()).toBe(false);
      expect(await scoped.locator('button').nth(0).getAttribute('aria-expanded')).toBe('false');
      await primary.locator('button').nth(0).click();
      expect(await primary.locator('[role="region"]').nth(0).isVisible()).toBe(false);
      expect(await primary.locator('button[aria-expanded="true"]').count()).toBe(0);
      await independent.locator('button').nth(0).click();
      await independent.locator('button').nth(1).click();
      expect(await independent.locator('[role="region"]').nth(0).isVisible()).toBe(true);
      expect(await independent.locator('[role="region"]').nth(1).isVisible()).toBe(true);
      expect(await page.locator('#site-header').getAttribute('style')).toBe('height:64px;overflow:hidden');
      expect(await page.locator('#tablet-frame').getAttribute('style')).toBe('height:480px');
      expect(await page.locator('#irrelevant-clip').getAttribute('style')).toBe('height:0;overflow:hidden');
      expect(await page.locator('#primary .decoy').getAttribute('style')).toBe('height:0;overflow:hidden');
    }
    await page.close();
  });

  it('keeps an initially open exclusive item open through expand then hydration', async () => {
    const page = await browser.newPage();
    const group = (id: string, openAnswer: string, closedAnswer: string) => `<section id="${id}">
      <div class="item"><button type="button" id="q1" aria-expanded="true" aria-controls="a1">Open question</button><div class="clip" style="height:auto;overflow:visible"><div class="inner" style="display:block;opacity:1"><div id="a1" role="region" aria-hidden="false">${openAnswer}</div></div></div></div>
      <div class="item"><button type="button" id="q2" aria-expanded="false" aria-controls="a2">Closed question</button><div class="clip" style="height:0;overflow:hidden"><div class="inner" style="display:none;opacity:0"><div id="a2" role="region" aria-hidden="true">${closedAnswer}</div></div></div></div>
    </section>`;
    await page.setContent(`
      <header id="site-header" style="height:64px;overflow:hidden">Site header</header>
      <div id="author-note" style="opacity:0.85">Author note</div>
      <div id="irrelevant-clip" style="height:0;overflow:hidden"></div>
      ${group('primary', 'Primary open answer.', 'Primary closed answer.')}
      ${group('scoped', 'Scoped open answer.', 'Scoped closed answer.')}
      <section id="separate">
        <div class="item"><button type="button" id="alone" aria-expanded="true" aria-controls="alone-panel">Separate question</button><div class="clip" style="height:auto;overflow:visible"><div class="inner" style="display:block"><div id="alone-panel" role="region">Separate answer.</div></div></div></div>
      </section>
      <section id="stuck">
        <div class="item"><button type="button" id="stuck-q" aria-expanded="false" aria-controls="stuck-a">Stuck question</button><div class="clip" style="height:0;overflow:hidden"><div class="inner" style="display:none"><div id="stuck-a" role="region">Stuck answer.</div></div></div></div>
      </section>
      <script>
        function setState(item, open) {
          const button = item.querySelector('button');
          const clip = item.querySelector('.clip');
          const inner = item.querySelector('.inner');
          const panel = item.querySelector('[role="region"]');
          button.setAttribute('aria-expanded', open ? 'true' : 'false');
          clip.style.height = open ? 'auto' : '0px';
          clip.style.overflow = open ? 'visible' : 'hidden';
          inner.style.display = open ? 'block' : 'none';
          inner.style.opacity = open ? '1' : '0';
          panel.setAttribute('aria-hidden', open ? 'false' : 'true');
        }
        function bind(section, exclusive) {
          section.querySelectorAll('button').forEach((button) => {
            button.addEventListener('click', () => {
              const item = button.closest('.item');
              const opening = button.getAttribute('aria-expanded') !== 'true';
              if (button.id === 'stuck-q') { if (opening) setState(item, true); return; }
              if (exclusive && opening) section.querySelectorAll('.item').forEach((other) => { if (other !== item) setState(other, false); });
              setState(item, opening);
            });
          });
        }
        bind(document.getElementById('primary'), true);
        bind(document.getElementById('scoped'), true);
        bind(document.getElementById('separate'), false);
        bind(document.getElementById('stuck'), false);
      </script>
    `);
    await expandCollapsedContent(page);
    const records = await hydrateDisclosureContent(page);
    expect(await page.locator('#primary button').nth(0).getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator('#primary [role="region"]').nth(0).isVisible()).toBe(true);
    expect(await page.locator('#primary [role="region"]').nth(0).innerText()).toBe('Primary open answer.');
    expect(await page.locator('#primary button').nth(1).getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator('#primary [role="region"]').nth(1).innerText()).toBe('Primary closed answer.');
    expect(await page.locator('#scoped button').nth(0).getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator('#separate button').getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator('#stuck [data-dla-local-disclosure]').count()).toBe(0);
    expect(await page.locator('#stuck [role="region"]').innerText()).toBe('Stuck answer.');
    expect(await page.locator('#site-header').getAttribute('style')).toBe('height:64px;overflow:hidden');
    expect(await page.locator('#author-note').getAttribute('style')).toBe('opacity:0.85');
    expect(await page.locator('#irrelevant-clip').getAttribute('style')).toBe('height:0;overflow:hidden');
    expect(await page.locator('#primary[data-dla-exclusive-disclosures]').count()).toBe(1);
    expect(await page.locator('#separate[data-dla-exclusive-disclosures]').count()).toBe(0);
    const offline = wireCapturedDialogs((await page.content()).replace(/<script>[\s\S]*?<\/script>/g, ''), records);
    await page.setContent(offline);
    expect(await page.locator('#primary [role="region"]').nth(0).isVisible()).toBe(true);
    await page.locator('#primary button').nth(1).press('Enter');
    expect(await page.locator('#primary [role="region"]').nth(1).innerText()).toBe('Primary closed answer.');
    expect(await page.locator('#primary [role="region"]').nth(0).isVisible()).toBe(false);
    expect(await page.locator('#scoped button').nth(0).getAttribute('aria-expanded')).toBe('true');
    await page.close();
  });

  it('hydrates a Radix-style accordion with no aria-controls, via the reverse aria-labelledby relationship, resilient to single-open auto-collapse', async () => {
    const page = await browser.newPage();
    // Mirrors the real shadcn/ui Radix accordion markup: the trigger carries
    // aria-expanded but NO aria-controls; only the panel names its trigger,
    // via aria-labelledby. A collapsed panel is truly empty (unmounted), not
    // merely hidden — content only exists in the runtime until opened.
    await page.setContent(`
      <div class="w-full">
        <div><h3><button type="button" aria-expanded="false" id="radix-t1" data-radix-collection-item="">Question one?</button></h3>
        <div id="radix-p1" hidden role="region" aria-labelledby="radix-t1"></div></div>
        <div><h3><button type="button" aria-expanded="false" id="radix-t2" data-radix-collection-item="">Question two?</button></h3>
        <div id="radix-p2" hidden role="region" aria-labelledby="radix-t2"></div></div>
        <div><h3><button type="button" aria-expanded="false" id="radix-t3" data-radix-collection-item="">Question three?</button></h3>
        <div id="radix-p3" hidden role="region" aria-labelledby="radix-t3"></div></div>
      </div>
      <script>
        const answers = { 'radix-p1': '<p>First answer.</p>', 'radix-p2': '<p>Second answer.</p>', 'radix-p3': '<p>Third answer.</p>' };
        document.querySelectorAll('button[id^="radix-t"]').forEach((trigger) => {
          trigger.addEventListener('click', () => {
            const opening = trigger.getAttribute('aria-expanded') === 'false';
            // Radix's type="single" behavior: opening one auto-collapses every other item.
            document.querySelectorAll('button[id^="radix-t"]').forEach((other) => {
              if (other === trigger) return;
              other.setAttribute('aria-expanded', 'false');
              document.getElementById('radix-p' + other.id.slice(-1)).setAttribute('hidden', '');
            });
            trigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
            const panel = document.getElementById('radix-p' + trigger.id.slice(-1));
            if (opening) {
              panel.removeAttribute('hidden');
              panel.innerHTML = answers[panel.id];
            } else {
              panel.setAttribute('hidden', '');
              panel.innerHTML = '';
            }
          });
        });
      </script>
    `);

    const hydrated = await hydrateDisclosureContent(page);
    expect(hydrated).toHaveLength(3);
    expect(hydrated.every((record) => record.status === 'captured' && record.kind === 'disclosure')).toBe(true);
    expect(hydrated.map((record) => record.trigger.id)).toEqual(['radix-t1', 'radix-t2', 'radix-t3']);
    expect(hydrated.map((record) => record.dialog?.html)).toEqual([
      expect.stringContaining('First answer.'),
      expect.stringContaining('Second answer.'),
      expect.stringContaining('Third answer.'),
    ]);
    // Every panel stays collapsed (single-open auto-collapse is harmless because
    // each candidate is captured then reclosed before the next one runs).
    const state = await page.evaluate(() => ({
      expanded: ['radix-t1', 'radix-t2', 'radix-t3'].map(
        (id) => document.getElementById(id)?.getAttribute('aria-expanded'),
      ),
      panels: ['radix-p1', 'radix-p2', 'radix-p3'].map((id) => {
        const panel = document.getElementById(id)!;
        return { hidden: panel.hasAttribute('hidden'), text: panel.textContent?.trim() };
      }),
    }));
    expect(state.expanded).toEqual(['false', 'false', 'false']);
    expect(state.panels).toEqual([
      { hidden: true, text: 'First answer.' },
      { hidden: true, text: 'Second answer.' },
      { hidden: true, text: 'Third answer.' },
    ]);
    // The serialized page — what actually gets written to html/<slug>.html —
    // carries the answers even though every panel is collapsed.
    const html = await page.content();
    expect(html).toContain('First answer.');
    expect(html).toContain('Second answer.');
    expect(html).toContain('Third answer.');
    await page.close();
  });

  it('keeps the LAST panel\'s content when the runtime unmounts closed panels after an exit animation', async () => {
    const page = await browser.newPage();
    // Regression for the single-open accordion whose LAST item shipped empty.
    // Real Radix runtimes do not unmount a closed panel's children immediately:
    // Presence keeps them mounted through the ~200ms close animation, and only
    // THEN removes them (and re-applies hidden). Restoring captured content
    // without waiting for that deferred unmount misreads the still-mounted
    // panel as "already has content", skips the write-back, and the pending
    // unmount deletes the panel's only copy of its answer — which is exactly
    // what always happened to the most recently closed (i.e. LAST) item.
    await page.setContent(`
      <button type="button" aria-expanded="false" id="exit-t1">Question one?</button>
      <div id="exit-p1" role="region" aria-labelledby="exit-t1" hidden></div>
      <button type="button" aria-expanded="false" id="exit-t2">Question two?</button>
      <div id="exit-p2" role="region" aria-labelledby="exit-t2" hidden></div>
      <button type="button" aria-expanded="false" id="exit-t3">Question three?</button>
      <div id="exit-p3" role="region" aria-labelledby="exit-t3" hidden></div>
      <script>
        const answers = { 'exit-p1': '<p>First exit answer.</p>', 'exit-p2': '<p>Second exit answer.</p>', 'exit-p3': '<p>Third exit answer.</p>' };
        const exitTimers = {};
        function closeWithExitAnimation(triggerId) {
          const trigger = document.getElementById(triggerId);
          const panel = document.getElementById('exit-p' + triggerId.slice(-1));
          trigger.setAttribute('aria-expanded', 'false');
          // aria-expanded flips immediately, but the unmount lands ~250ms later.
          exitTimers[panel.id] = setTimeout(() => {
            panel.innerHTML = '';
            panel.setAttribute('hidden', '');
          }, 250);
        }
        function openPanel(triggerId) {
          const trigger = document.getElementById(triggerId);
          const panel = document.getElementById('exit-p' + triggerId.slice(-1));
          if (exitTimers[panel.id]) { clearTimeout(exitTimers[panel.id]); exitTimers[panel.id] = null; }
          trigger.setAttribute('aria-expanded', 'true');
          panel.removeAttribute('hidden');
          panel.innerHTML = answers[panel.id];
        }
        document.querySelectorAll('button[id^="exit-t"]').forEach((trigger) => {
          trigger.addEventListener('click', () => {
            const opening = trigger.getAttribute('aria-expanded') === 'false';
            if (!opening) { closeWithExitAnimation(trigger.id); return; }
            document.querySelectorAll('button[id^="exit-t"]').forEach((other) => {
              if (other !== trigger && other.getAttribute('aria-expanded') === 'true') closeWithExitAnimation(other.id);
            });
            openPanel(trigger.id);
          });
        });
      </script>
    `);

    const hydrated = await hydrateDisclosureContent(page);
    expect(hydrated).toHaveLength(3);
    expect(hydrated.every((record) => record.status === 'captured' && record.kind === 'disclosure')).toBe(true);
    // Give any un-fixed pending exit unmount time to land: with the fix there is
    // nothing pending (the restore waited for it), so this is a no-op there.
    await page.waitForTimeout(600);
    // The diagnostics carry every panel's captured content...
    expect(hydrated.map((record) => record.dialog?.html)).toEqual([
      expect.stringContaining('First exit answer.'),
      expect.stringContaining('Second exit answer.'),
      expect.stringContaining('Third exit answer.'),
    ]);
    // ...and the DOM must too: every panel collapsed, every panel populated —
    // the LAST one specifically, which is the item this bug always destroyed.
    const state = await page.evaluate(() =>
      ['exit-p1', 'exit-p2', 'exit-p3'].map((id) => {
        const panel = document.getElementById(id)!;
        return { hidden: panel.hasAttribute('hidden'), text: panel.textContent?.trim() };
      }),
    );
    expect(state).toEqual([
      { hidden: true, text: 'First exit answer.' },
      { hidden: true, text: 'Second exit answer.' },
      { hidden: true, text: 'Third exit answer.' },
    ]);
    const html = await page.content();
    expect(html).toContain('First exit answer.');
    expect(html).toContain('Second exit answer.');
    expect(html).toContain('Third exit answer.');
    await page.close();
  });

  it('rescans for disclosures that become eligible during hydration', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <button aria-expanded="false" aria-controls="answer-1">Question one?</button>
      <div id="answer-1" role="region"></div>
      <button aria-expanded="pending" aria-controls="answer-2">Question two?</button>
      <div id="answer-2" role="region"></div>
      <script>
        const answers = { 'answer-1': 'First answer.', 'answer-2': 'Late answer.' };
        document.querySelectorAll('button').forEach((button) => {
          button.addEventListener('click', () => {
            const opening = button.getAttribute('aria-expanded') === 'false';
            button.setAttribute('aria-expanded', opening ? 'true' : 'false');
            const panel = document.getElementById(button.getAttribute('aria-controls'));
            panel.textContent = opening ? answers[panel.id] : '';
            if (button.getAttribute('aria-controls') === 'answer-1') {
              setTimeout(() => document.querySelector('[aria-controls="answer-2"]')
                .setAttribute('aria-expanded', 'false'), 150);
            }
          });
        });
      </script>
    `);

    expect(await hydrateDisclosureContent(page)).toHaveLength(2);
    expect(await page.locator('[data-dla-hydrated-disclosure]').allTextContents()).toEqual([
      'First answer.',
      'Late answer.',
    ]);
    await page.close();
  });

  it('waitForAppWidgets waits until a known widget populates', async () => {
    const page = await browser.newPage();
    // Loox-like container that fills in after 300ms.
    await page.setContent(
      '<div id="looxReviews"></div><script>setTimeout(()=>{document.getElementById("looxReviews").innerHTML="<div>a review here that is long enough</div>"},300)</script>',
    );
    await waitForAppWidgets(page, 5000);
    const populated = await page.evaluate(() => (document.getElementById('looxReviews')?.childElementCount ?? 0) > 0);
    expect(populated).toBe(true);
    await page.close();
  });

  it('waitForAppWidgets is a no-op (returns fast) when no known widget is present', async () => {
    const page = await browser.newPage();
    await page.setContent('<main>just normal content</main>');
    const t0 = Date.now();
    await waitForAppWidgets(page, 5000);
    expect(Date.now() - t0).toBeLessThan(2000); // didn't burn the full timeout
    await page.close();
  });
});

// `history.pushState` throws on a page with an opaque origin (about:blank,
// data:, or page.setContent's default), so these tests serve real content
// over a throwaway localhost origin — the same shape of origin every real
// SPA capture runs against.
describe('expandCollapsedContent vs. a client-routed SPA (Home/Browse regression)', () => {
  let browser: Browser;
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    browser = await chromium.launch();
    server = createServer((req, res) => res.end(req.url === '/details' ? fullNavigationFixture : '<!doctype html><html><body></body></html>'));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Mirrors how a real client router (e.g. the `history` package underlying
  // React Router) wires itself up: it patches `history.pushState` so ANY
  // caller triggers its render — not only its own `navigate()` — which is
  // exactly the mechanism `expandCollapsedContent`'s revert relies on.
  // A plain type=button whose handler loads another route as a new document
  // (location.assign), the way a site builder's "See all" link-out is wired.
  const fullNavigationFixture = `<!doctype html><html><body>
    <button id="see-all" type="button">See all</button>
    <button id="toggle" aria-expanded="false" aria-controls="more">Details</button>
    <div id="more" hidden>More.</div>
    <script>
      document.getElementById('see-all').addEventListener('click', () => { location.assign('/schedule'); });
      document.getElementById('toggle').addEventListener('click', (event) => {
        event.currentTarget.setAttribute('aria-expanded', 'true');
        document.getElementById('more').hidden = false;
      });
    </script>
  </body></html>`;

  const spaFixture = `
    <div id="root"></div>
    <button id="faq-trigger" aria-expanded="false" aria-controls="faq-answer">Question?</button>
    <div id="faq-answer" role="region" hidden>Answer.</div>
    <button id="view-all">View All</button>
    <script>
      const routes = {
        '/Home': '<main id="hero">Pre-made Logos, Community Approved</main>',
        '/Browse': '<h1>Browse Logos</h1>',
      };
      function render() {
        document.getElementById('root').innerHTML = routes[location.pathname] || '';
      }
      const nativePushState = history.pushState.bind(history);
      history.pushState = (...args) => { nativePushState(...args); render(); };
      window.addEventListener('popstate', render);
      render();
      document.getElementById('faq-trigger').addEventListener('click', (event) => {
        event.currentTarget.setAttribute('aria-expanded', 'true');
        document.getElementById('faq-answer').hidden = false;
      });
      document.getElementById('view-all').addEventListener('click', () => {
        history.pushState({}, '', '/Browse');
      });
    </script>
  `;

  it('reverts a button whose click turns out to be client-side navigation, restoring the route\'s real content', async () => {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/Home`);
    await page.setContent(spaFixture);

    await expandCollapsedContent(page);

    // The "View All" control drifted the SPA to /Browse; the guard must have
    // caught it and reverted — both the URL AND (because the revert goes
    // through the router's own patched pushState) the rendered content.
    expect(await page.evaluate(() => location.pathname)).toBe('/Home');
    expect(await page.locator('#root').innerText()).toContain('Pre-made Logos, Community Approved');
    expect(await page.locator('#root').innerText()).not.toContain('Browse Logos');
    await page.close();
  });

  it('keeps a "See all" button that loads another document from taking the capture off its route', async () => {
    const page = await browser.newPage();
    const navigations: string[] = [];
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    await page.goto(`${baseUrl}/details`);
    await page.evaluate(() => { (window as unknown as { marker: boolean }).marker = true; });

    await expandCollapsedContent(page);
    // A committed navigation lands asynchronously; give one the time to.
    await page.waitForTimeout(300);

    // The click must not have committed a full-document navigation: the same
    // document (its in-memory marker intact) is still on the original route.
    expect(navigations).toEqual([`${baseUrl}/details`]);
    expect(page.url()).toBe(`${baseUrl}/details`);
    expect(await page.evaluate(() => (window as unknown as { marker?: boolean }).marker)).toBe(true);
    // Probing still ran around it: the in-page disclosure opened.
    expect(await page.locator('#more').isVisible()).toBe(true);
    await page.close();
  });

  it('still expands a genuine in-page disclosure that runs before the navigating control', async () => {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/Home`);
    await page.setContent(spaFixture);

    await expandCollapsedContent(page);

    // aria-controls candidates are activated before the label-text pass, so
    // the FAQ disclosure — a real in-page toggle — must still have opened,
    // independent of the later control that turned out to navigate.
    expect(await page.locator('#faq-trigger').getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator('#faq-answer').isVisible()).toBe(true);
    await page.close();
  });

  it('still expands a genuine "load more" label control that does not navigate', async () => {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/products`);
    await page.setContent(`
      <ul id="list"><li>One</li></ul>
      <button id="load-more">Load more</button>
      <script>
        document.getElementById('load-more').addEventListener('click', () => {
          document.getElementById('list').insertAdjacentHTML('beforeend', '<li>Two</li>');
        });
      </script>
    `);

    await expandCollapsedContent(page);

    expect(await page.locator('#list li').count()).toBe(2);
    expect(await page.evaluate(() => location.pathname)).toBe('/products');
    await page.close();
  });
});
