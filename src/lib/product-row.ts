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

/** Catalog image sources, each row's primary image first: primaries are acquired and budgeted before galleries. */
export function catalogImageSources( rows: ReadonlyArray< ProductRow | undefined > ): { sources: string[]; primary: Set< string > } {
	const primary = new Set( rows.flatMap( row => row?.images?.[ 0 ] ? [ row.images[ 0 ].src ] : [] ) );
	const gallery = rows.flatMap( row => row?.images?.slice( 1 ).map( image => image.src ) ?? [] );
	return { sources: [ ...new Set( [ ...primary, ...gallery ] ) ], primary };
}
