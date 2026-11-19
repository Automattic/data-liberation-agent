import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
// @ts-ignore TS6059: test fixture lives outside production rootDir.
import { exportFixture } from '../../test/export-fixture.js';
import { exportWebsiteCapture } from './capture-export.js';
import { BOX_TREE_SCHEMA, type BoxTree } from './screenshot/box-tree.js';
import { compactBoxTree, namespaceExportBoxTreeIds, projectExportBoxTree, writeExportBoxTrees, type CompactExportBoxTree, type ExportBoxTree } from './export-box-trees.js';
import { WebsiteInventory } from './website-inventory.js';

const source: BoxTree = {
	schema: BOX_TREE_SCHEMA, source_path: 'html/home.html', source_hash: 'raw',
	viewports: { desktop: { width: 1440, height: 900 } },
	nodes: Object.fromEntries(['root', 'body', 'main', 'text', 'script'].map(id => [id, {
		children: id === 'root' ? ['body'] : id === 'body' ? ['main', 'script'] : id === 'main' ? ['text'] : [],
		viewports: { desktop: { border_box: { x: 0, y: 0, width: 100, height: 20 }, used_styles: { display: 'block' } } },
	} ])),
};

const expand = (tree: CompactExportBoxTree) => ({ ...tree, schema: BOX_TREE_SCHEMA, styles: undefined, nodes: Object.fromEntries(Object.entries(tree.nodes).map(([id, node]) => [id, { ...node,
	viewports: Object.fromEntries(Object.entries(node.viewports).map(([name, { pseudo, ...observation }]) => [name, { ...observation, used_styles: tree.styles[observation.used_styles],
		...(pseudo ? { pseudo: Object.fromEntries(Object.entries(pseudo).map(([side, value]) => [side, { ...value!, used_styles: tree.styles[value!.used_styles] }])) } : {}) }])) }])) });
/** Exported sidecars are v3; read one back in the captured v2 shape. */
const readSidecar = (path: string) => expand(JSON.parse(readFileSync(path, 'utf8')) as CompactExportBoxTree);

