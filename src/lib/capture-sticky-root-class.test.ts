import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureWebsite } from '../index.js';
import { readResolvedPage } from './site-includes.js';

// A source script adds a root class at narrow widths and never removes it on
// widening. Capture's narrow probes (consent banner layout, root-class ladder)
// must not leak it into the desktop copy.
const source = `<!doctype html><html><head><style>
nav a{display:inline-block;margin:0 8px}
body.menu-mobile nav{position:fixed;top:-100vh}
@media (max-width:768px){nav{position:fixed;top:-100vh}}
</style></head><body class="site"><header><nav><a href="/buy">Buy</a><a href="/sell">Sell</a></nav></header><main><h1>Homes</h1><p>Listings.</p></main>
<div id="cookie-banner" style="position:fixed;left:0;right:0;bottom:0;padding:24px;background:#fff"><p>This website uses cookies to analyze traffic.</p><button onclick="this.parentNode.remove()">Accept</button></div>
<script>function check(){if(innerWidth<=1024)document.body.classList.add('menu-mobile')}check();addEventListener('resize',check)</script></body></html>`;

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('keeps a sticky narrow-width root class out of the desktop document', async () => {
	mkdirSync('.tmp-test', { recursive: true });
	const root = mkdtempSync(join(process.cwd(), '.tmp-test/sticky-root-'));
	const server = createServer((request, response) => {
		if (request.url === '/robots.txt') { response.end(''); return; }
		if (request.url?.includes('sitemap')) { response.writeHead(404).end(); return; }
		response.setHeader('Content-Type', 'text/html');
		response.end(source);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	try {
		const result = await captureWebsite({ url, outputDir: root, captureImages: false, trustedOrigins: [url], learnFluid: false }, {
			findAdapter: () => ({ id: 'neutral-sticky-root', detect: () => true, discover: async () => ({ urls: [{ url }] }) }),
		});
		expect(result.summary.routesFailed).toBe(0);
		const html = readResolvedPage(join(root, 'website'), join(root, 'website/index.html'));
		// The desktop document keeps the capture-width root classes.
		const desktop = html.match(/class="([^"]*capture-desktop-document[^"]*)"/)?.[1] ?? html.match(/<body\b[^>]*class="([^"]*)"/)?.[1] ?? '';
		expect(desktop.split(/\s+/)).toContain('site');
		expect(desktop.split(/\s+/)).not.toContain('menu-mobile');
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
}, 120_000);
