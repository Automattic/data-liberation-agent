import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { bindBoxTree, bindBoxTreeEvidence, BOX_TREE_STYLES, captureBoxTree, describeBoxTreeMismatch, stampNodeIds, type BoxTree, type BoxTreeMismatch, type BoxTreeObservation } from './box-tree.js';
import { capturePageHtml } from './screenshotter.js';
import { observeStylesheetLoadErrors } from './stylesheet-load.js';

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
		await page.setContent('<html><head><style>body{background:red}</style></head><body><p style="width:100px;font:20px/25px monospace;padding:3px;border:1px solid">Excerpt words…</p><main><a>Keep me</a></main><script>matchMedia("(max-width:600px)").addEventListener("change", () => document.querySelector("a")?.remove()); const sync = () => document.body.classList.toggle("wide", innerWidth >= 1280); addEventListener("resize", sync); sync();</script></body></html>');
		await stampNodeIds(page);
		let nodes: BoxTree['nodes'] | undefined;
		const html = await capturePageHtml(page, [], undefined, observed => { nodes = observed && 'nodes' in observed ? observed.nodes : undefined; });
		expect(nodes).toBeDefined();
		expect(html).toContain('data-blocks-engine-capture-text-lines="[50,25]"');
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

// One Chromium pass (~1 second). Author rules paint retained SVG artwork; the
// consumer does not ship them on evidence routes, so the observed paint is all it has.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('records the used SVG paint of artwork shapes and text', async () => {
	expect(BOX_TREE_STYLES).toEqual(expect.arrayContaining(['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity']));
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		await page.setContent('<html><head><style>.bag path{fill:#333}.bag .handle{fill:none;stroke:#333;stroke-width:2px;stroke-linecap:round}.bag text{fill:#f8f4f0;fill-opacity:.9}</style></head><body><a class="bag" href="/cart"><svg viewBox="0 0 20 24" width="20" height="24"><path d="M0 6h20v18H0z"></path><path class="handle" d="M5 6a5 5 0 0 1 10 0"></path><text x="10" y="18">0</text></svg></a></body></html>');
		await stampNodeIds(page);
		let nodes: BoxTree['nodes'] | undefined;
		const html = await capturePageHtml(page, [], undefined, observed => { nodes = observed && 'nodes' in observed ? observed.nodes : undefined; });
		expect(nodes).toBeDefined();
		const id = (pattern: RegExp) => html.match(pattern)![1];
		const used = (pattern: RegExp) => nodes![id(pattern)].viewports.capture.used_styles;
		expect(used(/<svg[^>]*data-blocks-engine-node-id="([^"]+)"/)).toMatchObject({ fill: 'rgb(0, 0, 0)', stroke: 'none' });
		expect(used(/<path d="M0[^>]*data-blocks-engine-node-id="([^"]+)"/)).toMatchObject({ fill: 'rgb(51, 51, 51)', stroke: 'none' });
		expect(used(/<path class="handle"[^>]*data-blocks-engine-node-id="([^"]+)"/)).toMatchObject({ fill: 'none', stroke: 'rgb(51, 51, 51)', 'stroke-width': '2px', 'stroke-linecap': 'round' });
		expect(used(/<text[^>]*data-blocks-engine-node-id="([^"]+)"/)).toMatchObject({ fill: 'rgb(248, 244, 240)', 'fill-opacity': '0.9' });
	} finally {
		await browser.close();
	}
});

