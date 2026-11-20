/** Provider-neutral generic/products/v1 row. Image sources become artifact-relative paths at export. */
export interface ProductAttribute {
	key: string;
	label: string;
	value: string;
	value_label: string;
}
export interface ProductVariant {
	regular_price: string;
	sale_price?: string;
	sku?: string;
	stock_status: 'instock' | 'outofstock';
	attributes: ProductAttribute[];
}
export interface ProductRow {
	name: string;
	slug: string;
	description?: string;
	category?: string;
	categories?: string[];
	tags?: string[];
	regular_price: string;
	sale_price?: string;
	sku?: string;
	stock_status: 'instock' | 'outofstock';
	variants?: ProductVariant[];
	images?: Array<{ src: string; alt: string }>;
	source_path?: string;
}
