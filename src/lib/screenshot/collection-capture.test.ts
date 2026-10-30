import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { probeExclusionSkip } from './probe-exclusions.js';
import { captureCollections, collectionRegions } from './collection-capture.js';
import { captureWebsite } from '../../index.js';
import type { InteractionStatesReport } from './interaction-capture.js';
import { wireCapturedComponents } from '../static-components.js';

// ~55 seconds including one public pipeline run. Files and HTTP parsing are real.
it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('captures deterministic paginated membership, search, reset, empty and static filters', async () => {
	const parent = join(process.cwd(), '.tmp-test'); mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, 'collections-'));
	const source = `<!doctype html><html><head></head><body><main><section id="archive"><button id="filters" onclick="document.querySelector('#filter-panel').hidden=false">Filters</button><div id="filter-panel"><input id="search" type="search"><select id="category"><option value="">All</option><option>Even</option><option>Odd</option></select></div><div id="cards"></div><button id="previous">Previous</button><button id="next">Next</button><button id="subscribe" onclick="fetch('/subscribe',{method:'POST'})">Subscribe</button></section><section id="portfolio"><button id="all">All</button><button id="decks">Decks</button><button id="bathrooms">Bathrooms</button><div id="projects"><article data-category="Decks"><a href="/deck">Deck</a></article><article data-category="Bathrooms"><a href="/bathroom">Bathroom</a></article></div></section></main><script>
if(innerWidth<600)document.querySelector('#filter-panel').hidden=true;let offset=0;const search=document.querySelector('#search'),category=document.querySelector('#category');function render(){const items=Array.from({length:16},(_,i)=>({id:i,text:'Record '+i,category:i%2?'Odd':'Even'})).filter(item=>(!category.value||item.category===category.value)&&item.text.toLowerCase().includes(search.value.toLowerCase()));document.querySelector('#cards').innerHTML=items.slice(offset,offset+12).map(item=>'<article><a href="/record/'+item.id+'">'+item.text+'</a></article>').join('');document.querySelector('#next').disabled=offset+12>=items.length;document.querySelector('#previous').disabled=!offset;}search.oninput=category.onchange=()=>{offset=0;render()};document.querySelector('#next').onclick=()=>{offset+=12;render()};document.querySelector('#previous').onclick=()=>{offset-=12;render()};render();for(const button of document.querySelectorAll('#portfolio button'))button.onclick=()=>{for(const card of document.querySelector('#projects').children)card.hidden=button.id!=='all'&&card.dataset.category!==button.textContent};</script></body></html>`;
	writeFileSync(join(root, 'source.html'), source);
	const unsafe: string[] = [];
	const server = createServer((request, response) => { if (request.method !== 'GET') unsafe.push(`${request.method} ${request.url}`); response.setHeader('Content-Type', 'text/html'); response.end(request.url === '/' ? readFileSync(join(root, 'source.html')) : '<!doctype html><html><body><main><h1>Record detail</h1></main></body></html>'); });
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	const browser = await chromium.launch();
	try {
		const context = await browser.newContext(); const page = await context.newPage(); await page.goto(url);
		const blocked: string[] = [];
		const components = await captureCollections(page, undefined, diagnostic => blocked.push(diagnostic.reason));
		expect(unsafe).toEqual([]);
		expect(blocked).toContain('POST /subscribe blocked during collection probing');
		const archive = components.find(component => component.selector === '#cards')!.collection!;
		expect(archive.members.map(member => member.url)).toEqual(Array.from({ length: 16 }, (_,i) => `${url}record/${i}`));
		expect(new Set(archive.members.map(member => member.key)).size).toBe(16);
		const even = archive.states.find(state => state.trigger?.value === 'Even')!;
		expect(even.members).toEqual(Array.from({ length: 8 }, (_,i) => `${url}record/${i*2}`));
		expect(archive.states.find(state => state.trigger?.value === '__capture_no_matching_record__')?.members).toEqual([]);
		expect(archive.states.find(state => state.trigger?.selector === '#search' && state.trigger.value === '')?.members).toHaveLength(16);
		const portfolio = components.find(component => component.selector === '#projects')!.collection!;
		expect(portfolio.states.find(state => state.trigger?.selector === '#decks')?.members).toEqual([`${url}deck`]);
		expect(portfolio.states.find(state => state.trigger?.selector === '#bathrooms')?.members).toEqual([`${url}bathroom`]);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.reload();
		const second = await captureCollections(page);
		expect(second.map(node => node.collection)).toEqual(components.map(node => node.collection));
		writeFileSync(join(root, 'copy.html'), wireCapturedComponents(source, components));
		await page.setContent(readFileSync(join(root, 'copy.html'), 'utf8').replace(/<script>[\s\S]*?<\/script>/g, ''));
		expect(await page.locator('#cards > article').count()).toBe(16);
		expect(await page.locator('#next').getAttribute('data-blocks-engine-capture-unsupported')).toBe('collection');
		const output = join(root, 'capture');
		const captured = await captureWebsite({ url, outputDir: output, captureImages: false, trustedOrigins: [url], learnFluid: false }, {
			findAdapter: () => ({ id: 'collections', detect: () => true, discover: async () => ({ urls: [{ url }] }) }),
		});
		expect(captured.summary.routesFailed).toBe(0);
		const reports = JSON.parse(readFileSync(join(output, 'interaction-states.json'), 'utf8')) as { pages: InteractionStatesReport[] };
		expect(reports.pages.find(report => report.sourceUrl === url)?.components?.find(node => node.selector === '#cards')?.collection?.members).toHaveLength(16);
		const receipt = JSON.parse(readFileSync(join(output, 'capture-receipt.json'), 'utf8'));
		for (let index = 0; index < 16; index++) {
			expect(JSON.stringify(receipt)).toContain(`${url}record/${index}`);
			expect(existsSync(join(output, 'website', 'record', String(index), 'index.html'))).toBe(true);
		}
	} finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
}, 180_000);

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('does not treat a probe-excluded control as a collection control', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.setContent('<main><div id="column"><div><a href="/a">Tab A</a></div><div><a href="/one">Story one</a></div></div><button class="scroll">›</button></main>');
		expect(await collectionRegions(page)).toHaveLength(1);
		const skip = probeExclusionSkip([{ id: 'scroll', selector: 'button.scroll', reason: 'runtime scroller' }]);
		expect(await collectionRegions(page, skip)).toEqual([]);
	} finally { await browser.close(); }
});