it('exports hash-bound evidence after script removal and export wrapping', () => {
	const fixture = exportFixture();
	const outputDir = fixture.build();
	fixture.file('html/home.html', '<html data-blocks-engine-node-id="root"><head></head><body data-blocks-engine-node-id="body"><main data-blocks-engine-node-id="main"><div><p data-blocks-engine-node-id="text">Hello</p></div></main><script data-blocks-engine-node-id="script">window.foo = 1</script></body></html>');
	fixture.json('box-tree/home.json', source);
	fixture.manifest({ version: 1, entries: { 'https://example.com/': { html: 'html/home.html' } } });
	const receipt = JSON.parse(readFileSync(exportWebsiteCapture({ outputDir, sourceUrl: 'https://example.com/', platform: 'generic', summary: {}, failures: [] }), 'utf8'));
	const bytes = readFileSync(join(outputDir, 'website/index.html'));
	const tree = readSidecar(join(outputDir, 'website/box-tree/index.json'));
	expect(bytes.toString()).not.toContain('window.foo');
	expect(tree.source_path).toBe('website/index.html');
	expect(tree.source_hash).toBe(createHash('sha256').update(bytes).digest('hex'));
	expect(JSON.parse(readFileSync(join(outputDir, 'website/box-tree/index.json'), 'utf8')).schema).toBe('blocks-engine/box-tree/v3');
	expect(tree.viewports).toEqual(source.viewports);
	expect(Object.keys(tree.nodes).sort()).toEqual(['body', 'main', 'root', 'text']);
	expect(tree.nodes.main.children).toEqual(['text']);
	expect(tree.nodes.text.viewports).toEqual(source.nodes.text.viewports);
	// Sidecars are website files; listing them as reports too delivers them twice.
	expect(receipt.reports.filter((path: string) => path.startsWith('website/'))).toEqual([]);
	// Importers receive website/ and the reports, never html/: a raw sidecar bound to an
	// html/ capture document would always be rejected as stale.
	expect(receipt.reports.filter((path: string) => /(?:^|\/)box-tree\//.test(path))).toEqual([]);
	expect(receipt.exportBudget.files).toBeGreaterThanOrEqual(2);
});

const observation = (width: number) => ({ border_box: { x: 0, y: 0, width, height: 20 }, used_styles: { display: 'block' } });
const captured = (sourcePath: string, viewport: string, size: { width: number; height: number }, children: Record<string, string[]>, width: number): BoxTree => ({
	schema: BOX_TREE_SCHEMA, source_path: sourcePath, source_hash: 'raw', viewports: { [viewport]: size },
	nodes: Object.fromEntries(Object.entries(children).map(([id, kids]) => [id, { children: kids, viewports: { [viewport]: observation(width) } }])),
});

it('merges phone observations into the one document served at every width and drops the rest', () => {
	const fixture = exportFixture();
	const root = fixture.build();
	// The phone document has a menu where the desktop one has none, so it numbers the
	// footer n5 and the desktop footer's n4 names the menu there. The desktop aside has
	// no phone counterpart even though n5 exists in both captures.
	const desktopHtml = '<html data-blocks-engine-node-id="n0"><head data-blocks-engine-node-id="n1"></head><body data-blocks-engine-node-id="n2"><main data-blocks-engine-node-id="n3"><p data-blocks-engine-node-id="n6">Hi</p></main><footer data-blocks-engine-node-id="n4"></footer><aside data-blocks-engine-node-id="n5"></aside></body></html>';
	const mobileHtml = '<html data-blocks-engine-node-id="n0"><head data-blocks-engine-node-id="n1"></head><body data-blocks-engine-node-id="n2"><main data-blocks-engine-node-id="n3"><p data-blocks-engine-node-id="n6">Hi</p></main><nav data-blocks-engine-node-id="n4"></nav><footer data-blocks-engine-node-id="n5"></footer></body></html>';
	fixture.file('html/home.html', desktopHtml);
	fixture.file('html-mobile/home.html', mobileHtml);
	fixture.file('website/index.html', desktopHtml.replace('<p ', '<div><p ').replace('</p>', '</p></div>'));
	const tree = { n0: ['n1', 'n2'], n1: [], n2: ['n3', 'n4', 'n5'], n3: ['n6'], n4: [], n5: [], n6: [] };
	const desktop = captured('html/home.html', 'desktop', { width: 1440, height: 900 }, tree, 100);
	// The desktop capture's own phone-width observation of this document wins.
	desktop.nodes.n0.viewports.mobile = observation(7);
	const mobile = captured('html-mobile/home.html', 'mobile', { width: 402, height: 681 }, tree, 40);
	// The phone document observed at desktop width is not this page's desktop evidence.
	mobile.nodes.n3.viewports.desktop = observation(999);
	mobile.nodes.n5.viewports.mobile = observation(55);
	fixture.json('box-tree/home.json', desktop);
	fixture.json('box-tree/home.mobile.json', mobile);
	writeExportBoxTrees(root, join(root, 'website'), [{ sourcePath: 'html/home.html', path: 'index.html' }], new WebsiteInventory(join(root, 'website')));
	const result = readSidecar(join(root, 'website/box-tree/index.json'));
	expect(result.viewports).toEqual({ desktop: { width: 1440, height: 900 }, mobile: { width: 402, height: 681 } });
	expect(Object.keys(result.nodes).sort()).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n6']);
	for (const node of Object.values(result.nodes) as BoxTree['nodes'][string][]) expect(Object.keys(node.viewports).sort()).toEqual(['desktop', 'mobile']);
	expect(result.nodes.n2.children).toEqual(['n3', 'n4']);
	expect(result.nodes.n4.viewports.mobile.border_box.width).toBe(55);
	expect(result.nodes.n3.children).toEqual(['n6']);
	expect(result.nodes.n0.viewports.mobile.border_box.width).toBe(7);
	expect(result.nodes.n3.viewports).toEqual({ desktop: observation(100), mobile: observation(40) });
});

it('keeps desktop only when the route has no phone capture', () => {
	const fixture = exportFixture();
	const root = fixture.build();
	fixture.file('website/index.html', '<html data-blocks-engine-node-id="n0"><body data-blocks-engine-node-id="n1"></body></html>');
	fixture.json('box-tree/home.json', captured('html/home.html', 'desktop', { width: 1440, height: 900 }, { n0: ['n1'], n1: [] }, 100));
	writeExportBoxTrees(root, join(root, 'website'), [{ sourcePath: 'html/home.html', path: 'index.html' }], new WebsiteInventory(join(root, 'website')));
	const result = readSidecar(join(root, 'website/box-tree/index.json'));
	expect(result.viewports).toEqual({ desktop: { width: 1440, height: 900 } });
	expect(Object.keys(result.nodes)).toEqual(['n0', 'n1']);
});

it('leaves out a sidecar over the per-file limit instead of writing a file the importer refuses', () => {
	const fixture = exportFixture();
	const root = fixture.build();
	// A long listing: one observed node per row, enough to exceed a small limit.
	const rows = Array.from({ length: 200 }, (_, i) => `r${i}`);
	fixture.file('website/index.html', `<html data-blocks-engine-node-id="n0"><body data-blocks-engine-node-id="n1">${rows.map(id => `<p data-blocks-engine-node-id="${id}">row</p>`).join('')}</body></html>`);
	fixture.file('website/about.html', '<html data-blocks-engine-node-id="n0"><body data-blocks-engine-node-id="n1"></body></html>');
	fixture.json('box-tree/home.json', captured('html/home.html', 'desktop', { width: 1440, height: 900 }, { n0: ['n1'], n1: rows, ...Object.fromEntries(rows.map(id => [id, []])) }, 100));
	fixture.json('box-tree/about.json', captured('html/about.html', 'desktop', { width: 1440, height: 900 }, { n0: ['n1'], n1: [] }, 100));
	const pages = [{ sourcePath: 'html/home.html', path: 'index.html' }, { sourcePath: 'html/about.html', path: 'about.html' }];
	const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	try {
		expect(writeExportBoxTrees(root, join(root, 'website'), pages, new WebsiteInventory(join(root, 'website')), new Map(), 4096)).toEqual(['website/box-tree/about.json']);
		expect(existsSync(join(root, 'website/box-tree/index.json'))).toBe(false);
		expect(stderr.mock.calls.map(([line]) => String(line)).join('')).toMatch(/box-tree sidecar website\/box-tree\/index\.json is \d+ bytes, over the 4096-byte per-file limit; not written/);
	} finally {
		stderr.mockRestore();
	}
});

it('compacts losslessly, storing each distinct used_styles once', () => {
	const styles = (display: string) => ({ display, color: 'rgb(0, 0, 0)' });
	const box = { x: 0, y: 0, width: 10, height: 10 };
	const tree: ExportBoxTree = {
		schema: BOX_TREE_SCHEMA, source_path: 'website/index.html', source_hash: 'h', includes: { 'website/parts/header-x.html': 'p' },
		viewports: { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } },
		nodes: {
			a: { children: ['b'], viewports: { desktop: { border_box: box, used_styles: styles('block') }, mobile: { border_box: box, used_styles: styles('block') } } },
			b: { children: [], viewports: {
				desktop: { border_box: box, used_styles: styles('flex'), pseudo: { before: { content: '"“"', border_box: box, used_styles: styles('inline') } } },
				mobile: { border_box: box, used_styles: styles('block') },
			} },
		},
	};
	const compact = compactBoxTree(tree);
	expect(compact.schema).toBe('blocks-engine/box-tree/v3');
	expect(compact.styles).toEqual([styles('block'), styles('flex'), styles('inline')]);
	expect(compact.nodes.b.viewports.desktop.pseudo?.before?.used_styles).toBe(2);
	expect(JSON.parse(JSON.stringify(expand(compact)))).toEqual(tree);
});

it('writes v3, so a long page that repeats few style sets fits the per-file limit', () => {
	const fixture = exportFixture();
	const root = fixture.build();
	const rows = Array.from({ length: 50 }, (_, i) => `r${i}`);
	fixture.file('website/index.html', `<html data-blocks-engine-node-id="n0"><body data-blocks-engine-node-id="n1">${rows.map(id => `<p data-blocks-engine-node-id="${id}">row</p>`).join('')}</body></html>`);
	// Every row repeats the same full computed style set, as long listings do.
	const used = Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`property-${i}`, 'initial-value']));
	const tree = captured('html/home.html', 'desktop', { width: 1440, height: 900 }, { n0: ['n1'], n1: rows, ...Object.fromEntries(rows.map(id => [id, []])) }, 100);
	for (const node of Object.values(tree.nodes)) node.viewports.desktop.used_styles = used;
	fixture.json('box-tree/home.json', tree);
	const limit = 32 * 1024;
	expect(Buffer.byteLength(JSON.stringify(tree))).toBeGreaterThan(limit);
	expect(writeExportBoxTrees(root, join(root, 'website'), [{ sourcePath: 'html/home.html', path: 'index.html' }], new WebsiteInventory(join(root, 'website')), new Map(), limit)).toEqual(['website/box-tree/index.json']);
	const written = readFileSync(join(root, 'website/box-tree/index.json'), 'utf8');
	expect(Buffer.byteLength(written)).toBeLessThanOrEqual(limit);
	const compact = JSON.parse(written) as CompactExportBoxTree;
	expect(compact.styles).toEqual([used]);
	expect(Object.keys(compact.nodes)).toEqual(['n0', 'n1', ...rows]);
	expect(Object.values(expand(compact).nodes).every(node => node.viewports.desktop.used_styles === undefined || JSON.stringify(node.viewports.desktop.used_styles) === JSON.stringify(used))).toBe(true);
});

