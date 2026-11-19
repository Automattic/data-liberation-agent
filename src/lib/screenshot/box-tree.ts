import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import * as cheerio from 'cheerio';
import type { AnyNode, Element as TagElement } from 'domhandler';
import type { Page } from 'playwright';

export const BOX_TREE_SCHEMA = 'blocks-engine/box-tree/v2';
export const NODE_ID_ATTRIBUTE = 'data-blocks-engine-node-id';

/** The v2 used-style vocabulary, including paint, typography and placement. */
export const BOX_TREE_STYLES = [
	'display', 'position', 'box-sizing', 'overflow-x', 'overflow-y',
	'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
	'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
	'row-gap', 'column-gap', 'flex-direction', 'flex-wrap', 'justify-content',
	'align-items', 'align-content', 'flex-grow', 'flex-shrink', 'flex-basis', 'align-self', 'order',
	'grid-template-columns', 'grid-template-rows', 'grid-auto-columns', 'grid-auto-rows',
	'grid-auto-flow', 'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end',
	'justify-items', 'justify-self', 'background-color', 'background-image', 'border-top', 'border-right', 'border-bottom',
	'border-left', 'border-radius', 'outline', 'box-shadow', 'mask-image', 'mask-mode', 'filter', 'opacity',
	'mix-blend-mode', 'transform', 'z-index', 'width', 'height', 'min-width', 'max-width',
	'min-height', 'max-height', 'animation-name', 'transition-property', 'transition-duration',
	'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
	'letter-spacing', 'word-spacing', 'text-align', 'text-transform', 'text-indent',
	'text-decoration-line', 'text-decoration-color', 'text-decoration-style', 'text-shadow',
	'white-space', 'word-break', 'overflow-wrap', 'text-overflow', 'vertical-align',
	'list-style-type', 'list-style-position',
	'top', 'right', 'bottom', 'left', 'float', 'clear', 'visibility', 'aspect-ratio',
	'object-fit', 'object-position', 'transform-origin', 'clip-path', 'isolation',
	'backdrop-filter', 'pointer-events', 'cursor',
	'background-position-x', 'background-position-y', 'background-size', 'background-repeat',
	'background-clip', 'background-origin', 'background-attachment', 'background-blend-mode',
] as const;

type BoxObservation = { border_box: { x: number; y: number; width: number; height: number }; used_styles: Record<string, string> };
type Observation = BoxObservation & { pseudo?: { before?: BoxObservation & { content: string }; after?: BoxObservation & { content: string } } };
export type BoxTree = {
	schema: typeof BOX_TREE_SCHEMA;
	source_path: string;
	source_hash: string;
	viewports: Record<string, { width: number; height: number }>;
	nodes: Record<string, { children: string[]; viewports: Record<string, Observation> }>;
};

/** The first node at which saved bytes and observed topology disagree. */
export type BoxTreeMismatch = {
	/** missing: saved node absent from the live tree; extra: bound bytes hold a node the tree never observed; moved: an observed node sits under another parent or position. */
	kind: 'missing' | 'extra' | 'moved' | 'duplicate' | 'unstamped' | 'unobservable' | 'oversized';
	id?: string;
	parent?: string;
	path: string;
	detail?: string;
};
/** `unwrapped`: identities of proven-inert wrappers the serializer removed but the live page keeps. */
export type BoxTreeObservation = { nodes: BoxTree['nodes']; unwrapped?: string[] } | { mismatch: BoxTreeMismatch };

export function describeBoxTreeMismatch(mismatch: BoxTreeMismatch): string {
	const node = mismatch.id ? ` ${mismatch.id}` : '';
	const parent = mismatch.parent ? ` under ${mismatch.parent}` : '';
	return `${mismatch.kind} node${node}${parent} at ${mismatch.path}${mismatch.detail ? ` (${mismatch.detail})` : ''}`;
}

