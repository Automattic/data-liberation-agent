import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium as playwrightChromium } from 'playwright';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { alignCapturedGalleries, captureGalleries } from './gallery-capture.js';
import { captureTriggeredDialogs } from './interaction-capture.js';
import { wireCapturedDialogs } from '../static-dialogs.js';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';
import { learnAndApplyFluidGeometry } from './fluid-capture.js';

let sharedBrowser: import('playwright').Browser;
const chromium = {
	executablePath: () => playwrightChromium.executablePath(),
	launch: async () => new Proxy(sharedBrowser, {
		get(target, property) {
			if (property === 'close') return async () => {};
			const value = Reflect.get(target, property, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}),
};
beforeAll(async () => {
	if (!process.env.SKIP_BROWSER_TESTS && existsSync(playwrightChromium.executablePath())) sharedBrowser = await playwrightChromium.launch();
});
afterEach(async () => { for (const context of sharedBrowser?.contexts() ?? []) await context.close(); });
afterAll(async () => { await sharedBrowser?.close(); });

const image = (index: number, full = false) =>
	'data:image/svg+xml,' +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${full ? 800 : 200}" height="200"><rect width="100%" height="100%" fill="${['red', 'green', 'blue'][index]}"/><text x="20" y="50">${index}</text></svg>`,
	);
const fixture = `<!doctype html><html><head><style>
.frame{display:none;width:100%}.frame.chosen{display:block}img{width:100%;height:200px;object-fit:contain}#gallery{transform:translateZ(0)}
#overlay{display:block;visibility:hidden;position:fixed;inset:0;background:black;z-index:100}#overlay.visible{visibility:visible}#overlay img{height:60vh}#overlay .frame.chosen{display:block!important}button,[role=button],[role=img]{cursor:pointer}#stage{width:100%}
</style></head><body><section id="gallery"><h2>Pictures</h2><div aria-label="Image gallery carousel"><div id="stage">${[0, 1, 2].map((i) => `<div class="frame ${i === 0 ? 'chosen' : ''}"><div role="img" data-src="${image(i, true)}"><img src="${image(i)}"></div></div>`).join('')}</div></div><div role="button" aria-label="Previous image">Previous</div><div role="button" aria-label="Next image">Next</div><span id="count">1 / 3</span></section>
<div id="overlay"><div id="large">${[0, 1, 2].map((i) => `<div class="frame ${i === 0 ? 'chosen' : ''}"><img src="${image(i, true)}"></div>`).join('')}</div><button aria-label="Previous slide">Previous</button><button aria-label="Next slide">Next</button><button aria-label="Close gallery">Close</button><span id="large-count">1 / 3</span></div>
<script>let current=0,large=0;function show(scope,index,counter){scope.querySelectorAll('.frame').forEach((node,i)=>node.classList.toggle('chosen',i===index));document.getElementById(counter).textContent=(index+1)+' / 3';}
document.querySelector('[aria-label="Next image"]').onclick=()=>{current=(current+1)%3;show(document.getElementById('stage'),current,'count');};document.querySelector('[aria-label="Previous image"]').onclick=()=>{current=(current+2)%3;show(document.getElementById('stage'),current,'count');};
document.querySelectorAll('#stage [role=img]').forEach((node,i)=>node.onclick=()=>{large=i;show(document.getElementById('large'),large,'large-count');document.getElementById('overlay').classList.add('visible');});
document.querySelector('[aria-label="Next slide"]').onclick=()=>{large=(large+1)%3;show(document.getElementById('large'),large,'large-count');};document.querySelector('[aria-label="Previous slide"]').onclick=()=>{large=(large+2)%3;show(document.getElementById('large'),large,'large-count');};document.querySelector('[aria-label="Close gallery"]').onclick=()=>document.getElementById('overlay').classList.remove('visible');</script></body></html>`;

// The source runtime translates a clipped row, lazily fills empty items, and
// carries duplicate end items. No builder names or accessible arrow labels.
const translatedTrackFixture = (count = 3) => `<!doctype html><style>
#translated{position:relative;max-width:440px;margin:auto}.clip{overflow:hidden;width:100%;height:200px}
#row{display:flex;list-style:none;padding:0;margin:0;width:100%;transform:translateX(-320px)}
#row>li{flex:0 0 80%;height:200px;opacity:.3}#row img{width:100%;height:200px;object-fit:cover}
button{position:absolute;top:90px;z-index:2}button:last-child{right:0}
</style><section id="translated"><div class="clip"><ul id="row">${Array.from({length:count+2},(_,i)=>i-1).map(i=>`<li data-index="${i}">${i===2?'':`<img src="${image((i+count)%count)}">`}</li>`).join('')}</ul></div><button data-action="galleryPrevious"><svg width="20" height="20"><path d="M15 0L0 10L15 20Z"/></svg></button><button data-action="galleryNext"><svg width="20" height="20"><path d="M0 0L15 10L0 20Z"/></svg></button></section><script>
let selected=0;const pictures=${JSON.stringify(Array.from({length:count},(_,i)=>image(i)))};function draw(){const row=document.getElementById('row');[...row.children].forEach((li,i)=>{li.style.opacity=i===selected+1?'1':'.3';if(i===selected+1&&!li.firstElementChild)li.innerHTML='<img src="'+pictures[selected]+'">'});row.style.transform='translateX('+((row.parentElement.clientWidth-row.children[0].getBoundingClientRect().width)/2-row.children[selected+1].offsetLeft+3)+'px)'}
document.querySelector('[data-action="galleryNext"]').onclick=()=>{selected=(selected+1)%${count};draw()};document.querySelector('[data-action="galleryPrevious"]').onclick=()=>{selected=(selected+${count-1})%${count};draw()};draw();</script>`;
const translatedFixture = translatedTrackFixture();

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))(
	'replays a lazy translated image track with unnamed semantic arrows and cloned end items', async () => {
		const page = await sharedBrowser.newPage({viewport:{width:768,height:900}});
		await page.setContent(translatedFixture);
		const baseline = await page.content();
		const states = await captureGalleries(page);
		expect(states[0]?.gallery?.inline).toMatchObject({coverage:'complete',restoration:'verified'});
		expect(states[0]?.gallery?.inline.frames).toHaveLength(3);
		// Replay must remain deterministic even when a retained source stylesheet
		// animates opacity. Add it after observation to avoid six slow source fades.
		const portable = wireCapturedDialogs(baseline.replace(/<script>[\s\S]*?<\/script>/g,''),states).replace('</style>','#row>li{transition:opacity 2s}</style>');
		const offline = await sharedBrowser.newPage();
		await offline.route('**/*',route=>route.abort());
		await offline.setContent(portable);
		for (const width of [390,768,1440]) {
			await offline.setViewportSize({width,height:900});
			for (const expected of [1,2,0]) {
				await offline.locator('[data-action="galleryNext"]').click();
				const selected = await offline.locator('#row').evaluate(row=>{
					const viewport=row.parentElement!.getBoundingClientRect();
					const child=[...row.children].find(child=>Math.abs(child.getBoundingClientRect().x+child.getBoundingClientRect().width/2-viewport.x-viewport.width/2)<2);
					return child?.querySelector('img')?.getAttribute('src');
				});
				expect(selected).toBe(image(expected));
				expect(await offline.locator('#row>li').evaluateAll(items=>items.map(item=>getComputedStyle(item).opacity).sort())).toEqual(['0.3','0.3','1']);
			}
		}
		await offline.locator('[data-action="galleryPrevious"]').click();
		expect(await offline.locator('#translated').getAttribute('data-blocks-engine-capture-gallery-index')).toBe('2');
	},30_000,
);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))(
	'keeps a proven offscreen track replayable when aligning the serialization boundary', async () => {
		const page = await sharedBrowser.newPage({viewport:{width:768,height:900}});
		await page.setContent(translatedFixture.replace('<section id="translated">','<div style="height:1200px"></div><section id="translated">'));
		const states = await captureGalleries(page);
		expect(states[0]?.gallery?.inline.restoration).toBe('verified');
		expect(await page.evaluate(()=>scrollY)).toBe(0);
		await alignCapturedGalleries(page,states);
		expect(states[0]?.gallery?.inline).toMatchObject({coverage:'complete',restoration:'verified',initial:0});
		expect(await page.evaluate(()=>scrollY)).toBe(0);
	},15_000,
);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))(
	'leaves a proven fourteen-frame interaction in control of translation through fluid learning and export', async () => {
		const page = await sharedBrowser.newPage({viewport:{width:768,height:900}});
		await page.setContent(translatedTrackFixture(14).replace('max-width:440px;','').replace('draw();</script>',"window.addEventListener('resize',draw);draw();</script>"));
		const states = await captureGalleries(page);
		expect(states[0]?.gallery?.inline).toMatchObject({coverage:'complete',restoration:'verified',initial:0});
		expect(states[0]?.gallery?.inline.frames).toHaveLength(14);
		await learnAndApplyFluidGeometry(page,{widths:[390,600,768,1440],settleMs:30});
		await page.locator('[data-action="galleryNext"]').click();
		await page.waitForTimeout(100);
		await alignCapturedGalleries(page,states);
		expect(states[0]?.gallery?.inline).toMatchObject({coverage:'complete',restoration:'verified',initial:1});
		const portable=wireCapturedDialogs((await page.content()).replace(/<script>[\s\S]*?<\/script>/g,''),states);
		await page.setContent(portable);
		expect(await page.locator('[data-blocks-engine-capture-gallery-frame]').count()).toBe(14);
		await page.locator('[data-action="galleryNext"]').click();
		expect(await page.locator('#translated').getAttribute('data-blocks-engine-capture-gallery-index')).toBe('2');
	},45_000,
);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))(
	'captures and replays a touch-only translated gallery without inventing arrow controls', async () => {
		const page = await sharedBrowser.newPage({viewport:{width:390,height:900},isMobile:true,hasTouch:true});
		const touchFixture = translatedFixture
			.replace(/<button\b[\s\S]*?<\/button>/g,'')
			.replace(/document\.querySelector\('\[data-action="galleryNext"\]'\)\.onclick=[\s\S]*?;draw\(\);<\/script>/,
				`let start=0;const surface=document.querySelector('.clip');surface.style.touchAction='pan-y';surface.addEventListener('touchstart',event=>start=event.touches[0].clientX);surface.addEventListener('touchend',event=>{const delta=event.changedTouches[0].clientX-start;if(Math.abs(delta)>30){selected=(selected+(delta<0?1:2))%3;draw()}});draw();</script>`);
		await page.setContent(touchFixture);
		const baseline = await page.content();
		const states = await captureGalleries(page);
		expect(states[0]?.gallery?.inline).toMatchObject({coverage:'complete',restoration:'verified',swipe:true});
		expect(states[0]?.gallery?.inline.frames).toHaveLength(3);
		await page.setContent(wireCapturedDialogs(baseline.replace(/<script>[\s\S]*?<\/script>/g,''),states));
		expect(await page.locator('button').count()).toBe(0);
		const client = await page.context().newCDPSession(page);
		const box = (await page.locator('.clip').boundingBox())!;
		const x=box.x+box.width*.8,y=box.y+box.height/2;
		await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
		await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-box.width*.6,y}]});
		await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
		expect(await page.locator('#translated').getAttribute('data-blocks-engine-capture-gallery-index')).toBe('1');
		await client.detach();
	},20_000,
);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))(
	'restores the same source nodes and nested scrollport pose after an offscreen gallery drive', async () => {
		const page = await sharedBrowser.newPage({viewport:{width:1440,height:900}});
		await page.setContent(fixture.replace('<section id="gallery">','<div id="scrollport" style="height:450px;overflow:auto"><div style="height:900px"></div><section id="gallery">').replace('</section>','</section></div>'));
		const scrollport = await page.locator('#scrollport').elementHandle();
		const before = await scrollport!.evaluate(node=>({x:node.scrollLeft,y:node.scrollTop,style:node.getAttribute('style')}));
		const viewport = page.viewportSize();
		const states = await captureGalleries(page);
		expect(states[0],JSON.stringify(states[0])).toMatchObject({status:'captured',gallery:{viewportRestoration:'verified',closed:true}});
		expect(await scrollport!.evaluate(node=>({x:node.scrollLeft,y:node.scrollTop,style:node.getAttribute('style')}))).toEqual(before);
		expect(await scrollport!.evaluate(node=>node===document.getElementById('scrollport'))).toBe(true);
		expect(page.viewportSize()).toEqual(viewport);
	}, 20_000,
);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))(
	'waits for an initialized lightbox stage to materialize before proving its complete cycle', async () => {
		const page = await sharedBrowser.newPage({viewport:{width:1440,height:900}});
		await page.setContent(fixture
			.replace('<script>', '<script>const deferred=[...document.querySelectorAll("#large .frame")].slice(1);deferred.forEach(node=>node.remove());')
			.replace("document.getElementById('overlay').classList.add('visible');", "document.getElementById('overlay').classList.add('visible');setTimeout(()=>{deferred.forEach(node=>document.getElementById('large').append(node));show(document.getElementById('large'),large,'large-count')},600);")
			.replace('</style>', 'html{scroll-behavior:smooth}#large{overflow:auto;max-height:65vh}#overlay button{position:fixed;top:70vh}#overlay [aria-label="Previous slide"]{left:20px}#overlay [aria-label="Next slide"]{right:20px}#overlay [aria-label="Close gallery"]{top:20px;right:20px}</style>'));
		const root = await page.locator('#overlay').elementHandle();
		const stage = await page.locator('#large').elementHandle();
		const states = await captureGalleries(page);
		expect(states[0],JSON.stringify(states[0])).toMatchObject({status:'captured',gallery:{inline:{coverage:'complete'},lightbox:{coverage:'complete',restoration:'verified'},closed:true,selection:[0,1,2],viewportRestoration:'verified'}});
		expect(await root!.evaluate(node=>node===document.getElementById('overlay'))).toBe(true);
		expect(await stage!.evaluate(node=>node===document.getElementById('large'))).toBe(true);
	}, 20_000,
);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))(
	'keeps a decoded mobile modal without directional controls as observed incomplete evidence', async () => {
		const page = await sharedBrowser.newPage({hasTouch:true,isMobile:true,viewport:{width:402,height:681}});
		await page.setContent(fixture.replace('<div id="overlay">','<div id="overlay" role="dialog" aria-modal="true">')
			.replace('aria-label="Next slide"','data-mobile-direction="next" style="display:none"')
			.replace('aria-label="Previous slide"','data-mobile-direction="previous" style="display:none"')
			.replace('aria-label="Close gallery"','data-mobile-direction="close" style="display:none"')
			.replaceAll('[aria-label="Next slide"]','[data-mobile-direction="next"]')
			.replaceAll('[aria-label="Previous slide"]','[data-mobile-direction="previous"]')
			.replaceAll('[aria-label="Close gallery"]','[data-mobile-direction="close"]')
			.replace('<script>', '<script>document.addEventListener("keydown",event=>{if(event.key==="Escape")document.getElementById("overlay").classList.remove("visible")});'));
		const states = await captureGalleries(page);
		expect(states[0]).toMatchObject({status:'observed-incomplete',dialog:{ariaModal:true,htmlTruncated:false},gallery:{inline:{coverage:'complete'},closed:true}});
		expect(states[0]?.dialog?.html).toContain('id="overlay"');
		expect(states[0]?.error).toContain('directional');
		expect(states[0]?.gallery?.lightbox?.coverage).not.toBe('complete');
	}, 20_000,
);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))(
	'retains a decoded lightbox cycle when its inverse control starts outside the viewport', async () => {
		const page = await sharedBrowser.newPage({viewport:{width:1440,height:900}});
		await page.setContent(fixture.replace("large=(large+1)%3;show", "document.querySelector('[aria-label=\"Previous slide\"]').style.cssText='position:fixed;top:-200vh';large=(large+1)%3;show"));
		const states = await captureGalleries(page);
		expect(states[0]).toMatchObject({status:'captured',gallery:{inline:{coverage:'complete'},lightbox:{coverage:'complete',restoration:'verified'},closed:true},dialog:{htmlTruncated:false}});
		expect(wireCapturedDialogs(fixture,states)).toContain('data-blocks-engine-capture-dialog-panel');
	}, 20_000,
);