it('keeps phone identities distinct in assembled documents, leaving width-selected wrappers unobserved', () => {
	const html = namespaceExportBoxTreeIds('<html><body><div class="data-blocks-engine-capture-desktop-document" data-blocks-engine-node-id="body"><p data-blocks-engine-node-id="text">Desktop</p></div><div class="data-blocks-engine-capture-mobile-document" data-blocks-engine-node-id="body"><p data-blocks-engine-node-id="text">Phone</p></div></body></html>');
	expect(html).toContain('data-blocks-engine-node-id="mobile:text"');
	const fixture = exportFixture();
	fixture.file('website/index.html', html);
	fixture.file('html/home.html', '<html><body data-blocks-engine-node-id="body"><p data-blocks-engine-node-id="text">Desktop</p></body></html>');
	fixture.file('html-mobile/home.html', '<html><body data-blocks-engine-node-id="body"><p data-blocks-engine-node-id="text">Phone</p></body></html>');
	const desktop = structuredClone(source);
	desktop.nodes.text.viewports.mobile = observation(5);
	fixture.json('box-tree/home.json', desktop);
	fixture.json('box-tree/home.mobile.json', captured('html-mobile/home.html', 'mobile', { width: 390, height: 844 }, { body: ['text'], text: [] }, 42));
	const inventory = new WebsiteInventory(join(fixture.build(), 'website'));
	writeExportBoxTrees(fixture.build(), join(fixture.build(), 'website'), [{ sourcePath: source.source_path, path: 'index.html' }], inventory);
	const tree = readSidecar(join(fixture.build(), 'website/box-tree/index.json'));
	expect(Object.keys(tree.viewports).sort()).toEqual(['desktop', 'mobile']);
	expect(tree.nodes).toEqual({});
});

