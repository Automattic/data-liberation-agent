import type { ProductRow, ProductVariant } from '../../lib/product-row.js';

const decimal = (value: unknown): value is string => typeof value === 'string' && /^\d+(?:\.\d{1,2})?$/.test(value) && Number.isFinite(Number(value));
/** Shopify handles may be Unicode; reject only what cannot be one path segment. */
export const safeHandle = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value !== '' && value !== '.' && value !== '..' && !/[\s\p{C}/\\?#%]/u.test(value);
const token = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Fail closed rather than inventing a slug, price, availability or option identity. */
export function shopifyProductRow(product: Record<string, any>): ProductRow | undefined {
	if (!safeHandle(product.handle) || typeof product.title !== 'string' || !product.title.trim() || !Array.isArray(product.variants) || !product.variants.length) return undefined;
	const options = product.options;
	if (!Array.isArray(options) || !options.length || options.length > 3) return undefined;
	// One variant is a simple product whatever its placeholder option is called (#2141).
	const simple = product.variants.length === 1;
	const combinations = new Set<string>();
	const variants: ProductVariant[] = [];
	for (const variant of product.variants) {
		if (!variant || !decimal(variant.price) || typeof variant.available !== 'boolean') return undefined;
		if (variant.compare_at_price != null && variant.compare_at_price !== '' && !decimal(variant.compare_at_price)) return undefined;
		const sale = decimal(variant.compare_at_price) && Number(variant.compare_at_price) > Number(variant.price);
		const attributes = [];
		if (!simple) for (const [index, option] of options.entries()) {
			const value = variant[`option${index + 1}`];
			if (typeof option?.name !== 'string' || typeof value !== 'string' || !token(option.name) || !token(value) || !Array.isArray(option.values) || !option.values.includes(value)) return undefined;
			attributes.push({ key: token(option.name), label: option.name, value: token(value), value_label: value });
		}
		if (new Set(attributes.map(attribute => attribute.key)).size !== attributes.length) return undefined;
		const combination = JSON.stringify(attributes.map(attribute => [attribute.key, attribute.value]));
		if (combinations.has(combination)) return undefined;
		combinations.add(combination);
		variants.push({ regular_price: sale ? variant.compare_at_price : variant.price, ...(sale ? { sale_price: variant.price } : {}),
			...(typeof variant.sku === 'string' && variant.sku.trim() ? { sku: variant.sku } : {}), stock_status: variant.available ? 'instock' : 'outofstock', attributes });
	}
	const cheapest = variants.reduce((a, b) => Number(a.regular_price) <= Number(b.regular_price) ? a : b);
	const images = Array.isArray(product.images) ? product.images.flatMap((image: any) => typeof image?.src === 'string' && /^https?:\/\//.test(image.src) ? [{ src: image.src, alt: typeof image.alt === 'string' && image.alt ? image.alt : product.title }] : []) : [];
	const gallery = images.filter((image: { src: string }, index: number) => images.findIndex((other: { src: string }) => other.src === image.src) === index);
	return { name: product.title, slug: product.handle, description: product.body_html,
		...(typeof product.product_type === 'string' && product.product_type ? { category: product.product_type } : {}),
		tags: [...new Set<string>((typeof product.tags === 'string' ? product.tags.split(',') : product.tags ?? []).map((tag: string) => tag.trim()).filter(Boolean))],
		regular_price: cheapest.regular_price, ...(cheapest.sale_price ? { sale_price: cheapest.sale_price } : {}),
		...(simple && cheapest.sku ? { sku: cheapest.sku } : {}), stock_status: variants.some(variant => variant.stock_status === 'instock') ? 'instock' : 'outofstock',
		...(!simple ? { variants } : {}), ...(gallery.length ? { images: gallery } : {}) };
}
