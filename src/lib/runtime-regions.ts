import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { isRouteDrift } from './screenshot/document-integrity.js';
import type { RuntimeRegionRequirement } from '../platform/acquisition.js';

export interface RuntimeRegionNode {
	index: number;
	html?: string;
	sha256?: string;
	box: { x: number; y: number; width: number; height: number };
	visible: boolean;
	frames: Array<{
		url: string;
		index?: number;
		owner?: { id: string; src: string | null; name: string | null };
		html?: string;
		sha256?: string;
		box?: { width: number; height: number };
		error?: string;
	}>;
	error?: string;
	attributes?: Record<string, string>;
}

export interface RuntimeRegionObservation {
	schema: 'data-liberation/runtime-regions/v1';
	sourceUrl: string;
	finalUrl: string;
	viewport: { width: number; height: number } | null;
	regions: Array<
		RuntimeRegionRequirement & {
			status: 'observed' | 'missing' | 'partial' | 'failed';
			nodes: RuntimeRegionNode[];
			matches?: number;
			error?: string;
		}
	>;
	verification: { rendering: 'unverified'; interactions: 'unverified'; projection: 'not_materialized' };
	document?: { baseUrl: string; styles: string; stylesSha256: string; userAgent: string; deviceScaleFactor: number };
	/** Export-only learning provenance; rendering and interactions remain unverified. */
	projection?: Record<string, unknown>;
}

const hash = (html: string) => createHash('sha256').update(html).digest('hex');

/** Observe only declared regions on a caller-owned, ready browser page.
 * Observed DOM is source evidence, not a portable or interactive reconstruction.
 * No navigation, clicks, scrolling or DOM mutation is performed here.
 */
