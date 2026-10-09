import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium as playwrightChromium } from 'playwright';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { captureGalleries } from './gallery-capture.js';
import { captureTriggeredDialogs } from './interaction-capture.js';
import { wireCapturedDialogs } from '../static-dialogs.js';
import { captureScreenshots } from './screenshotter.js';
import { exportWebsiteCapture } from '../capture-export.js';

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
					expect(await offline.locator('#stage img:visible').count()).toBe(1);
					expect(await offline.locator('#stage img:visible').getAttribute('src')).toBe(image(Number(expected[0])-1));
				}
				await offline.getByRole('button', { name: 'Previous image', exact: true }).click();
				expect(await offline.locator('#count').textContent()).toBe('3 / 3');
				await offline.locator('#stage img:visible').click();
				expect(await offline.locator('[data-dla-dialog-panel]').isVisible()).toBe(true);
				expect(await offline.locator('[data-dla-dialog-panel]').evaluate(el=>{const rect=el.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};})).toEqual({x:0,y:0,width,height:900});
				expect(await offline.locator('#large-count').textContent()).toBe('3 / 3');
				expect(await offline.locator('[data-dla-dialog-panel] img:visible').count()).toBe(1);
				await offline.getByRole('button', { name: 'Next slide', exact: true }).click();
				expect(await offline.locator('#large-count').textContent()).toBe('1 / 3');
				expect(await offline.locator('[data-dla-dialog-panel] img:visible').count()).toBe(1);
				expect(await offline.locator('[data-dla-dialog-panel] img:visible').getAttribute('src')).toBe(image(0,true));
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
			expect(await page.locator('[data-dla-dialog-panel]').isVisible()).toBe(true);
			await page.getByRole('button',{name:'Next slide',exact:true}).click();
			expect(await page.locator('#large-count').textContent()).toBe('1 / 3');
			await page.getByRole('button',{name:'Close gallery',exact:true}).click();
			expect(await page.locator('[data-dla-dialog-panel]').isVisible()).toBe(false);
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
			expect(wireCapturedDialogs(html,states).match(/data-dla-gallery-runtime/g)).toHaveLength(1);
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
