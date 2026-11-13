import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cheerio from 'cheerio';
import { SourceRequestGovernors } from '../../lib/source-request-governor.js';
import { templateFingerprint } from '../../lib/template-groups.js';
import { shopifyAdapter } from './index.js';
import { enumerateShopifyProducts, productBodyEquivalent, productMemberDocument, shopifyStructuredContent } from './template-content.js';

const product = (handle: string) => ({ handle, title: `Product ${handle}`, body_html: '<p>Neutral <a href="/pages/details">description</a><img src="/body.png"></p>', vendor: 'Example vendor', tags: ['Sample'], published_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-02T00:00:00Z', images: [{ src: `https://example.com/${handle}.png` }], variants: [{ price: handle === 'one' ? '10.00' : '20.00' }] });
const entry = (handle: string) => ({ permalink: `https://example.com/products/${handle}`, slug: handle, kind: 'page' as const, title: `Product ${handle}`, contentHtml: product(handle).body_html, published: product(handle).published_at, updated: product(handle).updated_at, author: 'Example vendor', terms: ['Sample'], images: [`https://example.com/${handle}.png`], price: handle === 'one' ? '10.00' : '20.00' });
const document = `<html><head><title>Product one — Example store</title><link rel="canonical" href="/products/one"></head><body class="template-product"><main><h1>Product one</h1><div class="product__description">${entry('one').contentHtml}</div><div class="product__media"><img src="/one.png" srcset="/one.png 400w" width="400"></div><span class="price-item--regular">$10.00</span><a href="/products/one">Self</a></main></body></html>`;
afterEach(() => vi.unstubAllGlobals());

describe('Shopify structured catalog', () => {
	it('paginates through the supplied governor, rejects malformed entries and enriches collections', async () => {
		let throttled = false;
		const requests: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			requests.push(url);
			if (!throttled) { throttled = true; return new Response('', { status: 429, headers: { 'Retry-After': '0' } }); }
			const path = new URL(url).pathname;
			const page = new URL(url).searchParams.get('page');
			const data = path === '/collections.json' ? { collections: [{ handle: 'samples' }] } : path.startsWith('/collections/') ? { products: [{ handle: 'one' }] } : { products: page === '1' ? [product('one'), { handle: '../bad' }] : page === '2' ? [product('two')] : [] };
			return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
		}));
		const governors = new SourceRequestGovernors({ maxRetryAfterMs: 0 });
		const admission = vi.spyOn(governors, 'forOrigin');
		const result = await enumerateShopifyProducts('https://example.com/', { governors });
		expect(result.entries.map(item => item.slug)).toEqual(['one', 'two']);
		expect(result.entries[0]).toMatchObject({ ...entry('one'), terms: ['Sample', 'collection:samples'] });
		expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'product_rejected' })]);
		expect(requests.filter(url => url === 'https://example.com/products.json?limit=250&page=1')).toHaveLength(2);
		expect(admission).toHaveBeenCalledTimes(5);
		expect(shopifyAdapter.structuredContent).toBe(shopifyStructuredContent);
	});

	it('reports unavailable catalog pages instead of silently dropping them', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
		const result = await enumerateShopifyProducts('https://example.com/', { governors: new SourceRequestGovernors() });
		expect(result.entries).toEqual([]);
		expect(result.diagnostics[0]?.code).toBe('product_page_failed');
	});

	it('requires one complete description with matching text and resolved URLs', () => {
		expect(productBodyEquivalent(document, entry('one'))).toBe(true);
		expect(productBodyEquivalent(document.replace('/body.png', '/other.png'), entry('one'))).toBe(false);
		expect(productBodyEquivalent(document.replace('/pages/details', '/pages/other'), entry('one'))).toBe(false);
		expect(productBodyEquivalent(document.replace('Neutral', 'Truncated'), entry('one'))).toBe(false);
		expect(productBodyEquivalent(`${document}<div itemprop="description">Duplicate</div>`, entry('one'))).toBe(false);
	});

	it('keeps Dawn collapsible rows outside the description slot', () => {
		const dawn = document.replace('<div class="product__description">', '<div class="product__info-container"><div class="product__description rte">')
			.replace('</main>', '<div class="rte">Shipping information</div><div class="rte">Care information</div></div></main>');
		const $ = cheerio.load(dawn);
		expect($('.product__info-container .rte')).toHaveLength(3);
		expect($(shopifyStructuredContent.contentSlotSelector!)).toHaveLength(1);
		expect(productBodyEquivalent(dawn, entry('one'))).toBe(true);
		const member = { ...entry('two'), contentHtml: '<p>Another description</p>' };
		const result = productMemberDocument(dawn, entry('one'), member);
		expect(result).toBeDefined();
		const rendered = cheerio.load(result!);
		expect(rendered(shopifyStructuredContent.contentSlotSelector!).html()).toBe(member.contentHtml);
		expect(rendered('.product__info-container .rte').map((_, node) => rendered(node).text()).get())
			.toEqual(['Another description', 'Shipping information', 'Care information']);
	});

	it('substitutes source slots, featured image, price and self links', () => {
		const member = { ...entry('two'), contentHtml: '<p>Another description</p>' };
		const result = productMemberDocument(document, entry('one'), member);
		expect(result).toBeDefined();
		const $ = cheerio.load(result!);
		expect($('h1').text()).toBe('Product two');
		expect($('title').text()).toBe('Product two — Example store');
		expect($('.product__description').html()).toBe(member.contentHtml);
		expect($('link').attr('href')).toBe(member.permalink);
		expect($('a').attr('href')).toBe(member.permalink);
		expect($('.product__media img').attr('src')).toBe(member.images[0]);
		expect($('.product__media img').attr('srcset')).toBe(member.images[0]);
		expect($('.price-item--regular').text()).toBe('$20.00');
	});

	it.each([
		document.replace('<h1>', '<h1>Other</h1><h1>'),
		document.replace('class="product__media"', 'class="unrecognized-gallery"'),
		document.replace('</main>', '<span class="price-item--regular">$10.00</span></main>'),
		document.replace('/one.png" srcset', '/unknown.png" srcset'),
		document.replace('$10.00', '$10,00'),
	])('fails closed for ambiguous or unknown slots', html => {
		expect(productMemberDocument(html, entry('one'), entry('two'))).toBeUndefined();
	});

	it('round trips tag and collection archive identities', () => {
		for (const term of ['Sample tag', 'collection:samples']) {
			const url = shopifyStructuredContent.termArchiveUrl(term, 'https://example.com/');
			expect(shopifyStructuredContent.termName(url)).toBe(term);
		}
		expect(shopifyStructuredContent.termArchiveUrl('collection:samples', 'https://example.com/')).toBe('https://example.com/collections/samples');
	});

	it('groups declared product templates despite different gallery and variant counts', () => {
		const other = document.replace('</main>', '<div class="product__media"><video></video><img src="/two.png"></div><form action="/cart/add"><select><option>A</option><option>B</option></select></form><details><summary>Options</summary></details></main>');
		const key = (html: string, hooked = true) => templateFingerprint(html, 'https://example.com/products/one', undefined, hooked ? shopifyAdapter.templateIdentity : undefined).key;
		expect(key(document, false)).not.toBe(key(other, false));
		expect(key(document)).toBe(key(other));
		expect(shopifyAdapter.templateIdentity!(document, 'https://example.com/pages/about')).toBeUndefined();
		expect(shopifyAdapter.templateIdentity!(document.replace('template-product', 'template-page'), 'https://example.com/products/one')).toBeUndefined();
	});
});
