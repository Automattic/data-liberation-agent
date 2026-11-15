import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import type { PlatformAdapter } from '../../types.js';
import { SourceRequestGovernors } from '../source-request-governor.js';
import { createSourceContext } from './source-identity.js';
import { attributeSourcePhase } from './source-traffic.js';

const skipBrowser = Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath());

it.skipIf(skipBrowser)('blocks adapter-declared telemetry without source admission or rendering loss', async () => {
  const received: string[] = [];
  const server = createServer((req, res) => {
    received.push(req.url!);
    res.setHeader('content-type', 'text/html');
    if (req.url !== '/') return res.end('ok');
    res.end(`<h1>Rendered fixture</h1><script>
      window.done = Promise.all([
        fetch('/metrics/fetch?event=view', { method: 'POST', body: 'visit' }).catch(() => {}),
        fetch('/events/collect?event=view', { method: 'POST' }).catch(() => {}),
        fetch('/events/collect?event=again', { method: 'POST' }).catch(() => {}),
        fetch('/content', { method: 'POST' }),
        fetch('/content?next=/metrics/'),
        fetch('http://localhost:' + location.port + '/metrics/external', { mode: 'no-cors', method: 'POST' })
      ]);
      navigator.sendBeacon('/metrics/beacon', 'visit');
    </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const adapter: PlatformAdapter = {
    id: 'fixture', discover: async () => ({}),
    sourceTelemetry: ['/metrics/', /^\/events\/collect$/g],
  };
  const governors = new SourceRequestGovernors();
  const browser = await chromium.launch();
  try {
    const context = await createSourceContext(browser, { userAgent: 'Mozilla/5.0 Chrome/130.0.0.0' }, {
      governors, sourceUrl: origin, sourceTelemetry: adapter.sourceTelemetry,
    });
    attributeSourcePhase(context, 'baseline');
    const page = await context.newPage();
    const blocked: string[] = [];
    page.on('requestfailed', request => blocked.push(new URL(request.url()).pathname));
    await page.goto(origin);
    await page.evaluate(() => (window as unknown as { done: Promise<unknown> }).done);
    await expect.poll(() => blocked.length).toBe(4);
    expect(await page.locator('h1').textContent()).toBe('Rendered fixture');
    expect(received.sort()).toEqual(['/', '/content', '/content?next=/metrics/', '/metrics/external'].sort());
    await expect.poll(() => governors.forOrigin(origin).stats().requests).toBe(3);
    expect(governors.attribution().origins[0].totals['desktop/baseline blocked:telemetry']).toBe(4);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 30_000);
