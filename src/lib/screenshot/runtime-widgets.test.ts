import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

// Chromium's local-network permission blocks cross-host loopback scripts under
// capture's browser identity. Disable only that check for this neutral fixture.
vi.mock('../browser-kit/browser-kit.js', async importOriginal => {
	const original = await importOriginal<typeof import('../browser-kit/browser-kit.js')>();
	return { ...original, connectBrowser: async () => {
		const { chromium } = await import('playwright');
		return chromium.launch({ headless: true, args: ['--disable-features=LocalNetworkAccessChecks'] });
	} };
});
import { captureScreenshots } from './screenshotter.js';

// One two-profile Chromium capture, approximately 15s. Different loopback
// hostnames stand in for different registrable domains; no vendor signatures.
it('removes third-party runtime islands but preserves authored and first-party forms', async () => {
	const server = createServer((request, response) => {
		if (request.url === '/widget.js') {
			response.setHeader('Content-Type', 'application/javascript');
			response.end(`addEventListener('load', () => {
				const root = document.createElement('div');
				root.id = 'neutral-widget'; root.style.position = 'fixed';
				root.innerHTML = '<form id="external-survey"><input name="feedback"></form>';
				document.body.appendChild(root);
				document.body.insertAdjacentHTML('beforeend', '<div id="html-widget" style="position:fixed"><form id="html-widget-form"></form></div>');
				document.body.insertAdjacentHTML('beforeend', '<section id="html-in-flow">Legitimate embedded HTML</section>');
				// An empty in-flow root whose only rendered content is fixed.
				const shell = document.createElement('div'); shell.id = 'neutral-shell';
				shell.innerHTML = '<div style="position:fixed;bottom:0"><form id="external-shell-form"><fieldset><input name="rating"></fieldset></form></div>';
				document.body.appendChild(shell);
				for (const method of ['prepend', 'insertAdjacentElement']) {
					const overlay = document.createElement('div');
					overlay.id = method + '-widget'; overlay.style.position = 'fixed';
					if (method === 'prepend') document.body.prepend(overlay);
					else document.body.insertAdjacentElement('beforeend', overlay);
				}
				// Moving an authored node is not ownership, through any node API.
				const authored = document.getElementById('authored');
				document.body.prepend(authored);
				document.body.insertAdjacentElement('beforeend', authored);
				document.body.appendChild(authored);
				const content = document.createElement('section'); content.id = 'in-flow';
				content.textContent = 'Legitimate embedded content'; document.body.append(content);
			});`);
		} else {
			const port = (server.address() as { port: number }).port;
			response.setHeader('Content-Type', 'text/html');
			response.end(`<!doctype html><html><body><h1>Authored page</h1>
				<form id="authored" style="position:fixed"><input name="newsletter"></form>
				<script>const own = document.createElement('div'); own.id = 'own-widget'; own.style.position = 'fixed'; own.innerHTML = '<form id="own-form"></form>'; document.body.append(own);</script>
				<script>document.body.insertAdjacentHTML('beforeend', '<div id="own-html-widget" style="position:fixed"><form id="own-html-form"></form></div>');</script>
				<script src="http://127.0.0.1:${port}/widget.js"></script></body></html>`);
		}
	});
	await new Promise<void>(resolve => server.listen(0, resolve));
	mkdirSync('.tmp-test', { recursive: true });
	const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'runtime-widgets-'));
	try {
		const url = `http://localhost:${(server.address() as { port: number }).port}/`;
		const result = await captureScreenshots({ urls: [url], outputDir, concurrency: 1, settleMs: 0, learnFluid: false });
		expect(result.failed).toBe(0);
		const entry = JSON.parse(readFileSync(result.manifestPath, 'utf8')).entries[url];
		for (const path of [entry.html, entry.mobileHtml]) {
			expect(path).toBeTruthy();
			const html = readFileSync(join(outputDir, path), 'utf8');
			expect(html).toContain('<form id="authored"');
			expect(html).toContain('<form id="own-form"');
			expect(html).toContain('<section id="in-flow"');
			expect(html).toContain('<section id="html-in-flow"');
			expect(html).toContain('<form id="own-html-form"');
			// Scripts remain in this intermediate capture, so match markup only.
			expect(html).not.toContain('<div id="neutral-widget"');
			expect(html).not.toContain('<div id="neutral-shell"');
			expect(html).not.toContain('<div id="html-widget"');
			for (const method of ['prepend', 'insertAdjacentElement']) {
				expect(html).not.toContain('<div id="' + method + '-widget"');
			}
		}
		for (const profile of ['desktop', 'mobile']) {
			expect(entry.profiles[profile].diagnostics).toContainEqual({
				code: 'third_party_runtime_widget_removed',
				reason: expect.stringMatching(/removed div#html-widget; runtime script origin http:\/\/127\.0\.0\.1:/),
			});
			expect(entry.profiles[profile].diagnostics).toContainEqual({
				code: 'third_party_runtime_widget_removed',
				reason: expect.stringMatching(/removed div#neutral-widget; runtime script origin http:\/\/127\.0\.0\.1:/),
			});
		}
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(outputDir, { recursive: true, force: true });
	}
}, 90_000);
