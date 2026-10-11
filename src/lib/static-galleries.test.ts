import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { wireCapturedGalleries } from './static-galleries.js';
import type { CapturedDialogInteraction } from './screenshot/interaction-capture.js';

describe('wireCapturedGalleries src-swap cycles', () => {
	it('emits slot metadata and advances every slot offline', async () => {
		const urls = Array.from({ length: 5 }, (_, i) => `/media/${i + 1}.jpeg`);
		const frame = (index: number) => `<div class="slot"><img src="${urls[(index + 4) % 5]}"></div><div class="slot"><img src="${urls[index]}"></div><div class="slot"><img src="${urls[(index + 1) % 5]}"></div>`;
		const state: CapturedDialogInteraction = {
			status: 'no-dialog', kind: 'gallery', trigger: { selector: '#gallery', tag: 'div', ariaHaspopup: '', dataBindings: {} },
			gallery: { inline: { selector: '#gallery', stage: ':scope', next: '.next', previous: '.previous', viewport: { width: 800, height: 600 }, order: [], initial: 0, coverage: 'complete', restoration: 'verified', autoplay: 'unmeasured', frames: urls.map((url, index) => ({ key: url, html: frame(index), text: [] })) } },
		};
		const html = wireCapturedGalleries(`<html><head></head><body><div id="gallery">${frame(0)}<button class="previous">Previous</button><button class="next">Next</button></div></body></html>`, [state]);
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			await page.setContent(html);
			expect(await page.locator('#gallery').getAttribute('data-dla-gallery-sequence')).toBe(JSON.stringify(urls));
			expect(await page.locator('[data-dla-gallery-slot]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-dla-gallery-slot')))).toEqual(['-1', '0', '1']);
			await page.locator('.next').click();
			expect(await page.locator('[data-dla-gallery-slot]').evaluateAll(nodes => nodes.map(node => (node as HTMLImageElement).getAttribute('src')))).toEqual([urls[0], urls[1], urls[2]]);
		} finally { await browser.close(); }
	}, 30_000);
});
