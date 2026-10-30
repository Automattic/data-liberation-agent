import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { expect, it } from 'vitest';
import { captureWebsite } from './capture.js';
import { srcsetReferences } from './srcset.js';

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
			<picture><source media="(max-width: 600px)" srcset="/crop-small.svg 200w, /crop-large.svg 800w">
			<img src="/fallback.svg" srcset="/small.svg 200w, /medium.svg 600w, /large.svg 1200w" alt="Landscape"></picture>
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
