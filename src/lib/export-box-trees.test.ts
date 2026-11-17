import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
// @ts-ignore TS6059: test fixture lives outside production rootDir.
import { exportFixture } from '../../test/export-fixture.js';
import { exportWebsiteCapture } from './capture-export.js';
import { BOX_TREE_SCHEMA, type BoxTree } from './screenshot/box-tree.js';
import { namespaceExportBoxTreeIds, projectExportBoxTree, writeExportBoxTrees } from './export-box-trees.js';
import { WebsiteInventory } from './website-inventory.js';

const source: BoxTree = {
	schema: BOX_TREE_SCHEMA, source_path: 'html/home.html', source_hash: 'raw',
	viewports: { desktop: { width: 1440, height: 900 } },
	nodes: Object.fromEntries(['root', 'body', 'main', 'text', 'script'].map(id => [id, {
		children: id === 'root' ? ['body'] : id === 'body' ? ['main', 'script'] : id === 'main' ? ['text'] : [],
		viewports: { desktop: { border_box: { x: 0, y: 0, width: 100, height: 20 }, used_styles: { display: 'block' } } },
	} ])),
};

it('exports hash-bound evidence after script removal and export wrapping', () => {
	const fixture = exportFixture();
	const outputDir = fixture.build();
	fixture.file('html/home.html', '<html data-blocks-engine-node-id="root"><head></head><body data-blocks-engine-node-id="body"><main data-blocks-engine-node-id="main"><div><p data-blocks-engine-node-id="text">Hello</p></div></main><script data-blocks-engine-node-id="script">window.foo = 1</script></body></html>');
	fixture.json('box-tree/home.json', source);
	fixture.manifest({ version: 1, entries: { 'https://example.com/': { html: 'html/home.html' } } });
	const receipt = JSON.parse(readFileSync(exportWebsiteCapture({ outputDir, sourceUrl: 'https://example.com/', platform: 'generic', summary: {}, failures: [] }), 'utf8'));
	const bytes = readFileSync(join(outputDir, 'website/index.html'));
	const tree = JSON.parse(readFileSync(join(outputDir, 'website/box-tree/index.json'), 'utf8'));
	expect(bytes.toString()).not.toContain('window.foo');
	expect(tree.source_path).toBe('website/index.html');
	expect(tree.source_hash).toBe(createHash('sha256').update(bytes).digest('hex'));
	expect(tree.schema).toBe(source.schema);
	expect(tree.viewports).toEqual(source.viewports);
	expect(Object.keys(tree.nodes).sort()).toEqual(['body', 'main', 'root', 'text']);
	expect(tree.nodes.main.children).toEqual(['text']);
	expect(tree.nodes.text.viewports).toEqual(source.nodes.text.viewports);
	// Sidecars are website files; listing them as reports too delivers them twice.
	expect(receipt.reports.filter((path: string) => path.startsWith('website/'))).toEqual([]);
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
	const result = JSON.parse(readFileSync(join(root, 'website/box-tree/index.json'), 'utf8'));
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
	const result = JSON.parse(readFileSync(join(root, 'website/box-tree/index.json'), 'utf8'));
	expect(result.viewports).toEqual({ desktop: { width: 1440, height: 900 } });
	expect(Object.keys(result.nodes)).toEqual(['n0', 'n1']);
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
	const tree = JSON.parse(readFileSync(join(fixture.build(), 'website/box-tree/index.json'), 'utf8'));
	expect(Object.keys(tree.viewports).sort()).toEqual(['desktop', 'mobile']);
	expect(tree.nodes).toEqual({});
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
	const home = JSON.parse(readFileSync(join(outputDir, 'website/box-tree/index.json'), 'utf8'));
	expect(home.source_hash).toBe(createHash('sha256').update(page).digest('hex'));
	expect(home.source_path).toBe('website/index.html');
	expect(home.includes).toEqual({ [`website/${part}`]: createHash('sha256').update(readFileSync(join(outputDir, 'website', part))).digest('hex') });
	expect(home.nodes.dup).toBeUndefined();
	expect(home.nodes.main.children).toEqual(['home']);
	expect(home.nodes.header.children).toEqual(['nav']);
	expect(home.nodes.body.children).toEqual(['header', 'main']);
	const about = JSON.parse(readFileSync(join(outputDir, 'website/box-tree/about/index.json'), 'utf8'));
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
