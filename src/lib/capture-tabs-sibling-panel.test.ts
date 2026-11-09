import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureWebsite } from '../index.js';
import type { CapturedComponent } from './screenshot/component-states.js';

// #1617: tabs without aria-controls that re-render a sibling panel.
const source = `<!doctype html><html><head><meta charset="utf-8"><title>Tabs with re-rendered sibling panel</title></head><body><main>
<div class="tabs" role="tablist"><button role="tab" data-tab="a">Alpha</button><button role="tab" data-tab="b">Beta</button><button role="tab" data-tab="c">Gamma</button></div>
<div id="panel"></div></main>
<script>const data={a:'Alpha panel text',b:'Beta panel text',c:'Gamma panel text'};let s='a';
function render(){document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===s)));const p=document.getElementById('panel');p.replaceChildren();const h=document.createElement('p');h.textContent=data[s];p.append(h)}
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{s=b.dataset.tab;render()}));render();</script></body></html>`;

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('binds tabs without aria-controls to the sibling panel their activation re-renders', async () => {
	const parent = join(process.cwd(), '.tmp-test'); mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, 'tabs-sibling-panel-'));
	const server = createServer((request, response) => {
		if (request.url === '/robots.txt' || request.url?.includes('sitemap')) { response.statusCode = 404; response.end(); return; }
		response.setHeader('Content-Type', 'text/html'); response.end(source);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	try {
		await captureWebsite({ url, outputDir: root, captureImages: false, trustedOrigins: [url], learnFluid: false }, {
			findAdapter: () => ({ id: 'tabs-fixture', detect: () => true, discover: async () => ({ urls: [{ url }] }) }),
		});
		const report = JSON.parse(readFileSync(join(root, 'interaction-states.json'), 'utf8')) as { pages: Array<{ components: CapturedComponent[] }> };
		const tabs = report.pages[0]!.components.find(node => node.kind === 'tabs')!;
		expect(tabs).toMatchObject({ status: 'captured', initial: 'tab-0', panel: '#panel' });
		expect(tabs.states.map(state => [state.id, state.html])).toEqual([
			['tab-0', '<div id="panel" role="tabpanel"><p>Alpha panel text</p></div>'],
			['tab-1', '<div id="panel-tab-1" role="tabpanel"><p>Beta panel text</p></div>'],
			['tab-2', '<div id="panel-tab-2" role="tabpanel"><p>Gamma panel text</p></div>'],
		]);
		// The exported route carries the same tablist + tabpanel shape as aria-controls tabs.
		const html = readFileSync(join(root, 'website/index.html'), 'utf8');
		expect(html).toContain('aria-controls="panel-tab-2">Gamma</button>');
		expect(html).toContain('<div id="panel" role="tabpanel"><p>Alpha panel text</p></div><div id="panel-tab-1" role="tabpanel" hidden=""><p>Beta panel text</p></div>');
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
	}
}, 180_000);
