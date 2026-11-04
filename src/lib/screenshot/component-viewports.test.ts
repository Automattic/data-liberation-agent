import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { exploreComponents, snapshotComponents } from './component-states.js';
import { withReadOnlyProbes } from './screenshotter.js';

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
		.search-form__lightbox { position:fixed; inset:0; background:white; z-index:10 }
		#search { display:none } @media(max-width:767px) { #search { display:block } }
		</style>
		<header id="search"><button id="search-toggle" aria-label="Toggle search" aria-controls="search-form" aria-expanded="false">Search</button>
		<form id="search-form" hidden><div class="search-form__lightbox"><input id="search-field" type="search"><button type="button" class="search-form__lightbox-close">Close</button></div></form></header>
		${['mobile', 'desktop', 'never'].map(id => `<section id="${id}"><button id="${id}-toggle" aria-expanded="false" aria-controls="${id}-panel">Search</button><div id="${id}-panel" hidden><input type="search"></div></section>`).join('')}
		<script>document.querySelectorAll('button').forEach(button => button.onclick = () => {
			const open = button.getAttribute('aria-expanded') !== 'true';
			button.setAttribute('aria-expanded', String(open));
			document.getElementById(button.getAttribute('aria-controls')).hidden = !open;
		});
		const close = () => { document.getElementById('search-form').hidden = true; document.getElementById('search-toggle').setAttribute('aria-expanded', 'false'); };
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
		expect(open.evidence).toMatchObject({ status: 'captured', trigger: { selector: '#search-toggle', ariaControls: 'search-form' }, dialog: { selector: '#search-form', tag: 'form', presentation: 'overlay', ancestorState: { status: 'verified' }, rootClassState: [] } });
		expect(open.evidence?.dialog?.html).toContain('search-form__lightbox');
		expect(search.transitions.map(edge => [edge.from, edge.to])).toEqual([['closed', 'open'], ['open', 'closed']]);
		expect(components.find(node => node.selector === '#never-toggle')).toMatchObject({
			status: 'partial', reason: 'trigger not rendered at captured viewports', states: [{ id: 'closed' }],
		});
		expect(components.some(node => node.reason === 'trigger activation failed')).toBe(false);
		expect(page.viewportSize()).toEqual({ width: desktop.width, height: desktop.height });
		expect(await page.locator('[aria-expanded="true"]').count()).toBe(0);
	} finally {
		await browser.close();
	}
});