it('namespaces grafted phone-only fragments so desktop nodes keep evidence at both widths (#1994)', () => {
	// The phone capture numbers its picture n3/n4, IDs the desktop capture gave its wrapper and text.
	const desktopHtml = '<html data-blocks-engine-node-id="n0"><body data-blocks-engine-node-id="n1"><main data-blocks-engine-node-id="n2"><div data-blocks-engine-node-id="n3"><p data-blocks-engine-node-id="n4">Hi</p></div></main></body></html>';
	const mobileHtml = '<html data-blocks-engine-node-id="n0"><body data-blocks-engine-node-id="n1"><main data-blocks-engine-node-id="n2"><picture data-blocks-engine-node-id="n3"><img data-blocks-engine-node-id="n4"></picture><div data-blocks-engine-node-id="n5"><p data-blocks-engine-node-id="n6">Hi</p></div></main></body></html>';
	const assembled = namespaceExportBoxTreeIds(desktopHtml.replace('<div ', '<picture class="data-blocks-engine-capture-mobile-only" data-blocks-engine-node-id="n3"><img data-blocks-engine-node-id="n4"></picture><div '));
	const ids = [...assembled.matchAll(/data-blocks-engine-node-id="([^"]+)"/g)].map(match => match[1]);
	expect(new Set(ids).size).toBe(ids.length);
	expect(ids).toEqual(expect.arrayContaining(['mobile:n3', 'mobile:n4']));
	const fixture = exportFixture();
	const root = fixture.build();
	fixture.file('html/home.html', desktopHtml);
	fixture.file('html-mobile/home.html', mobileHtml);
	fixture.file('website/index.html', assembled);
	fixture.json('box-tree/home.json', captured('html/home.html', 'desktop', { width: 1440, height: 900 }, { n0: ['n1'], n1: ['n2'], n2: ['n3'], n3: ['n4'], n4: [] }, 100));
	fixture.json('box-tree/home.mobile.json', captured('html-mobile/home.html', 'mobile', { width: 390, height: 844 }, { n0: ['n1'], n1: ['n2'], n2: ['n3', 'n5'], n3: ['n4'], n4: [], n5: ['n6'], n6: [] }, 40));
	writeExportBoxTrees(root, join(root, 'website'), [{ sourcePath: 'html/home.html', path: 'index.html' }], new WebsiteInventory(join(root, 'website')));
	const tree = readSidecar(join(root, 'website/box-tree/index.json'));
	expect(Object.keys(tree.nodes).sort()).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
	for (const id of ['n3', 'n4']) expect(Object.keys(tree.nodes[id].viewports).sort()).toEqual(['desktop', 'mobile']);
	expect(tree.nodes.n2.children).toEqual(['n3']);
});

