import { resolveInteractionComponents, type ComponentPage } from '../captured-interactions.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { it } from '../../../test/browser.js';
import { probeExclusionSkip } from './probe-exclusions.js';
import { captureCollections, collectionRegions } from './collection-capture.js';
import { captureWebsite } from '../../index.js';
import type { InteractionStatesReport } from './interaction-capture.js';
import { wireCapturedComponents } from '../static-components.js';

// ~55 seconds including one public pipeline run. Files and HTTP parsing are real.
it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('captures deterministic paginated membership, search, reset, empty and static filters', async ({ serve, newContext }) => {
	const parent = join(process.cwd(), '.tmp-test'); mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, 'collections-'));
	const source = `<!doctype html><html><head></head><body><main><section id="archive"><button id="filters" onclick="document.querySelector('#filter-panel').hidden=false">Filters</button><div id="filter-panel"><input id="search" type="search"><select id="category"><option value="">All</option><option>Even</option><option>Odd</option></select></div><div id="cards"></div><button id="previous">Previous</button><button id="next">Next</button><button id="subscribe" onclick="fetch('/subscribe',{method:'POST'})">Subscribe</button></section><section id="portfolio"><button id="all">All</button><button id="decks">Decks</button><button id="bathrooms">Bathrooms</button><div id="projects"><article data-category="Decks"><a href="/deck">Deck</a></article><article data-category="Bathrooms"><a href="/bathroom">Bathroom</a></article></div></section></main><script>
if(innerWidth<600)document.querySelector('#filter-panel').hidden=true;let offset=0;const search=document.querySelector('#search'),category=document.querySelector('#category');function render(){const items=Array.from({length:16},(_,i)=>({id:i,text:'Record '+i,category:i%2?'Odd':'Even'})).filter(item=>(!category.value||item.category===category.value)&&item.text.toLowerCase().includes(search.value.toLowerCase()));document.querySelector('#cards').innerHTML=items.slice(offset,offset+12).map(item=>'<article><a href="/record/'+item.id+'">'+item.text+'</a></article>').join('');document.querySelector('#next').disabled=offset+12>=items.length;document.querySelector('#previous').disabled=!offset;}search.oninput=category.onchange=()=>{offset=0;render()};document.querySelector('#next').onclick=()=>{offset+=12;render()};document.querySelector('#previous').onclick=()=>{offset-=12;render()};render();for(const button of document.querySelectorAll('#portfolio button'))button.onclick=()=>{for(const card of document.querySelector('#projects').children)card.hidden=button.id!=='all'&&card.dataset.category!==button.textContent};</script></body></html>`;
	writeFileSync(join(root, 'source.html'), source);
	const unsafe: string[] = [];
	const { server } = await serve((request, response) => { if (request.url?.includes('liberation-absent-')) {response.writeHead(404); response.end(); return;} if (request.method !== 'GET') unsafe.push(`${request.method} ${request.url}`); response.setHeader('Content-Type', 'text/html'); response.end(request.url === '/' ? readFileSync(join(root, 'source.html')) : '<!doctype html><html><body><main><h1>Record detail</h1></main></body></html>'); });

	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

	try {
		const context = await newContext(); const page = await context.newPage(); await page.goto(url);
		const blocked: string[] = [];
		const components = await captureCollections(page, undefined, diagnostic => blocked.push(diagnostic.reason));
		expect(unsafe).toEqual([]);
		expect(blocked).toContain('POST /subscribe blocked during collection probing');
		const archive = components.find(component => component.selector === '#cards')!.collection!;
		expect(archive.members.map(member => member.url)).toEqual(Array.from({ length: 16 }, (_,i) => `${url}record/${i}`));
		expect(new Set(archive.members.map(member => member.key)).size).toBe(16);
		const even = archive.states.find(state => state.trigger?.value === 'Even')!;
		const recordKey = (index: number) => archive.members.find(member => member.url === `${url}record/${index}`)!.key;
		expect(even.members).toEqual(Array.from({ length: 8 }, (_,i) => recordKey(i*2)));
		expect(archive.states.find(state => state.trigger?.value === '__capture_no_matching_record__')?.members).toEqual([]);
		expect(archive.states.find(state => state.trigger?.selector === '#search' && state.trigger.value === '')?.members).toHaveLength(16);
		const portfolio = components.find(component => component.selector === '#projects')!.collection!;
		expect(portfolio.states.find(state => state.trigger?.selector === '#decks')?.members).toEqual([portfolio.members.find(member => member.url === `${url}deck`)!.key]);
		expect(portfolio.states.find(state => state.trigger?.selector === '#bathrooms')?.members).toEqual([portfolio.members.find(member => member.url === `${url}bathroom`)!.key]);
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
		const reports = resolveInteractionComponents(JSON.parse(readFileSync(join(output, 'interaction-states.json'), 'utf8')) as { pages: Array<Omit<InteractionStatesReport, 'components'> & ComponentPage> });
		expect(reports.pages.find(report => report.sourceUrl === url)?.components?.find(node => node.selector === '#cards')?.collection?.members).toHaveLength(16);
		const receipt = JSON.parse(readFileSync(join(output, 'capture-receipt.json'), 'utf8'));
		for (let index = 0; index < 16; index++) {
			expect(JSON.stringify(receipt)).toContain(`${url}record/${index}`);
			expect(existsSync(join(output, 'website', 'record', String(index), 'index.html'))).toBe(true);
		}
	} finally {   rmSync(root, { recursive: true, force: true }); }
}, 180_000);

