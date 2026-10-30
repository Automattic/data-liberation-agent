import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { expect, it } from 'vitest';
import { captureWebsite } from './capture.js';
import { srcsetReferences } from './srcset.js';
import { captureAssets } from './image-assets.js';
import { exportWebsiteCapture } from './capture-export.js';

async function captureFixture(body: string, check: (outputDir: string, url: string) => void) {
	const server = createServer((request, response) => {
		const width = request.url?.includes('-scaled') ? 2560 : request.url?.includes('300x') ? 300 : 2048;
		response.setHeader('content-type', request.url === '/' ? 'text/html' : 'image/svg+xml');
		response.end(request.url === '/' ? `<!doctype html><html><head><title>Photos</title></head><body>${body}</body></html>` : `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="100"><rect width="100%" height="100%" fill="red"/></svg>`);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	mkdirSync('.tmp-test', { recursive: true });
	const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'portable-limit-'));
	try {
		const result = await captureWebsite({ url, outputDir, acquisition: 'http', trustedOrigins: [url] }, {
			findAdapter: () => ({
				id: 'fixture',
				discover: async () => ({ urls: [], siteMeta: { title: 'Photos' } }),
				acquisition: { id: 'fixture-http', variants: [{ id: 'authored' }], prepare: html => ({ html }) },
			}),
		});
		expect(result.summary.routesCaptured).toBe(1);
		expect(result.failures).toEqual([]);
		// HTTP acquisition is read-only review; exercise the portable asset/export
		// stages explicitly against its captured files, as browser capture does.
		const html = `<!doctype html><html><head><title>Photos</title></head><body>${body}</body></html>`;
		await captureAssets(outputDir, [{ html, url }]);
		mkdirSync(join(outputDir, 'html'), { recursive: true });
		mkdirSync(join(outputDir, 'screenshots'), { recursive: true });
		writeFileSync(join(outputDir, 'html/home.html'), html);
		writeFileSync(join(outputDir, 'screenshots/manifest.json'), JSON.stringify({ version: 1, entries: { [url]: { html: 'html/home.html' } } }));
		exportWebsiteCapture({ outputDir, sourceUrl: url, platform: 'generic', summary: { routesFailed: 0 }, failures: [] });
		check(outputDir, url);
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(outputDir, { recursive: true, force: true });
	}
}

it('captures and exports the widest portable srcset representative', async () => {
	await captureFixture('<img src="/photo-300x100.svg" srcset="/photo-300x100.svg 300w, /photo-2048x100.svg 2048w, /photo-scaled.svg 2560w"><img src="/portrait-1152x2048.svg" srcset="/portrait-1152x2048.svg 1152w, /portrait-scaled.svg 1440w">', (dir, url) => {
		const manifest = JSON.parse(readFileSync(join(dir, 'resources/manifest.json'), 'utf8'));
		expect(manifest.resources[url + 'photo-scaled.svg']).toEqual(manifest.resources[url + 'photo-2048x100.svg']);
		expect(manifest.resources[url + 'portrait-scaled.svg']).toEqual(manifest.resources[url + 'portrait-1152x2048.svg']);
		const $ = cheerio.load(readFileSync(join(dir, 'website/index.html'), 'utf8'));
		for (const reference of [$('img').attr('src')!, ...srcsetReferences($('img').attr('srcset') ?? '')]) {
			expect(reference).toMatch(/^\/media\//);
			const file = join(dir, 'website', reference);
			expect(existsSync(file)).toBe(true);
			expect(readFileSync(file, 'utf8')).toContain('width="2048"');
		}
	});
}, 30_000);

it('exports over-limit social originals using a retained rendition, but never a stub', async () => {
	await captureFixture('<meta property="og:image" content="/photo-scaled.svg"><meta name="twitter:image" content="/photo-scaled.svg"><meta property="og:image:url" content="/alone-scaled.svg"><meta name="twitter:image:src" content="/standalone-300x100.svg"><img src="/photo-2048x100.svg">', (dir, url) => {
		const $ = cheerio.load(readFileSync(join(dir, 'website/index.html'), 'utf8'));
		for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
			const reference = $(selector).attr('content')!;
			expect(reference).toBe($('img').attr('src'));
			expect(reference).toMatch(/^\/media\//);
			expect(readFileSync(join(dir, 'website', reference), 'utf8')).toContain('width="2048"');
		}
		expect($('meta[property="og:image:url"]').attr('content')).toBe(url + 'alone-scaled.svg');
		const standalone = $('meta[name="twitter:image:src"]').attr('content')!;
		expect(standalone).toMatch(/^\/media\//);
		expect(existsSync(join(dir, 'website', standalone))).toBe(true);
	});
}, 30_000);
