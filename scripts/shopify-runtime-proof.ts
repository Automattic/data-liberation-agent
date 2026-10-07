import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { captureWebsite } from '../src/lib/capture.js';
import { shopifyAdapter } from '../src/adapters/shopify/index.js';
import { startStaticServer } from '../src/lib/replicate/local-site/static-server.js';
import { chromium, type Page } from 'playwright';
import { waitForFonts, waitForDomQuiescence } from '../src/lib/screenshot/page-helpers.js';
import { assertPublicHttpUrl } from '../src/lib/media-fetch/safe-fetch.js';

const root = resolve(process.env.PROOF_OUTPUT ?? '.tmp-test/shopify-http-projected');
const source = 'https://moroccaninterior.com/';
const paths = ['/', '/collections/all', '/products/pom-pom-blanket-white', '/pages/about-us'];
if (existsSync(join(root, 'capture-receipt.json')))
	throw new Error('Use a fresh PROOF_OUTPUT; retained evidence is immutable.');
mkdirSync(root, { recursive: true });
const observations: unknown[] = [];
async function record(page: Page, path: string, width: number, mode: string, pose: string) {
	const started = performance.now();
	await page.evaluate('globalThis.__name ??= fn => fn');
	await page
		.waitForFunction(
			() => [...document.querySelectorAll('video')].every((video) => video.readyState >= 2 || video.error !== null),
			undefined,
			{ timeout: 5000 }
		)
		.catch(() => {});
	await page.evaluate(() => {
		for (const video of document.querySelectorAll('video')) {
			video.pause();
		}
		window.scrollTo(0, 0);
	});
	await waitForFonts(page);
	await waitForDomQuiescence(page, 300, 1500);
	const snapshot = await page.evaluate(() => {
		const box = (element: Element) => {
			const r = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return {
				id: element.id,
				class: element.getAttribute('class'),
				x: r.x,
				y: r.y + scrollY,
				width: r.width,
				height: r.height,
				display: style.display,
				opacity: style.opacity,
			};
		};
		const main = [...document.querySelectorAll('main')].find((node) =>
			node.checkVisibility({ checkVisibilityCSS: true })
		);
		return {
			url: location.href,
			ua: navigator.userAgent,
			dpr: devicePixelRatio,
			height: document.documentElement.scrollHeight,
			text: (main as HTMLElement | undefined)?.innerText ?? '',
			headings: [...document.querySelectorAll('main h1,main h2,main h3')].map((element) => ({
				text: element.textContent?.trim(),
				...box(element),
			})),
			sections: [...document.querySelectorAll('main > *, main .shopify-section')].map(box),
			images: [...document.images].map((image) => ({
				src: image.currentSrc,
				alt: image.alt,
				decoded: image.complete && image.naturalWidth > 0,
				painted: image.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
				...box(image),
			})),
			forms: [...document.forms].map((form) => ({ action: form.getAttribute('action'), ...box(form) })),
			sort: (document.querySelector('#sort-by') as HTMLSelectElement | null)?.value,
			videos: [...document.querySelectorAll('video')].map((video) => ({
				readyState: video.readyState,
				currentTime: video.currentTime,
				width: video.videoWidth,
				height: video.videoHeight,
				error: video.error?.message ?? null,
				...box(video),
			})),
		};
	});
	const stem = `${paths.indexOf(path)}-${width}-${mode}`;
	writeFileSync(join(root, `${stem}.html`), await page.content());
	await page.screenshot({ path: join(root, `${stem}.png`), fullPage: true, animations: 'disabled', timeout: 10000 });
	const observation = {
		path,
		width,
		mode,
		pose,
		snapshot,
		screenshot: `${stem}.png`,
		dom: `${stem}.html`,
		durationMs: performance.now() - started,
	};
	observations.push(observation);
	writeFileSync(join(root, 'rendering.json'), JSON.stringify(observations, null, 2));
	return observation;
}
const profile = shopifyAdapter.acquisition!;
const adapter = {
	...shopifyAdapter,
	discover: async () => ({ urls: paths.map((path) => ({ url: new URL(path, source).href, type: 'page' })) }),
	acquisition: {
		...profile,
		prepareRuntimeRegions: async (
			page: Page,
			context: Parameters<NonNullable<typeof profile.prepareRuntimeRegions>>[1]
		) => {
			await profile.prepareRuntimeRegions!(page, context);
			const path = new URL(context.url).pathname;
			if (context.variant === 'desktop') {
				await page.setViewportSize({ width: 768, height: 900 });
				await profile.prepareRuntimeRegions!(page, context);
				await record(
					page,
					path,
					768,
					'source',
					'Same acquired-response runtime session resized from 1440 to 768; intermediate-width visitor equivalence is unproven.'
				);
				await page.setViewportSize({ width: 1440, height: 900 });
				await profile.prepareRuntimeRegions!(page, context);
				await record(
					page,
					path,
					1440,
					'source',
					'Same runtime session restored to selected desktop observation width.'
				);
			} else await record(page, path, 390, 'source', 'Selected mobile runtime observation.');
		},
	},
};
const started = performance.now();
const result = await captureWebsite(
	{ url: source, outputDir: root, acquisition: 'http', http: { routeLimit: 4, runtimeRouteLimit: 4 } },
	{ findAdapter: () => adapter }
);
const captureMs = performance.now() - started;
writeFileSync(join(root, 'capture-result.json'), JSON.stringify({ captureMs, result }, null, 2));
const receipt = JSON.parse(readFileSync(result.captureReceiptPath, 'utf8'));
const acquired = JSON.parse(readFileSync(join(root, 'http-acquisition.json'), 'utf8'));
const server = await startStaticServer(join(root, 'website'));
const browser = await chromium.launch();
try {
	for (const path of paths)
		for (const width of [390, 768, 1440]) {
			const variant = profile.variants.find((variant) => variant.id === (width === 390 ? 'mobile' : 'desktop'))!;
			const context = await browser.newContext({
				viewport: { width, height: 900 },
				deviceScaleFactor: 1,
				userAgent: variant.headers!['User-Agent'],
				serviceWorkers: 'block',
			});
			const page = await context.newPage();
			const failures: unknown[] = [];
			page.on('requestfailed', (request) => failures.push({ url: request.url(), error: request.failure()?.errorText }));
			await page.route('**/*', (route) =>
				new URL(route.request().url()).origin === new URL(server.url).origin ? route.continue() : route.abort()
			);
			const route = receipt.routes.find((entry: { url: string }) => new URL(entry.url).pathname === path);
			await page.goto(server.urlForPage(route.path.replace(/^website\//, '')), {
				waitUntil: 'domcontentloaded',
				timeout: 20000,
			});
			const observation = await record(
				page,
				path,
				width,
				'portable',
				'Fresh offline context; native videos paused at their observed frame, not certified motion parity.'
			);
			Object.assign(observation, { failures });
			await context.close();
		}
	// A separate context and fresh navigation at tablet width detects state or
	// geometry left behind by resizing the selected desktop observation.
	for (const path of paths) {
		const document = acquired.documents.find(
			(entry: { url: string; variant: string }) => new URL(entry.url).pathname === path && entry.variant === 'desktop'
		);
		const variant = profile.variants.find((variant) => variant.id === 'desktop')!;
		const context = await browser.newContext({
			viewport: { width: 768, height: 900 },
			deviceScaleFactor: 1,
			userAgent: variant.headers!['User-Agent'],
			serviceWorkers: 'block',
		});
		const page = await context.newPage();
		await page.route('**/*', async (route) => {
			try {
				assertPublicHttpUrl(route.request().url());
			} catch {
				await route.abort();
				return;
			}
			if (route.request().isNavigationRequest() && route.request().frame() === page.mainFrame()) {
				if (route.request().url() !== document.url) {
					await route.abort();
					return;
				}
				await route.fulfill({ contentType: document.rawContentType, body: readFileSync(join(root, document.rawPath)) });
			} else await route.continue();
		});
		await page.goto(document.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
		await profile.prepareRuntimeRegions!(page, { url: document.url, finalUrl: document.finalUrl, variant: 'desktop' });
		await record(
			page,
			path,
			768,
			'source-fresh-tablet',
			'Independent fresh tablet context replaying the exact acquired response; app-content drift from the selected session is reported separately.'
		);
		await context.close();
	}
} finally {
	await browser.close();
	await server.close();
}
writeFileSync(join(root, 'rendering.json'), JSON.stringify(observations, null, 2));
console.log(
	JSON.stringify(
		{
			root,
			captureMs,
			summary: result.summary,
			failures: result.failures,
			observations: observations.map((row: any) => ({
				path: row.path,
				width: row.width,
				mode: row.mode,
				height: row.snapshot.height,
				images: row.snapshot.images.length,
				decoded: row.snapshot.images.filter((image: any) => image.decoded).length,
			})),
		},
		null,
		2
	)
);
