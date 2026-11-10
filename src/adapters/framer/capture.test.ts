import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { load } from 'cheerio';
import { expect, it } from 'vitest';
import { captureScreenshots } from '../../lib/screenshot/screenshotter.js';
import { exportWebsiteCapture } from '../../lib/capture-export.js';
import { loadFramerDocument, settleFramerEntranceStyle } from './capture.js';
import { installSourceDocumentLoader } from '../../lib/source-navigation.js';
import { checkSelfConsistency } from '../../lib/fidelity/self-consistency.js';

it('settles only hinted inline entrance poses', () => {
	for (const style of [
		'opacity:0;transform:translateY(18px)',
		'will-change:contents;opacity:0',
		'will-change:transform;opacity:0;transform:rotate(20deg)',
		'display:none;opacity:0',
	]) expect(settleFramerEntranceStyle(style)).toBe(style);
	expect(settleFramerEntranceStyle('will-change:opacity;opacity:.2;color:red')).toContain('opacity:1');
	expect(settleFramerEntranceStyle('will-change:transform;transform:scale(0.8)')).toContain('transform:none');
});

// One browser capture (~20s), using the same document loader as liberation.
it('keeps width-selected SSR variants as one portable tree', async () => {
	const fixture = readFileSync(new URL('../../../test/fixtures/width-selected-variants.html', import.meta.url), 'utf8');
	const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(fixture); });
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	mkdirSync('.tmp-test', { recursive: true });
	const outputDir = mkdtempSync(join(process.cwd(), '.tmp-test', 'ssr-variants-'));
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		const before: number[] = [];
		const sourceTops: number[] = [];
		for (const width of [390, 1024, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(url);
			await page.waitForFunction(() => document.querySelectorAll('.ssr-variant').length === 1);
			before.push(await page.locator('.ssr-variant').count());
			sourceTops.push((await page.locator('#services').boundingBox())!.y);
		}
		await captureScreenshots({ urls: [url], primaryUrl: url, outputDir, concurrency: 1, settleMs: 50, learnFluid: false, force: true, deviceMode: 'auto',
			initScript: async page => {
				installSourceDocumentLoader(page, async (url, timeout) => {
					const document = await loadFramerDocument(page, url, timeout);
					return document && { url, status: 200, headers: document.headers, body: Buffer.from(document.html) };
				});
			},
		});
		exportWebsiteCapture({ outputDir, sourceUrl: url, platform: 'framer', summary: {}, failures: [] });
		const html = readFileSync(join(outputDir, 'website', 'index.html'), 'utf8');
		const $ = load(html);
		expect(checkSelfConsistency(join(outputDir, 'website'), new Map([['/', 'index.html']])).findings).not.toContainEqual(expect.objectContaining({ kind: 'anchor-ambiguous' }));
		expect($('header')).toHaveLength(1);
		expect($('form')).toHaveLength(1);
		expect($('.ssr-variant')).toHaveLength(3);
		expect($('.data-blocks-engine-capture-mobile-document')).toHaveLength(0);
		const ids = $('[id]').toArray().map(node => $(node).attr('id'));
		expect(new Set(ids).size).toBe(ids.length);
		const after: string[] = [];
		for (const width of [390, 1024, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await page.setContent(html);
			after.push(await page.locator('.ssr-variant:visible').innerText());
			const entrance = page.locator('#services');
			expect(await entrance.evaluate(node => ({ opacity: getComputedStyle(node).opacity, transform: getComputedStyle(node).transform })))
				.toEqual({ opacity: '1', transform: 'none' });
			expect((await entrance.boundingBox())!.y).toBeCloseTo(sourceTops[after.length - 1]!, 1);
			expect(await page.locator('#intentionally-hidden').evaluate(node => getComputedStyle(node).opacity)).toBe('0');
		}
		expect(after).toEqual(['Phone layout', 'Tablet layout', 'Desktop layout']);
		console.info('SSR variant evidence', { before, after, headers: $('header').length, forms: $('form').length });
	} finally {
		await browser.close();
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(outputDir, { recursive: true, force: true });
	}
}, 120000);