it('observes grafted phone-only fragments with the phone capture\'s evidence of the same element', () => {
	// The phone capture observed its document at both widths. The grafted fragment is
	// that document's cart; desktop has no counterpart, so only the phone capture knows it.
	const desktopHtml = '<html data-blocks-engine-node-id="n0"><body data-blocks-engine-node-id="n1"><header data-blocks-engine-node-id="n2"><div data-blocks-engine-node-id="n3"><a data-blocks-engine-node-id="n4">Cart</a></div></header></body></html>';
	const mobileHtml = '<html data-blocks-engine-node-id="n0"><body data-blocks-engine-node-id="n1"><header data-blocks-engine-node-id="n2"><span data-blocks-engine-node-id="n3">Menu</span><div data-blocks-engine-node-id="n4"><a data-blocks-engine-node-id="n5">Cart</a></div></header></body></html>';
	// The fragment's root keeps its phone tag; its link is retagged, so it has no proven counterpart.
	const assembled = namespaceExportBoxTreeIds(desktopHtml.replace('</header>', '<div class="data-blocks-engine-capture-mobile-only" data-blocks-engine-node-id="n4"><b data-blocks-engine-node-id="n5">Cart</b></div></header>'));
	const fixture = exportFixture();
	const root = fixture.build();
	fixture.file('html/home.html', desktopHtml);
	fixture.file('html-mobile/home.html', mobileHtml);
	fixture.file('website/index.html', assembled);
	fixture.json('box-tree/home.json', captured('html/home.html', 'desktop', { width: 1440, height: 900 }, { n0: ['n1'], n1: ['n2'], n2: ['n3'], n3: ['n4'], n4: [] }, 100));
	const mobile = captured('html-mobile/home.html', 'mobile', { width: 390, height: 844 }, { n0: ['n1'], n1: ['n2'], n2: ['n3', 'n4'], n3: [], n4: ['n5'], n5: [] }, 40);
	mobile.viewports.desktop = { width: 1440, height: 900 };
	for (const node of Object.values(mobile.nodes)) node.viewports.desktop = observation(30);
	fixture.json('box-tree/home.mobile.json', mobile);
	writeExportBoxTrees(root, join(root, 'website'), [{ sourcePath: 'html/home.html', path: 'index.html' }], new WebsiteInventory(join(root, 'website')));
	const tree = readSidecar(join(root, 'website/box-tree/index.json'));
	expect(tree.nodes['mobile:n4'].viewports).toEqual({ desktop: observation(30), mobile: observation(40) });
	expect(tree.nodes.n2.children).toEqual(['n3', 'mobile:n4']);
	expect(tree.nodes).not.toHaveProperty(['mobile:n5']);
	// Desktop nodes with the fragment's phone numbers keep their own evidence.
	expect(tree.nodes.n4.viewports.desktop).toEqual(observation(100));
});

it('uses nearest observed descendants through new wrappers without inventing observations', () => {
	const html = '<html data-blocks-engine-node-id="root"><body><section><p data-blocks-engine-node-id="text">Hello</p></section></body></html>';
	const result = projectExportBoxTree(html, source, 'about/index.html', Buffer.from(html));
	expect(Object.keys(result.nodes)).toEqual(['root', 'text']);
	expect(result.nodes.root.children).toEqual(['text']);
	expect(result.nodes.text.children).toEqual([]);
});

