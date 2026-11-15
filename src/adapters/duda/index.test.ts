import { existsSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { findAdapter } from '../index.js';
import { detectFromResponse } from '../../lib/detect-platform/index.js';
import { dudaAdapter } from './index.js';
import { detection } from './detection.js';

const fixture = readFileSync(new URL('./fixture.html', import.meta.url), 'utf8');
const INERT = 'data-blocks-engine-capture-inert-control';

// A generic site with the same pager markup but no Duda runtime.
const nonDuda = `<!doctype html><html><body>${fixture.match(/<nav[^]*?<\/nav>/)![0]}</body></html>`;

describe('Duda adapter', () => {
	it('registers the adapter and detects Duda documents only', () => {
		expect(findAdapter('duda')).toBe(dudaAdapter);
		const matches = (html: string) => detection.sourceSignals!.some(({ pattern }) => pattern.test(html));
		expect(matches(fixture)).toBe(true);
		expect(matches('<div id="dmRoot" class="dmRespDesignRoot">')).toBe(true);
		expect(matches('<script src="https://www.example.com/_dm/s/rt/dist/scripts/d-js-runtime-flex-package.min.js"></script>')).toBe(true);
		expect(matches(nonDuda)).toBe(false);
		expect(matches('<img src="https://lirp.cdn-website.com/abc/dms3rep/multi/photo.jpg">')).toBe(false);
	});
});

// Detection picks the adapter whose hooks capture runs, exactly as capture does.
const hooksFor = (html: string) => findAdapter(detectFromResponse(new Headers(), html).platform)?.liberation;

describe.skipIf(!existsSync(chromium.executablePath()))('Duda pager capture', () => {
	it('materializes anchor ids without replacing existing or colliding ids', async () => {
		const cases = [
			{ markup: '<div data-anchor="Epson EB-U42"></div>', id: 'EpsonEB-U42' },
			{ markup: '<div data-anchor="Gespannausfahrten - coming soon"></div>', id: 'Gespannausfahrten-comingsoon' },
			{ markup: '<div data-anchor=" A&#9;B&#10;C "></div>', id: 'ABC' },
			{ markup: '<div id="keep" data-anchor="Kept"></div>', id: 'keep' },
			{ markup: '<div id="taken"></div><div data-anchor="ta ken"></div>', id: null },
			{ markup: '<div data-anchor=" &#9; "></div>', id: null },
		];
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.setContent(cases.map(test => test.markup).join(''));
			await dudaAdapter.liberation!.beforeSerialize!(page, { url: 'https://duda.example/', viewport: 'desktop' });
			expect(await page.locator('[data-anchor]').evaluateAll(elements => elements.map(element => element.getAttribute('id'))))
				.toEqual(cases.map(test => test.id));
		} finally {
			await browser.close();
		}
	});

	it('marks a single-page pager inert and leaves multi-page and non-Duda pagers alone', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			const inert = (selector: string) => page.locator(`${selector} a[data-action="paginate"]`).evaluateAll(
				(links, name) => links.map(link => link.getAttribute(name)), INERT);
			const ctx = { url: 'https://duda.example/resources', viewport: 'desktop' };

			await page.setContent(fixture);
			await hooksFor(fixture)?.beforeSerialize?.(page, ctx);
			expect(await inert('#single')).toEqual(['true', 'true', 'true']);
			expect(await inert('#multi')).toEqual([null, null, null, null]);

			// Same pager without Duda's runtime: the generic capture contract governs it.
			await page.setContent(nonDuda);
			await hooksFor(nonDuda)?.beforeSerialize?.(page, ctx);
			expect(await inert('#single')).toEqual([null, null, null]);
		} finally {
			await browser.close();
		}
	});
});
