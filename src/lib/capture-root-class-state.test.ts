import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureWebsite } from '../index.js';
import { readResolvedPage } from './site-includes.js';

// One public capture, then portable replay at phone and desktop widths (~15s).
it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('replays root-gated drawers through public capture and export', async () => {
	mkdirSync('.tmp-test', { recursive: true });
	const root = mkdtempSync(join(process.cwd(), '.tmp-test/root-drawer-'));
	const source = readFileSync(new URL('../../test/fixtures/root-class-drawer.html', import.meta.url), 'utf8');
	let copy: string | undefined;
	const server = createServer((request, response) => {
		if (request.url === '/robots.txt') { response.end(''); return; }
		if (request.url?.includes('sitemap')) { response.writeHead(404).end(); return; }
		response.setHeader('Content-Type', 'text/html');
		const phone = /Mobile/.test(request.headers['user-agent'] ?? '');
		response.end(request.url === '/copy/' && copy ? copy : phone ? source.replace('nav-closed persistent', 'nav-closed persistent phone').replace('<main>', '<main><aside>Phone navigation</aside>') : source);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	const browser = await chromium.launch();
	try {
		const result = await captureWebsite({ url, outputDir: root, captureImages: false, trustedOrigins: [url], learnFluid: false }, {
			findAdapter: () => ({ id: 'neutral-drawer', detect: () => true, discover: async () => ({ urls: [{ url }] }) }),
		});
		expect(result.summary.routesFailed).toBe(0);
		copy = readResolvedPage(join(root, 'website'), join(root, 'website/index.html'));
		const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
		await page.goto(`${url}copy/`);
		expect(copy).toContain('data-blocks-engine-capture-mobile-document');
		let widthIsPhone = true;
		const scope = () => page.locator(widthIsPhone ? '.data-blocks-engine-capture-mobile-document' : '.data-blocks-engine-capture-desktop-document');
		for (const width of [390, 1440]) {
			widthIsPhone = width === 390;
			await page.setViewportSize({ width, height: 900 });
			const trigger = scope().locator('[data-blocks-engine-capture-dialog-trigger]');
			const links = scope().locator('.drawer a');
			expect(await links.count()).toBe(5);
			expect(await links.first().isVisible()).toBe(false);
			await trigger.click();
			await expect.poll(() => links.first().isVisible()).toBe(true);
			for (const link of await links.all()) expect(await link.isVisible()).toBe(true);
			expect(await scope().evaluate(node => node.classList.contains('nav-open') && !node.classList.contains('nav-closed'))).toBe(true);
			const other = page.locator(widthIsPhone ? '.data-blocks-engine-capture-desktop-document' : '.data-blocks-engine-capture-mobile-document');
			expect(await other.evaluate(node => node.classList.contains('nav-closed') && !node.classList.contains('nav-open'))).toBe(true);
			await trigger.click();
			expect(await links.first().isVisible()).toBe(false);
			await trigger.click();
			await page.keyboard.press('Escape');
			await expect.poll(() => links.first().isVisible()).toBe(false);
			expect(await page.locator('.persistent').count()).toBeGreaterThan(0);
		}
	} finally {
		await browser.close();
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
}, 90_000);
