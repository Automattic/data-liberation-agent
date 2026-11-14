import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { BROWSER_IMAGE_ACCEPT, createSourceContext } from './browser-kit/source-identity.js';
import { CapturedResourceStore, installResourceReplay } from './screenshot/resource-capture.js';
import { captureAssets, imageContentType } from './image-assets.js';
import { exportWebsiteCapture } from './capture-export.js';
import { srcsetReferences } from './srcset.js';

// One browser pass (~2 seconds): exercise identity routing alone and replay's
// cache-miss fallback, with Chromium 156's image negotiation on older builds too.
it('exports verified src and srcset bytes despite browser JPEG XL negotiation', async () => {
	const jxl = Buffer.from('\x00\x00\x00\x0cJXL \r\n\x87\n', 'latin1');
	const served: Array<{ path: string; accept: string }> = [];
	const images = new Map<string, Buffer>();
	const html = '<!doctype html><html><body><img id="plain" src="/plain.webp"><img id="responsive" src="/large.webp" srcset="/small.webp 400w, /large.webp 800w" sizes="100vw"></body></html>';
	const server = createServer((request, response) => {
		const path = request.url!;
		const accept = request.headers.accept ?? '';
		served.push({ path, accept });
		if (path === '/') {
			response.writeHead(200, { 'content-type': 'text/html' });
			response.end(html);
		} else {
			const xl = accept.includes('image/jxl');
			response.writeHead(200, { 'content-type': xl ? 'image/jxl' : 'image/png' });
			response.end(xl ? jxl : images.get(path));
		}
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	mkdirSync('.tmp-test', { recursive: true });
	const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'image-negotiation-'));
	const browser = await chromium.launch({ headless: true });
	try {
		const generator = await browser.newPage();
		for (const [path, width] of [['/plain.webp', 200], ['/small.webp', 400], ['/large.webp', 800]] as const) {
			const data = await generator.evaluate(width => {
				const canvas = document.createElement('canvas');
				canvas.width = width; canvas.height = width / 2;
				const ctx = canvas.getContext('2d')!;
				ctx.fillStyle = 'red'; ctx.fillRect(0, 0, width, width / 2);
				return canvas.toDataURL().split(',')[1];
			}, width);
			images.set(path, Buffer.from(data, 'base64'));
		}
		await generator.close();
		const store = new CapturedResourceStore(outputDir, url);
		for (const replay of [false, true]) {
			const context = await createSourceContext(browser, {
				userAgent: 'Mozilla/5.0 Chrome/156.0.0.0 Safari/537.36',
				extraHTTPHeaders: { accept: `image/jxl,${BROWSER_IMAGE_ACCEPT}` },
				viewport: { width: replay ? 900 : 400, height: 600 }, deviceScaleFactor: 1,
			});
			if (replay) await installResourceReplay(context, store);
			const page = await context.newPage();
			store.observe(page);
			await page.goto(url, { waitUntil: 'networkidle' });
			await store.settle(page);
			await context.close();
		}
		await store.flush();
		// Ensure both the representative and an independently captured alias exist.
		const manifest = JSON.parse(readFileSync(join(outputDir, 'resources/manifest.json'), 'utf8'));
		for (const path of images.keys()) expect(manifest.resources[url + path.slice(1)]).toBeDefined();
		const records = await captureAssets(outputDir, [{ url, html }], Date.now() - 1);
		expect(records.every(record => record.original?.content_type === 'image/png')).toBe(true);
		const responsive = records.find(record => record.source_urls.includes(url + 'small.webp'))!;
		expect(responsive.renditions?.map(record => record.original?.source_url)).toContain(url + 'small.webp');
		mkdirSync(join(outputDir, 'html'));
		mkdirSync(join(outputDir, 'screenshots'));
		writeFileSync(join(outputDir, 'html/home.html'), html);
		writeFileSync(join(outputDir, 'screenshots/manifest.json'), JSON.stringify({ version: 1, entries: { [url]: { html: 'html/home.html' } } }));
		exportWebsiteCapture({ outputDir, sourceUrl: url, platform: 'generic', summary: { routesFailed: 0 }, failures: [] });
		const $ = cheerio.load(readFileSync(join(outputDir, 'website/index.html'), 'utf8'));
		const references = [$('img#plain').attr('src')!, $('img#responsive').attr('src')!, ...srcsetReferences($('img#responsive').attr('srcset') ?? '')];
		expect(srcsetReferences($('img#responsive').attr('srcset') ?? '').length).toBeGreaterThan(1);
		for (const reference of references) {
			expect(reference).toMatch(/^\//);
			expect(extname(reference)).toBe('.png');
			const bytes = readFileSync(join(outputDir, 'website', reference));
			expect(imageContentType(bytes)).toBe('image/png');
			expect(bytes.subarray(0, jxl.length)).not.toEqual(jxl);
		}
		expect(served.filter(request => images.has(request.path)).map(request => request.accept)).toEqual(expect.arrayContaining([BROWSER_IMAGE_ACCEPT]));
		expect(served.filter(request => images.has(request.path)).every(request => request.accept === BROWSER_IMAGE_ACCEPT)).toBe(true);
		// Documents are not given the image-only Accept header.
		expect(served.filter(request => request.path === '/').every(request => request.accept !== BROWSER_IMAGE_ACCEPT)).toBe(true);
	} finally {
		await browser.close();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(outputDir, { recursive: true, force: true });
	}
}, 30_000);
