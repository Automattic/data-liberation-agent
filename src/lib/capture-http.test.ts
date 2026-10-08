import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAdapter } from '../types.js';

const state = vi.hoisted(() => ({ runtime: false, redirected: false, multiple: false }));
vi.mock('./media-fetch/safe-fetch.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('./media-fetch/safe-fetch.js')>();
	return {
		...original,
		safeFetch: vi.fn(async (url: string) => ({
			finalUrl: state.redirected ? 'https://example.com/final/article/index.html' : url,
			status: 200,
			headers: new Headers({ 'content-type': url.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' }),
			body: Buffer.from(
				url.endsWith('.css')
					? 'body{color:red}'
					: state.runtime
						? `<html class="no-js"><head><title>Runtime fixture</title></head><body><div id="host"></div><p id="authored">Keep authored identity</p>${state.multiple ? '<section class="item"></section>'.repeat(20) : ''}<select id="choice"><option value="first">First</option><option value="second">Second</option></select><script>document.getElementById("host").textContent=${state.redirected ? 'document.baseURI' : '"Mounted ready"'};document.documentElement.className="js";document.getElementById("choice").value="second";document.querySelectorAll('.item').forEach((node,index)=>node.textContent='Observed item '+index);const s=document.createElement("style");s.textContent="#host{color:rgb(11,22,33);width:calc(100% - 24px)}";document.head.append(s)</script></body></html>`
						: `<html><head><title>Article</title><link rel="stylesheet" href="https://cdn.example.com/site.css"></head><body><h1>${url}</h1><a href="https://example.com/post/">Post</a>${url.includes('requires-browser') ? '<canvas></canvas>' : ''}</body></html>`
			),
		})),
	};
});
vi.mock('./detect-platform/index.js', () => ({ detect: vi.fn(async () => ({ platform: 'fixture' })) }));
const browserCapture = vi.hoisted(() =>
	vi.fn(async () => {
		throw new Error('Browser capture must not run');
	})
);
vi.mock('./screenshot/screenshotter.js', () => ({ captureScreenshots: browserCapture }));

import { captureWebsite, IncompleteCaptureError, UnsupportedCapturePlatformError } from './capture.js';
import { safeFetch } from './media-fetch/safe-fetch.js';

const dirs: string[] = [];
const url = 'https://example.com/';
function directory() {
	const root = join(process.cwd(), '.tmp-test');
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(join(root, 'http-orchestration-'));
	dirs.push(dir);
	return dir;
}
function adapter(): PlatformAdapter {
	return {
		id: 'fixture',
		discover: async () => ({
			siteMeta: { title: 'Fixture site' },
			urls: [{ url: `${url}post/` }, { url: `${url}requires-browser/` }],
		}),
		acquisition: {
			id: 'fixture-http',
			variants: [{ id: 'authored' }],
			prepare: (html) =>
				html.includes('<canvas')
					? undefined
					: {
							html: html.replace(/<script>[\s\S]*?<\/script>/g, ''),
							browserRegions: state.runtime
								? [
										{ selector: '#host', reason: 'Runtime mount', projection: 'subtree' },
										{ selector: 'html', reason: 'Source state', projection: 'attributes' },
										{ selector: '#choice', reason: 'Selected state', projection: 'subtree' },
									]
								: undefined,
						},
		},
	};
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	state.runtime = false;
	state.redirected = false;
	state.multiple = false;
	vi.clearAllMocks();
});

