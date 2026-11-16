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
	expect(tree.source_path).toBe('index.html');
	expect(tree.source_hash).toBe(createHash('sha256').update(bytes).digest('hex'));
	expect(tree.schema).toBe(source.schema);
	expect(tree.viewports).toEqual(source.viewports);
	expect(Object.keys(tree.nodes).sort()).toEqual(['body', 'main', 'root', 'text']);
	expect(tree.nodes.main.children).toEqual(['text']);
	expect(tree.nodes.text.viewports).toEqual(source.nodes.text.viewports);
	expect(receipt.reports).toContain('website/box-tree/index.json');
	expect(receipt.exportBudget.files).toBeGreaterThanOrEqual(2);
});

it('keeps phone identities distinct in assembled documents', () => {
	const html = namespaceExportBoxTreeIds('<html><body><div class="data-blocks-engine-capture-desktop-document" data-blocks-engine-node-id="body"><p data-blocks-engine-node-id="text">Desktop</p></div><div class="data-blocks-engine-capture-mobile-document" data-blocks-engine-node-id="body"><p data-blocks-engine-node-id="text">Phone</p></div></body></html>');
	const fixture = exportFixture();
	fixture.file('website/index.html', html);
	fixture.json('box-tree/home.json', source);
	const mobile = structuredClone(source);
	mobile.source_path = 'html-mobile/home.html';
	mobile.nodes.text.viewports.desktop.border_box.width = 42;
	fixture.json('box-tree/home.mobile.json', mobile);
	const inventory = new WebsiteInventory(join(fixture.build(), 'website'));
	writeExportBoxTrees(fixture.build(), join(fixture.build(), 'website'), [{ sourcePath: source.source_path, path: 'index.html' }], inventory);
	const tree = JSON.parse(readFileSync(join(fixture.build(), 'website/box-tree/index.json'), 'utf8'));
	expect(tree.nodes.body.children).toEqual(['text']);
	expect(tree.nodes['mobile:body'].children).toEqual(['mobile:text']);
	expect(tree.nodes.text.viewports.desktop.border_box.width).toBe(100);
	expect(tree.nodes['mobile:text'].viewports.desktop.border_box.width).toBe(42);
});

it('uses nearest observed descendants through new wrappers without inventing observations', () => {
	const html = '<html data-blocks-engine-node-id="root"><body><section><p data-blocks-engine-node-id="text">Hello</p></section></body></html>';
	const result = projectExportBoxTree(html, source, 'about/index.html', Buffer.from(html));
	expect(Object.keys(result.nodes)).toEqual(['root', 'text']);
	expect(result.nodes.root.children).toEqual(['text']);
	expect(result.nodes.text.children).toEqual([]);
});
