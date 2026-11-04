import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { SourceRequestGovernors } from '../source-request-governor.js';
import { getSourceResponse, governSourceContext } from './source-traffic.js';

const skipBrowser = Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath());

// Hosted builders set several cookies; Playwright joins repeated set-cookie values with a newline.
it.skipIf(skipBrowser)('governs a source response that sets several cookies', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': ['edge=miss; Max-Age=20', 'origin=hit; Path=/'] });
    res.end('<h1>Repeated headers</h1>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    governSourceContext(context, new SourceRequestGovernors(), origin);
    const response = await getSourceResponse(context, `${origin}/`);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('Repeated headers');
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 30_000);
