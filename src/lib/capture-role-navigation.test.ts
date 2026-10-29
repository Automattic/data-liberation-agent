import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { captureWebsite } from '../index.js';
import { readResolvedPage } from './site-includes.js';
import type { InteractionStatesReport } from './screenshot/interaction-capture.js';

// Reduced Radix/shadcn Select portal and button-router header shapes. Neither
// relies on framework names, inferred labels, or aria-haspopup for semantics.
const source = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:20px}header{display:flex;gap:20px}button{padding:12px}main{margin-top:30px}[data-radix-popper-content-wrapper]{position:absolute;top:180px;background:white;padding:12px}</style>
</head><body><header><button id="home" type="button">Home</button><button id="about" type="button">About</button><button id="contact" type="button">Contact</button><button id="action" type="button">Refresh</button></header>
<main><h1>Choose a country</h1><form><label id="country-label" for="country">Country</label><button id="country" type="button" role="combobox" aria-labelledby="country-label" aria-expanded="false" aria-controls="radix-options">Select country</button><button id="region" type="button" aria-controls="region-popper" aria-expanded="false">Select region</button></form></main>
<div id="region-popper" hidden><div role="listbox" aria-label="Region"><div role="option">North</div><div role="option">South</div></div></div>
<script>
for(const button of document.querySelectorAll('header button:not(#action)'))button.onclick=()=>{history.pushState({},'',button.id==='home'?'/':'/'+button.id);};
document.querySelector('#action').onclick=()=>document.body.dataset.refreshed='yes';
const trigger=document.querySelector('#country');
function close(){document.querySelector('[data-radix-popper-content-wrapper]')?.remove();trigger.setAttribute('aria-expanded','false');}
trigger.onclick=()=>{if(trigger.getAttribute('aria-expanded')==='true'){close();return;}
trigger.setAttribute('aria-expanded','true');const wrapper=document.createElement('div');wrapper.setAttribute('data-radix-popper-content-wrapper','');
wrapper.innerHTML='<div id="radix-options" role="listbox" aria-labelledby="country-label"><div role="option" tabindex="-1">Canada</div><div role="option" tabindex="-1">Ghana</div></div>';document.body.append(wrapper);};
const region=document.querySelector('#region'),regionPopper=document.querySelector('#region-popper');
region.onclick=()=>{regionPopper.hidden=!regionPopper.hidden;region.setAttribute('aria-expanded',String(!regionPopper.hidden));};
addEventListener('keydown',event=>{if(event.key==='Escape'){close();regionPopper.hidden=true;region.setAttribute('aria-expanded','false');}});
</script></body></html>`;

it.skipIf(Boolean(process.env.SKIP_BROWSER_TESTS))('exports owned listbox semantics and observed header router destinations through the public capture API', async () => {
	const parent = join(process.cwd(), '.tmp-test');
	mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, 'role-navigation-'));
	let copyRoot: string | undefined;
	const server = createServer((request, response) => {
		if (request.url === '/robots.txt') { response.end(''); return; }
		if (request.url?.includes('sitemap')) { response.statusCode = 404; response.end(); return; }
		response.setHeader('Content-Type', 'text/html');
		response.end(request.url === '/copy/' && copyRoot ? readResolvedPage(copyRoot, join(copyRoot, 'index.html')) : source);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	const browser = await chromium.launch();
	try {
		const result = await captureWebsite({ url, outputDir: root, captureImages: false, trustedOrigins: [url], learnFluid: false }, {
			findAdapter: () => ({ id: 'neutral-surfaces', detect: () => true, discover: async () => ({ urls: [url, `${url}about`, `${url}contact`].map(url => ({ url })) }) }),
		});
		expect(result.summary.routesFailed).toBe(0);
		copyRoot = join(root, 'website');
		const evidence = JSON.parse(readFileSync(join(root, 'interaction-states.json'), 'utf8')) as { pages: InteractionStatesReport[] };
		const entry = evidence.pages.find(page => page.sourceUrl === url)!;
		for (const id of ['country', 'region']) {
			expect(entry.components?.find(node => node.selector === `#${id}` || node.states.some(state => state.evidence?.trigger.id === id))?.kind).toBe('listbox');
		}
		expect(entry.routeNavigation?.find(route => route.id === 'about')?.url).toBe(`${url}about`);
		expect(entry.routeNavigation?.find(route => route.id === 'contact')?.url).toBe(`${url}contact`);
		expect(existsSync(join(copyRoot, 'about', 'index.html'))).toBe(true);
		expect(existsSync(join(copyRoot, 'contact', 'index.html'))).toBe(true);
		const html = readResolvedPage(copyRoot, join(copyRoot, 'index.html'));
		expect(html).toContain('data-blocks-engine-capture-listbox-trigger');
		expect(html).not.toContain('data-blocks-engine-capture-dialog-trigger');
		const page = await browser.newPage();
		await page.goto(`${url}copy/`);
		expect(await page.locator('#about').evaluate(el => el.tagName)).toBe('A');
		expect(new URL((await page.locator('#about').getAttribute('href'))!, url).pathname).toBe('/about/index.html');
		expect(new URL((await page.locator('#contact').getAttribute('href'))!, url).pathname).toBe('/contact/index.html');
		expect(await page.locator('#action').evaluate(el => el.tagName)).toBe('BUTTON');
		await page.locator('#country').click();
		await expect.poll(() => page.getByRole('listbox', { name: 'Country' }).isVisible()).toBe(true);
		expect(await page.getByRole('dialog').count()).toBe(0);
		await page.getByRole('option', { name: 'Ghana' }).click();
		expect(await page.locator('#country').textContent()).toBe('Ghana');
		expect(await page.locator('#country').getAttribute('aria-expanded')).toBe('false');
		expect(await page.locator('label[for="country"]').textContent()).toBe('Country');
		await page.locator('#country').click();
		await page.keyboard.press('Escape');
		expect(await page.getByRole('listbox', { name: 'Country' }).isVisible()).toBe(false);
		await page.locator('#region').click();
		expect(await page.getByRole('option', { name: 'South' }).isVisible()).toBe(true);
		await page.getByRole('option', { name: 'South' }).click();
		expect(await page.locator('#region').textContent()).toBe('South');
		expect(await page.locator('#region').getAttribute('aria-expanded')).toBe('false');
		expect(await page.locator('[role="option"]').count()).toBe(4);
		expect(await page.locator('#region-popper').count()).toBe(1);
	} finally {
		await browser.close();
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
}, 180_000);
