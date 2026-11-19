import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'cheerio';
import { expect, it, vi } from 'vitest';

// Chromium's local-network permission blocks cross-host loopback scripts under
// capture's browser identity. Disable only that check for this neutral fixture.
vi.mock('../browser-kit/browser-kit.js', async importOriginal => {
	const original = await importOriginal<typeof import('../browser-kit/browser-kit.js')>();
	return { ...original, connectBrowser: async () => {
		const { chromium } = await import('playwright');
		// Own launch: disable LocalNetworkAccessChecks for third-party-origin widget attribution.
		return chromium.launch({ headless: true, args: ['--disable-features=LocalNetworkAccessChecks'] });
	} };
});
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';

// One two-profile Chromium capture, approximately 15s. Different loopback
// hostnames and ports exercise differing runtime script origins; no vendor signatures.
it('removes cross-origin runtime islands but preserves authored and same-origin forms', async () => {
	const sibling = createServer((_request, response) => {
		response.setHeader('Content-Type', 'application/javascript');
		response.end(`const widget = document.createElement('div'); widget.id = 'sibling-origin-widget'; widget.style.position = 'fixed'; document.body.append(widget);`);
	});
	await new Promise<void>(resolve => sibling.listen(0, resolve));
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
			// The page wraps createElement with its own inline script, so the
			// wrapper's page-origin frame precedes the widget's in every stack.
			response.end(`<!doctype html><html><head><script>Object.defineProperty(document, 'createElement', { configurable: true, value: function (...args) { return Document.prototype.createElement.apply(this, args); } });</script></head><body><h1>Authored page</h1>
				<form id="authored" style="position:fixed"><input name="newsletter"></form>
				<script>const own = document.createElement('div'); own.id = 'own-widget'; own.style.position = 'fixed'; own.innerHTML = '<form id="own-form"></form>'; document.body.append(own);</script>
				<script>document.body.insertAdjacentHTML('beforeend', '<div id="own-html-widget" style="position:fixed"><form id="own-html-form"></form></div>');</script>
				<script src="http://localhost:${(sibling.address() as { port: number }).port}/widget.js"></script>
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
			expect(html).not.toContain('<div id="sibling-origin-widget"');
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
		await new Promise<void>(resolve => sibling.close(() => resolve()));
		rmSync(outputDir, { recursive: true, force: true });
	}
}, 90_000);

// One capture plus export, approximately 15s. A cross-origin embed script in an
// authored container renders an in-flow form after load (#2038).
it('marks a cross-origin in-flow embed form with inert provenance, not same-origin or HubSpot forms', async () => {
	const renderForm = (id: string) => `(() => { const script = document.currentScript; addEventListener('load', () => {
		const root = document.createElement('div'); root.className = '${id}-root';
		const form = document.createElement('form'); form.id = '${id}';
		const header = document.createElement('header'); header.textContent = 'Contact form'; form.appendChild(header);
		for (let index = 0; index < 4; index++) { const input = document.createElement('input'); input.type = 'text'; form.appendChild(input); }
		const select = document.createElement('select'); select.appendChild(document.createElement('option')); form.appendChild(select);
		form.appendChild(document.createElement('textarea'));
		const footer = document.createElement('footer');
		const submit = document.createElement('button'); submit.type = 'button'; submit.textContent = 'Submit'; footer.appendChild(submit); form.appendChild(footer);
		if ('${id}' === 'page-runtime') {
			const main = document.createElement('main'); main.appendChild(form); root.appendChild(main);
		} else root.appendChild(form);
		script.parentNode.insertBefore(root, script);
	}); })();`;
	const server = createServer((request, response) => {
		if (request.url === '/f/embed.js' || request.url === '/own-form.js' || request.url === '/page-runtime.js') {
			response.setHeader('Content-Type', 'application/javascript');
			response.end(renderForm(request.url === '/own-form.js' ? 'own-form' : request.url === '/page-runtime.js' ? 'page-runtime' : 'vendor-form'));
			return;
		}
		const port = (server.address() as { port: number }).port;
		response.setHeader('Content-Type', 'text/html');
		response.end(`<!doctype html><html><head><title>Embeds</title></head><body><main><h1>Contact</h1>
			<div class="wcustomhtml"><script src="http://127.0.0.1:${port}/f/embed.js" data-key="SITE_FORM_KEY" data-form="1"></script></div>
			<div class="own-embed"><script src="/own-form.js"></script></div>
			<div class="page-runtime-container"><script src="http://127.0.0.1:${port}/page-runtime.js"></script></div>
			<div class="hs-form-frame" data-portal-id="145288931" data-form-id="d320b12e-97d4-4fc0-91be-27d99192f4e9" data-region="eu1"></div>
			<p>Enough authored prose to keep this the primary document.</p></main></body></html>`);
	});
	await new Promise<void>(resolve => server.listen(0, resolve));
	mkdirSync('.tmp-test', { recursive: true });
	const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'runtime-embeds-'));
	try {
		const port = (server.address() as { port: number }).port;
		const url = `http://localhost:${port}/`;
		const result = await captureScreenshots({ urls: [url], primaryUrl: url, outputDir, concurrency: 1, settleMs: 0, learnFluid: false });
		expect(result.failed).toBe(0);
		exportWebsiteCapture({ outputDir, sourceUrl: url, platform: 'default', summary: {
			routesDiscovered: 1, routesCaptured: result.captured, routesSkipped: result.skipped,
			routesFailed: result.failed, durationMs: result.durationMs,
		}, failures: [] });
		const html = readFileSync(join(outputDir, 'website/index.html'), 'utf8');
		const $ = load(html);
		// Rendered DOM stays as visual reference; no executable script ships.
		expect($('#vendor-form').length).toBeGreaterThan(0);
		expect($('#vendor-form > header').text()).toContain('Contact form');
		expect($('#vendor-form > footer > button').length).toBeGreaterThan(0);
		expect($('#vendor-form').closest('[data-blocks-engine-capture-runtime-owner]').length).toBeGreaterThan(0);
		// A cross-origin page runtime still owns the page, not an embed region.
		expect($('.page-runtime-root main #page-runtime').length).toBeGreaterThan(0);
		expect($('.page-runtime-root').closest('[data-blocks-engine-capture-runtime-owner]').length).toBe(0);
		// Only export's own inert data and runtime remain; nothing loads the embed.
		expect($('script[src]').length).toBe(0);
		expect($('script').toArray().some(script => !$(script).attr('data-blocks-engine-capture-source-evidence') && $(script).text().includes('127.0.0.1'))).toBe(false);
		expect(html).not.toContain('embed.js"></script>');
		expect($('[data-blocks-engine-capture-runtime-owner-script], [data-blocks-engine-capture-runtime-owner-data]').length).toBe(0);
		const marked = $('[data-blocks-engine-capture-runtime-owner]');
		expect(marked.length).toBeGreaterThan(0);
		expect(marked.toArray().every(root => $(root).hasClass('vendor-form-root'))).toBe(true);
		const id = marked.first().attr('data-blocks-engine-capture-runtime-owner')!;
		expect(id).toMatch(/^runtime-[0-9a-f]{16}$/);
		const evidence = JSON.parse($('script[data-blocks-engine-capture-source-evidence="runtime-owned-regions"]').text());
		expect(evidence).toEqual({
			schema: 'blocks-engine-capture/runtime-owned-regions/v1',
			regions: [{
				id, selector: `[data-blocks-engine-capture-runtime-owner="${id}"]`,
				script: { origin: `http://127.0.0.1:${port}`, path: '/f/embed.js', data: { 'data-key': 'SITE_FORM_KEY', 'data-form': '1' } },
				roots: Array.from({ length: marked.length }, () => expect.objectContaining({ tag: 'div', controls: 7 })),
			}],
		});
		// A same-origin script's form is not marked.
		expect($('#own-form').length).toBeGreaterThan(0);
		expect($('#own-form').closest('[data-blocks-engine-capture-runtime-owner]').length).toBe(0);
		// HubSpot's declarative restore is unchanged.
		expect($('.hs-form-frame iframe').first().attr('src')).toBe('https://js-eu1.hsforms.net/forms/embed/v2/?portalId=145288931&formId=d320b12e-97d4-4fc0-91be-27d99192f4e9&region=eu1');
		expect($('.hs-form-frame').closest('[data-blocks-engine-capture-runtime-owner]').length).toBe(0);
		const findings = readdirSync(outputDir).filter(name => name.endsWith('.json')).map(name => readFileSync(join(outputDir, name), 'utf8')).join('\n');
		expect(findings).toContain('third_party_runtime_region_marked');
		expect(findings).toContain(`marked [data-blocks-engine-capture-runtime-owner=\\"${id}\\"]`);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(outputDir, { recursive: true, force: true });
	}
}, 90_000);
