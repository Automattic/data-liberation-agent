import { expect } from 'vitest';
import { it } from '../../../test/browser.js';
import { waitForStable } from './page-helpers.js';
import { loadSourceBaseline } from './load-baseline.js';
import type { ManifestEntry, ProfileDiagnostic } from './manifest-queue.js';

// One browser pass, about 9 s including the permanently unmounted control.
it('captures late footer media and names components still pending at the bound', async ({ newPage, serve }) => {
	const { origin } = await serve((request, response) => {
		response.setHeader('content-type', 'text/html');
		if (request.url === '/never-mounted') {
			response.end('<!doctype html><title>Pending</title><sample-iframe id="pending-map"></sample-iframe><img id="pending-icon" data-src="later" width="24" height="24">');
			return;
		}
		response.end(`<!doctype html><title>Delayed footer</title>
		<footer>
			<sample-iframe id="map"><div></div></sample-iframe>
			<picture><img id="icon" data-src="pending" width="24" height="24" alt="Orbit"></picture>
			<picture><img id="variant" width="24" height="24" alt="Signal"><img style="display:none" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></picture>
			<img id="authored-empty" width="24" height="24" alt="Intentionally empty">
		</footer>
		<script>addEventListener('load', () => setTimeout(() => {
			document.querySelector('#map div').innerHTML = '<iframe title="Map" src="about:blank"></iframe>';
			for (const id of ['icon', 'variant']) document.getElementById(id).src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
		}, 1000));</script>`);
	});
	const page = await newPage();
	const diagnostics: ProfileDiagnostic[] = [];
	const failures: unknown[] = [];
	const url = `${origin}/delayed-footer`;
	const load = await loadSourceBaseline({
		page, url, viewport: { id: 'desktop', width: 1440, height: 900 }, outputDir: '.tmp-test',
		entry: {} as ManifestEntry, diagnostics, browserProfile: { isMobile: false, hasTouch: false },
		publicUrlsOnly: false, serverLinks: new Set(), rendererCrashed: () => false,
		sourceErrors: () => [], fail: (...args) => { failures.push(args); }, settleMs: 0, evaluateTimeoutMs: 10_000,
	});
	expect(load).toBeDefined();
	expect(failures).toEqual([]);
	expect(await page.content()).toContain('<iframe title="Map" src="about:blank"></iframe>');
	for (const id of ['icon', 'variant']) expect(await page.locator(`#${id}`).getAttribute('src')).toMatch(/^data:image/);
	// Assert the readiness result itself, not just later lazy-load waits that
	// can accidentally give a timer enough time to fire before serialization.
	await load!.releaseBaselineNavigation();
	await page.goto(url);
	await waitForStable(page);
	const html = await page.content();
	expect(html).toContain('<iframe title="Map" src="about:blank"></iframe>');
	for (const id of ['icon', 'variant']) expect(await page.locator(`#${id}`).getAttribute('src')).toMatch(/^data:image/);
	expect(diagnostics).toEqual([]);

	// Reuse the same browser: the never-mounted case must remain bounded and
	// publish route/selector evidence rather than silently serializing empties.
	const pendingUrl = `${origin}/never-mounted`;
	const pending = await loadSourceBaseline({
		page, url: pendingUrl, viewport: { id: 'desktop', width: 1440, height: 900 }, outputDir: '.tmp-test',
		entry: {} as ManifestEntry, diagnostics, browserProfile: { isMobile: false, hasTouch: false },
		publicUrlsOnly: false, serverLinks: new Set(), rendererCrashed: () => false,
		sourceErrors: () => [], fail: (...args) => { failures.push(args); }, settleMs: 0, evaluateTimeoutMs: 10_000,
	});
	expect(diagnostics).toEqual(['#pending-map', '#pending-icon'].map(selector => ({
		code: 'media_mount_pending', reason: expect.stringContaining(`${pendingUrl}: media component ${selector}`),
	})));
	expect(failures).toEqual([]);
	await pending!.releaseBaselineNavigation();
}, 30_000);
