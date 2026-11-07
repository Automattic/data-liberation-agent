import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { captureScreenshots } from './screenshot/screenshotter.js';
import { exportWebsiteCapture } from './capture-export.js';

describe.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))('percent-encoded route discovery (real Chromium)', () => {
	it('captures and exports one document for encoded and literal path spellings', async () => {
		const server = createServer((request, response) => {
			const path = decodeURIComponent(new URL(request.url!, 'http://fixture.test').pathname);
			response.setHeader('content-type', 'text/html; charset=utf-8');
			if (path !== '/' && path !== '/a:.html') {
				response.writeHead(404).end();
				return;
			}
			response.end(`<!doctype html><html><head><title>Route fixture</title></head><body><main>${path === '/' ? '<h1>Home</h1><a href="/a%3A.html">Encoded</a><a href="/a:.html">Literal</a>' : '<h1>One document</h1>'}</main></body></html>`);
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
		mkdirSync('.tmp-test', { recursive: true });
		const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'route-encoding-'));
		try {
			const capture = await captureScreenshots({
				urls: [url], primaryUrl: url, outputDir,
				linkedPages: { maxPages: 10, timeoutMs: 120_000 },
				concurrency: 1, settleMs: 0, learnFluid: false,
				viewports: [{ id: 'desktop', width: 1440, height: 900 }],
			});
			expect(capture.failed).toBe(0);
			expect(capture.captured).toBe(2); // Index plus one canonical document, not both spellings.
			const receiptPath = exportWebsiteCapture({ outputDir, sourceUrl: url, platform: 'default', summary: { routesFailed: capture.failed }, failures: [] });
			const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
			expect(receipt.routes).toHaveLength(2);
			const document = receipt.routes.find((route: { url: string }) => route.url !== url);
			expect(document.url).toBe(`${url}a%3A.html`); // First discovered spelling is retained.
			expect(readdirSync(join(outputDir, 'website')).filter(name => /^a.*\.html$/.test(name))).toEqual([document.path.replace('website/', '')]);
			expect(readFileSync(join(outputDir, document.path), 'utf8')).toContain('One document');
			const home = readFileSync(join(outputDir, 'website/index.html'), 'utf8');
			const links = [...home.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
			expect(links).toHaveLength(2);
			expect(new Set(links).size).toBe(1);
		} finally {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
			rmSync(outputDir, { recursive: true, force: true });
		}
	}, 180_000);
});
