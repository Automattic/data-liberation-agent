import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { expect, it } from 'vitest';
import { captureWebsite } from './capture.js';
import { srcsetReferences } from './srcset.js';
import { chromium } from 'playwright';
import { CapturedResourceStore } from './screenshot/resource-capture.js';
import { exportWebsiteCapture } from './capture-export.js';

it('maps real browser responses at multiple viewports before exporting', async () => {
	const html = '<!doctype html><html><body><picture><source media="(max-width: 600px)" sizes="100vw" srcset="/crop-small.svg 400w, /crop-large.svg 800w"><img sizes="100vw" src="/fallback.svg" srcset="/small.svg 400w, /medium.svg 800w, /large.svg 1600w"></picture></body></html>';
	const server = createServer((request, response) => {
		response.setHeader('content-type', request.url === '/' ? 'text/html' : 'image/svg+xml');
		response.end(request.url === '/' ? html : `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="800"><text>${request.url}</text></svg>`);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	mkdirSync('.tmp-test', { recursive: true });
	const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'browser-srcset-'));
	const browser = await chromium.launch({ headless: true });
	try {
		const store = new CapturedResourceStore(outputDir, url, async resourceUrl => {
			const response = await fetch(resourceUrl);
			return { finalUrl: resourceUrl, status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
		});
		const selected: string[] = [];
		for (const width of [390, 768, 1440]) {
			const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
			store.observe(page);
			await page.goto(url, { waitUntil: 'networkidle' });
			selected.push(await page.locator('img').evaluate(img => (img as HTMLImageElement).currentSrc));
			await store.captureDomDependencies(await page.content(), url);
			await store.settle(page);
			await page.close();
		}
		expect(selected).toEqual(['crop-small.svg', 'medium.svg', 'large.svg'].map(path => url + path));
		await store.flush();
		const manifest = JSON.parse(readFileSync(join(outputDir, 'resources/manifest.json'), 'utf8'));
		expect(manifest.failures).toEqual([]);
		expect(manifest.omissions).toHaveLength(4);
		expect(new Set(Object.values(manifest.resources).map((entry: any) => entry.path)).size).toBe(2);
		expect(readdirSync(join(outputDir, 'resources')).filter(path => path.endsWith('.svg'))).toHaveLength(2);
		for (const omission of manifest.omissions) {
			expect(omission.reason).toBe('redundant-srcset-rendition');
			expect(manifest.resources[omission.url]).toEqual(manifest.resources[omission.representative]);
		}
		mkdirSync(join(outputDir, 'html'));
		mkdirSync(join(outputDir, 'screenshots'));
		writeFileSync(join(outputDir, 'html/home.html'), html);
		writeFileSync(join(outputDir, 'screenshots/manifest.json'), JSON.stringify({ version: 1, entries: { [url]: { html: 'html/home.html' } } }));
		exportWebsiteCapture({ outputDir, sourceUrl: url, platform: 'generic', summary: { routesFailed: 0 }, failures: [] });
		const $ = cheerio.load(readFileSync(join(outputDir, 'website/index.html'), 'utf8'));
		const references = [$('img').attr('src')!, ...srcsetReferences($('img').attr('srcset') ?? ''), ...srcsetReferences($('source').attr('srcset') ?? '')];
		for (const reference of references) {
			expect(reference).not.toMatch(/^https?:/);
			expect(existsSync(join(outputDir, 'website', reference.replace(/^\//, '')))).toBe(true);
		}
	} finally {
		await browser.close();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(outputDir, { recursive: true, force: true });
	}
}, 30_000);

// HTTP capture uses the same resource store without browser image requests;
// counting source requests proves that unused candidates were never downloaded.
it('captures representative srcset renditions and exports resolvable references', async () => {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		const path = request.url!;
		if (path !== '/') {
			if (path.endsWith('.svg')) requests.push(path);
			response.writeHead(200, { 'content-type': 'image/svg+xml' });
			response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><text>${path}</text></svg>`);
			return;
		}
		response.writeHead(200, { 'content-type': 'text/html' });
		response.end(`<!doctype html><html><head><title>Renditions</title><meta property="og:image" content="/social.svg"></head><body>
			<picture><source media="(max-width: 600px)" sizes="100vw" srcset="/crop-small.svg 400w, /crop-large.svg 800w">
			<img src="/fallback.svg" sizes="100vw" srcset="/small.svg 400w, /medium.svg 800w, /large.svg 1600w" alt="Landscape"></picture>
		</body></html>`);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	mkdirSync('.tmp-test', { recursive: true });
	const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'srcset-capture-'));
	try {
		const result = await captureWebsite({ url, outputDir, acquisition: 'http', trustedOrigins: [url] }, {
			findAdapter: () => ({
				id: 'fixture',
				discover: async () => ({ urls: [], siteMeta: { title: 'Renditions' } }),
				acquisition: { id: 'fixture-http', variants: [{ id: 'authored' }], prepare: html => ({ html }) },
			}),
		});
		expect(result.summary.routesCaptured).toBe(1);
		expect(result.failures).toEqual([]);
		expect(requests.sort()).toEqual(['/crop-large.svg', '/large.svg', '/social.svg']);
		const manifest = JSON.parse(readFileSync(join(outputDir, 'resources/manifest.json'), 'utf8'));
		expect(manifest.failures).toEqual([]);
		expect(manifest.omissions).toHaveLength(4);
		expect(new Set(Object.values(manifest.resources).map((entry: any) => entry.path)).size).toBe(3);
		for (const omission of manifest.omissions) {
			expect(omission.reason).toBe('redundant-srcset-rendition');
			expect(manifest.resources[omission.url]).toEqual(manifest.resources[omission.representative]);
		}
		const $ = cheerio.load(readFileSync(join(outputDir, 'website/index.html'), 'utf8'));
		const references: string[] = [];
		$('img,source').each((_, element) => {
			const node = $(element);
			if (node.attr('src')) references.push(node.attr('src')!);
			references.push(...srcsetReferences(node.attr('srcset') ?? ''));
		});
		expect(references.length).toBeGreaterThan(0);
		for (const reference of references) {
			expect(reference).not.toMatch(/^https?:/);
			expect(existsSync(join(outputDir, 'website', reference.replace(/^\//, ''))), reference).toBe(true);
		}
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(outputDir, { recursive: true, force: true });
	}
}, 30_000);
