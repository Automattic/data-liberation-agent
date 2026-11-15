import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureWebsite } from '../index.js';
import { readResolvedPage } from './site-includes.js';

// A pre-existing drawer is marked before its opened state is serialized.
const source = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0}button{padding:20px}#drawer{position:fixed;inset:60px 0 0;background:white}[hidden]{display:none!important}
</style></head><body><main><h1>Community garden</h1><button id="menu" aria-haspopup="dialog" aria-controls="drawer" aria-expanded="false">Menu</button></main><div id="drawer" role="dialog" aria-label="Navigation" hidden><nav><a href="/"><span>Garden home</span></a></nav><button id="close" aria-label="Close">Close</button></div>
<script>const drawer=document.querySelector('#drawer'),menu=document.querySelector('#menu');menu.onclick=()=>{drawer.hidden=false;menu.setAttribute('aria-expanded','true')};document.querySelector('#close').onclick=()=>{drawer.hidden=true;menu.setAttribute('aria-expanded','false')};</script></body></html>`;

// One public capture and replay (~15 seconds); no synthetic capture attributes.
it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('exports an interactive drawer without capture bookkeeping in any HTML', async () => {
	const parent = join(process.cwd(), '.tmp-test'); mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, 'bookkeeping-'));
	let copy: string | undefined;
	const server = createServer((request, response) => {
		if (request.url === '/robots.txt') { response.end(''); return; }
		if (request.url?.includes('sitemap')) { response.statusCode = 404; response.end(); return; }
		response.setHeader('Content-Type', 'text/html'); response.end(copy ?? source);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	const browser = await chromium.launch();
	try {
		const result = await captureWebsite({ url, outputDir: root, captureImages: false, trustedOrigins: [url], learnFluid: false }, {
			findAdapter: () => ({ id: 'garden-fixture', detect: () => true, discover: async () => ({ urls: [{ url }] }) }),
		});
		expect(result.summary.routesFailed).toBe(0);
		const website = join(root, 'website');
		const htmlFiles = readdirSync(website, { recursive: true }).filter(path => String(path).endsWith('.html'));
		expect(htmlFiles.length).toBeGreaterThan(0);
		for (const path of htmlFiles) {
			const html = readFileSync(join(website, String(path)), 'utf8');
			expect(html, String(path)).not.toContain('data-blocks-engine-capture-initial-node');
			expect(html, String(path)).not.toContain('data-blocks-engine-capture-geometry-id');
		}
		copy = readResolvedPage(website, join(website, 'index.html'));
		expect(copy).toContain('data-blocks-engine-capture-dialog-trigger');
		const page = await browser.newPage(); await page.goto(url);
		await page.locator('#menu').click();
		const link = page.getByRole('link', { name: 'Garden home' });
		await expect.poll(() => link.isVisible()).toBe(true);
		expect(await link.locator('span').textContent()).toBe('Garden home');
		await page.keyboard.press('Escape');
		await expect.poll(() => link.isVisible()).toBe(false);
	} finally {
		await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
	}
}, 180_000);
