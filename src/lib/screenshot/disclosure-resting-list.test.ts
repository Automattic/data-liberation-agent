import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { load } from 'cheerio';
import { expect, it } from 'vitest';
import { captureTriggeredDialogs } from './interaction-capture.js';
import { wireCapturedDialogs } from '../static-dialogs.js';

const skipBrowser = Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath());

// One real capture (~5 seconds): a desktop list is a phone drawer, not a
// permanently closed dialog. Its external runtime must not leak opened classes.
it.skipIf(skipBrowser)('exports an aria-controls list with resting attributes and preserves phone replay', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/app.js') {
      response.setHeader('content-type', 'application/javascript');
      response.end(`document.getElementById('toggle').onclick=function(){
        const open=this.getAttribute('aria-expanded')!=='true';
        this.setAttribute('aria-expanded',String(open));
        document.getElementById('nav-list').classList.toggle('is-open',open);
      };`);
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
      .inner{position:relative}.nav-list{display:flex;gap:24px;list-style:none}.toggle{display:none}
      @media(max-width:768px){.toggle{display:block}.nav-list{display:none;position:absolute;top:100%;left:0;right:0;flex-direction:column}.nav-list.is-open{display:flex}}
      </style><script src="/app.js" defer></script></head><body>
      <header><div class="inner"><a href="/">Site</a><nav aria-label="Main">
        <button id="toggle" class="toggle" aria-expanded="false" aria-controls="nav-list">Open menu</button>
        <ul id="nav-list" class="nav-list"><li><a href="/">Home</a></li><li><a href="/about/">About</a></li></ul>
      </nav></div></header><main><h1>Page content</h1></main></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const browser = await chromium.launch({ headless: true });
  try {
    const source = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await source.goto(url);
    const captured = await source.content();
    await source.setViewportSize({ width: 390, height: 900 });
    const { states } = await captureTriggeredDialogs(source, url);
    expect(states).toEqual(expect.arrayContaining([expect.objectContaining({
      status: 'captured', trigger: expect.objectContaining({ id: 'toggle' }),
      dialog: expect.objectContaining({ selector: '#nav-list' }),
    })]));
    const $ = load(wireCapturedDialogs(captured, states));
    const panel = $('#nav-list');
    expect(panel).toHaveLength(1);
    expect(panel.attr('data-blocks-engine-capture-dialog-panel')).toBeDefined();
    expect(panel.attr('hidden')).toBeUndefined();
    expect(panel.hasClass('is-open')).toBe(false);
    expect(panel.attr('style')).toBeUndefined();
    $('script[src]').remove();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent($.html());
    expect(await page.locator('#nav-list').isVisible()).toBe(true);
    await page.setViewportSize({ width: 390, height: 900 });
    await expect.poll(() => page.locator('#nav-list').isVisible()).toBe(false);
    await page.locator('#toggle').click();
    expect(await page.locator('#nav-list').isVisible()).toBe(true);
    await page.locator('#toggle').click();
    expect(await page.locator('#nav-list').isVisible()).toBe(false);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => page.locator('#nav-list').isVisible()).toBe(true);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 30000);