it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))('captures a bounded src-swap cycle in order', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		const colors = ['red', 'green', 'blue'];
		await page.setContent(`<!doctype html><section id="swap"><div aria-label="Image gallery carousel"><div id="stage">${colors.slice(0, 3).map((_, i) => `<img src="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><rect width="30" height="30" fill="${colors[i]}"/></svg>`)}">`).join('')}</div></div><button aria-label="Previous picture">Previous</button><button aria-label="Next picture">Next</button></section><script>let n=0;const urls=[...document.querySelectorAll('#stage img')].map(x=>x.src);function update(){document.querySelectorAll('#stage img').forEach((x,i)=>x.src=urls[(n+i)%3])}document.querySelector('[aria-label="Next picture"]').onclick=()=>{n=(n+1)%3;update()};document.querySelector('[aria-label="Previous picture"]').onclick=()=>{n=(n+2)%3;update()}</script>`);
		const states = await captureGalleries(page);
		expect(states[0]?.gallery?.inline.coverage).toBe('complete');
		expect(states[0]?.gallery?.inline.frames).toHaveLength(3);
	} finally { await browser.close(); }
}, 60_000);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))('rejects a src-swap cycle that skips the same frame in both directions', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		const colors = ['red', 'green', 'blue', 'yellow'];
		await page.setContent(`<!doctype html><section id="swap"><div aria-label="Image gallery carousel"><div id="stage">${colors.map((color, i) => `<img src="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><rect width="30" height="30" fill="${color}"/></svg>`)}">`).join('')}</div></div><button aria-label="Previous picture">Previous</button><button aria-label="Next picture">Next</button></section><script>
		let n=0;const urls=[...document.querySelectorAll('#stage img')].map(x=>x.src);function update(){document.querySelectorAll('#stage img').forEach((x,i)=>x.src=urls[(n+i)%4])}
		document.querySelector('[aria-label="Next picture"]').onclick=()=>{n=(n+2)%4;update()};document.querySelector('[aria-label="Previous picture"]').onclick=()=>{n=(n+2)%4;update()};</script>`);
		const gallery = (await captureGalleries(page))[0]?.gallery?.inline;
		expect(gallery).toMatchObject({ coverage: 'partial', restoration: 'unverified', failure: 'Adjacent src-swap frames do not preserve overlapping slot continuity' });
		expect(gallery?.frames).toHaveLength(2);
	} finally { await browser.close(); }
}, 60_000);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))('retries gallery actions ignored during the source transition lock', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.setContent(`<!doctype html><section id="locked"><div id="stage">${[0,1,2,3,4].map(i => `<img width="80" height="80" src="${image(i)}">`).join('')}</div><button aria-label="Previous picture">Previous</button><button aria-label="Next picture">Next</button></section><script>
		let index=0,locked=false;const urls=Array.from(document.querySelectorAll('#stage img'),img=>img.src);
		function change(dir){if(locked)return;locked=true;index=(index+dir+5)%5;setTimeout(()=>{document.querySelectorAll('#stage img').forEach((img,slot)=>img.src=urls[(index+slot)%5]);setTimeout(()=>locked=false,300);},150);}
		document.querySelector('[aria-label="Next picture"]').onclick=()=>change(1);document.querySelector('[aria-label="Previous picture"]').onclick=()=>change(-1);
		</script>`);
		const states = await captureGalleries(page);
		expect(states[0]?.gallery?.inline).toMatchObject({ coverage: 'complete', restoration: 'verified' });
		expect(states[0]?.gallery?.inline.frames).toHaveLength(5);
	} finally { await browser.close(); }
}, 90_000);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))('does not retry a click whose gallery mutation is delayed', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.setContent(`<!doctype html><section id="delayed"><div id="stage">${[0,1,2].map(i => `<img width="80" height="80" src="${image(i)}">`).join('')}</div><button aria-label="Previous picture">Previous</button><button aria-label="Next picture">Next</button></section><script>
		let index=0;const urls=Array.from(document.querySelectorAll('#stage img'),img=>img.src);
		function change(dir){setTimeout(()=>{index=(index+dir+3)%3;document.querySelectorAll('#stage img').forEach((img,slot)=>img.src=urls[(index+slot)%3])},600)}
		document.querySelector('[aria-label="Next picture"]').onclick=()=>change(1);document.querySelector('[aria-label="Previous picture"]').onclick=()=>change(-1);
		</script>`);
		const states = await captureGalleries(page);
		expect(states[0]?.gallery?.inline).toMatchObject({ coverage: 'complete', restoration: 'verified' });
		expect(states[0]?.gallery?.inline.frames).toHaveLength(3);
	} finally { await browser.close(); }
}, 90_000);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))(
	'proves a three-frame directional cycle in at most 2N+1 clicks', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.setContent(fixture.replace("document.getElementById('overlay').classList.add('visible');", ''));
			await page.evaluate(() => {
				(globalThis as typeof globalThis & { galleryClicks?: number }).galleryClicks = 0;
				document.querySelectorAll('#gallery button,#gallery [role="button"]').forEach(control =>
					control.addEventListener('click', () => {
						(globalThis as typeof globalThis & { galleryClicks?: number }).galleryClicks!++;
					}, true),
				);
			});
			const states = await captureGalleries(page);
		expect(states[0]?.gallery?.inline).toMatchObject({ coverage: 'complete', restoration: 'verified' });
		expect(states[0]?.gallery?.inline.frames).toHaveLength(3);
			expect(await page.evaluate(() => (globalThis as typeof globalThis & { galleryClicks?: number }).galleryClicks)).toBeLessThanOrEqual(7);
		} finally {
			await browser.close();
		}
	}, 30_000,
);

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
				expect(await offline.locator('[data-blocks-engine-capture-dialog-panel] img').count()).toBe(3);
				for (const expected of ['2 / 3', '3 / 3', '1 / 3']) {
					await offline.getByRole('button', { name: 'Next image', exact: true }).click();
					expect(await offline.locator('#count').textContent()).toBe(expected);
					expect(await offline.locator('#stage img:visible').count()).toBe(1);
					expect(await offline.locator('#stage img:visible').getAttribute('src')).toBe(image(Number(expected[0])-1));
				}
				await offline.getByRole('button', { name: 'Previous image', exact: true }).click();
				expect(await offline.locator('#count').textContent()).toBe('3 / 3');
				await offline.locator('#stage img:visible').click();
				expect(await offline.locator('[data-blocks-engine-capture-dialog-panel]').isVisible()).toBe(true);
				expect(await offline.locator('[data-blocks-engine-capture-dialog-panel]').evaluate(el=>{const rect=el.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};})).toEqual({x:0,y:0,width,height:900});
				expect(await offline.locator('#large-count').textContent()).toBe('3 / 3');
				expect(await offline.locator('[data-blocks-engine-capture-dialog-panel] img:visible').count()).toBe(1);
				await offline.getByRole('button', { name: 'Next slide', exact: true }).click();
				expect(await offline.locator('#large-count').textContent()).toBe('1 / 3');
				expect(await offline.locator('[data-blocks-engine-capture-dialog-panel] img:visible').count()).toBe(1);
				expect(await offline.locator('[data-blocks-engine-capture-dialog-panel] img:visible').getAttribute('src')).toBe(image(0,true));
				await offline.getByRole('button', { name: 'Previous slide', exact: true }).click();
				expect(await offline.locator('#large-count').textContent()).toBe('3 / 3');
				await offline.getByRole('button', { name: 'Close gallery', exact: true }).click();
				expect(await offline.locator('[data-blocks-engine-capture-dialog-panel]').isVisible()).toBe(false);
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
			).not.toContain('data-blocks-engine-capture-gallery-runtime');
		} finally {
			await browser.close();
		}
	},
	30_000,
);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))('waits for a delayed rendered initial frame without inventing its identity',async()=>{
	const browser=await chromium.launch();
	try{
		const page=await browser.newPage();
		await page.setContent(fixture.replace('<script>','<script>document.querySelector("#stage .chosen").classList.remove("chosen");setTimeout(()=>document.querySelector("#stage .frame").classList.add("chosen"),350);'));
		const states=await captureGalleries(page);
		expect(states[0]).toMatchObject({status:'captured',gallery:{inline:{initial:0,coverage:'complete',restoration:'verified'}}});
	}finally{await browser.close();}
},15_000);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS)||!existsSync(chromium.executablePath()))('retains gallery evidence through real dual-viewport capture, export and offline replay',async()=>{
	const parent=join(process.cwd(),'.tmp-test');mkdirSync(parent,{recursive:true});
	const outputDir=mkdtempSync(join(parent,'gallery-pipeline-'));
	const server=createServer((_,response)=>{response.writeHead(200,{'Content-Type':'text/html'});response.end(fixture);});
	await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
	const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
	const browser=await chromium.launch();
	try{
		await captureScreenshots({urls:[url],outputDir,concurrency:1,settleMs:100,captureImages:true,beforeSerialize:async page=>{await page.evaluate(()=>{document.getElementById('overlay')!.remove();(document.querySelector('[aria-label="Next image"]') as HTMLElement).click();});},viewports:[{id:'desktop',width:1440,height:900},{id:'mobile',width:390,height:900}]});
		const manifest=JSON.parse(readFileSync(join(outputDir,'screenshots','manifest.json'),'utf8'));
		const galleries=manifest.entries[url].interactions.states.filter((state:{kind:string})=>state.kind==='gallery');
		expect(galleries).toHaveLength(2);
		expect(galleries[0]).toMatchObject({status:'captured',gallery:{inline:{coverage:'complete',initial:1},lightbox:{coverage:'complete'},closed:true}});
		exportWebsiteCapture({outputDir,sourceUrl:url,platform:'default',summary:{},failures:[]});
		const portable=readFileSync(join(outputDir,'website','index.html'),'utf8');
		for(const width of [390,768,1440]){
			const page=await browser.newPage({viewport:{width,height:900}});
			await page.route('**/*',route=>route.abort());await page.setContent(portable);
			await page.getByRole('button',{name:'Next image',exact:true}).click();
			expect(await page.locator('#count').textContent()).toBe('3 / 3');
			await page.locator('#stage img:visible').click();
			expect(await page.locator('[data-blocks-engine-capture-dialog-panel]').isVisible()).toBe(true);
			await page.getByRole('button',{name:'Next slide',exact:true}).click();
			expect(await page.locator('#large-count').textContent()).toBe('1 / 3');
			await page.getByRole('button',{name:'Close gallery',exact:true}).click();
			expect(await page.locator('[data-blocks-engine-capture-dialog-panel]').isVisible()).toBe(false);
			await page.close();
		}
	}finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(outputDir,{recursive:true,force:true});}
},180_000);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))(
	'retains decoded responsive inline cycles when no lightbox opens', async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage({viewport:{width:390,height:900}});
			const responsive = fixture.replace(/<img src="([^"]+)"/g, '<img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" srcset="$1 1x"')
				.replace("document.getElementById('overlay').classList.add('visible');", '');
			await page.setContent(responsive);
			const baseline = await page.content();
			const states = await captureGalleries(page);
			expect(states[0]).toMatchObject({status:'no-dialog',gallery:{inline:{coverage:'complete',restoration:'verified'}}});
			const html = wireCapturedDialogs(baseline.replace(/<script>[\s\S]*?<\/script>/g,''), states);
			await page.setContent(html);
			for(const ordinal of [2,3,1]) {
				await page.getByRole('button',{name:'Next image',exact:true}).click();
				expect(await page.locator('#count').textContent()).toBe(`${ordinal} / 3`);
				expect(await page.locator('#stage img:visible').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(200);
			}
			expect(wireCapturedDialogs(html,states).match(/data-blocks-engine-capture-gallery-runtime/g)).toHaveLength(1);
		} finally { await browser.close(); }
	}, 20_000,
);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath()))('activates an image-opened lightbox through the source touch contract',async()=>{
	const browser=await chromium.launch();
	try{
		const page=await browser.newPage({hasTouch:true,isMobile:true,viewport:{width:390,height:900}});
		await page.setContent(fixture.replace('node.onclick=()=>{large=i;', "node.addEventListener('touchend',()=>{large=i;").replace("document.getElementById('overlay').classList.add('visible');});", "document.getElementById('overlay').classList.add('visible');}));"));
		expect(await captureGalleries(page)).toMatchObject([{status:'captured',gallery:{closed:true,selection:[0,1,2]}}]);
	}finally{await browser.close();}
},20_000);

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
