import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';
import { load } from 'cheerio';
import { NODE_ID_ATTRIBUTE } from './box-tree.js';

// One capture, roughly 20 seconds: no device-mode probes consume the first
// stylesheet failure, and archive acquisition is allowed to succeed separately.
describe.skipIf(!!process.env.SKIP_BROWSER_TESTS || !existsSync(chromium.executablePath()))('page stylesheet failures (#2125)', () => {
	let server: Server;
	let outputDir: string;
	let origin: string;
	let firstLoads = 0;
	let result: Awaited<ReturnType<typeof captureScreenshots>>;
	let entries: Record<string, { html?: string; desktop?: string; mobileHtml?: string }>;
	beforeAll(async () => {
		mkdirSync('.tmp-test', { recursive: true });
		outputDir = mkdtempSync(join(process.cwd(), '.tmp-test/stylesheet-load-'));
		server = createServer((request, response) => {
			if (request.url === '/gone.css') {
				response.writeHead(404, { 'Content-Type': 'text/plain' });
				response.end('Not found');
				return;
			}
			if (request.url?.endsWith('.css')) {
				const render = request.headers['x-capture-fixture'] === 'route' && request.headers['sec-fetch-dest'] === 'style';
				const fails = request.url === '/always.css' || (render && firstLoads++ === 0);
				response.writeHead(fails ? 403 : 200, { 'Content-Type': 'text/css', 'Cache-Control': 'no-store' });
				response.end(fails ? 'Forbidden' : 'header { position: fixed; height: 120px; top: 0 }');
				return;
			}
			if (!['/once', '/always', '/missing'].includes(request.url ?? '')) {
				response.writeHead(404, { 'Content-Type': 'text/html' });
				response.end('<!doctype html><title>Not found</title><p>Not found</p>');
				return;
			}
			response.setHeader('Content-Type', 'text/html');
			response.end(`<!doctype html><html><head><title>Theme</title><link rel="stylesheet" href="/${request.url === '/always' ? 'always' : request.url === '/missing' ? 'gone' : 'once'}.css"></head><body><header>Theme header</header><main><h1>Page content</h1></main></body></html>`);
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		result = await captureScreenshots({ urls: [`${origin}/once`, `${origin}/always`, `${origin}/missing`], outputDir, concurrency: 1, settleMs: 0, learnFluid: false, captureImages: true,
			viewports: [{ id: 'desktop', width: 1440, height: 900 }],
			initScript: page => page.setExtraHTTPHeaders({ 'x-capture-fixture': 'route' }) });
		entries = JSON.parse(readFileSync(result.manifestPath, 'utf8')).entries;
	}, 120_000);
	afterAll(async () => {
		await new Promise(resolve => server.close(resolve));
		rmSync(outputDir, { recursive: true, force: true });
	});
	it('recaptures a rejected sheet rather than exporting the unstyled render', () => {
		expect(firstLoads).toBeGreaterThan(1);
		const entry = entries[`${origin}/once`]!;
		expect(entry.html).toBeDefined();
		const treePath = entry.html!.replace(/^html\//, 'box-tree/').replace(/\.html$/, '.json');
		const tree = JSON.parse(readFileSync(join(outputDir, treePath), 'utf8'));
		const $ = load(readFileSync(join(outputDir, entry.html!), 'utf8'));
		expect(tree.nodes[$('header').attr(NODE_ID_ATTRIBUTE)!].viewports.desktop.used_styles.position).toBe('fixed');
	});
	it('fails a persistently rejected stylesheet without HTML, screenshots or box-tree', () => {
		expect(result.failed).toBe(1);
		expect(entries[`${origin}/always`]?.html).toBeUndefined();
		expect(entries[`${origin}/always`]?.desktop).toBeUndefined();
		const failures = JSON.parse(readFileSync(join(outputDir, 'screenshots/failures.json'), 'utf8'));
		expect(failures.some((failure: { url: string; error: string }) => failure.url === `${origin}/always` && failure.error.includes('stylesheet-load failed'))).toBe(true);
		for (const dir of ['html', 'box-tree', 'screenshots/desktop']) {
			expect(readdirSync(join(outputDir, dir)).some(name => name.startsWith('always'))).toBe(false);
		}
	});
	it('exports a route whose stylesheet is missing from the source itself', () => {
		expect(entries[`${origin}/missing`]?.html).toBeDefined();
	});
});
