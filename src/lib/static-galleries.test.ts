
import { describe, expect } from 'vitest';
import { it } from '../../test/browser.js';
import { wireCapturedGalleries } from './static-galleries.js';
import type { CapturedDialogInteraction } from './screenshot/interaction-capture.js';

describe('wireCapturedGalleries src-swap cycles', () => {
	it('emits slot metadata and advances every slot offline', async ({ newPage }) => {
		const urls = Array.from({ length: 5 }, (_, i) => `/media/${i + 1}.jpeg`);
		const frame = (index: number) => `<div class="slot"><img src="${urls[(index + 4) % 5]}"></div><div class="slot"><img src="${urls[index]}"></div><div class="slot"><img src="${urls[(index + 1) % 5]}"></div>`;
		const state: CapturedDialogInteraction = {
			status: 'no-dialog', kind: 'gallery', trigger: { selector: '#gallery', tag: 'div', ariaHaspopup: '', dataBindings: {} },
			gallery: { inline: { selector: '#gallery', stage: ':scope', next: '.next', previous: '.previous', viewport: { width: 800, height: 600 }, order: [], initial: 0, coverage: 'complete', restoration: 'verified', autoplay: 'unmeasured', frames: urls.map((url, index) => ({ key: url, html: frame(index), text: [] })) } },
		};
		const html = wireCapturedGalleries(`<html><head></head><body><div id="gallery">${frame(0)}<button class="previous">Previous</button><button class="next">Next</button></div></body></html>`, [state]);

		{
			const page = await newPage();
			await page.setContent(html);
			expect(await page.locator('#gallery').getAttribute('data-blocks-engine-capture-gallery-sequence')).toBe(JSON.stringify(urls));
			expect(await page.locator('[data-blocks-engine-capture-gallery-slot]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-blocks-engine-capture-gallery-slot')))).toEqual(['-1', '0', '1']);
			await page.locator('.next').click();
			expect(await page.locator('[data-blocks-engine-capture-gallery-slot]').evaluateAll(nodes => nodes.map(node => (node as HTMLImageElement).getAttribute('src')))).toEqual([urls[0], urls[1], urls[2]]);
		}
	}, 30_000);
});

describe('wireCapturedGalleries frame stages', () => {
	it('drops the source track translation from a frame-wired stage', () => {
		const frames = [0, 1, 2].map(i => ({ key: `k${i}`, html: `<div class="slide">Quote ${i}</div>`, text: [] }));
		const state: CapturedDialogInteraction = {
			status: 'no-dialog', kind: 'gallery', trigger: { selector: '.slider', tag: 'div', ariaHaspopup: '', dataBindings: {} },
			gallery: { inline: { selector: '.slider', stage: '.track', next: '.next', previous: '.prev', viewport: { width: 1440, height: 900 }, order: [], initial: 2, coverage: 'complete', restoration: 'verified', autoplay: 'unmeasured', frames } },
		};
		const html = wireCapturedGalleries(`<html><head></head><body><div class="slider"><div class="track" style="display:flex; transform: translate3d(-1200px,0px,0px); translate: -10px; gap:4px">${frames.map(f => f.html).join('')}</div><button class="prev">p</button><button class="next">n</button></div></body></html>`, [state]);
		const stage = /<div class="track"[^>]*>/.exec(html)![0];
		expect(stage).toContain('data-blocks-engine-capture-gallery-stage');
		expect(stage).not.toMatch(/transform|translate/);
		expect(stage).toContain('display:flex;gap:4px');
	});
});
