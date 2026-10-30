import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { load } from 'cheerio';
import { expect, it } from 'vitest';
import { captureScreenshots } from './screenshotter.js';

const skip = Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath());

it.skipIf(skip)('serializes identical settled chrome across route lengths, framework counters and repeat captures', async () => {
	const server = createServer((request, response) => {
		const counter = request.url === '/long' ? 71 : 3;
		response.setHeader('content-type', 'text/html');
		response.end(`<!doctype html><html><head><style>
		body{margin:0}header{height:80px}main{height:${counter === 71 ? 2400 : 700}px}
		@keyframes entrance{from{opacity:0;transform:translateX(-40px)}to{opacity:1;transform:translateX(0)}}
		header{animation:entrance 60s linear both}header.scrolled{background:red}
		</style></head><body><header>
		<label id=":r${counter}:" for="headlessui-input-${counter}">Search</label>
		<input id="headlessui-input-${counter}" aria-labelledby=":r${counter}:" aria-describedby="radix-:r${counter}:" list="headlessui-list-${counter}">
		<span id="radix-:r${counter}:">Help</span><datalist id="headlessui-list-${counter}"><option value="One"></datalist>
		<a href="#radix-:r${counter}:">Help link</a><button aria-controls="headlessui-list-${counter}">Choices</button>
		</header><main>Page</main><script>
		addEventListener('scroll',()=>document.querySelector('header').classList.toggle('scrolled',scrollY>2));
		</script></body></html>`);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
	mkdirSync('.tmp-test', { recursive:true });
	const dir = mkdtempSync(join(process.cwd(), '.tmp-test', 'capture-state-'));
	const headers: string[] = [];
	try {
		for (let run = 0; run < 2; run++) {
			const outputDir = join(dir, String(run));
			const result = await captureScreenshots({ urls:[`${base}/short`, `${base}/long`], outputDir, concurrency:1, settleMs:0,
				viewports:[{id:'desktop',width:1024,height:600}], learnFluid:false,
				// Adapter preparation reproduces the offscreen-control pose left by a sweep.
				prepareCapture: async page => { await page.evaluate(() => window.scrollTo({top:300,behavior:'instant'})); },
			});
			expect(result).toMatchObject({captured:2,failed:0});
			for (const file of readdirSync(join(outputDir, 'html'))) {
				const $ = load(readFileSync(join(outputDir, 'html', file), 'utf8'));
				expect($('header').hasClass('scrolled')).toBe(false);
				// Motion is read at a fixed point, never baked into inline styles.
				expect($('header').attr('style')).toBeUndefined();
				for (const name of ['aria-controls','aria-labelledby','aria-describedby','for','list','href']) {
					$(`header [${name}]`).each((_, node) => {
						const value = $(node).attr(name)!;
						for (const id of (name === 'href' ? value.slice(1) : value).split(/\s+/)) {
							expect($('[id]').filter((_, target) => $(target).attr('id') === id).length).toBe(1);
						}
					});
				}
				headers.push($.html('header'));
			}
		}
		expect(headers).toHaveLength(4);
		expect(new Set(headers).size).toBe(1);
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(dir, { recursive:true,force:true });
	}
}, 120_000);
