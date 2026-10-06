import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureGalleries } from './gallery-capture.js';
import { captureTriggeredDialogs } from './interaction-capture.js';
import { wireCapturedDialogs } from '../static-dialogs.js';

const image = (index: number, full = false) =>
	'data:image/svg+xml,' +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${full ? 800 : 200}" height="200"><rect width="100%" height="100%" fill="${['red', 'green', 'blue'][index]}"/><text x="20" y="50">${index}</text></svg>`,
	);
const fixture = `<!doctype html><html><head><style>
.frame{display:none;width:100%}.frame.chosen{display:block}img{width:100%;height:200px;object-fit:contain}
#overlay{display:none;position:fixed;inset:0;background:black;z-index:100}#overlay.visible{display:block}#overlay img{height:60vh}button,[role=button],[role=img]{cursor:pointer}#stage{width:100%}
</style></head><body><section id="gallery"><h2>Pictures</h2><div aria-label="Image gallery carousel"><div id="stage">${[0, 1, 2].map((i) => `<div class="frame ${i === 0 ? 'chosen' : ''}"><div role="img" data-src="${image(i, true)}"><img src="${image(i)}"></div></div>`).join('')}</div></div><div role="button" aria-label="Previous image">Previous</div><div role="button" aria-label="Next image">Next</div><span id="count">1 / 3</span></section>
<div id="overlay"><div id="large">${[0, 1, 2].map((i) => `<div class="frame ${i === 0 ? 'chosen' : ''}"><img src="${image(i, true)}"></div>`).join('')}</div><button aria-label="Previous slide">Previous</button><button aria-label="Next slide">Next</button><button aria-label="Close gallery">Close</button><span id="large-count">1 / 3</span></div>
<script>let current=0,large=0;function show(scope,index,counter){scope.querySelectorAll('.frame').forEach((node,i)=>node.classList.toggle('chosen',i===index));document.getElementById(counter).textContent=(index+1)+' / 3';}
document.querySelector('[aria-label="Next image"]').onclick=()=>{current=(current+1)%3;show(document.getElementById('stage'),current,'count');};document.querySelector('[aria-label="Previous image"]').onclick=()=>{current=(current+2)%3;show(document.getElementById('stage'),current,'count');};
document.querySelectorAll('#stage [role=img]').forEach((node,i)=>node.onclick=()=>{large=i;show(document.getElementById('large'),large,'large-count');document.getElementById('overlay').classList.add('visible');});
document.querySelector('[aria-label="Next slide"]').onclick=()=>{large=(large+1)%3;show(document.getElementById('large'),large,'large-count');};document.querySelector('[aria-label="Previous slide"]').onclick=()=>{large=(large+2)%3;show(document.getElementById('large'),large,'large-count');};document.querySelector('[aria-label="Close gallery"]').onclick=()=>document.getElementById('overlay').classList.remove('visible');</script></body></html>`;

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))(
	'replays observed cycles and image-opened galleries offline at phone, tablet and desktop widths',
	async () => {
		const browser = await chromium.launch();
		try {
			for (const width of [390, 768, 1440]) {
				const page = await browser.newPage({ viewport: { width, height: 900 } });
				await page.setContent(fixture);
				const baseline = await page.content();
				const states = await captureGalleries(page);
				expect(states).toHaveLength(1);
				expect(states[0]).toMatchObject({
					status: 'captured',
					gallery: {
						inline: { coverage: 'complete', restoration: 'verified' },
						lightbox: { coverage: 'complete', restoration: 'verified' },
						closed: true,
					},
				});
				expect(states[0]!.gallery!.inline.frames).toHaveLength(3);
				const portable = wireCapturedDialogs(
					baseline.replace(/<script>[\s\S]*?<\/script>/g, ''),
					states,
				);
				const offline = await browser.newPage({ viewport: { width, height: 900 } });
				await offline.route('**/*', (route) => route.abort());
				await offline.setContent(portable);
				expect(await offline.locator('#stage img').count()).toBe(3);
				expect(await offline.locator('[data-dla-dialog-panel] img').count()).toBe(3);
				for (const expected of ['2 / 3', '3 / 3', '1 / 3']) {
					await offline.getByRole('button', { name: 'Next image', exact: true }).click();
					expect(await offline.locator('#count').textContent()).toBe(expected);
				}
				await offline.getByRole('button', { name: 'Previous image', exact: true }).click();
				expect(await offline.locator('#count').textContent()).toBe('3 / 3');
				await offline.locator('#stage img:visible').click();
				expect(await offline.locator('[data-dla-dialog-panel]').isVisible()).toBe(true);
				expect(await offline.locator('#large-count').textContent()).toBe('3 / 3');
				await offline.getByRole('button', { name: 'Next slide', exact: true }).click();
				expect(await offline.locator('#large-count').textContent()).toBe('1 / 3');
				await offline.getByRole('button', { name: 'Previous slide', exact: true }).click();
				expect(await offline.locator('#large-count').textContent()).toBe('3 / 3');
				await offline.getByRole('button', { name: 'Close gallery', exact: true }).click();
				expect(await offline.locator('[data-dla-dialog-panel]').isVisible()).toBe(false);
				await page.close();
				await offline.close();
			}
		} finally {
			await browser.close();
		}
	},
	60_000,
);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))(
	'keeps a non-invertible directional action as partial evidence and emits no gallery runtime',
	async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.setContent(fixture.replace('current=(current+2)%3', 'current=(current+1)%3'));
			const baseline = await page.content();
			const states = await captureGalleries(page);
			expect(states[0]).toMatchObject({
				status: 'no-dialog',
				gallery: { inline: { coverage: 'partial', restoration: 'unverified' } },
			});
			expect(
				wireCapturedDialogs(baseline.replace(/<script>[\s\S]*?<\/script>/g, ''), states),
			).not.toContain('data-dla-gallery-runtime');
		} finally {
			await browser.close();
		}
	},
	10_000,
);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))(
	'takes the popup baseline after activation scrolls a nested contact container',
	async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.setContent(
				'<div style="height:180px;overflow:auto"><div style="height:1000px"></div><section id="contact" style="height:200px"><h2>Contact</h2><button id="send" type="button">Submit</button></section></div>',
			);
			const report = await captureTriggeredDialogs(page, 'https://neutral.test/');
			expect(report.states).toEqual([
				expect.objectContaining({
					status: 'no-dialog',
					trigger: expect.objectContaining({ id: 'send' }),
				}),
			]);
		} finally {
			await browser.close();
		}
	},
	10_000,
);