// One Chromium pass (~1 second). Normalize only the snapshot: source scripts
// may place flow content outside body even though serialized HTML cannot.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('binds a snapshot with runtime elements before head and around body', async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
		await page.setContent('<!doctype html><html><head><title>Route</title></head><body><main>Copy</main></body></html>');
		await page.evaluate(() => {
			const element = (id: string) => { const div = document.createElement('div'); div.id = id; return div; };
			document.documentElement.insertBefore(element('before-head-1'), document.head);
			document.documentElement.insertBefore(element('before-head-2'), document.head);
			document.head.append(element('inside-head'));
			document.documentElement.insertBefore(element('before-body'), document.body);
			document.documentElement.append(element('after-body-1'), element('after-body-2'));
		});
		await stampNodeIds(page);
		const source = await page.evaluate(() => document.documentElement.outerHTML);
		const headId = await page.locator('head').getAttribute('data-blocks-engine-node-id');
		let observation: BoxTreeObservation | undefined;
		const html = await capturePageHtml(page, [], undefined, observed => { observation = observed; });
		expect(observation).toHaveProperty('nodes');
		expect(html).toContain(`<head data-blocks-engine-node-id="${headId}">`);
		expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(source);
		const nodes = observation && 'nodes' in observation ? observation.nodes : {};
		const dropped: Array<{ name: string; mismatch: BoxTreeMismatch }> = [];
		const viewports = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 }, tablet: { width: 768, height: 1024 } };
		const tree = await captureBoxTree(page, html, viewports, { name: 'mobile', nodes }, undefined, (name, mismatch) => dropped.push({ name, mismatch }));
		expect(tree).toBeDefined();
		expect(Object.keys(tree!.viewports).sort()).toEqual(['desktop', 'mobile', 'tablet']);
		for (const node of Object.values(tree!.nodes)) expect(Object.keys(node.viewports).sort()).toEqual(['desktop', 'mobile', 'tablet']);
		expect(dropped).toEqual([]);
		expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(source);
		// A real retained move must still drop the width and name the disagreement.
		await page.evaluate(() => document.querySelector('main')!.append(document.querySelector('#before-head-1')!));
		const changed = await captureBoxTree(page, html, { desktop: viewports.desktop }, { name: 'mobile', nodes }, undefined, (name, mismatch) => dropped.push({ name, mismatch }));
		expect(Object.keys(changed!.viewports)).toEqual(['mobile']);
		expect(dropped).toMatchObject([{ name: 'desktop', mismatch: { kind: 'moved', detail: expect.stringContaining('expected children') } }]);
		expect(bindBoxTree(html, tree)).toEqual(tree);
		await page.setContent(html);
		expect(await page.locator('html > *').evaluateAll(elements => elements.map(element => element.localName))).toEqual(['head', 'body']);
		expect(await page.locator('body > *').evaluateAll(elements => elements.map(element => element.id || element.localName))).toEqual(['before-head-1', 'before-head-2', 'inside-head', 'before-body', 'main', 'after-body-1', 'after-body-2']);
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
	// Capture-owned, non-rendering elements have no box; unmarked source scripts still fail by name.
	const owned = '<style data-blocks-engine-capture-width-class-rules></style><p data-blocks-engine-node-id="n3"></p><p data-blocks-engine-node-id="n4"></p><script data-blocks-engine-capture-native-control-runtime></script>';
	expect(bindBoxTreeEvidence(doc(owned), tree)).toHaveProperty('tree');
	expect(describeBoxTreeMismatch(mismatch(doc('<p data-blocks-engine-node-id="n3"></p><p data-blocks-engine-node-id="n4"></p><script></script>'))!)).toBe('unstamped node at html[n0]>body[n2]>script');
});

// One Chromium pass (~1 second). The native-control runtime is appended after
// observation (#2187), so a page with a stateful checkbox lost its box tree.
it.skipIf(process.env.SKIP_BROWSER_TESTS)('binds a page whose stateful checkbox adds the native-control runtime', async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
		await page.setContent('<!doctype html><html><head><title>Form</title></head><body><form><input type="checkbox" name="news"></form></body></html>');
		await page.check('input');
		await stampNodeIds(page);
		let observation: BoxTreeObservation | undefined;
		const html = await capturePageHtml(page, [], undefined, observed => { observation = observed; });
		expect(html).toContain('data-blocks-engine-capture-native-control-runtime');
		expect(observation).toHaveProperty('nodes');
		const nodes = observation && 'nodes' in observation ? observation.nodes : {};
		let unproven: BoxTreeMismatch | undefined;
		const tree = await captureBoxTree(page, html, { mobile: { width: 390, height: 844 }, desktop: { width: 1440, height: 900 } }, { name: 'mobile', nodes }, mismatch => { unproven = mismatch; });
		expect(unproven).toBeUndefined();
		expect(tree && Object.keys(tree.viewports).sort()).toEqual(['desktop', 'mobile']);
		expect(bindBoxTree(html, tree)).toEqual(tree);
	} finally {
		await browser.close();
	}
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
		// A fetched-but-disabled preferred sheet is not a resource failure.
		// It must not turn browser defaults into exportable layout evidence.
		await page.setContent('<!doctype html><link rel="stylesheet" title="theme" href="data:text/css,header{position:fixed}"><header>Fixed</header>');
		await page.evaluate(() => { document.querySelector<HTMLLinkElement>('link')!.sheet!.disabled = true; });
		await capturePageHtml(page, [], undefined, observed => { observation = observed; });
		expect(observation).toMatchObject({ mismatch: { kind: 'stylesheet', detail: expect.stringContaining('author stylesheet not applied') } });
		// A failed load must be rejected even if the browser exposes a sheet.
		await page.addInitScript(observeStylesheetLoadErrors);
		await page.goto('data:text/html,<!doctype html><link rel="stylesheet" href="data:text/css,header{position:fixed}"><header>Fixed</header>');
		await page.evaluate(() => document.querySelector('link')!.dispatchEvent(new Event('error')));
		await capturePageHtml(page, [], undefined, observed => { observation = observed; });
		expect(observation).toMatchObject({ mismatch: { kind: 'stylesheet' } });
	} finally {
		await browser.close();
	}
});
