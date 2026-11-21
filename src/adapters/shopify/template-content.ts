import * as cheerio from 'cheerio';
import { shopifyProductRow } from './product-row.js';
import type { StructuredContentEntry, StructuredContentSource } from '../../platform/types.js';
import { safeFetch } from '../../lib/media-fetch/safe-fetch.js';
import { shopifyStoreFileUrl } from './media-identity.js';

// Descendant .rte selectors also match collapsible rows in common themes.
// Keep one narrow selector shared by equivalence, substitution and template keying.
const BODY = '.product__description, [itemprop="description"], .product-single__description';
const GALLERY = '.product__media img, .product-single__photos img, [data-product-featured-media] img';
interface ProductEntry extends StructuredContentEntry {
	images: string[];
	price?: string;
	optionCount?: number;
}

/** Catalog requests share capture's origin governor, including pagination and failures. */
export async function enumerateShopifyProducts(sourceUrl: string, options: Parameters<StructuredContentSource['enumerate']>[1]) {
	const origin = new URL(sourceUrl).origin;
	const entries: ProductEntry[] = [];
	const diagnostics: Array<{ code: string; url: string; reason: string }> = [];
	let currency: string | undefined;
	for (const path of ['/cart.js', '/meta.json']) {
		try {
			const response = await safeFetch(`${origin}${path}`, { governors: options.governors, timeoutMs: 15_000, maxBytes: 1024 * 1024 });
			const value = response.status === 200 ? JSON.parse(response.body.toString('utf8'))?.currency : undefined;
			if (typeof value === 'string' && /^[A-Z]{3}$/.test(value)) {
				currency = value;
				break;
			}
		} catch { /* Try the fallback endpoint before reporting unavailable currency. */ }
	}
	if (!currency) diagnostics.push({ code: 'product_currency_unavailable', url: origin, reason: 'Store currency unavailable or malformed at /cart.js and /meta.json; product currency omitted' });
	const seen = new Set<string>();
	for (let page = 1; page <= 1000; page++) {
		const url = `${origin}/products.json?limit=250&page=${page}`;
		try {
			const response = await safeFetch(url, { governors: options.governors, timeoutMs: 15_000, maxBytes: 32 * 1024 * 1024 });
			// failure-class: operational
			if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
			const data = JSON.parse(response.body.toString('utf8'));
			// failure-class: operational
			if (!Array.isArray(data.products)) throw new Error('Missing products array');
			if (!data.products.length) break;
			let fresh = 0;
			for (const listed of data.products) {
				// Catalog images name the theme's alias of each file, so page media is reused.
				const product = listed && Array.isArray(listed.images) ? { ...listed, images: listed.images.map((image: { src?: unknown } | null) =>
					typeof image?.src === 'string' ? { ...image, src: shopifyStoreFileUrl(image.src, origin) } : image) } : listed;
				if (!product || typeof product.handle !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(product.handle) ||
					typeof product.title !== 'string' || !product.title.trim() || typeof product.body_html !== 'string' ||
					typeof product.vendor !== 'string' || ![product.published_at, product.updated_at].every(date => typeof date === 'string' && Number.isFinite(Date.parse(date))) ||
					!(typeof product.tags === 'string' || (Array.isArray(product.tags) && product.tags.every((tag: unknown) => typeof tag === 'string')))) {
					diagnostics.push({ code: 'product_rejected', url, reason: 'Malformed product content or metadata' });
					continue;
				}
				if (seen.has(product.handle)) continue;
				seen.add(product.handle);
				fresh++;
				const prices = new Set<string>((Array.isArray(product.variants) ? product.variants : []).map((variant: { price?: unknown } | null) => variant?.price).filter((price: unknown): price is string => typeof price === 'string' && /^\d+\.\d{2}$/.test(price)));
				const row = shopifyProductRow(product, currency);
				if (!row) diagnostics.push({ code: 'product_row_omitted', url: `${origin}/products/${product.handle}`, reason: 'Catalog product has unrepresentable price, stock or option evidence' });
				entries.push({ ...(row ? { product: row } : {}), permalink: `${origin}/products/${product.handle}`, slug: product.handle, kind: 'page', title: product.title,
					contentHtml: product.body_html, published: product.published_at, updated: product.updated_at, author: product.vendor,
					terms: (typeof product.tags === 'string' ? product.tags.split(',') : product.tags).map((tag: string) => tag.trim()).filter(Boolean),
					images: Array.isArray(product.images) ? product.images.flatMap((image: { src?: unknown }) => typeof image?.src === 'string' && /^https?:\/\//.test(image.src) ? [image.src] : []) : [],
					...(prices.size === 1 ? { price: [...prices][0] } : {}),
					...(Array.isArray(product.options) && product.options.length ? { optionCount: product.options.length === 1 &&
						product.options[0]?.name === 'Title' && Array.isArray(product.options[0]?.values) &&
						product.options[0].values.length === 1 && product.options[0].values[0] === 'Default Title' ? 0 : product.options.length } : {}),
				});
			}
			if (!fresh) {
				diagnostics.push({ code: 'product_pagination_stalled', url, reason: 'No new valid products' });
				break;
			}
		} catch (error) {
			diagnostics.push({ code: 'product_page_failed', url, reason: error instanceof Error ? error.message : 'Catalog request failed' });
			break;
		}
	}
	// Collections are optional enrichment: a failed listing never discards products.
	const catalog = new Map(entries.map(entry => [entry.slug, entry]));
	const readPages = async (path: string, key: string, visit: (item: Record<string, unknown>) => void) => {
		for (let page = 1; page <= 100; page++) {
			const url = `${origin}${path}?limit=250&page=${page}`;
			try {
				const response = await safeFetch(url, { governors: options.governors, timeoutMs: 15_000, maxBytes: 32 * 1024 * 1024 });
				const items = response.status === 200 ? JSON.parse(response.body.toString('utf8'))[key] : undefined;
				if (!Array.isArray(items)) {
					diagnostics.push({ code: 'collection_page_failed', url, reason: 'Collection endpoint unavailable or malformed' });
					break;
				}
				for (const item of items) if (item && typeof item === 'object') visit(item);
				if (items.length < 250) break;
			} catch (error) {
				diagnostics.push({ code: 'collection_page_failed', url, reason: error instanceof Error ? error.message : 'Collection request failed' });
				break;
			}
		}
	};
	const collections = new Map<string, string>();
	await readPages('/collections.json', 'collections', item => {
		if (typeof item.handle === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(item.handle)) collections.set(item.handle, typeof item.title === 'string' && item.title.trim() ? item.title : item.handle);
	});
	for (const [handle, title] of collections) await readPages(`/collections/${handle}/products.json`, 'products', item => {
		const entry = catalog.get(String(item.handle));
		if (entry && !entry.terms.includes(`collection:${handle}`)) entry.terms.push(`collection:${handle}`);
		if (entry?.product) entry.product.categories = [...new Set([...(entry.product.categories ?? []), title])];
	});
	return { entries, diagnostics };
}

export function productBodyEquivalent(html: string, entry: StructuredContentEntry): boolean {
	const $ = cheerio.load(html);
	if ($(BODY).length !== 1 || !entry.contentHtml.trim()) return false;
	const signature = (fragment: string) => {
		const doc = cheerio.load(fragment);
		doc('script, style').remove();
		const resolve = (value: string) => { try { return new URL(value, entry.permalink).href; } catch { return value; } };
		const urls = doc('a[href], img[src], [srcset]').toArray().flatMap(node => {
			const element = doc(node);
			return [element.attr('href'), element.attr('src')].filter((value): value is string => value !== undefined).map(resolve)
				.concat((element.attr('srcset') ?? '').split(',').filter(Boolean).map(candidate => {
					const [url, ...descriptor] = candidate.trim().split(/\s+/);
					return `${resolve(url!)} ${descriptor.join(' ')}`.trim();
				}));
		}).sort();
		return JSON.stringify([doc('body').text().replace(/\s+/g, ' ').trim(), urls]);
	};
	return signature($(BODY).html() ?? '') === signature(entry.contentHtml);
}

/** Substitute only proven slots in the source document; ambiguous themes use ordinary acquisition. */
export function productMemberDocument(html: string, representative: StructuredContentEntry, member: StructuredContentEntry): string | undefined {
	if (!productBodyEquivalent(html, representative) || member.kind !== 'page' || !member.contentHtml.trim()) return undefined;
	const rep = representative as Partial<ProductEntry>;
	const next = member as Partial<ProductEntry>;
	const $ = cheerio.load(html);
	const title = $('h1, .product__title, .product-single__title').filter((_, node) => !$(node).find('h1').length);
	const documentTitle = $('head > title');
	if (!title.length || title.toArray().some(node => $(node).text().trim() !== representative.title) ||
		documentTitle.length !== 1 || !documentTitle.text().includes(representative.title)) return undefined;
	const images = $(GALLERY);
	// Keep the source gallery structure. Different cardinality needs ordinary acquisition.
	if (!images.length || !rep.images?.length || !next.images?.length ||
		(images.length !== 1 && (images.length !== rep.images.length || images.length !== next.images.length)) ||
		images.closest('picture').find('source').length) return undefined;
	const sameImage = (a: string, b: string) => {
		try { return new URL(a, representative.permalink).pathname === new URL(b, representative.permalink).pathname; } catch { return false; }
	};
	if (images.toArray().some((node, index) => !sameImage($(node).attr('src') ?? '', rep.images![index]!))) return undefined;
	const prices = $('[itemprop="price"], .price-item--regular, .product-single__price');
	if (!prices.length || !rep.price || !next.price || prices.children().length) return undefined;
	// Preserve each copy's currency decoration only when its numeric formatting is explicit.
	if (prices.toArray().some(node => {
		const text = $(node).text();
		return (text.match(/\d[\d.,]*/g) ?? []).length !== 1 || !text.includes(rep.price!);
	})) return undefined;
	$(BODY).html(member.contentHtml);
	title.text(member.title);
	documentTitle.text(documentTitle.text().replace(representative.title, member.title));
	$('a[href], link[href]').each((_, node) => {
		try { if (new URL($(node).attr('href')!, representative.permalink).href === representative.permalink) $(node).attr('href', member.permalink); } catch { /* Not a URL. */ }
	});
	images.each((index, node) => {
		const image = $(node);
		image.attr('src', next.images![index]!).attr('alt', member.title);
		if (image.attr('srcset')) image.attr('srcset', next.images![index]!);
		image.removeAttr('width height data-src data-srcset');
	});
	prices.each((_, node) => {
		const price = $(node);
		price.text(price.text().replace(rep.price!, next.price!));
		if (price.attr('content')) price.attr('content', next.price!);
	});
	return $.html();
}

/** Gallery, price and variant-picker state a representative must share. */
export function productMemberShape(entry: StructuredContentEntry): string {
	const product = entry as Partial<ProductEntry>;
	return `images=${product.images?.length ?? 0};price=${product.price ? 'single' : 'none'}` +
		(product.optionCount === undefined ? '' : `;options=${product.optionCount === 0 ? 'default' : product.optionCount}`);
}

export const shopifyStructuredContent: StructuredContentSource = {
	enumerate: enumerateShopifyProducts,
	contentSlotSelector: BODY,
	bodyEquivalent: productBodyEquivalent,
	memberDocument: productMemberDocument,
	memberShape: productMemberShape,
	termArchiveUrl: (term, source) => new URL(term.startsWith('collection:') ? `/collections/${encodeURIComponent(term.slice(11))}` : `/collections/all/${encodeURIComponent(term)}`, source).href,
	termName(url) {
		try {
			const path = new URL(url).pathname;
			const tag = /^\/collections\/all\/([^/]+)\/?$/.exec(path);
			if (tag) return decodeURIComponent(tag[1]!);
			const collection = /^\/collections\/([^/]+)\/?$/.exec(path);
			return collection && collection[1] !== 'all' ? `collection:${decodeURIComponent(collection[1]!)}` : undefined;
		} catch { return undefined; }
	},
};