it('binds included shared parts and leaves duplicated identities unobserved', () => {
	const fixture = exportFixture();
	const outputDir = fixture.build();
	const nav = Array.from({ length: 12 }, (_, index) => `<li data-blocks-engine-node-id="nav-${index}"><a href="/about/">Shared navigation entry number ${index}</a></li>`).join('');
	const header = `<header data-blocks-engine-node-id="header"><nav data-blocks-engine-node-id="nav"><ul data-blocks-engine-node-id="list">${nav}</ul></nav></header>`;
	const tree = (path: string, ids: string[], children: Record<string, string[]>): BoxTree => ({
		schema: BOX_TREE_SCHEMA, source_path: path, source_hash: 'raw', viewports: { desktop: { width: 1440, height: 900 } },
		nodes: Object.fromEntries(ids.map(id => [id, { children: children[id] ?? [], viewports: { desktop: { border_box: { x: 0, y: 0, width: 10, height: 10 }, used_styles: { display: 'block' } } } }])),
	});
	const navIds = Array.from({ length: 12 }, (_, index) => `nav-${index}`);
	const headerIds = ['header', 'nav', 'list', ...navIds];
	const headerChildren = { header: ['nav'], nav: ['list'], list: navIds };
	// The fluid-rules style is copied, so its identity occurs twice in the page.
	fixture.page('/', `<html data-blocks-engine-node-id="root"><head></head><body data-blocks-engine-node-id="body">${header}<main data-blocks-engine-node-id="main"><style data-blocks-engine-capture-fluid-rules data-blocks-engine-node-id="dup">p{}</style><div data-blocks-engine-node-id="dup"><p data-blocks-engine-node-id="home">Home</p></div></main></body></html>`);
	fixture.page('/about/', `<html data-blocks-engine-node-id="root"><head></head><body data-blocks-engine-node-id="body">${header}<main data-blocks-engine-node-id="main"><p data-blocks-engine-node-id="about">About</p></main></body></html>`);
	fixture.json('box-tree/page-0.json', tree('html/page-0.html', ['root', 'body', 'main', 'dup', 'home', ...headerIds], { root: ['body'], body: ['header', 'main'], main: ['dup'], dup: ['home'], ...headerChildren }));
	fixture.json('box-tree/page-1.json', tree('html/page-1.html', ['root', 'body', 'main', 'about', ...headerIds], { root: ['body'], body: ['header', 'main'], main: ['about'], ...headerChildren }));
	exportWebsiteCapture({ outputDir, sourceUrl: 'https://example.com/', platform: 'generic', summary: {}, failures: [] });
	const page = readFileSync(join(outputDir, 'website/index.html'), 'utf8');
	const include = /<!--#include virtual="\/(parts\/[^"]+\.html)" -->/.exec(page);
	expect(include).not.toBeNull();
	const part = include![1];
	const home = readSidecar(join(outputDir, 'website/box-tree/index.json'));
	expect(home.source_hash).toBe(createHash('sha256').update(page).digest('hex'));
	expect(home.source_path).toBe('website/index.html');
	expect(home.includes).toEqual({ [`website/${part}`]: createHash('sha256').update(readFileSync(join(outputDir, 'website', part))).digest('hex') });
	expect(home.nodes.dup).toBeUndefined();
	expect(home.nodes.main.children).toEqual(['home']);
	expect(home.nodes.header.children).toEqual(['nav']);
	expect(home.nodes.body.children).toEqual(['header', 'main']);
	const about = readSidecar(join(outputDir, 'website/box-tree/about/index.json'));
	expect(about.source_path).toBe('website/about/index.html');
	expect(about.includes).toEqual(home.includes);
	expect(about.nodes.list.children).toEqual(navIds);
});

it('omits includes for pages without parts and drops IDs foreign to the route', () => {
	const html = '<html data-blocks-engine-node-id="root"><body><p data-blocks-engine-node-id="foreign">x</p><p data-blocks-engine-node-id="text">y</p></body></html>';
	const result = projectExportBoxTree(html, source, 'index.html', Buffer.from(html));
	expect(result).not.toHaveProperty('includes');
	expect(Object.keys(result.nodes)).toEqual(['root', 'text']);
});
