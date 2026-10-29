import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { capture } from './capture.js';
import { completeProductJsonLd } from './product-jsonld.js';
import type { ShopifyProductJson } from './types.js';
import { fetchShopifyJson } from './http.js';

const html = readFileSync(new URL('./fixtures/product.html', import.meta.url), 'utf8');
const product = JSON.parse(readFileSync(new URL('./fixtures/product.json', import.meta.url), 'utf8')) as ShopifyProductJson;
const source = cheerio.load(html)('script').text();
const url = 'https://store.example/products/field-jacket';
afterEach(() => vi.unstubAllGlobals());

function mockPage() {
  const context = { browser: () => null };
  const evaluate = vi.fn().mockResolvedValueOnce({ scripts: [source], currency: 'USD' }).mockResolvedValue(undefined);
  return { page: { url: () => url, context: () => context, evaluate } as unknown as Page, evaluate };
}

describe('Shopify product JSON-LD', () => {
  it('completes the captured route through the adapter hook, fetching only once', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(product)));
    vi.stubGlobal('fetch', fetch);
    const { page, evaluate } = mockPage();
    await capture.beforeSerialize!(page, { url, viewport: 'desktop' });
    expect(fetch).toHaveBeenCalledWith(`${url}.js`, expect.objectContaining({ redirect: 'error' }));
    const group = JSON.parse(evaluate.mock.calls[1]![1][0]);
    expect(group['@id']).toBe(`${url}#group`);
    expect(group.brand).toEqual({ '@type': 'Brand', name: 'Example Studio' });
    expect(group.hasVariant[0].additionalProperty).toEqual([
      { '@type': 'PropertyValue', name: 'Size', value: 'Small' },
      { '@type': 'PropertyValue', name: 'Colour', value: 'Blue' },
    ]);
    expect(group.hasVariant[1].additionalProperty[0].value).toBe('Medium');
    expect(group.hasVariant[1]['@id']).toBe('theme-variant');
    expect(group.hasVariant[0].offers.price).toBe('78900.00');
    expect(group.hasVariant[0].offers.priceSpecification).toEqual({
      '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/StrikethroughPrice', price: '85000.00', priceCurrency: 'USD',
    });
    expect(group.hasVariant[1].offers.priceSpecification).toBeUndefined();
    expect(group.image).toEqual(['front', 'back', 'side', 'detail'].map(name => `https://store.example/files/${name}.jpg`));
    expect(group.keywords).toEqual(product.tags);
    evaluate.mockResolvedValueOnce({ scripts: [source], currency: 'USD' });
    await capture.beforeSerialize!(page, { url, viewport: 'mobile' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const second = mockPage();
    const browser = {};
    const sharedContext = { browser: () => browser };
    vi.spyOn(page, 'context').mockReturnValue(sharedContext as any);
    vi.spyOn(second.page, 'context').mockReturnValue({ browser: () => browser } as any);
    evaluate.mockResolvedValueOnce({ scripts: [source], currency: 'USD' });
    await capture.beforeSerialize!(page, { url, viewport: 'desktop' });
    await capture.beforeSerialize!(second.page, { url, viewport: 'mobile' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('creates the same product group on locale routes with page URL and language', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(product)));
    vi.stubGlobal('fetch', fetch);
    const defaultGroup = JSON.parse(completeProductJsonLd([], product, url, 'USD').scripts[0]!);
    for (const locale of ['fr', 'en-ca']) {
      const localizedUrl = `https://store.example/${locale}/products/field-jacket`;
      const { page, evaluate } = mockPage();
      vi.spyOn(page, 'url').mockReturnValue(localizedUrl);
      evaluate.mockReset().mockResolvedValueOnce({ scripts: [], currency: 'USD' }).mockResolvedValue(undefined);
      await capture.beforeSerialize!(page, { url: localizedUrl, viewport: 'desktop' });
      expect(fetch).toHaveBeenCalledWith(`${localizedUrl}.js`, expect.objectContaining({ redirect: 'error' }));
      const group = JSON.parse(evaluate.mock.calls[1]![1][0]);
      expect(group).toMatchObject({
        '@type': 'ProductGroup', productGroupID: String(product.id),
        inLanguage: locale, url: localizedUrl,
      });
      expect(group.productGroupID).toBe(defaultGroup.productGroupID);
      expect(group.hasVariant).toHaveLength(product.variants.length);
      expect(group.hasVariant[0].additionalProperty).toEqual(defaultGroup.hasVariant[0].additionalProperty);
    }
    expect(defaultGroup.url).toBe(url);
    expect(defaultGroup.inLanguage).toBeUndefined();
  });

  it('leaves the page unchanged when fetching fails and ignores non-product routes', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetch);
    const { page, evaluate } = mockPage();
    await capture.beforeSerialize!(page, { url, viewport: 'desktop' });
    expect(evaluate).not.toHaveBeenCalled();
    await capture.beforeSerialize!(page, { url: 'https://store.example/collections/jackets', viewport: 'desktop' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('creates a group when absent and preserves existing Product evidence', () => {
    const group = JSON.parse(completeProductJsonLd([], product, url, 'USD').scripts[0]!);
    expect(group.hasVariant).toHaveLength(2);
    expect(group.hasVariant[0].offers.price).toBe('78900.00');
    expect(group.hasVariant[1].offers.availability).toBe('https://schema.org/OutOfStock');
    const plain = { '@type': 'Product', '@id': `${url}?variant=101`, additionalProperty: [{ name: 'Size', value: 'Authored' }], keywords: 'Original' };
    const result = JSON.parse(completeProductJsonLd([JSON.stringify({ '@graph': [plain] })], product, url).scripts[0]!);
    expect(result['@graph'][0].additionalProperty[0].value).toBe('Authored');
    expect(result['@graph'][0].keywords).toBe('Original, Outerwear, Everyday');
  });

  it('leaves related-product nodes for other routes untouched', () => {
    const related = { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', position: 1,
      item: { '@type': 'Product', name: 'Other Coat', url: 'https://store.example/products/other-coat', offers: { '@type': 'Offer', price: '10.00' } } }] };
    const { scripts } = completeProductJsonLd([source, JSON.stringify(related)], product, url);
    const other = JSON.parse(scripts[1]!).itemListElement[0].item;
    expect(other.hasVariant).toBeUndefined();
    expect(other.keywords).toBeUndefined();
    expect(other.image).toBeUndefined();
    expect(JSON.parse(scripts[0]!).hasVariant.length).toBeGreaterThan(0);
  });

  it('keeps one gallery entry per file and prefers the URL the page rendered', () => {
    const name = new URL(product.images[0]!, url).pathname.split('/').pop()!;
    const rendered = `https://store.example/cdn/shop/files/${name}?width=1920`;
    const theme = { '@context': 'https://schema.org', '@type': 'ProductGroup', url, image: rendered };
    const { scripts } = completeProductJsonLd([JSON.stringify(theme)], product, url);
    const images: string[] = JSON.parse(scripts[0]!).image;
    const names = images.map(src => new URL(src, url).pathname.split('/').pop());
    expect(new Set(names).size).toBe(names.length);
    expect(images[0]).toBe(rendered);
    expect(images.length).toBe(new Set([...product.images, ...product.variants.flatMap(v => v.featured_image?.src ?? [])].map(src => new URL(src, url).pathname.split("/").pop())).size);
  });

  it('retains original scripts and reports size/count overflow', () => {
    const oversized = { ...product, tags: ['x'.repeat(65536)] };
    expect(completeProductJsonLd([source], oversized, url)).toEqual({ scripts: [source], diagnostic: expect.stringContaining('shopify_product_jsonld_limit') });
    expect(completeProductJsonLd(Array(16).fill('{}'), product, url).diagnostic).toBeDefined();
    expect(completeProductJsonLd(Array(5).fill(JSON.stringify({ value: 'x'.repeat(60000) })), product, url).diagnostic).toBeDefined();
  });

  it('bounds the public JSON response and declines redirects', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('x'.repeat(50)));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchShopifyJson(url, { maxBytes: 20, sameOrigin: true })).toBeNull();
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error' }));
  });
});
