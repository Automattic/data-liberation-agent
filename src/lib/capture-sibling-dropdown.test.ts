import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureWebsite } from '../index.js';
import { readResolvedPage } from './site-includes.js';

// One public capture, then portable replay at phone and desktop widths (~15s).
it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('adopts sibling dropdowns in each responsive document through public capture and export', async () => {
	mkdirSync('.tmp-test', { recursive: true });
	const root = mkdtempSync(join(process.cwd(), '.tmp-test/sibling-dropdown-'));
	const source = readFileSync(new URL('../../test/fixtures/sibling-dropdown.html', import.meta.url), 'utf8');
	let copy: string | undefined;
	const server = createServer((request, response) => {
		if (request.url === '/robots.txt') { response.end(''); return; }
		if (request.url?.includes('sitemap')) { response.writeHead(404).end(); return; }
		response.setHeader('Content-Type', 'text/html');
		const phone = /Mobile/.test(request.headers['user-agent'] ?? '');
		response.end(request.url === '/copy/' && copy ? copy : phone ? source.replace('<body>', '<body class="phone">').replace('Portable navigation fixture.', '<section><h2>Phone layout</h2><p>Additional phone content</p></section>') : source);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	const browser = await chromium.launch();
	try {
		const result = await captureWebsite({ url, outputDir: root, captureImages: false, trustedOrigins: [url], learnFluid: false }, {
			findAdapter: () => ({ id: 'neutral-dropdown', detect: () => true, discover: async () => ({ urls: [{ url }] }) }),
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
			const drawer = scope().locator('nav.drawer');
			expect(await drawer.count()).toBe(1);
			expect(await drawer.getAttribute('data-blocks-engine-capture-existing-panel')).not.toBeNull();
			expect(await drawer.evaluate(node => node.parentElement?.classList.contains('shell') && node.previousElementSibling?.classList.contains('bar'))).toBe(true);
			expect(await scope().locator('.bar [data-blocks-engine-capture-dialog-panel]').count()).toBe(0);
			const links = drawer.locator('a');
			expect(await links.count()).toBe(3);
			expect(await links.first().isVisible()).toBe(false);
			await trigger.click();
			await expect.poll(() => links.first().isVisible()).toBe(true);
			for (const link of await links.all()) expect(await link.isVisible()).toBe(true);
			expect((await drawer.boundingBox())!.y).toBe(0);
			expect(await trigger.evaluate(node => { const rect = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })).toBe(true);
			await trigger.click();
			expect(await links.first().isVisible()).toBe(false);
			await trigger.click();
			await page.keyboard.press('Escape');
			await expect.poll(() => links.first().isVisible()).toBe(false);
			expect(await page.locator('nav.drawer').count()).toBe(2);
		}
	} finally {
		await browser.close();
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
}, 90_000);
