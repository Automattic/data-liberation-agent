import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { observeRuntimeRegions } from './runtime-regions.js';
import { projectRuntimePresentation, stageRuntimeRegions } from './embedded-documents.js';
import { materializeHttpDocuments } from './http-materialization.js';
import { serveCapture } from './serve-capture.js';
import { acquireHttpDocuments } from './http-acquisition.js';
import { stripRemoteAssetRequests } from './self-contain.js';
import { TRANSPARENT_IMAGE_DATA_URL } from './portable-assets.js';

let browser: Browser;
const dirs: string[] = [];
const tempRoot = join(process.cwd(), '.tmp-test');
const sourceUrl = 'https://parent.test/article/';
const sha = (html: string) => createHash('sha256').update(html).digest('hex');
beforeAll(async () => {
	mkdirSync(tempRoot, { recursive: true });
	browser = await chromium.launch();
});
afterAll(async () => {
	await browser?.close();
});
afterEach(() => {
	for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function fixture(border = '0', width = 768, partial = false, projection?: 'subtree', failedOnly = false) {
	const outputDir = mkdtempSync(join(tempRoot, 'dla-embedded-'));
	dirs.push(outputDir);
	mkdirSync(join(outputDir, 'source-documents'));
	const prepared =
		'<html><head><title>Article</title></head><body><div id="host"></div><div id="legacy"><a name="legacy"></a></div></body></html>';
	writeFileSync(join(outputDir, 'source-documents/article.html'), prepared);
	const requirements = [{ selector: '#host', reason: 'Runtime child', ...(projection ? { projection } : {}) }];
	writeFileSync(
		join(outputDir, 'http-acquisition.json'),
		JSON.stringify({
			schema: 'data-liberation/http-acquisition/v1',
			sourceUrl,
			documents: [
				{
					url: sourceUrl,
					variant: 'desktop',
					status: 'acquired',
					documentPath: 'source-documents/article.html',
					documentContentType: 'text/html; charset=utf-8',
					documentSha256: sha(prepared),
					browserRegions: requirements,
				},
			],
		})
	);
	const page = await browser.newPage({ viewport: { width, height: 900 } });
	await page.route('**/*', (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: route.request().url().startsWith('https://child.test/')
				? '<html><head><base href="https://cdn.test/"><link rel="stylesheet" href="style.css"></head><body><p>Child text</p><button onclick="alert(1)">Action</button><script>window.provider=true</script></body></html>'
				: `<html><body style="margin:8px"><div id="host">${partial ? '<h2>Healthy runtime parent</h2>' : ''}${failedOnly ? '' : `<iframe id="editor" src="https://child.test/editor?view=${width}" width="100%" height="${width < 768 ? 104 : 86}" frameborder="${border}"></iframe>`}${partial ? '<iframe id="unready"></iframe>' : ''}</div></body></html>`,
		})
	);
	await page.goto(sourceUrl, { waitUntil: 'load' });
	const observation = await observeRuntimeRegions(page, sourceUrl, requirements);
	await page.close();
	const fetch = async (url: string) => ({
		finalUrl: url,
		status: 200,
		headers: new Headers({ 'content-type': 'text/css' }),
		body: Buffer.from('body{margin:0;color:rgb(255,0,0)}'),
	});
	const stage = () => stageRuntimeRegions({ outputDir, attachments: [{ variant: 'desktop', observation }] }, { fetch });
	const run = () =>
		materializeHttpDocuments({
			outputDir,
			sourceUrl,
			platform: 'generic',
			desktopVariant: 'desktop',
			embeddedDocuments: true,
		});
	return { outputDir, observation, stage, run };
}

describe('observed embedded document export', () => {
	it.each([undefined, 'color:rgb(9,8,7)'])('projects runtime child state while retaining authored root geometry across fresh visitors and a stale resize (%s)', async authoredStyle => {
		const outputDir = mkdtempSync(join(tempRoot, 'runtime-authored-geometry-'));
		dirs.push(outputDir);
		const raw = `<html><head><style>body{margin:0}#host{width:calc(100vw - 40px);aspect-ratio:1;position:relative}.label{position:absolute}</style></head><body><div id="host"${authoredStyle ? ` style="${authoredStyle}"` : ''}><img alt="Owned image"></div><script>const host=document.querySelector("#host");host.style.height=Math.round(host.getBoundingClientRect().width)+"px";host.querySelector("img").src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=";host.insertAdjacentHTML("beforeend","<span class=label>Mounted label</span>")</script></body></html>`;
		const requirements = [{ selector: '#host', reason: 'Runtime children with authored layout', projection: 'subtree' as const, retainSourceAttributes: ['style'] }];
		const fetch = async (url: string) => ({ finalUrl: url, status: 200, headers: new Headers({ 'content-type': 'text/html' }), body: Buffer.from(raw) });
		await acquireHttpDocuments({ url: sourceUrl, urls: [sourceUrl], outputDir, collectAssets: true,
			profile: { id: 'neutral', variants: [{ id: 'desktop' }], prepare: html => ({ html: html.replace(/<script>[\s\S]*?<\/script>/g, ''), browserRegions: requirements }) } }, { fetch });
		const source = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		try {
			await source.route('**/*', route => route.fulfill({ body: raw, contentType: 'text/html' }));
			await source.goto(sourceUrl, { waitUntil: 'load' });
			await source.setViewportSize({ width: 768, height: 900 });
			expect((await source.locator('#host').boundingBox())!.height).toBe(1400);
			const observation = await observeRuntimeRegions(source, sourceUrl, requirements);
			await stageRuntimeRegions({ outputDir, attachments: [{ variant: 'desktop', observation }] }, { fetch });
			materializeHttpDocuments({ outputDir, sourceUrl, platform: 'neutral', desktopVariant: 'desktop', embeddedDocuments: true });
			const server = await serveCapture(outputDir), copy = await browser.newPage();
			try {
				await copy.route('**/*', route => new URL(route.request().url()).origin === new URL(server.url).origin ? route.continue() : route.abort());
				for (const width of [390, 601, 768, 1024, 1440]) {
					await source.setViewportSize({ width, height: 900 });
					await source.goto(sourceUrl, { waitUntil: 'load' });
					await copy.setViewportSize({ width, height: 900 });
					await copy.goto(server.url, { waitUntil: 'load' });
					expect(await copy.locator('#host').boundingBox()).toEqual(await source.locator('#host').boundingBox());
					expect(await copy.locator('.label').innerText()).toBe('Mounted label');
					expect(await copy.locator('img').evaluate(node => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0)).toBe(true);
					expect(await copy.locator('#host').getAttribute('style')).toBe(authoredStyle ?? null);
				}
			} finally { await copy.close(); await server.close(); }
		} finally { await source.close(); }
	});
	it('preserves print and narrow linked media through two-variant runtime staging and offline assembly', async () => {
		const outputDir = mkdtempSync(join(tempRoot, 'runtime-dual-media-'));
		dirs.push(outputDir);
		const raw = `<html><head><title>Conditional widget</title><style>body{margin:0}#host{height:40px;color:rgb(1,2,3)}</style></head><body><main id="owner"><div id="host">Widget</div></main><script>
		if(innerWidth<768){
		  document.querySelector('#host').insertAdjacentHTML('beforeend','<aside id="phone">Phone note</aside>');
		  for(const [href,media] of [['print.css','print'],['narrow.css','screen and (min-width:500px) and (max-width:740px)']]){
		    const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.media=media;document.body.append(link);
		  }
		}
		</script></body></html>`;
		const sheets: Record<string, string> = {
			'print.css': '#host{height:180px;color:rgb(9,8,7)}',
			'narrow.css': '#host{height:90px;color:rgb(4,5,6)}',
		};
		const requirements = [{ selector: '#host', reason: 'Conditional runtime widget', projection: 'subtree' as const }];
		const fetch = async (url: string) => ({ finalUrl: url, status: 200,
			headers: new Headers({ 'content-type': url.endsWith('.css') ? 'text/css' : 'text/html' }),
			body: Buffer.from(url.endsWith('.css') ? sheets[url.split('/').pop()!]! : raw) });
		await acquireHttpDocuments({ url: sourceUrl, urls: [sourceUrl], outputDir, collectAssets: true,
			profile: { id: 'neutral', variants: [{ id: 'desktop' }, { id: 'mobile' }], prepare: html => ({
				html: html.replace(/<script>[\s\S]*?<\/script>/g, ''), browserRegions: requirements,
			}) } }, { fetch });
		const source = await browser.newPage();
		const attachments = [];
		const measure = (page: typeof source) => page.locator('#host:visible, [data-dla-responsive-source="host"]:visible').first().evaluate(node => {
			const box = node.getBoundingClientRect(), style = getComputedStyle(node);
			return { height: box.height, color: style.color };
		});
		try {
			await source.route('**/*', async route => {
				const response = await fetch(route.request().url());
				await route.fulfill({ contentType: response.headers.get('content-type')!, body: response.body });
			});
			for (const [variant, width] of [['desktop',1440], ['mobile',390]] as const) {
				await source.setViewportSize({ width, height: 900 });
				await source.goto(sourceUrl, { waitUntil: 'load' });
				attachments.push({ variant, observation: await observeRuntimeRegions(source, sourceUrl, requirements) });
			}
			await stageRuntimeRegions({ outputDir, attachments }, { fetch });
			materializeHttpDocuments({ outputDir, sourceUrl, platform: 'neutral', desktopVariant: 'desktop', mobileVariant: 'mobile', embeddedDocuments: true });
			const server = await serveCapture(outputDir);
			const copy = await browser.newPage();
			try {
				await copy.route('**/*', route => new URL(route.request().url()).origin === new URL(server.url).origin ? route.continue() : route.abort());
				for (const media of ['screen', 'print'] as const) for (const width of [390, 700, 768, 1440]) {
					await source.emulateMedia({ media });
					await copy.emulateMedia({ media });
					await source.setViewportSize({ width, height: 900 });
					await copy.setViewportSize({ width, height: 900 });
					await source.goto(sourceUrl, { waitUntil: 'load' });
					const expected = await measure(source);
					expect(expected.height).toBe(width < 768 && media === 'print' ? 180 : width === 700 && media === 'screen' ? 90 : 40);
					await copy.goto(server.url, { waitUntil: 'load' });
					expect(await measure(copy), `${media} at ${width}px`).toEqual(expected);
				}
			} finally { await copy.close(); await server.close(); }
		} finally { await source.close(); }
	});
	it('keeps implicit scope at its authored widget location and diagnoses unhoistable presentation', async () => {
		const outputDir = mkdtempSync(join(tempRoot, 'runtime-implicit-scope-'));
		dirs.push(outputDir);
		const raw = '<html><head><title>Scoped widget</title><style>body{margin:0}.caption{color:rgb(1,2,3);padding:0}</style></head><body><div id="host"><style id="widget-scope">@scope{.caption{color:rgb(9,8,7);padding:12px}}</style><p class="caption">Inside widget</p></div><p id="outside" class="caption">Outside widget</p></body></html>';
		const requirements = [{ selector: '#host', reason: 'Scoped widget', projection: 'subtree' as const }];
		const fetch = async (url: string) => ({ finalUrl: url, status: 200, headers: new Headers({ 'content-type': 'text/html' }), body: Buffer.from(raw) });
		await acquireHttpDocuments({ url: sourceUrl, urls: [sourceUrl], outputDir, collectAssets: true,
			profile: { id: 'neutral', variants: [{ id: 'desktop' }], prepare: html => ({ html, browserRegions: requirements }) } }, { fetch });
		const source = await browser.newPage();
		const measure = (page: typeof source) => page.locator('.caption').evaluateAll(nodes => nodes.map(node => {
			const box = node.getBoundingClientRect(), style = getComputedStyle(node);
			return { color: style.color, padding: style.padding, height: box.height, y: box.y };
		}));
		try {
			await source.route('**/*', route => route.fulfill({ contentType: 'text/html', body: raw }));
			await source.goto(sourceUrl, { waitUntil: 'load' });
			const observation = await observeRuntimeRegions(source, sourceUrl, requirements);
			await stageRuntimeRegions({ outputDir, attachments: [{ variant: 'desktop', observation }] }, { fetch });
			const receipt = JSON.parse(readFileSync(materializeHttpDocuments({ outputDir, sourceUrl, platform: 'neutral', desktopVariant: 'desktop', embeddedDocuments: true }), 'utf8'));
			const server = await serveCapture(outputDir);
			const copy = await browser.newPage();
			try {
				await copy.route('**/*', route => new URL(route.request().url()).origin === new URL(server.url).origin ? route.continue() : route.abort());
				for (const width of [390, 768, 1440]) {
					await source.setViewportSize({ width, height: 900 });
					await copy.setViewportSize({ width, height: 900 });
					const expected = await measure(source);
					expect(expected[0]).toMatchObject({ color: 'rgb(9, 8, 7)', padding: '12px' });
					expect(expected[1]).toMatchObject({ color: 'rgb(1, 2, 3)', padding: '0px' });
					await copy.goto(server.url, { waitUntil: 'load' });
					expect(await measure(copy)).toEqual(expected);
					expect(await copy.locator('#host > #widget-scope').count()).toBe(1);
					expect(await copy.locator('head #widget-scope').count()).toBe(0);
				}
				expect(receipt.discoveryDiagnostics).toEqual(expect.arrayContaining([
					expect.objectContaining({ code: 'http_runtime_projection_unresolved', reason: expect.stringContaining('Implicitly scoped stylesheet') }),
			]));
			} finally { await copy.close(); await server.close(); }
		} finally { await source.close(); }
	});
	it('replaces body-only style originals once while preserving title, metadata and base identities', async () => {
		const html = '<html><head><title id="title">Owned</title><meta id="meta" name="description" content="Owned"><base id="base" target="_self" href="https://parent.test/old/"></head><body><div id="host"><style id="old">#host{color:red}</style>Owned</div><link rel="stylesheet" href="old.css"></body></html>';
		const styles = '<style id="new">#host{color:green}</style><style id="last">#host{color:rgb(1,2,3)}</style>';
		const projected = projectRuntimePresentation(html, sourceUrl, 'desktop', sha(html), {
			schema: 'data-liberation/embedded-documents/v1', regions: [], documents: {},
			verification: { rendering: 'unverified', interactions: 'unverified' },
			presentation: [{ url: sourceUrl, variant: 'desktop', documentSha256: sha(html), baseUrl: 'https://parent.test/assets/',
				styles, sha256: sha(styles), viewport: { width: 390, height: 900 }, userAgent: 'neutral', deviceScaleFactor: 1 }],
		});
		const page = await browser.newPage();
		try {
			await page.setContent(projected);
			expect(await page.locator('#old,link[rel="stylesheet"]').count()).toBe(0);
			expect(await page.locator('head style').evaluateAll((nodes) => nodes.map((node) => node.id))).toEqual(['new', 'last']);
			expect(await page.locator('#host').evaluate((node) => getComputedStyle(node).color)).toBe('rgb(1, 2, 3)');
			expect(await page.locator('#title').textContent()).toBe('Owned');
			expect(await page.locator('#meta').getAttribute('content')).toBe('Owned');
			expect(await page.locator('#base').getAttribute('target')).toBe('_self');
			expect(await page.locator('#base').getAttribute('href')).toBe('https://parent.test/assets/');
		} finally {
			await page.close();
		}
	});
	it('exports active dynamically inserted body styles in source order with scoped selectors and media at every width', async () => {
		const outputDir = mkdtempSync(join(tempRoot, 'runtime-body-css-'));
		dirs.push(outputDir);
		const raw = `<html><head><base href="https://parent.test/assets/"><title>Body cascade</title><meta name="description" content="Source metadata"><style id="head-rule">#host{height:12px;color:red}body{margin:0}</style></head><body><div id="host"><style id="widget-rule">#host{height:20px;color:green}</style>Widget</div><p id="outside">Outside</p><style id="body-rule">#host{height:30px;color:blue}</style><script>
		for (const [href, media] of [['first.css',''],['second.css',''],['phone.css','(max-width:600px)']]) {
			const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.media=media;document.body.append(link);
		}
		const inactive=document.createElement('link');inactive.rel='stylesheet';inactive.href='inactive.css';inactive.disabled=true;document.body.append(inactive);
		const shadow=document.querySelector('#outside').attachShadow({mode:'open'});shadow.innerHTML='<style>#host{height:999px}</style>';
		</script></body></html>`;
		const sheets: Record<string, string> = {
			'first.css': '#host{height:70px;color:purple;padding:3px!important}@scope (#host){:scope{border:2px solid rgb(8,7,6)}}#outside{color:rgb(9,8,7)}',
			'second.css': '#host{height:78px;color:rgb(1,2,3);padding:9px}@media(min-width:601px) and (max-width:1000px){#host{height:116px}}',
			'phone.css': '#host{height:100px;color:rgb(4,5,6)}',
			'inactive.css': '#host{height:999px}',
		};
		const requirements = [{ selector: '#host', reason: 'Runtime widget', projection: 'subtree' as const }];
		const fetch = async (url: string) => ({
			finalUrl: url,
			status: 200,
			headers: new Headers({ 'content-type': url.endsWith('.css') ? 'text/css' : 'text/html' }),
			body: Buffer.from(url.endsWith('.css') ? sheets[url.split('/').pop()!]! : raw),
		});
		await acquireHttpDocuments({
			url: sourceUrl, urls: [sourceUrl], outputDir, collectAssets: true,
			profile: { id: 'neutral', variants: [{ id: 'desktop' }], prepare: (html) => ({
				html: html.replace(/<script>[\s\S]*?<\/script>/g, ''), browserRegions: requirements,
			}) },
		}, { fetch });
		const source = await browser.newPage();
		const expected = new Map<number, unknown>();
		const measure = () => source.locator('#host').evaluate((node) => {
			const box = node.getBoundingClientRect(), css = getComputedStyle(node);
			return { x: box.x, y: box.y, width: box.width, height: box.height, color: css.color, padding: css.padding };
		});
		try {
			await source.route('**/*', async (route) => {
				const response = await fetch(route.request().url());
				await route.fulfill({ contentType: response.headers.get('content-type')!, body: response.body });
			});
			await source.goto(sourceUrl, { waitUntil: 'load' });
			for (const width of [390, 768, 1440]) {
				await source.setViewportSize({ width, height: 900 });
				expected.set(width, await measure());
			}
			const observation = await observeRuntimeRegions(source, sourceUrl, requirements);
			expect(observation.document!.styles).toContain('first.css');
			expect(observation.document!.styles).not.toContain('inactive.css');
			expect(observation.document!.styles).not.toContain('999px');
			await stageRuntimeRegions({ outputDir, attachments: [{ variant: 'desktop', observation }] }, { fetch });
		} finally {
			await source.close();
		}
		const manifest = JSON.parse(readFileSync(join(outputDir, 'resources/manifest.json'), 'utf8'));
		for (const name of ['first.css', 'second.css', 'phone.css'])
			expect(manifest.resources[`https://parent.test/assets/${name}`]).toBeDefined();
		materializeHttpDocuments({ outputDir, sourceUrl, platform: 'neutral', desktopVariant: 'desktop', embeddedDocuments: true });
		const server = await serveCapture(outputDir);
		const page = await browser.newPage();
		const external: string[] = [];
		try {
			await page.route('**/*', (route) => {
				if (new URL(route.request().url()).origin === new URL(server.url).origin) return route.continue();
				external.push(route.request().url());
				return route.abort();
			});
			for (const width of [390, 768, 1440]) {
				await page.setViewportSize({ width, height: 900 });
				await page.goto(server.url, { waitUntil: 'load' });
				expect(await page.locator('#host').evaluate((node) => {
					const box = node.getBoundingClientRect(), css = getComputedStyle(node);
					return { x: box.x, y: box.y, width: box.width, height: box.height, color: css.color, padding: css.padding };
				})).toEqual(expected.get(width));
				expect(await page.locator('#widget-rule').count()).toBe(1);
				expect(await page.locator('#body-rule').count()).toBe(1);
				expect(await page.title()).toBe('Body cascade');
				expect(await page.locator('meta[name="description"]').getAttribute('content')).toBe('Source metadata');
			}
			expect(external).toEqual([]);
		} finally {
			await page.close();
			await server.close();
		}
	});
	it('retains the observed style and linked-sheet cascade order instead of appending a mutated early rule last', async () => {
		const outputDir = mkdtempSync(join(tempRoot, 'runtime-cascade-'));
		dirs.push(outputDir);
		const raw =
			'<html><head><title>Owned title</title><meta name="description" content="Owned metadata"><style id="early">#host{color:red}</style><link rel="stylesheet" href="/middle.css"><style id="late">#host{color:rgb(1,2,3)}</style></head><body><div id="host">Owned content</div><script>document.querySelector("#early").textContent="#host{color:green}"</script></body></html>';
		const css = '#host{color:purple}';
		const requirements = [{ selector: '#host', reason: 'Runtime presentation', projection: 'subtree' as const }];
		const fetch = async (url: string) => ({
			finalUrl: url,
			status: 200,
			headers: new Headers({ 'content-type': url.endsWith('.css') ? 'text/css' : 'text/html' }),
			body: Buffer.from(url.endsWith('.css') ? css : raw),
		});
		await acquireHttpDocuments(
			{
				url: sourceUrl,
				urls: [sourceUrl],
				outputDir,
				collectAssets: true,
				profile: {
					id: 'neutral',
					variants: [{ id: 'desktop' }],
					prepare: (html) => ({ html: html.replace(/<script>[\s\S]*?<\/script>/g, ''), browserRegions: requirements }),
				},
			},
			{ fetch }
		);
		const source = await browser.newPage();
		await source.route('**/*', (route) =>
			route.fulfill({
				contentType: route.request().url().endsWith('.css') ? 'text/css' : 'text/html',
				body: route.request().url().endsWith('.css') ? css : raw,
			})
		);
		await source.goto(sourceUrl, { waitUntil: 'load' });
		expect(await source.locator('#host').evaluate((node) => getComputedStyle(node).color)).toBe('rgb(1, 2, 3)');
		const observation = await observeRuntimeRegions(source, sourceUrl, requirements);
		await source.close();
		await stageRuntimeRegions({ outputDir, attachments: [{ variant: 'desktop', observation }] }, { fetch });
		materializeHttpDocuments({
			outputDir,
			sourceUrl,
			platform: 'neutral',
			desktopVariant: 'desktop',
			embeddedDocuments: true,
		});
		const server = await serveCapture(outputDir);
		const page = await browser.newPage();
		try {
			await page.route('**/*', (route) =>
				new URL(route.request().url()).origin === new URL(server.url).origin ? route.continue() : route.abort()
			);
			await page.goto(server.url, { waitUntil: 'load' });
			expect(await page.locator('#host').evaluate((node) => getComputedStyle(node).color)).toBe('rgb(1, 2, 3)');
			expect(await page.title()).toBe('Owned title');
			expect(await page.locator('meta[name="description"]').getAttribute('content')).toBe('Owned metadata');
		} finally {
			await page.close();
			await server.close();
		}
	});
	it.each([undefined, 'subtree'] as const)(
		'keeps a valid parent and complete child while diagnosing a failed sibling (%s)',
		async (projection) => {
			const { outputDir, observation, stage, run } = await fixture('0', 768, true, projection);
			expect(observation.regions[0]!.status).toBe('partial');
			await stage();
			const staged = JSON.parse(readFileSync(join(outputDir, 'embedded-documents.json'), 'utf8'));
			expect(staged.regions).toHaveLength(1);
			expect(Object.keys(staged.documents)).toHaveLength(1);
			expect(staged.regions[0].childCoverage).toEqual({ expected: 2, staged: 1, unresolved: 1 });
			expect(staged.unresolved).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ selector: '#host', index: 0, reason: expect.stringContaining('not initialized') }),
				])
			);
			const receipt = JSON.parse(readFileSync(run(), 'utf8'));
			expect(receipt.summary.complete).toBe(false);
			expect(receipt.discoveryDiagnostics).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: 'http_runtime_projection_unresolved' })])
			);
			const server = await serveCapture(outputDir);
			const page = await browser.newPage();
			const external: string[] = [];
			try {
				await page.route('**/*', (route) => {
					if (new URL(route.request().url()).origin !== new URL(server.url).origin) {
						external.push(route.request().url());
						return route.abort();
					}
					return route.continue();
				});
				await page.goto(server.url, { waitUntil: 'load' });
				expect(await page.locator('#host h2').innerText()).toBe('Healthy runtime parent');
				expect(await page.locator('iframe').count()).toBe(1);
				expect(await page.frameLocator('iframe').locator('p').innerText()).toBe('Child text');
				expect(external).toEqual([]);
			} finally {
				await page.close();
				await server.close();
			}
		}
	);

	it.each([undefined, 'subtree'] as const)(
		'accounts for a parent whose only child is incomplete (%s)',
		async (projection) => {
			const { outputDir, stage, run } = await fixture('0', 768, true, projection, true);
			await stage();
			const staged = JSON.parse(readFileSync(join(outputDir, 'embedded-documents.json'), 'utf8'));
			expect(staged.regions).toHaveLength(projection ? 1 : 0);
			expect(staged.coverage[0]).toMatchObject({ expectedNodes: 1, projectedIndices: projection ? [0] : [] });
			run();
			const html = readFileSync(join(outputDir, 'website/index.html'), 'utf8');
			expect(html.includes('Healthy runtime parent')).toBe(!!projection);
			expect(html).not.toContain('<iframe');
		}
	);
	it('does not turn a failed video poster into a successfully loaded square placeholder that changes source geometry', async () => {
		const source = await browser.newPage(),
			copy = await browser.newPage();
		const failedPoster = 'https://poster.test/missing.jpg';
		const raw = `<video style="width:320px;height:auto" poster="${failedPoster}"></video>`;
		await source.route('**/*', (route) => route.fulfill({ status: 404, body: '' }));
		try {
			await source.setContent(raw, { waitUntil: 'load' });
			const expected = await source.locator('video').boundingBox();
			await copy.setContent(stripRemoteAssetRequests(raw.replace(failedPoster, TRANSPARENT_IMAGE_DATA_URL)), {
				waitUntil: 'load',
			});
			expect(await copy.locator('video').boundingBox()).toEqual(expected);
			expect(await copy.locator('video').getAttribute('poster')).toBeNull();
		} finally {
			await source.close();
			await copy.close();
		}
	});
	it('carries linked source CSS into responsive subtree reconciliation rather than losing viewport-only classes', async () => {
		const outputDir = mkdtempSync(join(tempRoot, 'runtime-css-'));
		dirs.push(outputDir);
		const raw =
			'<html><head><link rel="stylesheet" href="/theme.css"></head><body><div id="host"><p class="piece">Owned content</p></div><p id="stable">Stable owner</p><script>if(innerWidth<600){document.querySelector("#host").className="mounted";document.querySelector("#host").insertAdjacentHTML("beforeend","<aside id=phone>Phone note</aside>")}</script></body></html>';
		const css = '.piece{display:none}.mounted .piece{display:block;color:rgb(7,8,9);width:calc(100% - 20px)}';
		const requirements = [{ selector: '#host', reason: 'Observed responsive mount', projection: 'subtree' as const }];
		const profile = {
			id: 'neutral-runtime',
			variants: [{ id: 'desktop' }, { id: 'mobile' }],
			prepare: (html: string) => ({
				html: html.replace(/<script>[\s\S]*?<\/script>/g, ''),
				browserRegions: requirements,
			}),
		};
		const fetch = async (url: string) => ({
			finalUrl: url,
			status: 200,
			headers: new Headers({ 'content-type': url.endsWith('.css') ? 'text/css' : 'text/html' }),
			body: Buffer.from(url.endsWith('.css') ? css : raw),
		});
		await acquireHttpDocuments(
			{ url: sourceUrl, urls: [sourceUrl], outputDir, profile, collectAssets: true },
			{ fetch }
		);
		const attachments = [];
		for (const [variant, width] of [
			['desktop', 1440],
			['mobile', 390],
		] as const) {
			const page = await browser.newPage({ viewport: { width, height: 900 } });
			await page.route('**/*', (route) =>
				route.fulfill({
					contentType: route.request().url().endsWith('.css') ? 'text/css' : 'text/html',
					body: route.request().url().endsWith('.css') ? css : raw,
				})
			);
			await page.goto(sourceUrl, { waitUntil: 'load' });
			attachments.push({ variant, observation: await observeRuntimeRegions(page, sourceUrl, requirements) });
			await page.close();
		}
		await stageRuntimeRegions({ outputDir, attachments }, { fetch });
		materializeHttpDocuments({
			outputDir,
			sourceUrl,
			platform: 'neutral',
			desktopVariant: 'desktop',
			mobileVariant: 'mobile',
			embeddedDocuments: true,
		});
		const server = await serveCapture(outputDir);
		try {
			for (const width of [390, 768, 1440]) {
				const page = await browser.newPage({ viewport: { width, height: 900 } });
				await page.route('**/*', (route) =>
					new URL(route.request().url()).origin === new URL(server.url).origin ? route.continue() : route.abort()
				);
				await page.goto(server.url, { waitUntil: 'load' });
				expect(await page.locator('.piece:visible').count()).toBe(width === 390 ? 1 : 0);
				if (width === 390)
					expect(await page.locator('.piece:visible').evaluate((node) => getComputedStyle(node).color)).toBe(
						'rgb(7, 8, 9)'
					);
				expect(await page.locator('#stable').count()).toBe(1);
				await page.close();
			}
		} finally {
			await server.close();
		}
	});
	it('localizes a runtime-mounted cross-origin child and its base-relative CSS through shared export', async () => {
		const { outputDir, stage, run } = await fixture();
		await stage();
		const receipt = JSON.parse(readFileSync(run(), 'utf8'));
		expect(receipt.summary.complete).toBe(false);
		expect(receipt.embeddedDocuments.verification.interactions).toBe('unverified');
		const html = readFileSync(join(outputDir, 'website/index.html'), 'utf8');
		expect(html).toContain('<iframe');
		expect(html).toContain('width="100%"');
		expect(html).not.toContain('https://child.test/');
		const server = await serveCapture(outputDir);
		const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
		const external: string[] = [];
		try {
			await page.route('**/*', (route) => {
				if (new URL(route.request().url()).origin !== new URL(server.url).origin) {
					external.push(route.request().url());
					return route.abort();
				}
				return route.continue();
			});
			await page.goto(server.url, { waitUntil: 'load' });
			const frame = page.frames()[1]!;
			expect(await frame.locator('p').innerText()).toBe('Child text');
			expect(await frame.locator('p').evaluate((node) => getComputedStyle(node).color)).toBe('rgb(255, 0, 0)');
			expect(await frame.evaluate(() => 'provider' in window)).toBe(false);
			expect(await frame.locator('button').getAttribute('onclick')).toBeNull();
			expect(external).toEqual([]);
			expect((await page.locator('iframe').boundingBox())!.height).toBe(86);
		} finally {
			await page.close();
			await server.close();
		}
	});

	it('rejects modified child bytes and stale parent identities before replacing the candidate', async () => {
		const { outputDir, stage, run } = await fixture();
		await stage();
		mkdirSync(join(outputDir, 'website'));
		writeFileSync(join(outputDir, 'website/index.html'), 'Preserve candidate');
		const path = join(outputDir, 'embedded-documents.json');
		const receipt = JSON.parse(readFileSync(path, 'utf8'));
		receipt.regions[0].documentSha256 = '0'.repeat(64);
		writeFileSync(path, JSON.stringify(receipt));
		expect(run).toThrow('hash mismatch');
		expect(readFileSync(join(outputDir, 'website/index.html'), 'utf8')).toBe('Preserve candidate');
		await stage();
		const doc = Object.values(JSON.parse(readFileSync(path, 'utf8')).documents)[0] as { path: string };
		writeFileSync(join(outputDir, doc.path), 'Changed child');
		expect(run).toThrow('mismatch');
		expect(readFileSync(join(outputDir, 'website/index.html'), 'utf8')).toBe('Preserve candidate');
	});

	it('preserves authored border geometry without adding border thickness twice', async () => {
		const { outputDir, observation, stage, run } = await fixture('1');
		await stage();
		run();
		const server = await serveCapture(outputDir);
		const page = await browser.newPage();
		try {
			await page.goto(server.url, { waitUntil: 'load' });
			expect((await page.locator('iframe').boundingBox())!.height).toBe(
				observation.regions[0]!.nodes[0]!.frames[0]!.box!.height
			);
		} finally {
			await page.close();
			await server.close();
		}
	});

	it('rejects ambiguous viewport selection and child file symlinks', async () => {
		const { outputDir, observation, stage, run } = await fixture();
		await expect(
			stageRuntimeRegions({
				outputDir,
				attachments: [
					{ variant: 'desktop', observation },
					{ variant: 'desktop', observation },
				],
			})
		).rejects.toThrow('explicit selection');
		await stage();
		const receiptPath = join(outputDir, 'embedded-documents.json');
		const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
		const external = mkdtempSync(join(tempRoot, 'dla-embedded-outside-'));
		dirs.push(external);
		writeFileSync(join(external, 'child.html'), 'Outside');
		symlinkSync(join(external, 'child.html'), join(outputDir, 'embedded-documents/linked.html'));
		const doc = Object.values(receipt.documents)[0] as { path: string };
		doc.path = 'embedded-documents/linked.html';
		writeFileSync(receiptPath, JSON.stringify(receipt));
		expect(run).toThrow('containment mismatch');
	});

	it('preserves child presentation variants when parent documents are structurally equivalent', async () => {
		const desktop = await fixture();
		const mobile = await fixture('0', 390);
		const acquisitionPath = join(desktop.outputDir, 'http-acquisition.json');
		const acquisition = JSON.parse(readFileSync(acquisitionPath, 'utf8'));
		acquisition.documents.push({ ...acquisition.documents[0], variant: 'mobile' });
		writeFileSync(acquisitionPath, JSON.stringify(acquisition));
		await stageRuntimeRegions(
			{
				outputDir: desktop.outputDir,
				attachments: [
					{ variant: 'desktop', observation: desktop.observation },
					{ variant: 'mobile', observation: mobile.observation },
				],
			},
			{
				fetch: async (url) => ({
					finalUrl: url,
					status: 200,
					headers: new Headers({ 'content-type': 'text/css' }),
					body: Buffer.from('<!--\nbody{margin:0}body::before{content:"<!--"}\n-->'),
				}),
			}
		);
		materializeHttpDocuments({
			outputDir: desktop.outputDir,
			sourceUrl,
			platform: 'generic',
			desktopVariant: 'desktop',
			mobileVariant: 'mobile',
			embeddedDocuments: true,
		});
		const server = await serveCapture(desktop.outputDir);
		try {
			for (const [width, height] of [
				[390, 104],
				[768, 86],
				[1440, 86],
			]) {
				const page = await browser.newPage({ viewport: { width: width!, height: 900 } });
				try {
					await page.goto(server.url, { waitUntil: 'load' });
					expect(await page.locator('iframe:visible').count()).toBe(1);
					expect((await page.locator('iframe:visible').boundingBox())!.height).toBe(height);
					expect(
						await page
							.frameLocator('iframe:visible')
							.locator('body')
							.evaluate((node) => getComputedStyle(node, '::before').content)
					).toBe('"<!--"');
				} finally {
					await page.close();
				}
			}
		} finally {
			await server.close();
		}
	});
});
