import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import { BOX_TREE_SCHEMA, NODE_ID_ATTRIBUTE, type BoxTree } from './screenshot/box-tree.js';
import { readResolvedPage } from './site-includes.js';
import type { WebsiteInventory } from './website-inventory.js';

/** Device captures stamp route-local IDs independently; keep their evidence distinct. */
export function namespaceExportBoxTreeIds(html: string): string {
	if (!html.includes(NODE_ID_ATTRIBUTE)) return html;
	if (!html.includes('data-blocks-engine-capture-mobile-document') && !html.includes('data-blocks-engine-capture-middle-document')) return html;
	const $ = cheerio.load(html);
	$('.data-blocks-engine-capture-mobile-document, .data-blocks-engine-capture-middle-document').each((_index, wrapper) => {
		const prefix = $(wrapper).hasClass('data-blocks-engine-capture-mobile-document') ? 'mobile:' : 'middle:';
		$(wrapper).find(`[${NODE_ID_ATTRIBUTE}]`).addBack(`[${NODE_ID_ATTRIBUTE}]`).each((_i, element) => {
			$(element).attr(NODE_ID_ATTRIBUTE, prefix + $(element).attr(NODE_ID_ATTRIBUTE));
		});
	});
	return $.html();
}

/** Export wrappers are unobserved; retained identities keep only their source observations. */
export function projectExportBoxTree(html: string, source: BoxTree, sourcePath: string, bytes: Buffer): BoxTree {
	const $ = cheerio.load(html);
	const nodes: BoxTree['nodes'] = {};
	$(`[${NODE_ID_ATTRIBUTE}]`).each((_index, element) => {
		const id = $(element).attr(NODE_ID_ATTRIBUTE)!;
		if (source.nodes[id]) nodes[id] = { children: [], viewports: source.nodes[id].viewports };
	});
	$(`[${NODE_ID_ATTRIBUTE}]`).each((_index, element) => {
		const id = $(element).attr(NODE_ID_ATTRIBUTE)!;
		if (!nodes[id]) return;
		let parent = element.parent;
		while (parent && parent.type !== 'root') {
			const parentId = $(parent).attr(NODE_ID_ATTRIBUTE);
			if (parentId && nodes[parentId]) { nodes[parentId].children.push(id); break; }
			parent = parent.parent;
		}
	});
	return { schema: source.schema, viewports: source.viewports, source_path: sourcePath,
		source_hash: createHash('sha256').update(bytes).digest('hex'), nodes };
}

/** Called after all HTML rewrites, including shared-part extraction, inside publication. */
export function writeExportBoxTrees(captureRoot: string, websiteDir: string, pages: Array<{ sourcePath: string; mobileSourcePath?: string; middleSourcePath?: string; path: string }>, inventory: WebsiteInventory): string[] {
	const directory = join(captureRoot, 'box-tree');
	if (!existsSync(directory)) return [];
	const sources = new Map<string, string>();
	for (const file of readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.json'))) {
		const path = join(directory, file);
		const tree = JSON.parse(readFileSync(path, 'utf8')) as BoxTree;
		if (tree.schema === BOX_TREE_SCHEMA) sources.set(tree.source_path, path);
	}
	const reports: string[] = [];
	for (const page of pages) {
		const source = sources.get(page.sourcePath);
		if (!source) continue;
		const bytes = readFileSync(join(websiteDir, page.path));
		const captured = JSON.parse(readFileSync(source, 'utf8')) as BoxTree;
		const mobileSource = sources.get(page.mobileSourcePath ?? page.sourcePath.replace(/^html\//, 'html-mobile/'));
		if (mobileSource) {
			const mobile = JSON.parse(readFileSync(mobileSource, 'utf8')) as BoxTree;
			for (const [id, node] of Object.entries(mobile.nodes)) captured.nodes[`mobile:${id}`] = node;
		}
		const middleSource = page.middleSourcePath && sources.get(page.middleSourcePath);
		if (middleSource) {
			const middle = JSON.parse(readFileSync(middleSource, 'utf8')) as BoxTree;
			for (const [id, node] of Object.entries(middle.nodes)) captured.nodes[`middle:${id}`] = node;
		}
		const tree = projectExportBoxTree(readResolvedPage(websiteDir, join(websiteDir, page.path)), captured, page.path, bytes);
		const path = `box-tree/${page.path.replace(/\.html$/, '.json')}`;
		// A captured resource must never be overwritten by generated evidence.
		if (existsSync(join(websiteDir, path))) continue;
		mkdirSync(dirname(join(websiteDir, path)), { recursive: true });
		writeFileSync(join(websiteDir, path), JSON.stringify(tree) + '\n');
		inventory.add(path);
		reports.push(`website/${path}`);
	}
	return reports;
}
