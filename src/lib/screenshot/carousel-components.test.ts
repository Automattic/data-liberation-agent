import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { snapshotComponents, exploreComponents, routeComponents } from './component-states.js';
import { captureTriggeredDialogs } from './interaction-capture.js';

let browser: Browser;
const directory = resolve('.tmp-test/carousel-components');
beforeAll(async () => { mkdirSync(directory, { recursive: true }); browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); rmSync(directory, { recursive: true, force: true }); });

// One browser pass per mechanism, approximately 15 seconds together.
for (const count of [14, 20]) it(`captures ${count} logical frames from the initial route without promoting a carousel to a dialog`, async () => {
	const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="blue"/></svg>');
	const frame = (index: number, clone = false) => `<div class="slide" ${clone ? 'data-clone' : ''}><img data-src="${image}" src="${index === 0 ? image : 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'}"><span>Frame ${index}</span></div>`;
	const filename = resolve(directory, `${count}.html`);
	writeFileSync(filename, `<style>.carousel{position:relative;width:320px;height:110px;overflow:hidden}button{width:30px;height:20px}.carousel button{position:absolute;bottom:0;left:0}.carousel #next{left:40px}svg{width:10px;height:10px}.track{display:flex;width:max-content}.slide{width:320px;height:80px;flex:none}img{width:80px;height:80px}</style><section id="section"><div id="carousel" class="carousel" tabindex="0"><div class="track">${Array.from({ length: count }, (_, index) => frame(index)).join('')}${frame(0, true)}</div><button id="prev"><svg class="arrow-left"></svg></button><button id="next"><svg class="arrow-right"></svg></button><span id="counter">1 / ${count}</span></div></section><button aria-haspopup="dialog" aria-controls="dialog" onclick="document.querySelector('dialog').showModal()">Open dialog</button><dialog id="dialog">Real dialog<button onclick="this.parentElement.close()">Close</button></dialog><script>let index=0;const root=document.querySelector('#carousel');function move(delta){index=(index+delta+${count})%${count};const img=root.querySelectorAll('.slide img')[index];img.src=img.dataset.src;root.querySelector('.track').style.transform='translateX('+(-index*320)+'px)';document.querySelector('#counter').textContent=(index+1)+' / ${count}'}document.querySelector('#next').onclick=()=>move(1);document.querySelector('#prev').onclick=()=>move(-1);root.onkeydown=e=>{if(e.key==='ArrowRight')move(1)};root.ontouchend=()=>move(1);</script>`);
	const page = await browser.newPage({ viewport: { width: 768, height: 900 }, hasTouch: true });
	try {
		await page.goto('file://' + filename);
		const baseline = await snapshotComponents(page);
		const nodes = await exploreComponents(page, baseline);
		const carousel = nodes.find(node => node.function === 'slideshow')!;
		expect(carousel.initial).toBe('slide-0');
		expect(carousel.slideshow?.frames).toHaveLength(count);
		expect(carousel.slideshow?.frames.map(frame => frame.id)).toEqual(Array.from({ length: count }, (_, index) => `slide-${index}`));
		expect(carousel.slideshow?.frames.every(frame => frame.media[0]?.asset === image)).toBe(true);
		expect(carousel.slideshow?.navigation.map(item => item.mode)).toEqual(['arrows', 'keyboard', 'swipe']);
		expect(carousel.slideshow?.views).toEqual([{ width: 768, framesPerView: 1 }]);
		expect(carousel.status).toBe('captured');
		const report = await captureTriggeredDialogs(page, 'file://' + filename, { skip: baseline.skip });
		const projected = routeComponents({ ...report, components: nodes });
		expect(projected.filter(node => node.kind === 'carousel')).toHaveLength(1);
		expect(projected.some(node => node.kind === 'dialog')).toBe(true);
		expect(await page.locator('#section > #carousel').count()).toBe(1);
		expect(await page.locator('#counter').textContent()).toBe(`1 / ${count}`);
	} finally { await page.close(); }
});
