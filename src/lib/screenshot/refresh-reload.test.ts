import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { navigateSourceDocument, SOURCE_NAVIGATION_LIMITS } from '../source-navigation.js';

describe.skipIf(!!process.env.SKIP_BROWSER_TESTS || !existsSync(chromium.executablePath()))('same-document refresh capture', () => {
	it.each(['meta', 'header'] as const)('retains a normal 200 heading with a 60-second %s refresh and no destination', async mechanism => {
		const source = createServer((_request, response) => {
			response.setHeader('content-type', 'text/html');
			if (mechanism === 'header') response.setHeader('refresh', '60');
			response.end(`<meta name="viewport" content="width=device-width,initial-scale=1">${mechanism === 'meta' ? '<meta http-equiv="refresh" content="60">' : ''}<h1>Ordinary refresh heading</h1>`);
		});
		await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
		const url = `http://127.0.0.1:${(source.address() as {port:number}).port}/`;
		const parent = join(process.cwd(), '.tmp-test'); mkdirSync(parent, {recursive: true});
		const directory = mkdtempSync(join(parent, 'refresh-baseline-'));
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage(); const requests: string[] = [];
			page.on('request', request => requests.push(request.url()));
			// Browser baseline: this declaration loads the source document normally.
			expect((await page.goto(url))!.status()).toBe(200);
			expect(await page.locator('h1').innerText()).toBe('Ordinary refresh heading');
			const navigation = await navigateSourceDocument(page, url);
			expect(navigation.response!.status()).toBe(200);
			expect(navigation.boundary).toBeUndefined(); expect(navigation.redirectedTo).toBeUndefined();
			expect(await page.locator('h1').innerText()).toBe('Ordinary refresh heading');
			expect(requests.every(request => new URL(request).origin === new URL(url).origin)).toBe(true);
			const capture = await captureScreenshots({urls:[url], primaryUrl:url, outputDir:directory, concurrency:1, settleMs:0, learnFluid:false});
			expect(capture.failed).toBe(0); expect(capture.captured).toBe(1);
			const entry = JSON.parse(readFileSync(join(directory,'screenshots/manifest.json'),'utf8')).entries[url];
			expect(entry.externalRedirect).not.toBe(true); expect(entry.redirectedTo).toBeUndefined();
			expect(readFileSync(join(directory,entry.html),'utf8')).toContain('Ordinary refresh heading');
		} finally { await browser.close(); source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve())); rmSync(directory,{recursive:true,force:true}); }
	}, 60_000);

	it.each(['meta', 'header'] as const)('settles a finite immediate %s reload and bounds immediate/delayed reload loops', async mechanism => {
		const counts = new Map<string, number>();
		const source = createServer((request, response) => {
			const path = request.url!; const count = (counts.get(path) ?? 0) + 1; counts.set(path,count);
			const delay = path === '/delayed-loop' ? '0.05' : '0';
			const refresh = path !== '/once' || count === 1;
			response.setHeader('content-type','text/html');
			if (mechanism === 'header' && refresh) response.setHeader('refresh',delay);
			response.end(`${mechanism === 'meta' && refresh ? `<meta http-equiv="refresh" content="${delay}">` : ''}<h1>Reload observation ${count}</h1>`);
		});
		await new Promise<void>(resolve => source.listen(0,'127.0.0.1',resolve));
		const origin = `http://127.0.0.1:${(source.address() as {port:number}).port}`;
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage(); const requests: string[] = [];
			page.on('request', request => requests.push(request.url()));
			const once = await navigateSourceDocument(page,`${origin}/once`);
			expect(once.boundary).toBeUndefined(); expect(once.redirectedTo).toBeUndefined();
			expect(await page.locator('h1').innerText()).toBe('Reload observation 2');
			for (const path of ['/immediate-loop','/delayed-loop']) {
				const start = Date.now();
				await expect(navigateSourceDocument(page,`${origin}${path}`)).rejects.toThrow(/reload.*budget/i);
				expect(Date.now()-start).toBeLessThan(SOURCE_NAVIGATION_LIMITS.timeoutMs);
				expect(counts.get(path)).toBeLessThanOrEqual(SOURCE_NAVIGATION_LIMITS.hops + 1);
			}
			expect(requests.every(request => new URL(request).origin === origin)).toBe(true);
		} finally { await browser.close(); source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve())); }
	}, 60_000);
});
