import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
	'justify-items', 'justify-self', 'background', 'border-top', 'border-right', 'border-bottom',
	'border-left', 'border-radius', 'outline', 'box-shadow', 'mask', 'filter', 'opacity',
	'mix-blend-mode', 'transform', 'z-index', 'width', 'height', 'min-width', 'max-width',
	'min-height', 'max-height', 'animation-name', 'transition-property', 'transition-duration',
] as const;

type Observation = { border_box: { x: number; y: number; width: number; height: number }; used_styles: Record<string, string> };
type BoxTree = {
	schema: typeof BOX_TREE_SCHEMA;
	source_path: string;
	source_hash: string;
	viewports: Record<string, { width: number; height: number }>;
	nodes: Record<string, { children: string[]; viewports: Record<string, Observation> }>;
};

/** Observe the same source elements at every width. Never load a serialized copy. */
export async function captureBoxTree(page: Page, html: string, viewports: BoxTree['viewports']): Promise<Omit<BoxTree, 'source_path' | 'source_hash'> | undefined> {
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
	try {
		for (const [name, size] of Object.entries(viewports)) {
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
			if (!observations) return;
			for (const [id, observation] of Object.entries(observations)) nodes[id].viewports[name] = observation;
		}
	} finally {
		if (original) await page.setViewportSize(original);
	}
	return { schema: BOX_TREE_SCHEMA, viewports, nodes };
}

export function writeBoxTree(outputDir: string, htmlPath: string, tree: Awaited<ReturnType<typeof captureBoxTree>>): void {
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
		const tree = JSON.parse(readFileSync(path, 'utf8')) as BoxTree;
		tree.source_hash = createHash('sha256').update(readFileSync(join(outputDir, tree.source_path))).digest('hex');
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
