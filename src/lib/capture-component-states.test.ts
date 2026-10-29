import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureWebsite } from '../index.js';
import { readResolvedPage } from './site-includes.js';
import type { InteractionStatesReport } from './screenshot/interaction-capture.js';

const source = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{padding:20px}button{padding:10px}[hidden]{display:none}</style></head><body><main>
<section id="tabs"><div role="tablist" id="tablist"><button id="first" role="tab" aria-selected="true" aria-controls="panel-first">First</button><button id="second" role="tab" aria-selected="false" aria-controls="panel-second">Second</button></div><div id="panel-first" role="tabpanel">Initially mounted</div></section>
<details id="disclosure" open><summary id="summary">Read details</summary><p>Initially open answer</p></details>
<section id="carousel" aria-roledescription="carousel"><div aria-roledescription="slide" id="slide-first">Initial slide</div><div aria-roledescription="slide" id="slide-second" hidden>Second slide</div><button id="previous">Previous</button><button id="next">Next</button></section>
</main><script>
for(const button of document.querySelectorAll('[role="tab"]'))button.onclick=()=>{for(const tab of document.querySelectorAll('[role="tab"]')){const active=tab===button;tab.setAttribute('aria-selected',String(active));document.getElementById(tab.getAttribute('aria-controls'))?.remove();if(active){const panel=document.createElement('div');panel.id=tab.getAttribute('aria-controls');panel.setAttribute('role','tabpanel');panel.textContent=tab.id==='first'?'Initially mounted':'Lazily mounted answer';document.querySelector('#tabs').append(panel);}}};
let slide=0;for(const button of document.querySelectorAll('#carousel button'))button.onclick=()=>{slide=1-slide;document.querySelectorAll('[aria-roledescription="slide"]').forEach((node,index)=>node.hidden=index!==slide);};
</script></body></html>`;

// One public pipeline pass, shared by all assertions (~15 seconds).
it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('captures the initial route before exploring lazy tabs, an open disclosure and a carousel', async () => {
	const parent = join(process.cwd(), '.tmp-test'); mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, 'component-states-'));
	let copy: string | undefined;
	const server = createServer((request, response) => {
		if (request.url === '/robots.txt') { response.end(''); return; }
		if (request.url?.includes('sitemap')) { response.statusCode = 404; response.end(); return; }
		response.setHeader('Content-Type', 'text/html'); response.end(copy ?? source);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage(); await page.goto(url);
		const pose = () => page.evaluate(() => ({ tab: document.querySelector('[role="tab"][aria-selected="true"]')?.id, disclosure: document.querySelector('details')?.open, slide: Array.from(document.querySelectorAll<HTMLElement>('[aria-roledescription="slide"]')).find(node => !node.hidden)?.id }));
		const before = await pose();
		const initialDom = await page.locator('main').evaluate(root => root.innerHTML);
		const result = await captureWebsite({ url, outputDir: root, captureImages: false, trustedOrigins: [url], learnFluid: false }, {
			findAdapter: () => ({ id: 'component-fixture', detect: () => true, discover: async () => ({ urls: [{ url }] }) }),
		});
		expect(result.summary.routesFailed).toBe(0);
		const evidence = JSON.parse(readFileSync(join(root, 'interaction-states.json'), 'utf8')) as { pages: InteractionStatesReport[] };
		const components = evidence.pages.find(page => page.sourceUrl === url)!.components!;
		expect(components.map(node => node.kind)).toEqual(['tabs', 'disclosure', 'carousel']);
		for (const [kind, initial, states, trigger] of [
			['tabs', 'tab-0', ['tab-0', 'tab-1'], '#second'],
			['disclosure', 'open', ['open', 'closed'], '#summary'],
			['carousel', 'slide-0', ['slide-0', 'slide-1'], '#next'],
		] as const) {
			const node = components.find(node => node.kind === kind)!;
			expect(node.initial).toBe(initial); expect(node.states.map(state => state.id)).toEqual(states);
			expect(node.transitions).toContainEqual(expect.objectContaining({ from: initial, trigger: { selector: trigger, action: 'click' } }));
		}
		expect(components[0].states.find(state => state.id === 'tab-1')?.html).toContain('Lazily mounted answer');
		copy = readResolvedPage(join(root, 'website'), join(root, 'website/index.html'));
		await page.goto(url); expect(await pose()).toEqual(before);
		// Remove only the newly materialized inactive panel and capture wiring.
		// The remaining route DOM must equal the source before any activation.
		const exportedInitialDom = await page.locator('main').evaluate(root => {
			const clone = root.cloneNode(true) as HTMLElement;
			clone.querySelector('#panel-second')?.remove();
			clone.querySelector('[data-blocks-engine-capture-tabs]')?.removeAttribute('data-blocks-engine-capture-tabs');
			return clone.innerHTML;
		});
		expect(exportedInitialDom).toBe(initialDom);
		expect(evidence.pages[0]).not.toHaveProperty('states');
		expect(evidence.pages[0]).not.toHaveProperty('initialDialogs');
		expect(await page.locator('#panel-first').textContent()).toBe('Initially mounted');
		await page.locator('#second').click(); expect(await page.locator('#panel-second').isVisible()).toBe(true);
		expect(await page.locator('#panel-second').textContent()).toBe('Lazily mounted answer');
		await page.locator('#next').click();
		expect(await pose()).toMatchObject({ slide: 'slide-second' });
		await page.locator('#next').click();
		expect(await pose()).toMatchObject({ slide: 'slide-first' });
	} finally {
		await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
	}
}, 180_000);
