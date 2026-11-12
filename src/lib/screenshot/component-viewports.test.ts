import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { exploreComponents, snapshotComponents } from './component-states.js';
import { withReadOnlyProbes } from './probe-guards.js';
import { wireCapturedComponents } from '../static-components.js';

// One browser pass, approximately three seconds. Uses the screenshotter's
// snapshot -> read-only exploration path, without a second capture pipeline.
it('explores responsive disclosures where they render and restores the capture viewport', async () => {
	const browser = await chromium.launch({ headless: true });
	const desktop = { id: 'desktop', width: 1440, height: 900 };
	const mobile = { id: 'mobile', width: 390, height: 900 };
	const page = await browser.newPage({ viewport: desktop });
	try {
		await page.setContent(`<style>
			#mobile, #never { display:none }
			@media(max-width:767px) { #mobile { display:block } #desktop { display:none } }
		.search-form__lightbox { display:none; position:fixed; inset:0; background:white; z-index:10 }
		#search-form { min-height:20px }
		#search-form.is-active .search-form__lightbox { display:block }
		#search { display:none } @media(max-width:767px) { #search { display:block } }
		</style>
		<header id="search"><button id="search-toggle" aria-label="Toggle search" aria-controls="search-form" aria-expanded="false">Search</button>
		<form id="search-form" aria-hidden="true"><div class="search-form__lightbox"><input id="search-field" type="search"><div role="button" tabindex="0" class="search-form__lightbox-close"><span>Close</span></div></div></form></header>
		${['mobile', 'desktop', 'never'].map(id => `<section id="${id}"><button id="${id}-toggle" aria-expanded="false" aria-controls="${id}-panel">Search</button><div id="${id}-panel" hidden><input type="search"></div></section>`).join('')}
		<script>document.querySelectorAll('button').forEach(button => button.onclick = () => {
			const open = button.getAttribute('aria-expanded') !== 'true';
			button.setAttribute('aria-expanded', String(open));
			document.getElementById(button.getAttribute('aria-controls')).hidden = !open;
		});
		const form = document.getElementById('search-form');
		document.getElementById('search-toggle').onclick = () => {
			const open = form.classList.toggle('is-active');
			form.setAttribute('aria-hidden', String(!open));
			document.getElementById('search-toggle').setAttribute('aria-expanded', String(open));
		};
		const close = () => { form.classList.remove('is-active'); form.setAttribute('aria-hidden', 'true'); document.getElementById('search-toggle').setAttribute('aria-expanded', 'false'); };
		document.querySelector('.search-form__lightbox-close').onclick = close;
		</script>`);
		const baseline = await snapshotComponents(page);
		const components = await withReadOnlyProbes(page, () => exploreComponents(page, baseline, undefined, [desktop, mobile]));
		for (const viewport of [desktop, mobile]) {
			const component = components.find(node => node.selector === `#${viewport.id}-toggle`)!;
			expect(component.status).toBe('captured');
			expect(component.reason).toBeUndefined();
			expect(component.viewport).toEqual(viewport);
			expect(component.states.map(state => state.id)).toEqual(['closed', 'open']);
			expect(component.transitions.map(edge => [edge.from, edge.to])).toEqual([['closed', 'open'], ['open', 'closed']]);
		}
		const search = components.find(node => node.selector === '#search-toggle')!;
		expect(search).toMatchObject({ status: 'captured', viewport: mobile });
		const open = search.states.find(state => state.id === 'open')!;
		expect(open.evidence).toMatchObject({ status: 'captured', trigger: { selector: '#search-toggle', ariaControls: 'search-form' }, dialog: { selector: '#search-form', tag: 'form', presentation: 'overlay', ancestorState: { status: 'unverified' }, rootClassState: [] } });
		expect(open.evidence?.dialog?.html).toContain('search-form__lightbox');
		expect(search.transitions.map(edge => [edge.from, edge.to])).toEqual([['closed', 'open'], ['open', 'closed']]);
		expect(await page.locator(search.transitions[1].trigger.selector).getAttribute('class')).toBe('search-form__lightbox-close');
		expect(components.find(node => node.selector === '#never-toggle')).toMatchObject({
			status: 'partial', reason: 'trigger not rendered at captured viewports', states: [{ id: 'closed' }],
		});
		expect(components.some(node => node.reason === 'trigger activation failed')).toBe(false);
		expect(page.viewportSize()).toEqual({ width: desktop.width, height: desktop.height });
		expect(await page.locator('[aria-expanded="true"]').count()).toBe(0);

		// Replay captured markup without the source runtime, including a nested
		// click target inside the panel's non-button dismissal control.
		await page.locator('script').evaluateAll(scripts => scripts.forEach(script => script.remove()));
		const output = wireCapturedComponents(await page.content(), components);
		await page.setViewportSize({ width: mobile.width, height: mobile.height });
		await page.setContent(output);
		const closedPanel = await page.evaluate(html => new DOMParser().parseFromString(html, 'text/html').getElementById('search-form')!.outerHTML, search.states.find(state => state.id === 'closed')!.html);
		await page.locator('#search-toggle').click();
		expect(await page.locator('#search-toggle').getAttribute('aria-expanded')).toBe('true');
		expect(await page.locator('.search-form__lightbox').isVisible()).toBe(true);
		await page.locator('.search-form__lightbox-close span').click();
		expect(await page.locator('#search-toggle').getAttribute('aria-expanded')).toBe('false');
		expect(await page.locator('#search-form').evaluate(panel => panel.outerHTML)).toBe(closedPanel);
		// The replacement panel must resolve again on subsequent interactions.
		await page.locator('#search-toggle').click();
		await page.locator('.search-form__lightbox-close span').click();
		expect(await page.locator('#search-toggle').getAttribute('aria-expanded')).toBe('false');
	} finally {
		await browser.close();
	}
});
