import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { bindBoxTree, BOX_TREE_STYLES, captureBoxTree, stampNodeIds, type BoxTree } from './box-tree.js';
import { capturePageHtml } from './screenshotter.js';

it('uses paint longhands without shorthand aliases', () => {
	expect(BOX_TREE_STYLES).toEqual(expect.arrayContaining(['background-color', 'background-image', 'mask-image', 'mask-mode']));
	expect(BOX_TREE_STYLES).not.toContain('background');
	expect(BOX_TREE_STYLES).not.toContain('mask');
});

// One Chromium pass (~1 second): width-driven topology and a later probe mutation.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('keeps the capture viewport when another width rerenders, and binds saved bytes rather than later live DOM', async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		await page.setContent('<html><head><style>body{background:red}</style></head><body><main><a>Keep me</a></main><script>matchMedia("(max-width:600px)").addEventListener("change", () => document.querySelector("a")?.remove()); const sync = () => document.body.classList.toggle("wide", innerWidth >= 1280); addEventListener("resize", sync); sync();</script></body></html>');
		await stampNodeIds(page);
		let nodes: BoxTree['nodes'] | undefined;
		const html = await capturePageHtml(page, [], undefined, observed => { nodes = observed; });
		expect(nodes).toBeDefined();
		const tree = await captureBoxTree(page, html, { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } }, { name: 'desktop', nodes: nodes! });
		expect(Object.keys(tree!.viewports)).toEqual(['desktop']);
		// The next learner must see the restored width's state immediately,
		// not the narrow classes left until the next resize event is delivered.
		expect(await page.locator('body').getAttribute('class')).toBe('wide');
		expect(await page.locator('a').count()).toBe(0);
		expect(bindBoxTree(html, tree)).toEqual(tree);
		expect(bindBoxTree(html.replace('</main>', '<div data-blocks-engine-node-id="new"></div></main>'), tree)).toBeUndefined();
		// Moving an existing node is not a valid rebind either.
		const moved = html.replace(/(<a[^>]*>Keep me<\/a>)<\/main>/, '</main>$1');
		expect(bindBoxTree(moved, tree)).toBeUndefined();
		// A mobile document starts from its own topology, not the desktop's.
		await page.setViewportSize({ width: 390, height: 844 });
		await stampNodeIds(page);
		const mobileHtml = await capturePageHtml(page, [], undefined, observed => { nodes = observed; });
		const mobileTree = await captureBoxTree(page, mobileHtml, { mobile: { width: 390, height: 844 } }, { name: 'mobile', nodes: nodes! });
		expect(Object.keys(mobileTree!.viewports)).toEqual(['mobile']);
		expect(bindBoxTree(mobileHtml, mobileTree)).toEqual(mobileTree);
		// A serialization that no longer binds at its own viewport is unproven.
		expect(await captureBoxTree(page, html, { mobile: { width: 390, height: 844 } }, { name: 'mobile', nodes: nodes! })).toBeUndefined();
	} finally {
		await browser.close();
	}
});
