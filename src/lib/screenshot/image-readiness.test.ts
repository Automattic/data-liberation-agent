// Real-browser regressions for `waitForImages`' layout-participation predicate
// (issue #656). The Spacefast recipe route held ten hidden native-lazy
// responsive alternatives — images with no layout box, invisible at the
// captured viewport — each of which exhausted every 4s image wait inside
// `triggerLazyLoad`'s settle rounds (~24s per run for pending bytes that could
// never affect the capture). These tests pin each contextual requirement of the
// contract: only images that are presently invisible AND outside layout may be
// skipped; anything that still participates must settle under the existing
// bounded-wait contract.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { triggerLazyLoad, waitForImages } from './page-helpers.js';

// An image response that resolves only after `delay` ms, so readiness waits can
// be timed end-to-end over real decode instead of data-URI instantaneity.
// Fictional SVG content; no source-site data.
const SVG_BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="teal"/></svg>',
);

function imageServer(delayMs: number): Server {
  return createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    // `/never.svg` stands in for the route's inert lazy alternatives: pending
    // far past any readiness budget instead of never reaching the wire at all.
    const hold = req.url?.includes('never') ? 10_000 : delayMs;
    setTimeout(() => res.end(SVG_BYTES), hold);
  });
}

const imageState = (page: Page, selector = 'img') =>
  page.locator(selector).evaluateAll((images) => images.map((image) => ({
    complete: (image as HTMLImageElement).complete,
    naturalWidth: (image as HTMLImageElement).naturalWidth,
  })));

describe('waitForImages layout participation', () => {
  let browser: Browser;
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    browser = await chromium.launch();
    server = imageServer(700);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('still waits for a visible image with delayed decoding, however slow', async () => {
    // Generic never-settling budget: baseline behavior awaited every image in
    // the document; a visible image must keep that contract, regardless of how
    // late it decodes.
    const page = await browser.newPage();
    await page.setContent(`<img src="${origin}/slow.svg" width="24" height="24">`, { waitUntil: 'domcontentloaded' });
    expect(await imageState(page)).toEqual([{ complete: false, naturalWidth: 0 }]);
    await waitForImages(page, 4_000);
    expect(await imageState(page)).toEqual([{ complete: true, naturalWidth: 24 }]);
    await page.close();
  }, 15_000);

  it('does not exhaust the readiness timer on inactive native-lazy alternatives', async () => {
    // display:none removes the image from layout entirely: an inactive
    // responsive alternative whose pending bytes cannot affect the captured
    // state. Its wait must not consume the timer — the elapsed time is the
    // observable; a blanket filter-free evaluate spends the full timeout here.
    const page = await browser.newPage();
    // Start src-less so the document's load event does not already hold the
    // bytes; the fetch is injected afterwards and held pending by the server.
    await page.setContent('<img id="inactive" style="display:none" width="24" height="24">');
    await page.evaluate((src: string) => {
      document.querySelector('img')!.setAttribute('src', src);
    }, `${origin}/never.svg`);
    await page.waitForTimeout(300);
    const started = Date.now();
    await waitForImages(page, 4_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    // Not awaited — but by no means emptied: it stays right where it was.
    expect(await imageState(page)).toEqual([{ complete: false, naturalWidth: 0 }]);
    await page.close();
  }, 15_000);

  it('waits for a visibility-hidden image that still occupies layout', async () => {
    // visibility:hidden keeps the box and the space it fills, so the element
    // remains a layout participant: whenever a class flip or resize reveals it,
    // a half-decoded alternative would land in the capture. It must settle.
    const page = await browser.newPage();
    await page.setContent(
      `<img src="${origin}/hidden.svg" style="visibility:hidden" width="24" height="24">`,
      { waitUntil: 'domcontentloaded' },
    );
    expect(await imageState(page)).toEqual([{ complete: false, naturalWidth: 0 }]);
    await waitForImages(page, 4_000);
    expect(await imageState(page)).toEqual([{ complete: true, naturalWidth: 24 }]);
    await page.close();
  }, 15_000);

  it('waits for an image revealed by a later viewport resize', async () => {
    // A media query may hold an alternative display:none at the captured
    // width and reveal it after a resize; the wait for the resized state has
    // to re-evaluate participation at the new viewport instead of trusting an
    // earlier snapshot.
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(`<style>
      #alt { display: none; }
      @media (max-width: 800px) { #alt { display: block; } }
    </style><img id="alt" src="${origin}/alt.svg" width="24" height="24">`, { waitUntil: 'domcontentloaded' });
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForImages(page, 4_000);
    expect(await imageState(page)).toEqual([{ complete: true, naturalWidth: 24 }]);
    await page.close();
  }, 15_000);

  it('settles scroll-grown content that grows a zero-size image into layout', async () => {
    // The sweep's repeat-until-stable rounds: an image starts un-reserved
    // (zero-height) and only gains layout when its reveal class lands as the
    // document grows. Every active image in the last layout must be decoded
    // before the sweep stops.
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`<!doctype html><style>
      body { margin: 0; }
      figure { margin: 0; height: 0; }
      figure.in { height: 400px; }
    </style>
    <div style="height:1200px">Spacer</div>
    <figure><img src="${origin}/grown.svg"></figure>
    <script>
      let revealed = false;
      addEventListener('scroll', () => {
        if (revealed || scrollY < 400) return;
        revealed = true;
        document.querySelector('figure').classList.add('in');
      });
    </script>`, { waitUntil: 'domcontentloaded' });
    await triggerLazyLoad(page);
    expect(await page.locator('figure.in').count()).toBe(1);
    expect(await imageState(page)).toEqual([{ complete: true, naturalWidth: 24 }]);
    await page.close();
  }, 30_000);

  it('settles every active image without exhausting the budget across rounds', async () => {
    // End-to-end bound from the route profile: inactive alternatives must not
    // cost the settle rounds their whole image budget — several display:none
    // lazies plus one active image, and the whole triggerLazyLoad returns on
    // the scale of the active image, not 10 rounds × the timer.
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<!doctype html><main style="height:1500px">
      ${Array.from({ length: 10 }, () =>
        `<img class="alt" src="${origin}/b.svg" style="display:none" width="24" height="24">`,
      ).join('\n')}
      <img id="active" src="${origin}/active.svg" width="24" height="24">
    </main>`, { waitUntil: 'domcontentloaded' });
    await triggerLazyLoad(page);
    expect(await page.locator('#active').evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBe(24);
    await page.close();
  }, 30_000);
});
