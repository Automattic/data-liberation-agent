import { expect } from 'vitest';
import { it } from '../../../test/browser.js';
import { settleDocument, triggerLazyLoad, waitForStable } from './page-helpers.js';
import { loadSourceBaseline } from './load-baseline.js';
import type { ManifestEntry, ProfileDiagnostic } from './manifest-queue.js';

// One browser pass, about 9 s including the permanently unmounted control.
it('captures late footer media and names components still pending at the bound', async ({ newPage, serve }) => {
	const { origin } = await serve((request, response) => {
		response.setHeader('content-type', 'text/html');
		if (request.url === '/never-mounted') {
			response.end('<!doctype html><title>Pending</title><sample-iframe id="pending-map"></sample-iframe><picture><img id="pending-icon" width="24" height="24"><img hidden src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></picture>');
			return;
		}
		response.end(`<!doctype html><title>Delayed footer</title>
		<footer>
			<sample-iframe id="map"><div></div></sample-iframe>
			<picture><img id="icon" width="24" height="24" alt="Orbit"><img hidden src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></picture>
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

// One browser pass, about 2 s for settle and the lazy-load sweep.
it('leaves intersection-driven images to the lazy-load sweep', async ({ newPage }) => {
	const page = await newPage();
	const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
	await page.setContent(`<!doctype html><title>Lazy cards</title>
		<picture><img loading="lazy" width="24" height="24"><img hidden src="${pixel}"></picture>
		<div data-src="${pixel}"><img width="24" height="24"></div>
		<div style="height:1800px"></div>
		<div data-lazy-src="${pixel}"><img id="lazy-card" width="24" height="24"></div>
		<picture><img width="24" height="24"><img hidden src="${pixel}"></picture>
		<script>
			const image = document.getElementById('lazy-card');
			const observer = new IntersectionObserver(entries => {
				if (entries.some(entry => entry.isIntersecting)) {
					image.src = image.parentElement.dataset.lazySrc;
					observer.disconnect();
				}
			});
			observer.observe(image);
		</script>`);
	const outcome = await settleDocument(page, 'scroll-lazy-media', { quietMs: 100, timeoutMs: 2_000, media: true });
	expect(outcome.reason).toBe('quiet');
	expect(outcome.ms).toBeLessThan(1_000);
	expect(outcome.pendingMedia).toBeUndefined();
	expect(await page.locator('#lazy-card').getAttribute('src')).toBeNull();
	await triggerLazyLoad(page);
	expect(await page.locator('#lazy-card').getAttribute('src')).toBe(pixel);
	expect(await page.locator('#lazy-card').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
});

it('accepts authored picture sources and bounds readiness without animation frames', async ({ newPage }) => {
	const page = await newPage();
	const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
	await page.setContent(`<picture><source srcset="${pixel}"><img id="selected" width="24" height="24"></picture>
		<picture><source srcset="${pixel}"><img src="${pixel}" width="24" height="24"></picture>
		<img id="empty" width="24" height="24">`);
	const quiet = await settleDocument(page, 'authored-media', { quietMs: 0, timeoutMs: 1_000, media: true });
	expect(quiet.reason).toBe('quiet');
	expect(quiet.pendingMedia).toBeUndefined();

	// Model Linux Chromium withholding confirmation frames for an occluded
	// page. Neither the in-page deadline nor observer cleanup may await rAF.
	await page.evaluate(() => {
		window.requestAnimationFrame = () => 0;
	});
	const bounded = await settleDocument(page, 'suspended-frames', { quietMs: 0, timeoutMs: 100, media: true });
	expect(bounded.reason).toBe('deadline');
	expect(bounded.ms).toBeLessThan(1_000);
	expect(bounded.pendingMedia).toBeUndefined();

	await page.setContent(`<picture><img id="pending" width="24" height="24"><img hidden src="${pixel}"></picture>`);
	const pending = await settleDocument(page, 'pending-media', { quietMs: 0, timeoutMs: 100, media: true });
	expect(pending.reason).toBe('deadline');
	expect(pending.pendingMedia).toEqual(['#pending']);
});
