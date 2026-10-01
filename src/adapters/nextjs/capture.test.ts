import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'cheerio';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { detectFromHttp, resolvePlatform } from '../../index.js';
import { captureScreenshots } from '../../lib/screenshot/screenshotter.js';
import { exportWebsiteCapture } from '../../lib/capture-export.js';

describe.skipIf(process.env.SKIP_BROWSER_TESTS)('Next.js capture/export (real Chromium)', () => {
	it('removes only framework announcers before observations and both responsive documents', async () => {
		const server = createServer((req, res) => {
			if (req.url !== '/') { res.writeHead(404); res.end(); return; }
			res.writeHead(200, { 'Content-Type': 'text/html', 'X-Powered-By': 'Next.js' });
			res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Owner site</title></head><body>
				<nav><a href="#owner-heading">Owner navigation</a></nav><main><h1 id="owner-heading">Owner heading</h1>
				<div aria-live="polite" id="owner-status">Owner status</div><div role="alert">Owner alert</div>
				<div id="owner-clipped" aria-live="assertive" style="position:absolute;width:1px;height:1px;overflow:hidden"></div>
				<owner-widget>Owner custom element</owner-widget>
				<details><summary>Owner question</summary><p>Owner answer</p></details>
				<p id="device"></p><div style="height:1600px">Owner content</div></main>
				<next-route-announcer></next-route-announcer>
				<p id="__next-route-announcer__" aria-live="assertive" style="position:absolute;width:1px;height:1px;overflow:hidden">Framework title</p>
				<script id="__NEXT_DATA__" type="application/json">{"page":"/"}</script>
				<script>document.getElementById('device').innerHTML=innerWidth<600?'<strong>Mobile document</strong>':'Desktop document';
				document.querySelector('next-route-announcer').attachShadow({mode:'open'}).innerHTML='<div aria-live="assertive">Framework title</div>';</script>
			</body></html>`);
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
		const root = join(process.cwd(), '.tmp-test');
		mkdirSync(root, { recursive: true });
		const outputDir = mkdtempSync(join(root, 'nextjs-'));
		const observations: Array<{ device: string; announcers: number; live: string; interactive: boolean }> = [];
		try {
			const detection = await detectFromHttp(url);
			const adapter = resolvePlatform(detection.platform);
			if (!adapter) throw new Error('Missing detected platform adapter');
			const result = await captureScreenshots({
				urls: [url], primaryUrl: url, outputDir, concurrency: 1,
				removeSelectors: adapter.liberation?.removeSelectors,
				observeSource: async (page, _url, device) => {
					const announcers = await page.locator('next-route-announcer, #__next-route-announcer__').count();
					const live = await page.locator('#owner-status').innerText();
					const initiallyOpen = await page.locator('details').evaluate((node) => node.hasAttribute('open'));
					await page.locator('summary').click();
					const interactive = initiallyOpen !== await page.locator('details').evaluate((node) => node.hasAttribute('open'));
					await page.locator('summary').click();
					observations.push({ device, announcers, live, interactive });
				},
			});
			expect(observations).toEqual([
				{ device: 'desktop', announcers: 0, live: 'Owner status', interactive: true },
				{ device: 'mobile', announcers: 0, live: 'Owner status', interactive: true },
			]);
			const manifest = JSON.parse(readFileSync(join(outputDir, 'screenshots/manifest.json'), 'utf8'));
			const entry = manifest.entries[url];
			for (const [path, device] of [[entry.html, 'Desktop'], [`html-mobile/${entry.slug}.html`, 'Mobile']]) {
				const html = readFileSync(join(outputDir, path), 'utf8');
				const $ = load(html);
				expect($('next-route-announcer, #__next-route-announcer__').length).toBe(0);
				expect($('#owner-status').text()).toBe('Owner status');
				expect($('#owner-clipped[aria-live="assertive"]').length).toBe(1);
				expect($('[role="alert"]').text()).toBe('Owner alert');
				expect($('owner-widget').text()).toBe('Owner custom element');
				expect($('h1').text()).toBe('Owner heading');
				expect($('nav a').attr('href')).toBe('#owner-heading');
				expect($('details summary').text()).toBe('Owner question');
				expect($('#device').text()).toBe(`${device} document`);
			}
			exportWebsiteCapture({ outputDir, sourceUrl: url, platform: detection.platform, summary: {
				routesDiscovered: 1, routesCaptured: result.captured, routesSkipped: result.skipped,
				routesFailed: result.failed, durationMs: result.durationMs,
			}, failures: [] });
			const portable = readFileSync(join(outputDir, 'website/index.html'), 'utf8');
			expect(load(portable)('next-route-announcer, #__next-route-announcer__').length).toBe(0);
			expect(load(portable)('#__NEXT_DATA__').length).toBe(0); // generic export policy strips bootstrap scripts
			expect(portable).toContain('Desktop document');
			expect(portable).toContain('Mobile document');
			expect(portable).toContain('Owner status');
			expect(portable).toContain('Owner custom element');
			const browser = await chromium.launch();
			try {
				for (const [width, device] of [[1440, 'Desktop'], [390, 'Mobile']] as const) {
					const page = await browser.newPage({ viewport: { width, height: 900 } });
					await page.setContent(portable);
					expect(await page.locator('next-route-announcer, #__next-route-announcer__').count()).toBe(0);
					expect(await page.locator('h1:visible').innerText()).toBe('Owner heading');
					expect(await page.locator('[aria-live="polite"]:visible').innerText()).toBe('Owner status');
					expect(await page.locator('owner-widget:visible').innerText()).toBe('Owner custom element');
					expect(await page.locator('main p:visible').allTextContents()).toContain(`${device} document`);
					const details = page.locator('details:visible');
					const open = await details.evaluate((node) => node.hasAttribute('open'));
					await page.locator('summary:visible').click();
					expect(await details.evaluate((node) => node.hasAttribute('open'))).toBe(!open);
					await page.close();
				}
			} finally {
				await browser.close();
			}
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
			rmSync(outputDir, { recursive: true, force: true });
		}
	}, 90_000);
});
