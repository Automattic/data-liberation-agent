import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import * as cheerio from 'cheerio';
import { BOX_TREE_SCHEMA, NODE_ID_ATTRIBUTE, type BoxTree } from './screenshot/box-tree.js';
import { resolvePage } from './site-includes.js';
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

/** Box-tree sidecar bound to a final page plus the shared parts it includes. */
export type ExportBoxTree = BoxTree & { includes?: Record<string, string> };

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Project captured observations onto the include-resolved document. An element is
 * observed only when its node ID occurs exactly once there and was captured for this
 * route; duplicated, foreign and unstamped elements stay unobserved, and `children`
 * traverse through them to the nearest observed descendants.
 */
export function projectExportBoxTree(html: string, source: BoxTree, sourcePath: string, bytes: Buffer, includes: Record<string, string> = {}): ExportBoxTree {
	const $ = cheerio.load(html);
	const stamped = $(`[${NODE_ID_ATTRIBUTE}]`).toArray();
	const occurrences = new Map<string, number>();
	for (const element of stamped) {
		const id = $(element).attr(NODE_ID_ATTRIBUTE)!;
		occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
	}
	const observed = (id: string | undefined): id is string =>
		id !== undefined && occurrences.get(id) === 1 && Object.hasOwn(source.nodes, id);
	const nodes: BoxTree['nodes'] = {};
	for (const element of stamped) {
		const id = $(element).attr(NODE_ID_ATTRIBUTE);
		if (observed(id)) nodes[id] = { children: [], viewports: source.nodes[id].viewports };
	}
	for (const element of stamped) {
		const id = $(element).attr(NODE_ID_ATTRIBUTE);
		if (!observed(id)) continue;
		let parent = element.parent;
		while (parent && parent.type !== 'root') {
			const parentId = $(parent).attr(NODE_ID_ATTRIBUTE);
			if (observed(parentId)) { nodes[parentId].children.push(id); break; }
			parent = parent.parent;
		}
	}
	return { schema: source.schema, viewports: source.viewports, source_path: sourcePath,
		source_hash: sha256(bytes), ...(Object.keys(includes).length ? { includes } : {}), nodes };
}

/**
 * Called after all HTML rewrites, including shared-part extraction, inside publication.
 * Sidecars are website files (`website/box-tree/<route>.json`), not receipt reports:
 * importers recognize them by path, and listing them as reports too would deliver each
 * file twice. `source_path` and `includes` keys use capture-root paths
 * (`website/about/index.html`), the virtual root importers address artifact files by.
 * Returns the capture-root paths written.
 */
export function writeExportBoxTrees(captureRoot: string, websiteDir: string, pages: Array<{ sourcePath: string; mobileSourcePath?: string; middleSourcePath?: string; path: string }>, inventory: WebsiteInventory): string[] {
	const directory = join(captureRoot, 'box-tree');
	if (!existsSync(directory)) return [];
	const sources = new Map<string, string>();
	for (const file of readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.json'))) {
		const path = join(directory, file);
		const tree = JSON.parse(readFileSync(path, 'utf8')) as BoxTree;
		if (tree.schema === BOX_TREE_SCHEMA) sources.set(tree.source_path, path);
	}
	const written: string[] = [];
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
		const file = join(websiteDir, page.path);
		let resolved: ReturnType<typeof resolvePage>;
		try {
			resolved = resolvePage(websiteDir, file);
		} catch {
			// An unresolvable include leaves the page without evidence rather than unbound evidence.
			continue;
		}
		const includes: Record<string, string> = {};
		for (const part of resolved.files.filter(path => path !== resolve(file)).map(path => relative(resolve(websiteDir), path).split('\\').join('/')).sort())
			includes[`website/${part}`] = sha256(readFileSync(join(websiteDir, part)));
		const tree = projectExportBoxTree(resolved.html, captured, `website/${page.path}`, bytes, includes);
		const path = `box-tree/${page.path.replace(/\.html$/, '.json')}`;
		// A captured resource must never be overwritten by generated evidence.
		if (existsSync(join(websiteDir, path))) continue;
		mkdirSync(dirname(join(websiteDir, path)), { recursive: true });
		writeFileSync(join(websiteDir, path), JSON.stringify(tree) + '\n');
		inventory.add(path);
		written.push(`website/${path}`);
	}
	return written;
}