// Each reduced article should take milliseconds, not the 15-second navigation timeout.
it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS)).for([false, true])('ignores article actions without probing (beacon: %s)', { timeout: 20_000 }, async (beacon, { serve, newContext }) => {
	const source = `<!doctype html><html><head><title>Post</title></head><body><main><article>
<div id="content-wrapper">
  <div><p>Read the <a href="/guide">walking guide</a> first.</p></div>
  <div><p>Then see <a href="/rspca">RSPCA advice</a>.</p><button aria-label="Expand image">⤢</button></div>
</div>
<div><button aria-label="Share via link">Share</button><button aria-label="Like post">♥</button></div>
</article></main>${beacon ? "<script>setInterval(()=>fetch('/beacon?'+Date.now()),400)</script>" : ''}</body></html>`;
	const { server } = await serve((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(source); });

	{
		const context = await newContext();
		const page = await context.newPage();
		await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`, { waitUntil: 'load' });
		const started = performance.now();
		const components = await captureCollections(page);
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(components).toEqual([]);
	}
});

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('does not treat a probe-excluded control as a collection control', async ({ newPage }) => {

	{
		const page = await newPage();
		await page.setContent('<main><div id="column"><div><a href="/a">Tab A</a></div><div><a href="/one">Story one</a></div></div><button class="scroll">›</button></main>');
		expect(await collectionRegions(page)).toHaveLength(1);
		const skip = probeExclusionSkip([{ id: 'scroll', selector: 'button.scroll', reason: 'runtime scroller' }]);
		expect(await collectionRegions(page, skip)).toEqual([]);
	}
});

// A consent dialog hidden in place after dismissal, and never rendered once consent is stored, is not a collection.
it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('skips lists inside a dismissed consent dialog without waiting on them', async ({ serve, newContext }) => {
	const source = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Consent collections</title><style>#consent{position:fixed;inset:auto 0 0 0;background:#fff;padding:1rem}</style></head><body>
<main><h1>Welcome</h1><p>A short paragraph of page content.</p></main>
<script>
if (!document.cookie.includes('consent=')) {
  const dialog = document.createElement('div');
  dialog.id = 'consent'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-label', 'Cookie consent');
  dialog.innerHTML = '<p>This website uses cookies.</p><div class="detail"><button type="button">Details</button><ul id="consent-vendors"><li><a href="/privacy#a">Analytics vendor</a></li><li><a href="/privacy#b">Marketing vendor</a></li><li><a href="/privacy#c">Video vendor</a></li></ul></div><button type="button" id="consent-decline">Decline</button> <button type="button" id="consent-accept">Accept all</button>';
  document.body.prepend(dialog);
  for (const button of dialog.querySelectorAll('#consent-decline,#consent-accept')) button.addEventListener('click', () => { document.cookie = 'consent=' + button.id + '; path=/'; dialog.style.display = 'none'; });
}
</script></body></html>`;
	const { server } = await serve((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(source); });

	{
		const page = await (await newContext()).newPage();
		await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`, { waitUntil: 'load' });
		await page.click('#consent-accept');
		expect(await collectionRegions(page)).toEqual([]);
		const started = performance.now();
		expect(await captureCollections(page)).toEqual([]);
		expect(performance.now() - started).toBeLessThan(2_000);
	}
}, 45_000);

// ~15 seconds: reduced from a revealed hero whose two columns link to the same detail page.
// Motion, media, nested sections and all other controls can be removed without curing the loss.
it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('preserves distinct columns sharing a link through the public capture interface', async ({ serve }) => {
	const parent = join(process.cwd(), '.tmp-test'); mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, 'shared-link-columns-'));
	const source = readFileSync(new URL('./fixtures/shared-link-columns.html', import.meta.url), 'utf8');
	const { server } = await serve((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(source); });

	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	try {
		const captured = await captureWebsite({ url, outputDir: root, captureImages: false, trustedOrigins: [url], learnFluid: false }, {
			findAdapter: () => ({ id: 'default', detect: () => true, discover: async () => ({ urls: [{ url }] }) }),
		});
		expect(captured.summary.routesFailed).toBe(0);
		const output = readFileSync(join(root, 'website', 'index.html'), 'utf8');
		expect(output).toContain('id="visual"');
		expect(output).toContain('Explore</a>');
		expect(output).toContain('Featured</a>');
		// An unrelated control must not turn an unchanged pair into a collection.
		expect(existsSync(join(root, 'interaction-states.json'))).toBe(false);
	} finally {  rmSync(root, { recursive: true, force: true }); }
}, 90_000);

// ~5 seconds per case: one browser, injected Playwright failure and a genuinely hidden control.
it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS)).for([1, 2])('isolates control failures after a fresh-document retry (%s failures)', { timeout: 30_000 }, async (failures, { serve, newContext }) => {
	const source = `<!doctype html><html><body><main><section>
<button id="broken">Submit</button><button id="hidden" hidden>Menu</button>
<select id="filter" onchange="document.querySelector('#b').hidden=this.value==='a'"><option value="all">All</option><option value="a">A</option></select>
<div id="cards"><article><a href="/a">A</a></article><article id="b"><a href="/b">B</a></article></div>
</section></main></body></html>`;
	let documents = 0;
	const { server } = await serve((request, response) => { if (request.url === '/') documents++; response.setHeader('Content-Type', 'text/html'); response.end(source); });

	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

	{
		const page = await (await newContext()).newPage();
		await page.goto(url);
		const context = page.context();
		const newPage = context.newPage.bind(context);
		let clicks = 0;
		const clickDocuments: number[] = [];
		vi.spyOn(context, 'newPage').mockImplementation(async () => {
			const probe = await newPage();
			const locator = probe.locator.bind(probe);
			vi.spyOn(probe, 'locator').mockImplementation((selector, options) => {
				const target = locator(selector, options);
				if (selector === '#broken') vi.spyOn(target, 'click').mockImplementation(async () => {
					clickDocuments.push(documents);
					if (++clicks <= failures) throw new Error('fixture click failed');
				});
				return target;
			});
			return probe;
		});
		const [component] = await captureCollections(page);
		const evidence = component.collection!;
		expect(clicks).toBe(2);
		expect(clickDocuments[1]).toBe(clickDocuments[0] + 1);
		expect(evidence.coverage).toBe('complete');
		expect(component.status).toBe('captured');
		expect(evidence.members).toHaveLength(2);
		expect(evidence.failedControls).toEqual(failures === 2 ? ['#broken', '#hidden'] : ['#hidden']);
		expect(evidence.states.filter(state => state.trigger?.selector === '#broken')).toHaveLength(failures === 2 ? 0 : 1);
		expect(evidence.states.filter(state => state.trigger?.selector === '#filter').map(state => [state.trigger?.value, state.members.length])).toEqual([['all', 2], ['a', 1]]);
	}
});
