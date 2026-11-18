import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { prepareShopifyDocument } from './acquisition.js';

const context = {
	url: 'https://shop.example/products/woven-throw',
	finalUrl: 'https://shop.example/products/woven-throw',
	variant: 'desktop',
};
const dawn = readFileSync(new URL('./fixtures/dawn-product.html', import.meta.url), 'utf8');

describe('Shopify server-rendered acquisition profiles', () => {
	it('admits a renamed Dawn-family product without Brooklyn body classes', () => {
		const prepared = prepareShopifyDocument(dawn, context);
		expect(prepared?.metadata).toMatchObject({ document: 'shopify-dawn-server-rendered', kind: 'product' });
		const $ = cheerio.load(prepared!.html);
		expect($('.product__info-container h1').text()).toBe('Woven throw');
		expect($('.product__info-container').text()).toContain('$24.00');
		expect($('.product__media-list img').attr('src')).toBe('/cdn/shop/files/throw.jpg');
		expect($('script')).toHaveLength(0);
		expect($('[onclick]')).toHaveLength(0);
		expect(prepared!.browserRegions).toEqual(expect.arrayContaining([
			expect.objectContaining({ selector: 'product-info media-gallery', projection: 'subtree' }),
			expect.objectContaining({ selector: 'product-info .product__info-container', projection: 'subtree' }),
		]));
	});

	it('does not require theme metadata for structurally proven Dawn content', () => {
		expect(prepareShopifyDocument(dawn.replace('Shopify.theme = {"schema_name":"Local Craft"};', ''), context)).toBeDefined();
	});

	it.each([
		['missing product element', (html: string) => html.replaceAll('product-info', 'div')],
		['missing gallery', (html: string) => html.replaceAll('media-gallery', 'div')],
		['missing media list', (html: string) => html.replace('product__media-list', 'unrelated-list')],
		['missing info container', (html: string) => html.replace('product__info-container', 'unrelated-info')],
		['empty title', (html: string) => html.replace('<h1>Woven throw</h1>', '<h1></h1>')],
		['empty gallery', (html: string) => html.replace('<img src="/cdn/shop/files/throw.jpg" alt="Woven throw">', '')],
		['template-only content', (html: string) => html.replace('<product-info', '<template><product-info').replace('</product-info>', '</product-info></template>')],
		['noncanonical document', (html: string) => html.replace('rel="canonical"', 'rel="alternate"')],
		['embedded runtime content', (html: string) => html.replace('</product-info>', '<iframe src="/viewer"></iframe></product-info>')],
	])('refuses Dawn markup with %s', (_, mutate) => {
		expect(prepareShopifyDocument(mutate(dawn), context)).toBeUndefined();
	});

	it('refuses a theme-name claim without structural product evidence', () => {
		const $ = cheerio.load(dawn);
		$('script').text('Shopify.shop = "neutral.myshopify.com"; Shopify.theme = {"schema_name":"Dawn"};');
		$('main').html('<h1>Woven throw</h1><p>Loading product…</p>');
		expect(prepareShopifyDocument($.html(), context)).toBeUndefined();
	});

	it('keeps the Brooklyn product profile and its declared regions unchanged', () => {
		const $ = cheerio.load(dawn);
		$('script').text('Shopify.shop = "neutral.myshopify.com"; Shopify.theme = {"schema_name":"Brooklyn"};');
		$('body').attr('class', 'template-product');
		$('main').html('<div class="product-single__photos"><img src="/cdn/shop/files/throw.jpg"></div><div class="product-single__meta"><h1>Woven throw</h1><p>$24.00</p></div>');
		const prepared = prepareShopifyDocument($.html(), context);
		expect(prepared?.metadata).toMatchObject({ document: 'shopify-brooklyn-server-rendered', kind: 'product' });
		expect(prepared!.browserRegions).toEqual(expect.arrayContaining([
			expect.objectContaining({ selector: '.product-single__photos', projection: 'subtree' }),
			expect.objectContaining({ selector: '.product-single__meta', projection: 'subtree' }),
		]));
		$('.product-single__photos').remove();
		expect(prepareShopifyDocument($.html(), context)).toBeUndefined();
	});
});
