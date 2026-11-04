import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { readFileSync } from 'node:fs';
import type { SqsJsonResponse } from './types.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/product.json', import.meta.url), 'utf8')) as SqsJsonResponse & {
  item: Required<Pick<NonNullable<SqsJsonResponse['item']>, 'variants'>> & NonNullable<SqsJsonResponse['item']>;
};
import { completeProductJsonLd, preserveSquarespaceProductJsonLd } from './product-jsonld.js';
import { fetchSqsJson } from './content.js';

const thin = { '@context': 'http://schema.org', '@type': 'Product', name: 'Field Tee — Example',
  image: 'https://cdn.example/a.jpg', offers: { '@type': 'AggregateOffer', lowPrice: 27.99, highPrice: 27.99, priceCurrency: 'USD', offerCount: 1 } };
const related = { '@type': 'Product', url: '/shop/related', name: 'Related' };
const source = JSON.stringify({ '@graph': [thin, related] });
afterEach(() => vi.unstubAllGlobals());

describe('Squarespace product JSON-LD', () => {
  it.each(['product', 'non-product', 'fetch failure'] as const)('%s route', async kind => {
    const url = `https://example.com/shop/${kind}`;
    const fetch = vi.fn().mockImplementation(async () => {
      if (kind === 'fetch failure') throw new Error('offline');
      return { ok: true, json: async () => kind === 'product' ? fixture : { item: { structuredContent: { _type: 'page' } } } };
    });
    vi.stubGlobal('fetch', fetch);
    let scripts = [source];
    const evaluate = vi.fn(async (_fn: unknown, replacement?: string[]) => {
      if (replacement) { scripts = replacement; return; }
      return { scripts, canonical: url };
    });
    const page = { url: () => url, evaluate } as unknown as Page;
    // A payload already fetched during discovery must not be requested again.
    await fetchSqsJson(url);
    await preserveSquarespaceProductJsonLd(page, { url, viewport: 'desktop' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    if (kind !== 'product') { expect(scripts).toEqual([source]); return; }
    const [group, other] = JSON.parse(scripts[0])['@graph'];
    expect(other).toEqual(related);
    expect(group).toMatchObject({ '@type': 'ProductGroup', name: thin.name, url, productGroupID: 'abc',
      variesBy: ['Color', 'Size'], category: 'Shop', image: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'], offers: thin.offers });
    expect(group.hasVariant).toHaveLength(fixture.item.variants.length);
    group.hasVariant.forEach((variant: any, index: number) => {
      expect(variant.sku).toBe(fixture.item.variants[index].sku);
      expect(variant.additionalProperty).toEqual(fixture.item.variants[index].optionValues!.map(option => ({ '@type': 'PropertyValue', name: option.optionName, value: option.value })));
      expect(variant.offers).toMatchObject({ '@type': 'Offer', price: index ? '19.99' : '27.99', priceCurrency: 'USD', availability: `https://schema.org/${index ? 'OutOfStock' : 'InStock'}` });
    });
    expect(group.hasVariant[0].image).toBe('https://cdn.example/a.jpg');
  });

  it('retains authored variants and fields, is inert, and rolls back over-limit output', () => {
    const authored = { ...thin, category: 'Authored', variesBy: ['Finish'], hasVariant: [{ '@type': 'Product', sku: 'authored' }] };
    const result = completeProductJsonLd([JSON.stringify(authored)], fixture, 'https://example.com/shop/tee');
    expect(JSON.parse(result[0])).toMatchObject({ category: 'Authored', variesBy: ['Finish'], hasVariant: authored.hasVariant });
    const unsafe = { ...fixture, item: { ...fixture.item, title: '</script><script>alert(1)</script>' } };
    expect(completeProductJsonLd(['{"@type":"Product"}'], unsafe, 'https://example.com/shop/tee')[0]).not.toContain('<');
    const original = [JSON.stringify(thin)];
    const huge = { ...fixture, item: { ...fixture.item, variants: Array(1000).fill(fixture.item.variants[0]) } };
    expect(completeProductJsonLd(original, huge, 'https://example.com/shop/tee')).toBe(original);
    expect(completeProductJsonLd(['{broken'], fixture, 'https://example.com/shop/tee')).toEqual(['{broken']);
  });
});
