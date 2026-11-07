import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { captureScreenshots } from './screenshot/screenshotter.js';
import { exportWebsiteCapture } from './capture-export.js';

describe.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))('percent-encoded route discovery (real Chromium)', () => {
	it.each(['literal link', 'redirect', 'queued redirect'] as const)('captures and exports one document for encoded and literal path spellings: %s', async mode => {
		const server = createServer((request, response) => {
			const requested = new URL(request.url!, 'http://fixture.test');
			if (requested.search === '?view=full') {
				response.writeHead(302, { location: '/a:.html' }).end();
				return;
			}
			const path = decodeURIComponent(requested.pathname);
			response.setHeader('content-type', 'text/html; charset=utf-8');
			if (path !== '/' && path !== '/a:.html') {
				response.writeHead(404).end();
				return;
			}
			const links = ['<a href="/a%3A.html">Encoded</a>', `<a href="${mode === 'literal link' ? '/a:.html' : '/a%3A.html?view=full'}">Other spelling</a>`];
			if (mode === 'queued redirect') links.reverse();
			response.end(`<!doctype html><html><head><title>Route fixture</title></head><body><main>${path === '/' ? `<h1>Home</h1>${links.join('')}` : '<h1>One document</h1>'}</main></body></html>`);
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
		mkdirSync('.tmp-test', { recursive: true });
		const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'route-encoding-'));
		try {
			const aliases: [string, string][] = [];
			const capture = await captureScreenshots({
				onRouteAlias: (from, to) => { aliases.push([from, to]); },
				referenceSampleUrls: [`${url}a%3A.html?view=full`],
				urls: [url], primaryUrl: url, outputDir,
				linkedPages: { maxPages: 10, timeoutMs: 120_000 },
				concurrency: 1, settleMs: 0, learnFluid: false,
				viewports: [{ id: 'desktop', width: 1440, height: 900 }],
			});
			expect(capture.failed).toBe(0);
			expect(capture.captured).toBe(2); // Index plus one canonical document, not both spellings.
			if (mode !== 'literal link') expect(aliases).toEqual([[`${url}a%3A.html?view=full`, `${url}a%3A.html`]]);
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
