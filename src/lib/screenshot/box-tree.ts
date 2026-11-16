import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import * as cheerio from 'cheerio';
import type { Page } from 'playwright';

export const BOX_TREE_SCHEMA = 'blocks-engine/box-tree/v1';
export const NODE_ID_ATTRIBUTE = 'data-blocks-engine-node-id';

/** The v1 physical used-style vocabulary, including optional motion evidence. */
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
] as const;

type Observation = { border_box: { x: number; y: number; width: number; height: number }; used_styles: Record<string, string> };
export type BoxTree = {
	schema: typeof BOX_TREE_SCHEMA;
	source_path: string;
	source_hash: string;
	viewports: Record<string, { width: number; height: number }>;
	nodes: Record<string, { children: string[]; viewports: Record<string, Observation> }>;
};

/** Runs in the serializer's synchronous browser task, against its cleaned snapshot. */
export function observeBoxTree(snapshot: Element, properties: readonly string[], attribute: string): BoxTree['nodes'] | undefined {
	const retained = [snapshot, ...snapshot.querySelectorAll('*')];
	const live = new Map(Array.from(document.querySelectorAll('*'), element => [element.getAttribute(attribute), element]));
	const nodes: BoxTree['nodes'] = {};
	if (retained.length > 100_000) return;
	for (const saved of retained) {
		const id = saved.getAttribute(attribute);
		const element = id && live.get(id);
		if (!id || !element || nodes[id]) return;
		const children = Array.from(saved.children, child => child.getAttribute(attribute)!);
		const rect = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		const used_styles = Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)]));
		if (Object.values(used_styles).some(value => !value || new TextEncoder().encode(value).length > 4096)) return;
		const border_box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		if (Object.values(border_box).some(value => !Number.isFinite(value) || Math.abs(value) > 100_000_000)) return;
		nodes[id] = { children, viewports: { capture: { border_box, used_styles } } };
	}
	return nodes;
}

/** Rebind by identity after projection; added nodes cannot borrow another node's evidence. */
export function bindBoxTree(html: string, tree: Omit<BoxTree, 'source_path' | 'source_hash'> | undefined): typeof tree {
	if (!tree) return;
	const $ = cheerio.load(html);
	const nodes: BoxTree['nodes'] = {};
	let valid = true;
	$('*').each((_index, element) => {
		const id = $(element).attr(NODE_ID_ATTRIBUTE);
		if (!id || nodes[id] || !tree.nodes[id]) { valid = false; return; }
		const children = $(element).children().toArray().map(child => $(child).attr(NODE_ID_ATTRIBUTE)!);
		nodes[id] = { children, viewports: tree.nodes[id].viewports };
	});
	for (const [id, node] of Object.entries(nodes)) {
		if (JSON.stringify(tree.nodes[id].children.filter(child => nodes[child])) !== JSON.stringify(node.children)) valid = false;
	}
	return valid ? { ...tree, nodes } : undefined;
}

/** Observe extra widths immediately after serialization, keeping only stable ones. */
export async function captureBoxTree(page: Page, html: string, viewports: BoxTree['viewports'], initial?: { name: string; nodes: BoxTree['nodes'] }): Promise<Omit<BoxTree, 'source_path' | 'source_hash'> | undefined> {
	const $ = cheerio.load(html);
	const nodes: BoxTree['nodes'] = {};
	let valid = true;
	$('*').each((_index, element) => {
		const id = $(element).attr(NODE_ID_ATTRIBUTE);
		if (!id || nodes[id]) { valid = false; return; }
		const children = $(element).children().toArray().map(child => $(child).attr(NODE_ID_ATTRIBUTE)!);
		nodes[id] = { children, viewports: {} };
	});
	if (!valid || Object.keys(nodes).length > 100_000) return;
	const original = page.viewportSize();
	const stable: BoxTree['viewports'] = {};
	if (initial) {
		const bound = bindBoxTree(html, { schema: BOX_TREE_SCHEMA, viewports: {}, nodes: initial.nodes });
		if (!bound || !original) return;
		stable[initial.name] = original;
		for (const [id, node] of Object.entries(nodes)) node.viewports[initial.name] = bound.nodes[id].viewports.capture;
	}
	try {
		for (const [name, size] of Object.entries(viewports)) {
			if (name === initial?.name) continue;
			await page.setViewportSize(size);
			await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
			const observations = await page.evaluate(({ attribute, properties, topology }) => {
				const live = new Map(Array.from(document.querySelectorAll('*'), element => [element.getAttribute(attribute), element]));
				const result: Record<string, Observation> = {};
				for (const [id, expected] of Object.entries(topology)) {
					const element = live.get(id);
					if (!element) return;
					// Ignore source-only nodes removed by serialization, but never accept a changed retained tree.
					const children = Array.from(element.children, child => child.getAttribute(attribute)).filter(child => child && topology[child]);
					if (JSON.stringify(children) !== JSON.stringify(expected.children)) return;
					const rect = element.getBoundingClientRect();
					const style = getComputedStyle(element);
					const used_styles = Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)]));
					if (Object.values(used_styles).some(value => !value || new TextEncoder().encode(value).length > 4096)) return;
					const border_box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
					if (Object.values(border_box).some(value => !Number.isFinite(value) || Math.abs(value) > 100_000_000)) return;
					result[id] = { border_box, used_styles };
				}
				return result;
			}, { attribute: NODE_ID_ATTRIBUTE, properties: BOX_TREE_STYLES, topology: nodes });
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

/** Stamp before the initial document is serialized, not during interaction probes. */
export async function stampNodeIds(page: Page): Promise<void> {
	await page.evaluate(() => {
				// Route-local identity is assigned once, in document order. Keep it across
				// later serializations and width changes; newly inserted nodes get fresh IDs.
				const attribute = 'data-blocks-engine-node-id';
				const elements = Array.from( document.querySelectorAll( '*' ) );
				const used = new Set<string>();
				let next = 0;
				for ( const element of elements ) {
					const id = element.getAttribute( attribute );
					if ( id && /^n\d+$/.test( id ) && ! used.has( id ) ) { used.add( id ); next = Math.max( next, Number( id.slice( 1 ) ) + 1 ); }
					else element.removeAttribute( attribute );
				}
				for ( const element of elements ) if ( ! element.hasAttribute( attribute ) ) element.setAttribute( attribute, `n${ next++ }` );

	});
}
