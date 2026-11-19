import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import * as cheerio from 'cheerio';
import { BOX_TREE_SCHEMA, NODE_ID_ATTRIBUTE, type BoxTree } from './screenshot/box-tree.js';
import { resolvePage } from './site-includes.js';
import type { WebsiteInventory } from './website-inventory.js';

const DEVICE_DOCUMENT_WRAPPERS = '.data-blocks-engine-capture-mobile-document, .data-blocks-engine-capture-middle-document';
const MOBILE_ONLY_FRAGMENT = '.data-blocks-engine-capture-mobile-only';

/**
 * Device captures stamp route-local IDs independently; keep their evidence distinct.
 * Phone and middle documents namespace their whole subtree. A phone-only fragment
 * grafted into the desktop document (#1994) carries the phone capture's IDs, which
 * collide with unrelated desktop nodes, so it takes the same `mobile:` namespace.
 */
export function namespaceExportBoxTreeIds(html: string): string {
	if (!html.includes(NODE_ID_ATTRIBUTE)) return html;
	if (!html.includes('data-blocks-engine-capture-mobile-document') && !html.includes('data-blocks-engine-capture-middle-document')
		&& !html.includes('data-blocks-engine-capture-mobile-only')) return html;
	const $ = cheerio.load(html);
	$(DEVICE_DOCUMENT_WRAPPERS).each((_index, wrapper) => {
		const prefix = $(wrapper).hasClass('data-blocks-engine-capture-mobile-document') ? 'mobile:' : 'middle:';
		$(wrapper).find(`[${NODE_ID_ATTRIBUTE}]`).addBack(`[${NODE_ID_ATTRIBUTE}]`).each((_i, element) => {
			$(element).attr(NODE_ID_ATTRIBUTE, prefix + $(element).attr(NODE_ID_ATTRIBUTE));
		});
	});
	$(MOBILE_ONLY_FRAGMENT).filter((_index, fragment) => $(fragment).closest(DEVICE_DOCUMENT_WRAPPERS).length === 0).each((_index, fragment) => {
		$(fragment).find(`[${NODE_ID_ATTRIBUTE}]`).addBack(`[${NODE_ID_ATTRIBUTE}]`).each((_i, element) => {
			const id = $(element).attr(NODE_ID_ATTRIBUTE)!;
			// Nested fragments are visited once per enclosing fragment.
			if (!id.startsWith('mobile:')) $(element).attr(NODE_ID_ATTRIBUTE, `mobile:${id}`);
		});
	});
	return $.html();
}

/** Whether the page serves separate width-selected phone or middle documents. */
const hasDeviceDocuments = (html: string): boolean =>
	(html.includes('data-blocks-engine-capture-mobile-document') || html.includes('data-blocks-engine-capture-middle-document'))
	&& cheerio.load(html)(DEVICE_DOCUMENT_WRAPPERS).length > 0;

/**
 * Largest box-tree sidecar export writes, including JSON encoding and newline.
 * Coupled to Static Site Importer's compiler `max_file_bytes` (10 MiB): it refuses
 * the whole request bundle when any source file is over it, so an oversized sidecar
 * would turn optional geometry evidence into a failed import. Change both together.
 */
export const MAX_BOX_TREE_FILE_BYTES = 10 * 1024 * 1024;

/** Box-tree sidecar bound to a final page plus the shared parts it includes. */
export type ExportBoxTree = BoxTree & { includes?: Record<string, string> };

/**
 * Schema of every exported sidecar: the captured v2 tree with each distinct `used_styles`
 * object stored once in a top-level `styles` list, and every node and pseudo observation's
 * `used_styles` replaced by its index there. Long pages repeat few distinct style sets, so
 * this keeps their evidence well under the importer's per-file limit. Readers expand it
 * back to v2; one that predates it rejects the sidecar with a warning and converts without
 * evidence. Capture's own `box-tree/` sidecars stay v2.
 */
export const EXPORT_BOX_TREE_SCHEMA = 'blocks-engine/box-tree/v3';

type BoxObservation = BoxTree['nodes'][string]['viewports'][string];
type CompactBox = Omit<BoxObservation, 'used_styles' | 'pseudo'> & { used_styles: number };
type CompactObservation = CompactBox & { pseudo?: { before?: CompactBox & { content: string }; after?: CompactBox & { content: string } } };
export type CompactExportBoxTree = Omit<ExportBoxTree, 'schema' | 'nodes'> & {
	schema: typeof EXPORT_BOX_TREE_SCHEMA;
	styles: Array<Record<string, string>>;
	nodes: Record<string, { children: string[]; viewports: Record<string, CompactObservation> }>;
};