/** Runs in the serializer's synchronous browser task, against its cleaned snapshot. */
export function observeBoxTree(snapshot: Element, properties: readonly string[], attribute: string): BoxTreeObservation {
	const path = (element: Element) => {
		const parts: string[] = [];
		for (let node: Element | null = element; node && parts.length < 8; node = node.parentElement) {
			const id = node.getAttribute(attribute);
			parts.unshift(`${node.localName}${node.id ? `#${node.id}` : ''}${id ? `[${id}]` : ''}`);
		}
		return parts.join('>');
	};
	const retained = [snapshot, ...snapshot.querySelectorAll('*')];
	const live = new Map(Array.from(document.querySelectorAll('*'), element => [element.getAttribute(attribute), element]));
	const nodes: BoxTree['nodes'] = {};
	if (retained.length > 100_000) return { mismatch: { kind: 'oversized', path: snapshot.localName, detail: `${retained.length} elements` } };
	for (const saved of retained) {
		const id = saved.getAttribute(attribute);
		const element = id && live.get(id);
		if (!id) return { mismatch: { kind: 'unstamped', path: path(saved) } };
		if (nodes[id]) return { mismatch: { kind: 'duplicate', id, path: path(saved) } };
		if (!element) return { mismatch: { kind: 'missing', id, path: path(saved), detail: 'saved node has no live element' } };
		const children = Array.from(saved.children, child => child.getAttribute(attribute)!);
		const rect = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		const used_styles = Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)]));
		const unobservable = (detail: string): BoxTreeObservation => ({ mismatch: { kind: 'unobservable', id, path: path(saved), detail } });
		const badStyle = Object.keys(used_styles).find(property => !used_styles[property] || new TextEncoder().encode(used_styles[property]).length > 4096);
		if (badStyle) return unobservable(`used style ${badStyle}`);
		const border_box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		if (Object.values(border_box).some(value => !Number.isFinite(value) || Math.abs(value) > 100_000_000)) return unobservable('border box');
		const observation: Observation = { border_box, used_styles };
		for (const name of ['before', 'after'] as const) {
			const pseudoStyle = getComputedStyle(element, `::${name}`);
			const content = pseudoStyle.content;
			if (content === 'none' || content === 'normal' || pseudoStyle.display === 'none') continue;
			const pseudoStyles = Object.fromEntries(properties.map(property => [property, pseudoStyle.getPropertyValue(property)]));
			if (Object.values(pseudoStyles).some(value => !value || new TextEncoder().encode(value).length > 4096)
				|| new TextEncoder().encode(content).length > 4096) return unobservable(`::${name} style`);
			// Pseudos have no DOM rect API. Record their computed border-box geometry,
			// with computed left/top offsets, not host viewport coordinates. Unresolved
			// auto dimensions/offsets use zero; the original keywords stay in used_styles.
			const px = (property: string) => Number.parseFloat(pseudoStyle.getPropertyValue(property)) || 0;
			const width = px('width') + (pseudoStyle.boxSizing === 'border-box' ? 0 : px('padding-left') + px('padding-right') + px('border-left-width') + px('border-right-width'));
			const height = px('height') + (pseudoStyle.boxSizing === 'border-box' ? 0 : px('padding-top') + px('padding-bottom') + px('border-top-width') + px('border-bottom-width'));
			const pseudoBox = { x: px('left'), y: px('top'), width, height };
			if (Object.values(pseudoBox).some(value => !Number.isFinite(value) || Math.abs(value) > 100_000_000)) return unobservable(`::${name} border box`);
			(observation.pseudo ??= {})[name] = { content, used_styles: pseudoStyles, border_box: pseudoBox };
		}
		nodes[id] = { children, viewports: { capture: observation } };
	}
	return { nodes };
}

type BoundTree = Omit<BoxTree, 'source_path' | 'source_hash'>;