describe('orchestrated HTTP review capture', () => {
	it('records source readiness before export-only projection and retains its learning provenance', async () => {
		state.runtime = true;
		const outputDir = directory(), platform = adapter(), order: string[] = [];
		platform.acquisition!.prepareRuntimeRegions = async page => {
			expect(await page.locator('#host').textContent()).toBe('Mounted ready');
			expect(await page.locator('#host').getAttribute('style')).toBeNull();
			order.push('source-evidence');
		};
		platform.acquisition!.projectRuntimeRegions = async page => {
			order.push('export-projection');
			await page.locator('#host').evaluate(node => { (node as HTMLElement).style.width = '100%'; });
			return { primitive: 'neutral-geometry', sampling: 'source-runtime-resize' };
		};
		const result = await captureWebsite({ url, outputDir, acquisition: 'http', http: { routeLimit: 1, runtimeRouteLimit: 1 } }, { findAdapter: () => platform });
		expect(order).toEqual(['source-evidence', 'export-projection']);
		const runtime = JSON.parse(readFileSync(join(outputDir, 'runtime-observations.json'), 'utf8'));
		expect(runtime.attachments[0].observation.projection).toEqual({ primitive: 'neutral-geometry', sampling: 'source-runtime-resize' });
		expect(runtime.attachments[0].observation.regions[0].nodes[0].html).toContain('width: 100%');
		expect(result.complete).toBe(false);
	});
	it('retains unobserved node accounting when only the bounded first sixteen of twenty declared nodes are projected', async () => {
		state.runtime = true;
		state.multiple = true;
		const outputDir = directory();
		const platform = adapter();
		platform.acquisition!.prepare = (html) => ({
			html: html.replace(/<script>[\s\S]*?<\/script>/g, ''),
			browserRegions: [{ selector: '.item', reason: 'Bounded node coverage', projection: 'subtree' }],
		});
		const result = await captureWebsite(
			{ url, outputDir, acquisition: 'http', http: { routeLimit: 1, runtimeRouteLimit: 1 } },
			{ findAdapter: () => platform }
		);
		const staged = JSON.parse(readFileSync(join(outputDir, 'embedded-documents.json'), 'utf8'));
		expect(staged.coverage[0]).toMatchObject({
			expectedNodes: 20,
			observedIndices: Array.from({ length: 16 }, (_, index) => index),
			projectedIndices: Array.from({ length: 16 }, (_, index) => index),
		});
		expect(result.discoveryDiagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: 'http_browser_region_unobserved', reason: expect.stringContaining('.item') }),
				expect.objectContaining({
					code: 'http_runtime_projection_unresolved',
					reason: expect.stringContaining('16/20'),
				}),
			])
		);
		const html = readFileSync(join(outputDir, 'website/index.html'), 'utf8');
		expect(html).toContain('Observed item 15');
		expect(html).not.toContain('Observed item 16');
	});
	it('discovers, acquires and localizes through captureWebsite with truthful unsupported-route coverage', async () => {
		const outputDir = directory();
		const result = await captureWebsite({ url, outputDir, acquisition: 'http' }, { findAdapter: adapter });
		expect(result.summary).toMatchObject({
			routesDiscovered: 3,
			routesCaptured: 2,
			routesSkipped: 0,
			routesFailed: 1,
			complete: false,
		});
		expect(result.failures).toEqual([expect.objectContaining({ url: `${url}requires-browser/` })]);
		expect(result.provenance.provider).toBe('data-liberation/http-capture');
		const html = readFileSync(join(outputDir, 'website/index.html'), 'utf8');
		expect(html).not.toContain('https://cdn.example.com/');
		expect(readFileSync(join(outputDir, 'website/post/index.html'), 'utf8')).toContain('https://example.com/post/');
		const receipt = JSON.parse(readFileSync(result.captureReceiptPath, 'utf8'));
		expect(receipt.title).toBe('Fixture site');
		expect(receipt.acquisition.verification.rendering).toBe('unverified');
		expect(existsSync(join(outputDir, 'fidelity-reference.json'))).toBe(false);
		expect(existsSync(join(outputDir, 'screenshots/manifest.json'))).toBe(false);
		expect(browserCapture).not.toHaveBeenCalled();
	});

	it('limits requested routes without hiding the discovered remainder and preserves strict failure', async () => {
		const outputDir = directory();
		const result = await captureWebsite(
			{ url, outputDir, acquisition: 'http', http: { routeLimit: 1 } },
			{ findAdapter: adapter }
		);
		expect(result.summary).toMatchObject({ routesDiscovered: 3, routesCaptured: 1, routesFailed: 0, complete: false });
		expect(result.discoveryDiagnostics.filter((row) => row.code === 'http_route_not_requested')).toHaveLength(2);
		await expect(
			captureWebsite(
				{ url, outputDir: directory(), acquisition: 'http', strict: true, http: { routeLimit: 1 } },
				{ findAdapter: adapter }
			)
		).rejects.toBeInstanceOf(IncompleteCaptureError);
	});

	it('performs bounded real-browser region observation when explicitly requested', async () => {
		state.runtime = true;
		const outputDir = directory();
		const result = await captureWebsite(
			{ url, outputDir, acquisition: 'http', http: { routeLimit: 2, runtimeRouteLimit: 1 } },
			{ findAdapter: adapter }
		);
		const report = JSON.parse(readFileSync(join(outputDir, 'runtime-observations.json'), 'utf8'));
		expect(report.selectedRoutes).toEqual([url]);
		expect(report.attachments[0].observation.regions[0].nodes[0].html).toContain('Mounted ready');
		expect(report.failures).toEqual([]);
		expect(result.complete).toBe(false);
		expect(browserCapture).not.toHaveBeenCalled();
	});

	it('projects declared DOM and selected/document state with runtime CSS through the real orchestration and offline browser', async () => {
		state.runtime = true;
		const outputDir = directory();
		const result = await captureWebsite(
			{ url, outputDir, acquisition: 'http', http: { routeLimit: 1, runtimeRouteLimit: 1 } },
			{ findAdapter: adapter }
		);
		const html = readFileSync(join(outputDir, 'website/index.html'), 'utf8');
		expect(html).toContain('Mounted ready');
		expect(html).toContain('id="authored"');
		expect(html).toContain('class="js"');
		const { chromium } = await import('playwright');
		const { serveCapture } = await import('./serve-capture.js');
		const browser = await chromium.launch();
		const server = await serveCapture(outputDir);
		try {
			for (const width of [390, 768, 1440]) {
				const page = await browser.newPage({ viewport: { width, height: 900 } });
				await page.route('**/*', (route) =>
					new URL(route.request().url()).origin === new URL(server.url).origin ? route.continue() : route.abort()
				);
				await page.goto(server.url, { waitUntil: 'load' });
				expect(await page.locator('#choice').inputValue()).toBe('second');
				expect(
					await page
						.locator('#host')
						.evaluate((node) => ({ color: getComputedStyle(node).color, width: node.getBoundingClientRect().width }))
				).toEqual({ color: 'rgb(11, 22, 33)', width: width - 40 });
				await page.close();
			}
		} finally {
			await server.close();
			await browser.close();
		}
		expect(result.complete).toBe(false);
	});

	it('rejects modified observed attributes before replacing a previously exported candidate', async () => {
		state.runtime = true;
		const outputDir = directory();
		await captureWebsite(
			{ url, outputDir, acquisition: 'http', http: { routeLimit: 1, runtimeRouteLimit: 1 } },
			{ findAdapter: adapter }
		);
		const path = join(outputDir, 'embedded-documents.json');
		const receipt = JSON.parse(readFileSync(path, 'utf8'));
		receipt.regions.find((region: { projection: string }) => region.projection === 'attributes').attributes.class =
			'forged';
		writeFileSync(path, JSON.stringify(receipt));
		const before = readFileSync(join(outputDir, 'website/index.html'));
		const { materializeHttpDocuments } = await import('./http-materialization.js');
		expect(() =>
			materializeHttpDocuments({
				outputDir,
				sourceUrl: url,
				platform: 'fixture',
				desktopVariant: 'authored',
				embeddedDocuments: true,
			})
		).toThrow('attribute identity mismatch');
		expect(readFileSync(join(outputDir, 'website/index.html'))).toEqual(before);
	});

	it('preserves canonical final-URL identity during real-browser region replay', async () => {
		state.runtime = true;
		state.redirected = true;
		const outputDir = directory();
		await captureWebsite(
			{ url, outputDir, acquisition: 'http', http: { routeLimit: 1, runtimeRouteLimit: 1 } },
			{ findAdapter: adapter }
		);
		const report = JSON.parse(readFileSync(join(outputDir, 'runtime-observations.json'), 'utf8'));
		expect(report.selectedRoutes).toEqual(['https://example.com/final/article/index.html']);
		expect(report.failures).toEqual([]);
		expect(report.attachments[0].observation.regions[0].nodes[0].html).toContain(
			'https://example.com/final/article/index.html'
		);
	});

	it.each([
		{ resume: true },
		{ captureImages: true },
		{ http: { routeLimit: 0 } },
		{ http: { runtimeRouteLimit: 51 } },
	])('rejects unsupported options before fetching: %j', async (option) => {
		await expect(
			captureWebsite({ url, outputDir: directory(), acquisition: 'http', ...option }, { findAdapter: adapter })
		).rejects.toThrow();
		expect(safeFetch).not.toHaveBeenCalled();
	});

	it('rejects unsupported platforms and ambiguous variant roles without browser fallback', async () => {
		const unsupported = adapter();
		delete unsupported.acquisition;
		await expect(
			captureWebsite({ url, outputDir: directory(), acquisition: 'http' }, { findAdapter: () => unsupported })
		).rejects.toBeInstanceOf(UnsupportedCapturePlatformError);
		const ambiguous = adapter();
		ambiguous.acquisition!.variants = [{ id: 'wide' }, { id: 'narrow' }];
		await expect(
			captureWebsite({ url, outputDir: directory(), acquisition: 'http' }, { findAdapter: () => ambiguous })
		).rejects.toThrow('explicit export roles');
		expect(browserCapture).not.toHaveBeenCalled();
	});
});
