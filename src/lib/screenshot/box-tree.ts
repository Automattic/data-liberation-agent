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
	// SVG paint: author rules paint retained artwork (icon shapes, badge text), and the
	// consumer does not ship author CSS on evidence routes.
	'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
	'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
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
	kind: 'missing' | 'extra' | 'moved' | 'duplicate' | 'unstamped' | 'unobservable' | 'oversized' | 'stylesheet';
	id?: string;
	parent?: string;
	path: string;
	detail?: string;
};
export type BoxTreeObservation = { nodes: BoxTree['nodes'] } | { mismatch: BoxTreeMismatch };

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
	// Keep in step with captureOwned: generated map leaves use their stamped
	// owner's box; capture-owned script/style elements have no box.
	const owned = (element: Element) => !element.hasAttribute(attribute) && (
		((element.localName === 'script' || element.localName === 'style')
			&& element.getAttributeNames().some(name => name.startsWith('data-blocks-engine-capture-')))
		|| (element.localName === 'iframe' && element.hasAttribute('data-blocks-engine-capture-google-map-embed')
			&& element.parentElement?.hasAttribute(attribute))
	);
	// A successful response is not proof of application: reinsertion can leave
	// a link loading, and titled alternate sets can leave it inactive. Do not
	// read cssRules here: cross-origin sheets are valid, but opaque.
	const sheets = new Set(Array.from(document.styleSheets));
	for (const saved of snapshot.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet" i][href]')) {
		const id = saved.getAttribute(attribute);
		if (id && !Array.from(document.querySelectorAll('link')).some(link => link.getAttribute(attribute) === id)) return {
			mismatch: { kind: 'stylesheet', id, path: 'html>head>link', detail: 'saved author stylesheet missing from observed document' },
		};
	}
	for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet" i][href]')) {
		if (link.hasAttribute('disabled') || (link.media && !matchMedia(link.media).matches)) continue;
		// Unselected alternate sets are intentionally inactive.
		if (link.relList.contains('alternate') && (!link.sheet || link.sheet.disabled)) continue;
		const failed = (globalThis as typeof globalThis & { __captureFailedStylesheets?: WeakSet<HTMLLinkElement> }).__captureFailedStylesheets?.has(link);
		if (failed || !link.sheet || !sheets.has(link.sheet) || link.sheet.disabled) return {
			mismatch: { kind: 'stylesheet', path: 'html>head>link', detail: `author stylesheet not applied: ${link.href}` },
		};
	}
	const retained = [snapshot, ...snapshot.querySelectorAll('*')].filter(element => !owned(element));
	const live = new Map(Array.from(document.querySelectorAll('*'), element => [element.getAttribute(attribute), element]));
	const nodes: BoxTree['nodes'] = {};
	if (retained.length > 100_000) return { mismatch: { kind: 'oversized', path: snapshot.localName, detail: `${retained.length} elements` } };
	for (const saved of retained) {
		const id = saved.getAttribute(attribute);
		const element = id && live.get(id);
		if (!id) return { mismatch: { kind: 'unstamped', path: path(saved) } };
		if (nodes[id]) return { mismatch: { kind: 'duplicate', id, path: path(saved) } };
		if (!element) return { mismatch: { kind: 'missing', id, path: path(saved), detail: 'saved node has no live element' } };
		const children = Array.from(saved.children).filter(child => !owned(child)).map(child => child.getAttribute(attribute)!);
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

const CAPTURE_MARKER_PREFIX = 'data-blocks-engine-capture-';

/**
 * Capture inserts non-rendering script/style elements (the native-control runtime,
 * width-class rules) after observation. They have no box, so every box-tree walk
 * skips them. A generated map iframe is also an unobserved leaf: it fills its
 * stamped owner's observed box. A source element without an id still fails.
 */
function captureOwned(element: AnyNode): boolean {
	if (element.type !== 'tag' && element.type !== 'script' && element.type !== 'style') return false;
	const { attribs, name, parent } = element as TagElement;
	if (NODE_ID_ATTRIBUTE in attribs) return false;
	if (element.type === 'script' || element.type === 'style') return Object.keys(attribs).some(name => name.startsWith(CAPTURE_MARKER_PREFIX));
	return name === 'iframe' && 'data-blocks-engine-capture-google-map-embed' in attribs
		&& !!parent && 'attribs' in parent && NODE_ID_ATTRIBUTE in parent.attribs;
}

function boxElements($: cheerio.CheerioAPI): AnyNode[] {
	return $('*').toArray().filter(element => !captureOwned(element));
}

function boxChildren($: cheerio.CheerioAPI, element: AnyNode): Array<string> {
	return $(element).children().toArray().filter(child => !captureOwned(child)).map(child => $(child).attr(NODE_ID_ATTRIBUTE)!);
}

function savedPath(element: AnyNode): string {
	const parts: string[] = [];
	for (let node: AnyNode | null = element; node && (node.type === 'tag' || node.type === 'script' || node.type === 'style') && parts.length < 8; node = node.parent) {
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
	for (const element of boxElements($)) {
		const id = $(element).attr(NODE_ID_ATTRIBUTE);
		if (!id) mismatch = { kind: 'unstamped', path: savedPath(element) };
		else if (nodes[id]) mismatch = { kind: 'duplicate', id, path: savedPath(element) };
		else if (!tree.nodes[id]) mismatch = { kind: 'extra', id, parent: $(element).parent().attr(NODE_ID_ATTRIBUTE), path: savedPath(element) };
		if (mismatch) break;
		nodes[id!] = { children: boxChildren($, element), viewports: tree.nodes[id!].viewports };
		elements.set(id!, element);
	}
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

/** A debounced resize handler's quiet period, and the most a width may wait for one. */
export const RESIZE_SETTLE = { quietMs: 400, budgetMs: 2_000 };

/**
 * Wait for resize-driven DOM changes to settle before observing another width.
 * Debounced runtime restyles can land hundreds of milliseconds after resize;
 * two frames alone capture the previous width's state, not what a visitor sees.
 * Runs entirely in the page, with a budget so continuous mutations cannot stall capture.
 */
export function settleResize({ quietMs, budgetMs }: typeof RESIZE_SETTLE): Promise<void> {
	return new Promise<void>(resolve => {
		requestAnimationFrame(() => requestAnimationFrame(() => {
			const deadline = performance.now() + budgetMs;
			let last = performance.now();
			const observer = new MutationObserver(() => { last = performance.now(); });
			observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
			const check = () => {
				const now = performance.now();
				if (now - last >= quietMs || now >= deadline) {
					observer.disconnect();
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
					return;
				}
				setTimeout(check, Math.min(quietMs - (now - last), deadline - now) + 1);
			};
			check();
		}));
	});
}

/** Observe extra widths immediately after serialization, keeping only stable ones. */
export async function captureBoxTree(page: Page, html: string, viewports: BoxTree['viewports'], initial?: { name: string; nodes: BoxTree['nodes'] }, onUnproven?: (mismatch: BoxTreeMismatch) => void): Promise<Omit<BoxTree, 'source_path' | 'source_hash'> | undefined> {
	const $ = cheerio.load(html);
	const nodes: BoxTree['nodes'] = {};
	let mismatch: BoxTreeMismatch | undefined;
	for (const element of boxElements($)) {
		const id = $(element).attr(NODE_ID_ATTRIBUTE);
		if (!id || nodes[id]) { mismatch = { kind: id ? 'duplicate' : 'unstamped', id, path: savedPath(element) }; break; }
		nodes[id] = { children: boxChildren($, element), viewports: {} };
	}
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
			await page.evaluate(settleResize, RESIZE_SETTLE);
			const readObservation = () => page.evaluate(({ attribute, properties, topology, html, observerSource }) => {
				// A visitor loading at this width sees the end state, not a resize transition mid-flight.
				for (const animation of document.getAnimations()) if (animation instanceof CSSTransition) animation.finish();
				const live = new Map(Array.from(document.querySelectorAll('*'), element => [element.getAttribute(attribute), element]));
				for (const [id, expected] of Object.entries(topology)) {
					const element = live.get(id);
					if (!element) return;
					// Ignore source-only nodes removed by serialization, but never accept a changed retained tree.
					const children = Array.from(element.children, child => child.getAttribute(attribute)).filter(child => child && topology[child]);
					if (JSON.stringify(children) !== JSON.stringify(expected.children)) return;
				}
				// The protected constructor binds saved probe intrinsics; indirect eval
				// would resolve built-ins from the source page's mutable globals.
				const observe = new Function(`return (${observerSource})`)() as typeof observeBoxTree;
				const observed = observe(new DOMParser().parseFromString(html, 'text/html').documentElement, properties, attribute);
				return 'mismatch' in observed ? observed : { observations: Object.fromEntries(Object.entries(observed.nodes).map(([id, node]) => [id, node.viewports.capture])) };
			}, { attribute: NODE_ID_ATTRIBUTE, properties: BOX_TREE_STYLES, topology: nodes, html, observerSource: observeBoxTree.toString() });
			let reading = await readObservation();
			if (reading && 'mismatch' in reading && reading.mismatch.kind === 'stylesheet') {
				await page.waitForTimeout(250);
				reading = await readObservation();
			}
			if (reading && 'mismatch' in reading && reading.mismatch.kind === 'stylesheet') {
				onUnproven?.(reading.mismatch);
				return;
			}
			const observations = reading && 'observations' in reading ? reading.observations : undefined;
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
