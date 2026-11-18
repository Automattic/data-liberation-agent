import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { bindBoxTree, bindBoxTreeEvidence, BOX_TREE_STYLES, captureBoxTree, describeBoxTreeMismatch, stampNodeIds, type BoxTree, type BoxTreeMismatch, type BoxTreeObservation } from './box-tree.js';
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
		const html = await capturePageHtml(page, [], undefined, observed => { nodes = observed && 'nodes' in observed ? observed.nodes : undefined; });
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
		const mobileHtml = await capturePageHtml(page, [], undefined, observed => { nodes = observed && 'nodes' in observed ? observed.nodes : undefined; });
		const mobileTree = await captureBoxTree(page, mobileHtml, { mobile: { width: 390, height: 844 } }, { name: 'mobile', nodes: nodes! });
		expect(Object.keys(mobileTree!.viewports)).toEqual(['mobile']);
		expect(bindBoxTree(mobileHtml, mobileTree)).toEqual(mobileTree);
		// A serialization that no longer binds at its own viewport is unproven.
		expect(await captureBoxTree(page, html, { mobile: { width: 390, height: 844 } }, { name: 'mobile', nodes: nodes! })).toBeUndefined();
	} finally {
		await browser.close();
	}
});

it('names the first node at which saved bytes and the observed tree disagree', () => {
	const tree = { schema: 'blocks-engine/box-tree/v2' as const, viewports: {}, nodes: {
		n0: { children: ['n1', 'n2'], viewports: {} }, n1: { children: [], viewports: {} }, n2: { children: ['n3', 'n4'], viewports: {} }, n3: { children: [], viewports: {} }, n4: { children: [], viewports: {} },
	} };
	const doc = (body: string) => `<html data-blocks-engine-node-id="n0"><head data-blocks-engine-node-id="n1"></head><body data-blocks-engine-node-id="n2">${body}</body></html>`;
	expect(bindBoxTreeEvidence(doc('<p data-blocks-engine-node-id="n3"></p><p data-blocks-engine-node-id="n4"></p>'), tree)).toHaveProperty('tree');
	const mismatch = (html: string) => { const bound = bindBoxTreeEvidence(html, tree); return 'mismatch' in bound ? bound.mismatch : undefined; };
	expect(mismatch(doc('<p data-blocks-engine-node-id="n4"></p><p data-blocks-engine-node-id="n3"></p>'))).toMatchObject({ kind: 'moved', id: 'n4', parent: 'n2', path: 'html[n0]>body[n2]>p[n4]' });
	expect(mismatch(doc('<p data-blocks-engine-node-id="n3"><i data-blocks-engine-node-id="n9"></i></p>'))).toMatchObject({ kind: 'extra', id: 'n9', parent: 'n3' });
	expect(describeBoxTreeMismatch(mismatch(doc('<p data-blocks-engine-node-id="n3"><b></b></p>'))!)).toBe('unstamped node at html[n0]>body[n2]>p[n3]>b');
});

// One Chromium pass (~1 second). Wix inserted a head <script> during the
// serializer's settle waits, after the caller's stamp (#1924): the snapshot held
// an unstamped node, so the route shipped without a sidecar.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('binds a node the source runtime inserted after the stamp', async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
		await page.setContent('<html><head><title>Route</title></head><body><main><p>Copy</p></main></body></html>');
		await stampNodeIds(page);
		await page.evaluate(() => { const script = document.createElement('script'); script.type = 'application/json'; document.head.append(script); });
		let observation: BoxTreeObservation | undefined;
		const html = await capturePageHtml(page, [], undefined, observed => { observation = observed; });
		expect(observation).toHaveProperty('nodes');
		const nodes = observation && 'nodes' in observation ? observation.nodes : {};
		let unproven: BoxTreeMismatch | undefined;
		const tree = await captureBoxTree(page, html, { mobile: { width: 390, height: 844 } }, { name: 'mobile', nodes }, mismatch => { unproven = mismatch; });
		expect(unproven).toBeUndefined();
		expect(bindBoxTree(html, tree)).toEqual(tree);
	} finally {
		await browser.close();
	}
});