export async function observeRuntimeRegions(
	page: Page,
	sourceUrl: string,
	requirements: readonly RuntimeRegionRequirement[]
): Promise<RuntimeRegionObservation> {
	if (requirements.length > 32 || requirements.some((region) => !region.selector.trim()))
		throw new Error('Runtime observation requires at most 32 nonempty region selectors');
	if (isRouteDrift(page.url(), sourceUrl)) throw new Error('Runtime-region source route drift');
	const regions: RuntimeRegionObservation['regions'] = [];
	let remainingBytes = 2 * 1024 * 1024;
	let remainingFrames = 16;
	const started = Date.now();
	const remainingTime = () => Math.max(1, Math.min(2000, 10_000 - (Date.now() - started)));
	for (const requirement of requirements) {
		const region: RuntimeRegionObservation['regions'][number] = { ...requirement, status: 'failed', nodes: [] };
		regions.push(region);
		if (Date.now() - started >= 10_000) {
			region.error = 'Region observation time budget exhausted';
			continue;
		}
		try {
			const locator = page.locator(requirement.selector);
			const count = await locator.count();
			region.matches = count;
			if (count === 0) {
				region.status = 'missing';
				continue;
			}
			if (count > 16) region.error = `Region match budget exceeded: ${count} matches, first 16 observed`;
			for (let index = 0; index < Math.min(count, 16); index++) {
				if (Date.now() - started >= 10_000) {
					region.error = 'Region observation time budget exhausted';
					break;
				}
				const target = locator.nth(index);
				const snapshot = await target.evaluate(
					(element, projection) => {
						const box = element.getBoundingClientRect();
						const style = getComputedStyle(element);
						const clone = element.cloneNode(projection !== 'attributes') as Element;
						if (projection === 'subtree') {
							const originals = [element, ...element.querySelectorAll('select,input,textarea')];
							const copies = [clone, ...clone.querySelectorAll('select,input,textarea')];
							originals.forEach((original, index) => {
								const copy = copies[index]!;
								if (original instanceof HTMLSelectElement)
									[...(copy as HTMLSelectElement).options].forEach((option, i) =>
										option.toggleAttribute('selected', original.options[i]!.selected)
									);
								if (original instanceof HTMLInputElement && !['password', 'file'].includes(original.type)) {
									copy.setAttribute('value', original.value);
									copy.toggleAttribute('checked', original.checked);
								}
								if (original instanceof HTMLTextAreaElement) copy.textContent = original.value;
							});
						}
						const html = clone.outerHTML;
						return {
							html: html.length <= 256 * 1024 ? html : undefined,
							error: html.length > 256 * 1024 ? 'Region HTML exceeds byte budget' : undefined,
							...(projection === 'attributes'
								? {
										attributes: Object.fromEntries(
											[...element.attributes].map((attribute) => [attribute.name, attribute.value])
										),
									}
								: {}),
							box: { x: box.x, y: box.y, width: box.width, height: box.height },
							visible:
								box.width > 0 &&
								box.height > 0 &&
								style.display !== 'none' &&
								style.visibility !== 'hidden' &&
								style.opacity !== '0' &&
								(typeof element.checkVisibility !== 'function' ||
									element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })),
						};
					},
					requirement.projection,
					{ timeout: remainingTime() }
				);
				const node: RuntimeRegionNode = { ...snapshot, index, frames: [] };
				region.nodes.push(node);
				if (node.html) {
					const bytes = Buffer.byteLength(node.html);
					if (bytes > 256 * 1024 || bytes > remainingBytes) {
						delete node.html;
						node.error = 'Region HTML exceeds byte budget';
					} else {
						remainingBytes -= bytes;
						node.sha256 = hash(node.html);
					}
				}
				if (requirement.projection === 'attributes') continue;
				const handles: Awaited<ReturnType<typeof target.elementHandle>>[] = [];
				const own = await target.elementHandle({ timeout: remainingTime() });
				try {
					if (own && (await own.evaluate((element) => element.tagName === 'IFRAME'))) handles.unshift(own);
					const descendants = target.locator('iframe');
					const childCount = await descendants.count();
					const allowedChildren = Math.max(0, remainingFrames - handles.length);
					if (childCount > allowedChildren) node.error = 'Child-document observation budget exhausted';
					for (let childIndex = 0; childIndex < Math.min(childCount, allowedChildren); childIndex++) {
						if (Date.now() - started >= 10_000) {
							node.error = 'Child-document observation budget exhausted';
							break;
						}
						handles.push(await descendants.nth(childIndex).elementHandle({ timeout: remainingTime() }));
					}
					for (const [index, handle] of handles.entries()) {
						if (!handle) {
							node.error = 'Child element detached';
							continue;
						}
						if (remainingFrames-- <= 0 || Date.now() - started >= 10_000) {
							node.error = 'Child-document observation budget exhausted';
							break;
						}
						const frame = await handle.contentFrame();
						if (!frame) {
							node.frames.push({ url: '', error: 'Child document unavailable' });
							continue;
						}
						const child: RuntimeRegionNode['frames'][number] = { url: frame.url(), index };
						node.frames.push(child);
						try {
							const element = await handle.evaluate((element) => {
								const box = element.getBoundingClientRect();
								return {
									box: { width: box.width, height: box.height },
									owner: { id: element.id, src: element.getAttribute('src'), name: element.getAttribute('name') },
								};
							});
							child.box = element.box;
							child.owner = element.owner;
							// Locator evaluation provides timeout containment for detached/blocked frames.
							const html = await frame
								.locator('html')
								.evaluate(
									(element) =>
										element.outerHTML.length <= 256 * 1024 ? `<!DOCTYPE html>${element.outerHTML}` : undefined,
									undefined,
									{ timeout: remainingTime() }
								);
							if (!html || Buffer.byteLength(html) > 256 * 1024 || Buffer.byteLength(html) > remainingBytes)
								child.error = 'Child HTML exceeds byte budget';
							else if (child.url === 'about:blank' || !/^https?:/.test(child.url))
								child.error = 'Child document is not initialized';
							else {
								child.html = html;
								child.sha256 = hash(html);
								remainingBytes -= Buffer.byteLength(html);
							}
						} catch (error) {
							child.error = String(error);
						}
					}
				} finally {
					for (const handle of handles) await handle?.dispose();
					if (own && !handles.includes(own)) await own.dispose();
				}
			}
			region.status =
				region.error || region.nodes.some((node) => node.error || node.frames.some((frame) => frame.error))
					? 'partial'
					: 'observed';
		} catch (error) {
			region.error = String(error);
		}
	}
	if (isRouteDrift(page.url(), sourceUrl)) throw new Error('Runtime-region source route drift');
	let document: RuntimeRegionObservation['document'];
	if (requirements.some((requirement) => requirement.projection)) {
		const metadata = await page.locator('html').evaluate(
			() => ({
				baseUrl: window.document.baseURI,
				// Document selectors exclude shadow/template styles. Only sheets active
				// in this document participate, including runtime-inserted body siblings.
				styles: [...window.document.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style,link[rel~="stylesheet"]')]
					.filter((node) => node.sheet && !node.sheet.disabled)
					.map((node) => node.outerHTML)
					.join('\n'),
				userAgent: navigator.userAgent,
				deviceScaleFactor: devicePixelRatio,
			}),
			undefined,
			{ timeout: remainingTime() }
		);
		if (Buffer.byteLength(metadata.styles) > 256 * 1024)
			throw new Error('Runtime stylesheet observation exceeds byte budget');
		document = { ...metadata, stylesSha256: hash(metadata.styles) };
	}
	return {
		schema: 'data-liberation/runtime-regions/v1',
		sourceUrl,
		finalUrl: page.url(),
		viewport: page.viewportSize(),
		regions,
		...(document ? { document } : {}),
		verification: { rendering: 'unverified', interactions: 'unverified', projection: 'not_materialized' },
	};
}
