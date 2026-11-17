import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { expect, it } from 'vitest';
import { captureWebsite } from '../index.js';
import { readResolvedPage } from './site-includes.js';

// One two-route public browser capture for all variations (~30s).
it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('serializes route-independent disclosure replay HTML without capture instrumentation', async () => {
	mkdirSync('.tmp-test', { recursive: true });
	const root = mkdtempSync(join(process.cwd(), '.tmp-test/dialog-panel-state-'));
	const variants = [
		{ id: 'plain', attributes: '' },
		{ id: 'empty', attributes: ' style="" class=""' },
		{ id: 'styled', attributes: ' style="color: rgb(1, 2, 3)" class="authored" data-label=""' },
	];
	const server = createServer((request, response) => {
		if (request.url === '/robots.txt') { response.end(''); return; }
		if (request.url?.includes('sitemap')) { response.writeHead(404).end(); return; }
		const about = request.url === '/about/';
		// Route-local text prevents chrome reuse, exercising a fresh dialog probe
		// after each route's baseline serialization rather than reusing entry evidence.
		response.setHeader('Content-Type', 'text/html');
		response.end(`<!doctype html><html><head><title>Menu fixture</title><style>
			nav {position:relative;padding:20px} .panel {display:none;position:absolute;top:100%;background:white}
			.panel.open {display:block} main {padding:100px}
		</style></head><body>${variants.map(({ id, attributes }) => `<nav aria-label="${id}"><span>${about ? 'About' : 'Home'} navigation</span>
			<button aria-controls="${id}" aria-expanded="false">Toggle ${id}</button>
			<div id="${id}" class="panel"><div${attributes}><a href="/" class="link${about ? '' : ' active'}">Home</a><a href="/about/" class="link${about ? ' active' : ''}">About</a></div></div>
		</nav>`).join('')}<main><h1>${about ? 'About' : 'Home'}</h1><p>Neutral menu fixture.</p></main>
		<script>document.querySelectorAll('button').forEach(button => button.onclick = () => {
			const open = button.getAttribute('aria-expanded') !== 'true';
			button.setAttribute('aria-expanded', String(open));
			document.getElementById(button.getAttribute('aria-controls')).classList.toggle('open', open);
		});</script></body></html>`);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	try {
		const result = await captureWebsite({ url, outputDir: root, captureImages: false, trustedOrigins: [url], learnFluid: false }, {
			findAdapter: () => ({ id: 'neutral-menu', detect: () => true, discover: async () => ({ urls: [{ url }, { url: `${url}about/` }] }) }),
		});
		expect(result.summary.routesFailed).toBe(0);
		const pages = ['index.html', 'about/index.html'].map(path => cheerio.load(readResolvedPage(join(root, 'website'), join(root, 'website', path))));
		for (const { id } of variants) {
			const snapshots = pages.map($ => {
				const value = $(`button[aria-controls="${id}"]`).first().attr('data-blocks-engine-capture-dialog-panel-state');
				expect(value, `${id} replay state`).toBeDefined();
				return (JSON.parse(value!) as { html: string }).html;
			});
			for (const html of snapshots) {
				expect(html).not.toContain('data-blocks-engine-node-id');
				expect(html).not.toMatch(/(?:style|class)=""/);
				if (id === 'styled') {
					expect(html).toContain('color: rgb(1, 2, 3)');
					expect(html).toContain('class="authored"');
					expect(html).toContain('data-label=""');
				}
			}
			expect(snapshots[0]).not.toBe(snapshots[1]);
			expect(snapshots[0]).toContain('class="link active">Home');
			expect(snapshots[1]).toContain('class="link active">About');
			expect(snapshots[0]!.replace(/ active/g, '')).toBe(snapshots[1]!.replace(/ active/g, ''));
		}
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
}, 120_000);