/** Lossless: the same tree with each distinct `used_styles` object stored once. */
export function compactBoxTree(tree: ExportBoxTree): CompactExportBoxTree {
	const styles: Array<Record<string, string>> = [];
	const indexes = new Map<string, number>();
	const intern = (used: Record<string, string>): number => {
		const key = JSON.stringify(used);
		let index = indexes.get(key);
		if (index === undefined) {
			index = styles.push(used) - 1;
			indexes.set(key, index);
		}
		return index;
	};
	const nodes: CompactExportBoxTree['nodes'] = {};
	for (const [id, node] of Object.entries(tree.nodes)) {
		const viewports: Record<string, CompactObservation> = {};
		for (const [name, { pseudo, ...observation }] of Object.entries(node.viewports)) {
			const compact: CompactObservation = { ...observation, used_styles: intern(observation.used_styles) };
			if (pseudo) {
				compact.pseudo = {};
				for (const side of ['before', 'after'] as const) {
					const value = pseudo[side];
					if (value) compact.pseudo[side] = { ...value, used_styles: intern(value.used_styles) };
				}
			}
			viewports[name] = compact;
		}
		nodes[id] = { ...node, viewports };
	}
	return { ...tree, schema: EXPORT_BOX_TREE_SCHEMA, styles, nodes };
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Project captured observations onto the include-resolved document. An element is
 * observed only when its node ID occurs exactly once there, was captured for this
 * route and carries an observation for every declared viewport; duplicated, foreign,
 * partially observed and unstamped elements stay unobserved, and `children` traverse
 * through them to the nearest observed descendants. Undeclared observations are not
 * carried.
 */
export function projectExportBoxTree(html: string, source: BoxTree, sourcePath: string, bytes: Buffer, includes: Record<string, string> = {}): ExportBoxTree {
	const $ = cheerio.load(html);
	const stamped = $(`[${NODE_ID_ATTRIBUTE}]`).toArray();
	const occurrences = new Map<string, number>();
	for (const element of stamped) {
		const id = $(element).attr(NODE_ID_ATTRIBUTE)!;
		occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
	}
	const declared = Object.keys(source.viewports);
	const observed = (id: string | undefined): id is string =>
		id !== undefined && occurrences.get(id) === 1 && Object.hasOwn(source.nodes, id)
		&& declared.every(viewport => Object.hasOwn(source.nodes[id].viewports, viewport));
	const nodes: BoxTree['nodes'] = {};
	for (const element of stamped) {
		const id = $(element).attr(NODE_ID_ATTRIBUTE);
		if (observed(id)) nodes[id] = { children: [], viewports: Object.fromEntries(declared.map(viewport => [viewport, source.nodes[id].viewports[viewport]])) };
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

/** Element identity independent of route-local numbering: tag plus authored `id`. */
const signaturesOf = (html: string): Map<string, string> => {
	const $ = cheerio.load(html);
	return new Map($(`[${NODE_ID_ATTRIBUTE}]`).toArray().map(element => [$(element).attr(NODE_ID_ATTRIBUTE)!, `${element.tagName}#${$(element).attr('id') ?? ''}`]));
};

const rootsOf = (tree: BoxTree): string[] => {
	const children = new Set(Object.values(tree.nodes).flatMap(node => node.children));
	return Object.keys(tree.nodes).filter(id => !children.has(id));
};

/** Longest common subsequence of two sibling lists by signature; bounded per parent. */
const alignSiblings = (left: string[], right: string[], key: (side: 0 | 1, id: string) => string | undefined): Array<[string, string]> => {
	if (left.length * right.length > 1_000_000) return [];
	const lengths = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
	for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
		const same = key(0, left[i]) !== undefined && key(0, left[i]) === key(1, right[j]);
		lengths[i][j] = same ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
	}
	const pairs: Array<[string, string]> = [];
	for (let i = 0, j = 0; i < left.length && j < right.length;) {
		if (key(0, left[i]) !== undefined && key(0, left[i]) === key(1, right[j])) pairs.push([left[i++], right[j++]]);
		else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++;
		else j++;
	}
	return pairs;
};

/**
 * The exported page is one document served at every width, so its sidecar must carry
 * the phone observation too (#1943). Phone and desktop captures stamp route-local IDs
 * independently, in document order, so equal IDs need not name the same element: an
 * element absent from one document shifts every later number. Correspondence is
 * structural instead: matched parents (starting at the roots) align their children
 * by tag and authored `id`. A desktop node takes its counterpart's `mobile`
 * observation unless the desktop capture already observed this document at that
 * viewport. Unmatched nodes stay without one and are dropped at projection. The phone
 * capture's other viewports describe the phone document, never this one.
 */
export function mergeMobileBoxTree(desktop: BoxTree, desktopHtml: string, mobile: BoxTree, mobileHtml: string): BoxTree {
	const size = mobile.viewports.mobile;
	if (!size) return desktop;
	const signatures = [signaturesOf(desktopHtml), signaturesOf(mobileHtml)] as const;
	const trees = [desktop, mobile] as const;
	const key = (side: 0 | 1, id: string) => Object.hasOwn(trees[side].nodes, id) ? signatures[side].get(id) : undefined;
	const counterpart = new Map<string, string>();
	const pending = alignSiblings(rootsOf(desktop), rootsOf(mobile), key);
	for (let pair = pending.pop(); pair; pair = pending.pop()) {
		const [left, right] = pair;
		counterpart.set(left, right);
		pending.push(...alignSiblings(desktop.nodes[left].children, mobile.nodes[right].children, key));
	}
	const nodes: BoxTree['nodes'] = {};
	for (const [id, node] of Object.entries(desktop.nodes)) {
		const match = counterpart.get(id);
		const observation = node.viewports.mobile ?? (match === undefined ? undefined : mobile.nodes[match].viewports.mobile);
		nodes[id] = { children: node.children, viewports: { ...node.viewports, ...(observation ? { mobile: observation } : {}) } };
	}
	return { ...desktop, viewports: { ...desktop.viewports, mobile: desktop.viewports.mobile ?? size }, nodes };
}

/**
 * Called after all HTML rewrites, including shared-part extraction, inside publication.
 * Sidecars are website files (`website/box-tree/<route>.json`), not receipt reports:
 * importers recognize them by path, and listing them as reports too would deliver each
 * file twice. `source_path` and `includes` keys use capture-root paths
 * (`website/about/index.html`), the virtual root importers address artifact files by.
 * Returns the capture-root paths written.
 */
export function writeExportBoxTrees(captureRoot: string, websiteDir: string, pages: Array<{ sourcePath: string; mobileSourcePath?: string; path: string }>, inventory: WebsiteInventory, excludedBoxTrees: ReadonlyMap<string, number> = new Map(), maxFileBytes = MAX_BOX_TREE_FILE_BYTES): string[] {
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
		const path = `box-tree/${page.path.replace(/\.html$/, '.json')}`;
		if (excludedBoxTrees.has(path)) continue;
		const source = sources.get(page.sourcePath);
		if (!source) continue;
		const bytes = readFileSync(join(websiteDir, page.path));
		let captured = JSON.parse(readFileSync(source, 'utf8')) as BoxTree;
		const file = join(websiteDir, page.path);
		let resolved: ReturnType<typeof resolvePage>;
		try {
			resolved = resolvePage(websiteDir, file);
		} catch {
			// An unresolvable include leaves the page without evidence rather than unbound evidence.
			continue;
		}
		const mobileSource = sources.get(page.mobileSourcePath ?? page.sourcePath.replace(/^html\//, 'html-mobile/'));
		const mobile = mobileSource ? JSON.parse(readFileSync(mobileSource, 'utf8')) as BoxTree : undefined;
		if (hasDeviceDocuments(resolved.html)) {
			// An assembled page namespaces its phone and middle documents' identities.
			// At phone width its desktop wrapper is not what renders, so no node has a
			// phone observation of this page: declaring the width leaves them unobserved
			// rather than projecting desktop geometry onto phones.
			const size = captured.viewports.mobile ?? mobile?.viewports.mobile;
			if (size) captured = { ...captured, viewports: { ...captured.viewports, mobile: size },
				nodes: Object.fromEntries(Object.entries(captured.nodes).map(([id, node]) => [id, { ...node, viewports: Object.fromEntries(Object.entries(node.viewports).filter(([name]) => name !== 'mobile')) }])) };
		} else if (mobile) {
			const desktopHtml = join(captureRoot, captured.source_path);
			const mobileHtml = join(captureRoot, mobile.source_path);
			captured = mergeMobileBoxTree(captured, existsSync(desktopHtml) ? readFileSync(desktopHtml, 'utf8') : '', mobile, existsSync(mobileHtml) ? readFileSync(mobileHtml, 'utf8') : '');
		}
		const includes: Record<string, string> = {};
		for (const part of resolved.files.filter(path => path !== resolve(file)).map(path => relative(resolve(websiteDir), path).split('\\').join('/')).sort())
			includes[`website/${part}`] = sha256(readFileSync(join(websiteDir, part)));
		const tree = projectExportBoxTree(resolved.html, captured, `website/${page.path}`, bytes, includes);
		// A captured resource must never be overwritten by generated evidence.
		if (existsSync(join(websiteDir, path))) continue;
		const content = JSON.stringify(compactBoxTree(tree)) + '\n';
		const contentBytes = Buffer.byteLength(content);
		// Optional evidence: the page imports without it, but not with a file the importer refuses.
		if (contentBytes > maxFileBytes) {
			process.stderr.write(`[budget] box-tree sidecar website/${path} is ${contentBytes} bytes, over the ${maxFileBytes}-byte per-file limit; not written\n`);
			continue;
		}
		mkdirSync(dirname(join(websiteDir, path)), { recursive: true });
		writeFileSync(join(websiteDir, path), content);
		inventory.add(path);
		written.push(`website/${path}`);
	}
	return written;
}