function savedPath(element: AnyNode): string {
	const parts: string[] = [];
	for (let node: AnyNode | null = element; node && node.type === 'tag' && parts.length < 8; node = node.parent) {
		const tag = node as TagElement;
		const id = tag.attribs[NODE_ID_ATTRIBUTE];
		parts.unshift(`${tag.name}${tag.attribs.id ? `#${tag.attribs.id}` : ''}${id ? `[${id}]` : ''}`);
	}
	return parts.join('>');
}

/** Bind with the first disagreement named, so an unproven sidecar says why. */
export function bindBoxTreeEvidence<T extends BoundTree>(html: string, tree: T | undefined): { tree: T } | { mismatch?: BoxTreeMismatch } {
	if (!tree) return {};
	const $ = cheerio.load(html);
	const nodes: BoxTree['nodes'] = {};
	const elements = new Map<string, AnyNode>();
	let mismatch: BoxTreeMismatch | undefined;
	$('*').each((_index, element) => {
		const id = $(element).attr(NODE_ID_ATTRIBUTE);
		if (!id) mismatch = { kind: 'unstamped', path: savedPath(element) };
		else if (nodes[id]) mismatch = { kind: 'duplicate', id, path: savedPath(element) };
		else if (!tree.nodes[id]) mismatch = { kind: 'extra', id, parent: $(element).parent().attr(NODE_ID_ATTRIBUTE), path: savedPath(element) };
		if (mismatch) return false;
		const children = $(element).children().toArray().map(child => $(child).attr(NODE_ID_ATTRIBUTE)!);
		nodes[id!] = { children, viewports: tree.nodes[id!].viewports };
		elements.set(id!, element);
	});
	if (mismatch) return { mismatch };
	for (const [id, node] of Object.entries(nodes)) {
		const expected = tree.nodes[id].children.filter(child => nodes[child]);
		const index = expected.findIndex((child, position) => node.children[position] !== child);
		const at = index === -1 && node.children.length !== expected.length ? expected.length : index;
		if (at === -1) continue;
		const moved = node.children[at] ?? expected[at];
		return { mismatch: { kind: 'moved', id: moved, parent: id, path: savedPath(elements.get(moved)!), detail: `expected [${expected.slice(at, at + 3).join(',')}] at child ${at}, saved [${node.children.slice(at, at + 3).join(',')}]` } };
	}
	return { tree: { ...tree, nodes } };
}

/** Rebind by identity after projection; added nodes cannot borrow another node's evidence. */
export function bindBoxTree<T extends BoundTree>(html: string, tree: T | undefined): T | undefined {
	const bound = bindBoxTreeEvidence(html, tree);
	return 'tree' in bound ? bound.tree : undefined;
}

/** Observe extra widths immediately after serialization, keeping only stable ones. */
export async function captureBoxTree(page: Page, html: string, viewports: BoxTree['viewports'], initial?: { name: string; nodes: BoxTree['nodes']; unwrapped?: string[] }, onUnproven?: (mismatch: BoxTreeMismatch) => void): Promise<Omit<BoxTree, 'source_path' | 'source_hash'> | undefined> {
	const $ = cheerio.load(html);
	const nodes: BoxTree['nodes'] = {};
	let mismatch: BoxTreeMismatch | undefined;
	$('*').each((_index, element) => {
		const id = $(element).attr(NODE_ID_ATTRIBUTE);
		if (!id || nodes[id]) { mismatch = { kind: id ? 'duplicate' : 'unstamped', id, path: savedPath(element) }; return false; }
		const children = $(element).children().toArray().map(child => $(child).attr(NODE_ID_ATTRIBUTE)!);
		nodes[id] = { children, viewports: {} };
	});
	if (!mismatch && Object.keys(nodes).length > 100_000) mismatch = { kind: 'oversized', path: 'html', detail: `${Object.keys(nodes).length} elements` };
	if (mismatch) { onUnproven?.(mismatch); return; }
	const original = page.viewportSize();
	const stable: BoxTree['viewports'] = {};
	if (initial) {
		const bound = bindBoxTreeEvidence(html, { schema: BOX_TREE_SCHEMA, viewports: {}, nodes: initial.nodes });
		if (!('tree' in bound)) { onUnproven?.(bound.mismatch ?? { kind: 'missing', path: 'html' }); return; }
		if (!original) return;
		stable[initial.name] = original;
		for (const [id, node] of Object.entries(nodes)) node.viewports[initial.name] = bound.tree.nodes[id].viewports.capture;
	}
	try {
		for (const [name, size] of Object.entries(viewports)) {
			if (name === initial?.name) continue;
			await page.setViewportSize(size);
			await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
			const observations = await page.evaluate(({ attribute, properties, topology, html, observerSource, unwrapped }) => {
				const live = new Map(Array.from(document.querySelectorAll('*'), element => [element.getAttribute(attribute), element]));
				const seeThrough = new Set(unwrapped);
				// A wrapper the serializer unwrapped contributes its children in its place.
				const retainedChildren = (element: Element): Array<string | null> => Array.from(element.children).flatMap(child => {
					const id = child.getAttribute(attribute);
					return id && seeThrough.has(id) && !topology[id] ? retainedChildren(child) : [id];
				});
				for (const [id, expected] of Object.entries(topology)) {
					const element = live.get(id);
					if (!element) return;
					// Ignore source-only nodes removed by serialization, but never accept a changed retained tree.
					const children = retainedChildren(element).filter(child => child && topology[child]);
					if (JSON.stringify(children) !== JSON.stringify(expected.children)) return;
				}
				// The protected constructor binds saved probe intrinsics; indirect eval
				// would resolve built-ins from the source page's mutable globals.
				const observe = new Function(`return (${observerSource})`)() as typeof observeBoxTree;
				const observed = observe(new DOMParser().parseFromString(html, 'text/html').documentElement, properties, attribute);
				return 'nodes' in observed ? Object.fromEntries(Object.entries(observed.nodes).map(([id, node]) => [id, node.viewports.capture])) : undefined;
			}, { attribute: NODE_ID_ATTRIBUTE, properties: BOX_TREE_STYLES, topology: nodes, html, observerSource: observeBoxTree.toString(), unwrapped: initial?.unwrapped ?? [] });
			if (!observations) {
				if (!initial && size.width === original?.width && size.height === original?.height) return;
				continue;
			}
			stable[name] = size;
			for (const [id, observation] of Object.entries(observations)) nodes[id].viewports[name] = observation;
		}
	} finally {
		if (original) {
			await page.setViewportSize(original);
			// setViewportSize resolves before the source's resize handlers run.
			// Do not let the next learner record the previous width's classes.
			await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		}
	}
	return Object.keys(stable).length ? { schema: BOX_TREE_SCHEMA, viewports: stable, nodes } : undefined;
}

export function writeBoxTree(outputDir: string, htmlPath: string, tree: Awaited<ReturnType<typeof captureBoxTree>>): void {
	tree = bindBoxTree(readFileSync(htmlPath, 'utf8'), tree);
	if (!tree) return;
	const source_path = relative(outputDir, htmlPath).split('\\').join('/');
	const path = join(outputDir, 'box-tree', source_path.replace(/^html(?:-mobile)?\//, '').replace(/\.html$/, source_path.startsWith('html-mobile/') ? '.mobile.json' : '.json'));
	const content = JSON.stringify({ ...tree, source_path, source_hash: createHash('sha256').update(readFileSync(htmlPath)).digest('hex') });
	if (Buffer.byteLength(content) > 32 * 1024 * 1024) return;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content + '\n');
}

/** Glyph resolution can rewrite saved HTML after browser work is over. Bind final bytes only. */
export function finalizeBoxTreeHashes(outputDir: string): void {
	const directory = join(outputDir, 'box-tree');
	if (!existsSync(directory)) return;
	for (const file of readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.json'))) {
		const path = join(directory, file);
		const previous = JSON.parse(readFileSync(path, 'utf8')) as BoxTree;
		const html = readFileSync(join(outputDir, previous.source_path), 'utf8');
		const bound = bindBoxTree(html, previous);
		if (!bound) { unlinkSync(path); continue; }
		const tree = { ...previous, ...bound };
		tree.source_hash = createHash('sha256').update(html).digest('hex');
		writeFileSync(path, JSON.stringify(tree) + '\n');
	}
}

/**
 * Route-local identity is assigned in document order and kept across later
 * serializations and width changes; newly inserted or cloned nodes get fresh
 * IDs. The serializer reruns this in its own synchronous task, immediately
 * before the snapshot, so a node the source runtime inserts after an earlier
 * stamp is never saved without an identity.
 */
export function assignNodeIds(root: Document, attribute: string): void {
	const elements = Array.from(root.querySelectorAll('*'));
	const used = new Set<string>();
	let next = 0;
	for (const element of elements) {
		const id = element.getAttribute(attribute);
		if (id && /^n\d+$/.test(id) && !used.has(id)) { used.add(id); next = Math.max(next, Number(id.slice(1)) + 1); }
		else element.removeAttribute(attribute);
	}
	for (const element of elements) if (!element.hasAttribute(attribute)) element.setAttribute(attribute, `n${next++}`);
}

/** Stamp before the initial document is serialized, not during interaction probes. */
export async function stampNodeIds(page: Page): Promise<void> {
	await page.evaluate(({ source, attribute }) => {
		(new Function(`return (${source})`)() as typeof assignNodeIds)(document, attribute);
	}, { source: assignNodeIds.toString(), attribute: NODE_ID_ATTRIBUTE });
}
