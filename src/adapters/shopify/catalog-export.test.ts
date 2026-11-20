import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { enumerateShopifyProducts, shopifyStructuredContent } from './template-content.js';
import { SourceRequestGovernors, sourceRequestContext } from '../../lib/source-request-governor.js';
import { downloadCaptureSectionMedia } from '../../lib/capture.js';
import { exportWebsiteCapture } from '../../lib/capture-export.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/catalog/${name}.json`, import.meta.url), 'utf8'));
afterEach(() => vi.unstubAllGlobals());

it('exports fixture catalog rows and materializes catalog-only images while reusing page media (#2103)', async () => {
	mkdirSync('.tmp-test', { recursive: true });
	const directory = mkdtempSync(join(process.cwd(), '.tmp-test/catalog-'));
	const source = 'https://example.com/';
	const requests: string[] = [];
	const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>';
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
		const url = new URL(String(input));
		requests.push(url.href);
		if (url.pathname.endsWith('.svg')) return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
		const data = url.pathname === '/collections.json' ? fixture('collections') : url.pathname.startsWith('/collections/') ? { products: [{ handle: 'coffee' }, { handle: 'cups' }] } : url.searchParams.get('page') === '1' ? fixture('products') : { products: [] };
		return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
	}));
	try {
		for (const folder of ['html', 'screenshots', 'resources']) mkdirSync(join(directory, folder));
		writeFileSync(join(directory, 'html/home.html'), '<!doctype html><html><head><title>Shop</title></head><body><img src="https://example.com/shared.svg"></body></html>');
		writeFileSync(join(directory, 'html/coffee.html'), '<!doctype html><html><head><title>Coffee</title></head><body>Coffee</body></html>');
		writeFileSync(join(directory, 'screenshots/manifest.json'), JSON.stringify({ version: 1, entries: {
			[source]: { html: 'html/home.html' }, [`${source}products/coffee`]: { html: 'html/coffee.html' },
		} }));
		const governors = new SourceRequestGovernors();
		const result = await enumerateShopifyProducts(source, { governors });
		expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'product_row_omitted', url: `${source}products/no-price` })]);
		// Verify the page first; the later catalog pass must reuse its fetched image.
		await sourceRequestContext.run(governors, () => downloadCaptureSectionMedia(directory, [source]));
		await sourceRequestContext.run(governors, () => downloadCaptureSectionMedia(directory, [source], undefined, undefined, result.entries.flatMap(entry => entry.product?.images?.map(image => image.src) ?? [])));
		exportWebsiteCapture({ outputDir: directory, sourceUrl: source, platform: 'shopify', summary: {}, failures: [], structuredContent: { source: shopifyStructuredContent, entries: result.entries } });
		const content = JSON.parse(readFileSync(join(directory, 'website/content-index.json'), 'utf8'));
		expect(content.products).toHaveLength(3);
		expect(content.products[0]).toMatchObject({ name: 'Coffee', slug: 'coffee', description: '<p>Roasted</p>', category: 'Coffee', categories: ['Favorites'], tags: ['fresh', 'beans'], regular_price: '10.00', sale_price: '8.00', sku: 'BEAN', stock_status: 'instock', source_path: '/products/coffee/index.html' });
		expect(content.products[0]).not.toHaveProperty('variants');
		expect(content.products[1]).toMatchObject({ regular_price: '12.00', categories: ['Favorites'], variants: [
			{ sku: 'S', regular_price: '12.00', stock_status: 'instock', attributes: [{ key: 'size', label: 'Size', value: 'small', value_label: 'Small' }] },
			{ sku: 'L', regular_price: '20.00', sale_price: '18.00', stock_status: 'outofstock', attributes: [{ key: 'size', label: 'Size', value: 'large', value_label: 'Large' }] },
		] });
		expect(content.products[1]).not.toHaveProperty('source_path');
		expect(content.products[2]).toMatchObject({ slug: 'sold-out', stock_status: 'outofstock', regular_price: '3.00' });
		for (const product of content.products.slice(0, 2)) for (const image of product.images) {
			expect(image.src).toMatch(/^media\//);
			expect(readFileSync(join(directory, 'website', image.src), 'utf8')).toContain('<svg');
		}
		expect(content.products[0].images[0].alt).toBe('Beans');
		expect(content.posts.every((post: object) => !('product' in post))).toBe(true);
		expect(requests.filter(url => url === `${source}shared.svg`)).toHaveLength(1);
		expect(requests.filter(url => url === `${source}catalog.svg`)).toHaveLength(1);
		// Both source URLs have identical bytes and share one emitted asset.
		expect(content.products[0].images[0].src).toBe(content.products[1].images[0].src);
		expect(readdirSync(join(directory, 'website/media'))).toHaveLength(1);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
