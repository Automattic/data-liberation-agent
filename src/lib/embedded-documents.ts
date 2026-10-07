import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import * as cheerio from 'cheerio';
import type { RuntimeRegionObservation } from './runtime-regions.js';
import type { AcquiredHttpDocument } from './http-acquisition.js';
import { CapturedResourceStore, type CapturedResourceManifest } from './screenshot/resource-capture.js';
import { safeFetch } from './media-fetch/safe-fetch.js';
import { resolveDocumentReferences } from './document-resource-base.js';
import { escapeHtmlAttr } from './html-escape.js';
import { isElementNode } from './html-nodes.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export interface RuntimeRegionAttachment {
	variant: string;
	observation: RuntimeRegionObservation;
}
interface EmbeddedRegion {
	url: string;
	variant: string;
	selector: string;
	index: number;
	documentSha256: string;
	html: string;
	viewport: RuntimeRegionObservation['viewport'];
	projection?: 'subtree' | 'attributes';
	attributes?: Record<string, string>;
	sourcePath?: string;
	sourceSha256?: string;
	htmlSha256?: string;
	childCoverage?: { expected: number; staged: number; unresolved: number };
}
interface EmbeddedReceipt {
	schema: 'data-liberation/embedded-documents/v1';
	regions: EmbeddedRegion[];
	documents: Record<string, { path: string; sha256: string; sourcePath: string; sourceSha256: string }>;
	verification: { rendering: 'unverified'; interactions: 'unverified' };
	presentation?: Array<{
		url: string;
		variant: string;
		documentSha256: string;
		baseUrl: string;
		styles: string;
		sha256: string;
		viewport: RuntimeRegionObservation['viewport'];
		userAgent: string;
		deviceScaleFactor: number;
		sourcePath?: string;
		sourceSha256?: string;
	}>;
	unresolved?: Array<{ url: string; variant: string; selector?: string; index?: number; reason: string }>;
	coverage?: Array<{
		url: string;
		variant: string;
		selector: string;
		expectedNodes: number;
		observedIndices: number[];
		projectedIndices: number[];
	}>;
}

