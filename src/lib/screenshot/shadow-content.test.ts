import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { capturePageHtml, captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { checkFidelity } from '../fidelity/check.js';
import { createReferenceCollector } from '../fidelity/reference.js';

// One pipeline pass, expected wall time approximately 20 seconds.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('exports static open shadow rendering without its defining runtime', async () => {
  const fixture = `<!doctype html><html><head><title>Shadow icon</title><style>
    body{margin:0} a{display:block;width:32px;height:32px;background:#123456}
  </style></head><body><main><h1>Static shadow content</h1>
    <a href="https://example.com/" aria-label="Visit"><icon-component data-color="#FFFFFF"></icon-component></a>
    <script>customElements.define('icon-component',class extends HTMLElement {
      connectedCallback(){this.attachShadow({mode:'open'}).innerHTML = '<style>:host{display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:#FFFFFF} svg{width:100%;height:100%}</style><svg viewBox="-1 -1 18 18"><path d="M0 0H16V16H0Z" fill="#FFFFFF"/></svg>'}
    });</script></main></body></html>`;
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(fixture); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  mkdirSync('.tmp-test', { recursive: true });
  const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test/shadow-'));
  const browser = await chromium.launch();
  try {
    const collector = createReferenceCollector(outputDir, url, [url]);
    const result = await captureScreenshots({ urls: [url], primaryUrl: url, outputDir, concurrency: 1, deviceMode: 'reflow-only', observeSource: collector.observe });
    expect(result.failed).toBe(0);
    const receiptPath = exportWebsiteCapture({ outputDir, sourceUrl: url, platform: 'default', summary: {
      routesDiscovered: 1, routesCaptured: result.captured, routesSkipped: result.skipped,
      routesFailed: result.failed, durationMs: result.durationMs,
    }, failures: [] });
    collector.finalize(receiptPath);
    const html = readFileSync(join(outputDir, 'website/index.html'), 'utf8');
    expect(html).not.toContain('customElements.define');
    expect(html).not.toContain(':host');
    const source = await browser.newPage();
    const copy = await browser.newPage({ javaScriptEnabled: false });
    await source.goto(url);
    await copy.setContent(html);
    expect(await copy.locator('a icon-component svg path').count()).toBe(1);
    expect(await copy.locator('script').count()).toBe(0);
    const rendering = () => {
      const svg = document.querySelector('a icon-component')!.querySelector('svg') ?? document.querySelector('icon-component')!.shadowRoot!.querySelector('svg')!;
      const rect = svg.getBoundingClientRect();
      return { width: rect.width, height: rect.height, fill: getComputedStyle(svg.querySelector('path')!).fill };
    };
    expect(await source.evaluate(rendering)).toEqual({ width: 32, height: 32, fill: 'rgb(255, 255, 255)' });
    expect(await copy.evaluate(rendering)).toEqual(await source.evaluate(rendering));
    const report = await checkFidelity({ directory: outputDir });
    expect(report.pass, JSON.stringify(report)).toBe(true);
    expect(report.pending).toHaveLength(0);

    // Cheap serializer checks share this browser: nested roots, slot placement,
    // fallback slots, controls, closed roots and source identity.
    await source.setContent(`<outer-static><b slot="label">Assigned</b><i>Unassigned</i></outer-static>
      <closed-static></closed-static><interactive-static></interactive-static><form-static></form-static>
      <script>
      customElements.define('inner-static', class extends HTMLElement {connectedCallback(){this.attachShadow({mode:'open'}).innerHTML='<em>Nested</em>'}});
      customElements.define('outer-static', class extends HTMLElement {connectedCallback(){this.attachShadow({mode:'open'}).innerHTML='<span>Before</span><slot name="label"></slot><inner-static></inner-static><slot name="missing">Fallback</slot>'}});
      customElements.define('closed-static', class extends HTMLElement {connectedCallback(){this.attachShadow({mode:'closed'}).innerHTML='<b>Closed</b>'}});
      customElements.define('interactive-static', class extends HTMLElement {connectedCallback(){this.attachShadow({mode:'open'}).innerHTML='<button>Action</button>'}});
      customElements.define('form-static', class extends HTMLElement {static formAssociated=true;connectedCallback(){this.attachShadow({mode:'open'}).innerHTML='<span>Value</span>'}});
      </script>`);
    const captured = await capturePageHtml(source);
    await copy.setContent(captured);
    expect(await copy.locator('outer-static').textContent()).toBe('BeforeAssignedNestedFallback');
    expect(await copy.locator('outer-static > b[slot="label"]').count()).toBe(1);
    expect(await copy.locator('interactive-static,form-static').allTextContents()).toEqual(['', '']);
    expect(await copy.locator('closed-static b').count()).toBe(0);
    expect(await source.locator('outer-static').evaluate(node => !!node.shadowRoot && node.children.length === 2)).toBe(true);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(outputDir, { recursive: true, force: true });
  }
}, 120_000);