/** Stage observed child documents and dependencies; functional reconstruction remains unverified. */
export async function stageRuntimeRegions(
	options: { outputDir: string; attachments: readonly RuntimeRegionAttachment[] },
	dependencies?: { fetch: typeof safeFetch }
): Promise<string> {
	const acquisition = JSON.parse(readFileSync(join(options.outputDir, 'http-acquisition.json'), 'utf8')) as {
		schema: string;
		documents: AcquiredHttpDocument[];
	};
	if (
		acquisition.schema !== 'data-liberation/http-acquisition/v1' ||
		!Array.isArray(acquisition.documents) ||
		options.attachments.length > 100
	)
		throw new Error('Invalid acquisition or runtime attachment budget');
	const receipt: EmbeddedReceipt = {
		schema: 'data-liberation/embedded-documents/v1',
		regions: [],
		documents: {},
		presentation: [],
		coverage: [],
		verification: { rendering: 'unverified', interactions: 'unverified' },
	};
	const seen = new Set<string>();
	let bytes = 0;
	const pending = new Map<
		string,
		{ url: string; html: string; path: string; sourceHtml: string; sourcePath: string }
	>();
	const projected = new Map<string, { sourceHtml: string; html: string; baseUrl: string }>();
	for (const { variant, observation } of options.attachments) {
		const document = acquisition.documents.find(
			(candidate) =>
				candidate.url === observation.sourceUrl && candidate.variant === variant && candidate.status === 'acquired'
		);
		if (
			!document?.documentSha256 ||
			observation.schema !== 'data-liberation/runtime-regions/v1' ||
			observation.finalUrl !== observation.sourceUrl ||
			!observation.viewport
		)
			throw new Error('Runtime observation does not match acquired document identity');
		const key = JSON.stringify([document.url, variant]);
		if (seen.has(key)) throw new Error('Multiple runtime viewports require explicit selection per variant');
		seen.add(key);
		const prepared = readFileSync(join(options.outputDir, document.documentPath!), 'utf8');
		if (digest(prepared) !== document.documentSha256)
			throw new Error('Runtime attachment prepared-document hash mismatch');
		const source = cheerio.load(prepared);
		if (observation.document) {
			const metadata = observation.document;
			if (
				digest(metadata.styles) !== metadata.stylesSha256 ||
				Buffer.byteLength(metadata.styles) > 256 * 1024 ||
				!/^https?:\/\//.test(metadata.baseUrl)
			)
				throw new Error('Runtime presentation identity mismatch');
			bytes += Buffer.byteLength(metadata.styles);
			receipt.presentation!.push({
				url: document.url,
				variant,
				documentSha256: document.documentSha256,
				baseUrl: metadata.baseUrl,
				styles: metadata.styles,
				sha256: metadata.stylesSha256,
				viewport: observation.viewport,
				userAgent: metadata.userAgent,
				deviceScaleFactor: metadata.deviceScaleFactor,
			});
		}
		if (observation.regions.length > 32 || observation.regions.some((region) => region.nodes.length > 16))
			throw new Error('Runtime observation exceeds region budget');
		for (const region of observation.regions) {
			const declared = document.browserRegions?.find((requirement) => requirement.selector === region.selector);
			const unresolved = (reason: string, index?: number) => {
				(receipt.unresolved ??= []).push({ url: document.url, variant, selector: region.selector, index, reason });
			};
			if (!declared) {
				unresolved('Observation was not declared by the acquisition profile');
				continue;
			}
			if (declared.projection !== region.projection) throw new Error('Undeclared runtime projection');
			const coverage = {
				url: document.url,
				variant,
				selector: region.selector,
				expectedNodes: Math.max(source(region.selector).length, region.matches ?? region.nodes.length),
				observedIndices: [] as number[],
				projectedIndices: [] as number[],
			};
			receipt.coverage!.push(coverage);
			if (region.status !== 'observed')
				unresolved(`${region.status}: ${region.error ?? 'Observation contains incomplete nodes or children'}`);
			for (const node of region.nodes) {
				if (!node.html || !node.sha256) {
					unresolved(node.error ?? 'Parent snapshot is unavailable', node.index);
					continue;
				}
				if (digest(node.html) !== node.sha256) throw new Error('Runtime region identity mismatch');
				if (
					node.frames.length > 16 ||
					Buffer.byteLength(node.html) > 256 * 1024 ||
					!Number.isInteger(node.index) ||
					node.index < 0
				)
					throw new Error('Runtime region exceeds node budget');
				if (coverage.observedIndices.includes(node.index)) throw new Error('Duplicate observed node index');
				coverage.observedIndices.push(node.index);
				if (node.error) unresolved(node.error, node.index);
				if (!node.frames.length && !region.projection) continue;
				bytes += Buffer.byteLength(node.html);
				const $ = cheerio.load(node.html, null, region.projection === 'attributes');
				const root = region.projection === 'attributes' ? $(region.selector).first() : $.root().children().first();
				const original = source(region.selector).eq(node.index);
				if (
					!isElementNode(original[0]) ||
					!isElementNode(root[0]) ||
					original[0].tagName !== root[0].tagName ||
					original.attr('id') !== root.attr('id')
				)
					throw new Error('Runtime projection source-owned identity mismatch');
				const frames = $('iframe');
				const expectedChildren = Math.max(frames.length, node.frames.length);
				const accountedChildren = new Set<number>();
				let attached = 0;
				for (const child of node.frames) {
					const frame = child.owner
						? frames.filter((_, element) => {
								const node = $(element);
								return (
									(node.attr('id') ?? '') === child.owner!.id &&
									(node.attr('src') ?? null) === child.owner!.src &&
									(node.attr('name') ?? null) === child.owner!.name
								);
							})
						: child.index === undefined
							? frames.filter((_, element) => {
									try {
										return new URL($(element).attr('src') ?? '', document.url).href === child.url;
									} catch {
										return false;
									}
								})
							: frames.eq(child.index);
					const index = frame.length === 1 ? frames.toArray().indexOf(frame[0]!) : undefined;
					if (index !== undefined) {
						if (accountedChildren.has(index)) throw new Error('Duplicate observed child index');
						accountedChildren.add(index);
					}
					if (child.html && child.sha256 && digest(child.html) !== child.sha256)
						throw new Error('Child document identity mismatch');
					if (
						child.error ||
						!child.html ||
						!child.sha256 ||
						!child.box ||
						!Number.isFinite(child.box.width) ||
						!Number.isFinite(child.box.height) ||
						child.box.width <= 0 ||
						child.box.height <= 0 ||
						!/^https:\/\//.test(child.url)
					) {
						unresolved(
							`Child ${index ?? 'unknown'}: ${child.error ?? 'Document identity or geometry is incomplete'}`,
							node.index
						);
						continue;
					}
					if (Buffer.byteLength(child.html) > 256 * 1024) throw new Error('Child snapshot exceeds byte budget');
					bytes += Buffer.byteLength(child.html);
					if (frame.length !== 1) {
						unresolved(
							'Observed child is not uniquely addressable in the serialized parent (including shadow content)',
							node.index
						);
						continue;
					}
					const childDocument = cheerio.load(child.html);
					const base = new URL(childDocument('base[href]').first().attr('href') ?? child.url, child.url).href;
					childDocument('script,iframe,noscript,object,embed,meta[http-equiv="refresh"]').remove();
					childDocument('base').remove();
					childDocument('[href],[src],[poster],[action]').each((_, element) => {
						const node = childDocument(element);
						for (const attribute of ['href', 'src', 'poster', 'action']) {
							const value = node.attr(attribute);
							if (value && !value.startsWith('#')) {
								try {
									node.attr(attribute, new URL(value, base).href);
								} catch {
									/* Retain malformed source for sanitizer diagnostics. */
								}
							}
						}
					});
					childDocument('head').prepend(`<base href="${base.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`);
					const html = childDocument.html();
					bytes += Buffer.byteLength(html);
					if (bytes > 16 * 1024 * 1024) throw new Error('Embedded document staging byte budget exceeded');
					const path = `embedded-documents/${digest(html)}.html`;
					const sourcePath = `embedded-source/${child.sha256}.html`;
					const old = receipt.documents[child.url];
					if (old && old.sha256 !== digest(html))
						throw new Error('Conflicting child document bodies for one source URL');
					receipt.documents[child.url] = { path, sha256: digest(html), sourcePath, sourceSha256: child.sha256 };
					pending.set(sourcePath, { url: child.url, html, path, sourcePath, sourceHtml: child.html });
					frame.attr('data-dla-embedded-document', child.url);
					const authoredHeight = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(frame.attr('height') ?? '')?.[1];
					frame.attr('height', authoredHeight ?? String(child.box.height));
					if (!authoredHeight)
						frame.attr('style', `${frame.attr('style') ?? ''};box-sizing:border-box;height:${child.box.height}px`);
					attached++;
				}
				if (frames.length > accountedChildren.size)
					unresolved(`${frames.length - accountedChildren.size} child snapshots were not observed`, node.index);
				if (!region.projection && !attached) continue;
				const baseUrl = observation.document?.baseUrl ?? document.finalUrl ?? document.url;
				const resolved =
					region.projection === 'subtree'
						? resolveDocumentReferences(`<html><body>${$.html()}</body></html>`, document.url, baseUrl)
						: $.html();
				const html = region.projection === 'subtree' ? cheerio.load(resolved)('body').html()! : resolved;
				const sourcePath = `embedded-source/${node.sha256}.html`;
				if (region.projection) projected.set(sourcePath, { sourceHtml: node.html, html, baseUrl });
				receipt.regions.push({
					url: document.url,
					variant,
					selector: region.selector,
					index: node.index,
					documentSha256: document.documentSha256,
					html,
					viewport: observation.viewport,
					childCoverage: { expected: expectedChildren, staged: attached, unresolved: expectedChildren - attached },
					...(region.projection
						? { projection: region.projection, sourcePath, sourceSha256: node.sha256, htmlSha256: digest(html) }
						: {}),
					...(node.attributes ? { attributes: node.attributes } : {}),
				});
				coverage.projectedIndices.push(node.index);
				if (bytes > 16 * 1024 * 1024) throw new Error('Runtime staging byte budget exceeded');
			}
			if (coverage.projectedIndices.length < coverage.expectedNodes)
				unresolved(`${coverage.projectedIndices.length}/${coverage.expectedNodes} declared nodes were projected`);
		}
	}
	mkdirSync(join(options.outputDir, 'embedded-documents'), { recursive: true });
	mkdirSync(join(options.outputDir, 'embedded-source'), { recursive: true });
	const store = new CapturedResourceStore(
		options.outputDir,
		acquisition.documents[0]?.url ?? 'https://example.invalid/',
		dependencies ? (url, maxBytes, timeoutMs) => dependencies.fetch(url, { maxBytes, timeoutMs }) : undefined
	);
	for (const [path, region] of projected) {
		writeFileSync(join(options.outputDir, path), region.sourceHtml);
		await store.captureDomDependencies(region.html, region.baseUrl);
	}
	for (const presentation of receipt.presentation!)
		await store.captureDomDependencies(presentation.styles, presentation.baseUrl);
	for (const child of pending.values()) {
		writeFileSync(join(options.outputDir, child.sourcePath), child.sourceHtml);
		writeFileSync(join(options.outputDir, child.path), child.html);
		await store.captureDomDependencies(child.html, child.url);
	}
	await store.flush();
	// Responsive assembly reconciles class/state differences using inline CSS.
	// Make captured linked rules visible to that existing owner before it aliases
	// viewport-only classes; retaining a global external sheet loses those rules.
	const manifest = JSON.parse(
		readFileSync(join(options.outputDir, 'resources/manifest.json'), 'utf8')
	) as CapturedResourceManifest;
	for (const presentation of receipt.presentation!) {
		const sourcePath = `embedded-source/${presentation.sha256}.styles.html`;
		writeFileSync(join(options.outputDir, sourcePath), presentation.styles);
		presentation.sourcePath = sourcePath;
		presentation.sourceSha256 = presentation.sha256;
		const styles = cheerio.load(presentation.styles, null, false);
		styles('link[rel~="stylesheet"][href]').each((_, element) => {
			const node = styles(element),
				url = new URL(node.attr('href')!, presentation.baseUrl).href;
			const resource = manifest.resources[url];
			if (!resource || !/^text\/css(?:;|$)/i.test(resource.contentType)) {
				(receipt.unresolved ??= []).push({
					url: presentation.url,
					variant: presentation.variant,
					reason: 'Observed stylesheet was not captured',
				});
				return;
			}
			const path = realpathSync(resolve(options.outputDir, resource.path));
			const local = relative(realpathSync(options.outputDir), path);
			if (local === '..' || local.startsWith('../') || isAbsolute(local))
				throw new Error('Runtime CSS escapes acquisition directory');
			const css = readFileSync(path, 'utf8');
			if (/@import\b/i.test(css)) {
				(receipt.unresolved ??= []).push({
					url: presentation.url,
					variant: presentation.variant,
					reason: 'Imported CSS needs responsive selector reconciliation',
				});
				return;
			}
			bytes += Buffer.byteLength(css);
			if (bytes > 16 * 1024 * 1024) throw new Error('Runtime staging byte budget exceeded');
			const resolved = resolveDocumentReferences(
				`<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`,
				presentation.url,
				url
			);
			const style = cheerio.load(resolved)('style');
			if (node.attr('media')) style.attr('media', node.attr('media')!);
			node.replaceWith(cheerio.load(resolved).html(style));
		});
		styles('style').each((_, element) => {
			const node = styles(element);
			if (/@scope\s*\{/i.test(node.text())) {
				(receipt.unresolved ??= []).push({
					url: presentation.url, variant: presentation.variant,
					reason: 'Implicitly scoped stylesheet requires its original document location',
				});
				node.remove();
				return;
			}
			const media = node.attr('media');
			if (media) {
				// Responsive assembly consumes CSS text, not style attributes.
				node.text(`@media ${media}{${node.text()}}`);
				node.removeAttr('media');
			}
		});
		presentation.styles = styles.html();
		presentation.sha256 = digest(presentation.styles);
	}
	const path = join(options.outputDir, 'embedded-documents.json');
	writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n');
	return path;
}

/** Validate attachments before the exporter replaces its candidate directory. */
export function loadEmbeddedDocuments(outputDir: string) {
	const root = realpathSync(outputDir);
	const bytes = readFileSync(join(root, 'embedded-documents.json'));
	if (bytes.length > 32 * 1024 * 1024) throw new Error('Embedded receipt exceeds byte budget');
	const receipt = JSON.parse(bytes.toString('utf8')) as EmbeddedReceipt;
	if (
		receipt.schema !== 'data-liberation/embedded-documents/v1' ||
		!Array.isArray(receipt.regions) ||
		!receipt.documents
	)
		throw new Error('Invalid embedded document receipt');
	if (
		receipt.regions.length > 1600 ||
		Object.keys(receipt.documents).length > 1600 ||
		receipt.regions.some(
			(region) => !Number.isInteger(region.index) || region.index < 0 || typeof region.html !== 'string'
		)
	)
		throw new Error('Invalid embedded region budget or identity');
	const resources: CapturedResourceManifest['resources'] = {};
	for (const region of receipt.regions)
		if (region.projection) {
			const source = realpathSync(resolve(root, region.sourcePath!));
			const local = relative(root, source);
			if (
				local === '..' ||
				local.startsWith('../') ||
				isAbsolute(local) ||
				digest(readFileSync(source)) !== region.sourceSha256 ||
				digest(region.html) !== region.htmlSha256
			)
				throw new Error('Runtime projection identity or containment mismatch');
			if (region.projection === 'attributes') {
				const observed = cheerio.load(readFileSync(source, 'utf8'))(region.selector).first()[0];
				if (
					!isElementNode(observed) ||
					JSON.stringify(Object.entries(observed.attribs).sort()) !==
						JSON.stringify(Object.entries(region.attributes ?? {}).sort())
				)
					throw new Error('Runtime attribute identity mismatch');
			}
		}
	for (const presentation of receipt.presentation ?? []) {
		if (digest(presentation.styles) !== presentation.sha256) throw new Error('Runtime presentation identity mismatch');
		if (presentation.sourcePath) {
			const path = realpathSync(resolve(root, presentation.sourcePath)),
				local = relative(root, path);
			if (
				local === '..' ||
				local.startsWith('../') ||
				isAbsolute(local) ||
				digest(readFileSync(path)) !== presentation.sourceSha256
			)
				throw new Error('Runtime source presentation identity or containment mismatch');
		}
	}
	for (const [url, document] of Object.entries(receipt.documents)) {
		const sourcePath = realpathSync(resolve(root, document.sourcePath));
		const sourceLocal = relative(root, sourcePath);
		if (
			sourceLocal === '..' ||
			sourceLocal.startsWith('../') ||
			isAbsolute(sourceLocal) ||
			digest(readFileSync(sourcePath)) !== document.sourceSha256
		)
			throw new Error('Embedded source identity or containment mismatch');
		const path = realpathSync(resolve(root, document.path));
		const local = relative(root, path);
		if (
			local === '..' ||
			local.startsWith('../') ||
			isAbsolute(local) ||
			digest(readFileSync(path)) !== document.sha256 ||
			!/^https:\/\//.test(url)
		)
			throw new Error('Embedded document identity or containment mismatch');
		resources[url] = { path: local, contentType: 'text/html' };
	}
	return {
		receipt,
		resources,
		evidence: { path: 'embedded-documents.json', sha256: digest(bytes), verification: receipt.verification },
	};
}

export function projectEmbeddedRegions(
	html: string,
	url: string,
	variant: string,
	documentSha256: string | undefined,
	regions: EmbeddedRegion[]
): string {
	const $ = cheerio.load(html);
	for (const region of regions.filter((region) => region.url === url && region.variant === variant)) {
		if (region.documentSha256 !== documentSha256) throw new Error('Runtime attachment prepared-document hash mismatch');
		const node = $(region.selector).eq(region.index);
		if (!node.length) throw new Error('Runtime attachment region is missing from acquired document');
		if (region.projection === 'attributes') {
			const observed = cheerio.load(region.html)(region.selector).first();
			if (
				!isElementNode(node[0]) ||
				!isElementNode(observed[0]) ||
				node[0].tagName !== observed[0].tagName ||
				node.attr('id') !== observed.attr('id')
			)
				throw new Error('Runtime projection source-owned identity mismatch');
			for (const name of Object.keys(node[0].attribs)) if (!/^on/i.test(name) && name !== 'id') node.removeAttr(name);
			for (const [name, value] of Object.entries(region.attributes ?? {}))
				if (!/^on/i.test(name) && name !== 'id') node.attr(name, value);
		} else {
			if (region.projection === 'subtree') {
				const observed = cheerio.load(region.html, null, false).root().children().first();
				if (
					!isElementNode(node[0]) ||
					!isElementNode(observed[0]) ||
					node[0].tagName !== observed[0].tagName ||
					node.attr('id') !== observed.attr('id')
				)
					throw new Error('Runtime projection source-owned identity mismatch');
			}
			node.replaceWith(region.html);
		}
	}
	return $.html();
}

export function projectRuntimePresentation(
	html: string,
	url: string,
	variant: string,
	documentSha256: string,
	receipt: EmbeddedReceipt
): string {
	const presentation = receipt.presentation?.find((row) => row.url === url && row.variant === variant);
	if (!presentation) return html;
	if (presentation.documentSha256 !== documentSha256)
		throw new Error('Runtime presentation prepared-document hash mismatch');
	const $ = cheerio.load(html);
	const styles = cheerio.load(presentation.styles, null, false);
	const original = $('style,link[rel~="stylesheet"]').filter((_, node) =>
		!(isElementNode(node) && node.tagName === 'style' && /@scope\s*\{/i.test($(node).text()))
	);
	const observed = styles
		.root()
		.children('style,link[rel~="stylesheet"]')
		.map((_, node) => styles.html(node))
		.get()
		.join('\n');
	// The observed list is authoritative for stylesheet order. Replacing links
	// in place but appending changed styles last reverses the source cascade.
	// Title, metadata and non-stylesheet head nodes retain their identities.
	const headOriginal = original.filter((_, node) => $(node).parent().is('head'));
	if (headOriginal.length) headOriginal.first().before(observed);
	else $('head').append(observed);
	original.remove();
	const base = $('base').first();
	if (base.length) base.attr('href', presentation.baseUrl);
	else $('head').prepend(`<base href="${escapeHtmlAttr(presentation.baseUrl)}">`);
	return $.html();
}

/** Preserve observed child variants inside an otherwise equivalent parent document. */
export function mergeResponsiveEmbeddedRegions(options: {
	desktop: string;
	mobile: string;
	url: string;
	desktopVariant: string;
	mobileVariant: string;
	receipt: EmbeddedReceipt;
	switchWidth: number;
	scopeClasses: { desktop: string; mobile: string };
}): { desktop: string; mobile: string } {
	const d = cheerio.load(options.desktop),
		m = cheerio.load(options.mobile);
	const rules: string[] = [];
	for (const region of options.receipt.regions.filter(
		(region) => region.url === options.url && region.variant === options.desktopVariant
	)) {
		if (
			!options.receipt.regions.some(
				(candidate) =>
					candidate.url === region.url &&
					candidate.variant === options.mobileVariant &&
					candidate.selector === region.selector &&
					candidate.index === region.index
			)
		)
			continue;
		const desktopNode = d(region.selector).eq(region.index),
			mobileNode = m(region.selector).eq(region.index);
		const frames = ($: cheerio.CheerioAPI, node: ReturnType<typeof d>) =>
			node.is('iframe') ? node : node.find('iframe[data-dla-embedded-document]');
		const df = frames(d, desktopNode),
			mf = frames(m, mobileNode);
		if (df.length !== mf.length) throw new Error('Responsive embedded frame identities differ structurally');
		for (let index = 0; index < df.length; index++) {
			const desktopFrame = df.eq(index),
				mobileFrame = mf.eq(index);
			const desktopSource = desktopFrame.attr('data-dla-embedded-document') ?? '',
				mobileSource = mobileFrame.attr('data-dla-embedded-document') ?? '';
			if (
				options.receipt.documents[desktopSource]?.sha256 === options.receipt.documents[mobileSource]?.sha256 &&
				desktopFrame.attr('height') === mobileFrame.attr('height')
			)
				continue;
			const hook = `dla-embedded-${digest(JSON.stringify([region.url, region.selector, region.index, index])).slice(0, 16)}`;
			const desktopClass = `${hook}-desktop`,
				mobileClass = `${hook}-mobile`;
			const pair = `<span class="${desktopClass} ${options.scopeClasses.desktop}">${d.html(desktopFrame)}</span><span class="${mobileClass} ${options.scopeClasses.mobile}">${m.html(mobileFrame)}</span>`;
			desktopFrame.replaceWith(pair);
			mobileFrame.replaceWith(pair);
			rules.push(
				`.${desktopClass}{display:contents}.${mobileClass}{display:none}@media(max-width:${options.switchWidth}px){.${desktopClass}{display:none}.${mobileClass}{display:contents}}`
			);
		}
	}
	if (rules.length) {
		const style = `<style data-dla-embedded-responsive>${rules.join('\n')}</style>`;
		d('head').append(style);
		m('head').append(style);
	}
	return { desktop: d.html(), mobile: m.html() };
}
