import type { Page } from 'playwright';
import type { LiberationContext } from '../page-actions.js';
import { describesPage, list, object, withinJsonLdLimits } from '../product-jsonld.js';
import { fetchSqsJson } from './content.js';
import type { SqsJsonResponse } from './types.js';

/** Complete only the route's own product; authored fields always win. */
export function completeProductJsonLd(scripts: string[], payload: SqsJsonResponse, pageUrl: string): string[] {
  try {
    const item = payload.item;
    if (item?.structuredContent?._type !== 'product' || !Array.isArray(item.variants)) return scripts;
    const variants = item.variants;
    const page = new URL(pageUrl);
    page.search = '';
    page.hash = '';
    let changed = false;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!object(value)) return;
      const types = list(value['@type']);
      if (types.includes('Product') || types.includes('ProductGroup')) {
        // Do not descend into related products or overwrite authored variants.
        if (!describesPage(value, page.href)) return;
        changed = true;
        value['@type'] = Array.isArray(value['@type'])
          ? [...new Set(types.map(type => type === 'Product' ? 'ProductGroup' : type))] : 'ProductGroup';
        const defaults = {
          name: item.title, url: page.href, productGroupID: item.id,
          variesBy: item.variantOptionOrdering, category: payload.collection?.title,
          hasVariant: variants.map(variant => {
            const money = variant.onSale ? variant.salePriceMoney : variant.priceMoney;
            return {
              '@type': 'Product', sku: variant.sku, image: variant.mainImage?.assetUrl,
              // Variant names make each child a complete Product for schema consumers.
              name: [value.name ?? item.title, variant.optionValues?.map(option => option.value).join(' / ')].filter(Boolean).join(' - '),
              additionalProperty: variant.optionValues?.map(option => ({
                '@type': 'PropertyValue', name: option.optionName, value: option.value,
              })),
              offers: { '@type': 'Offer', price: money?.value, priceCurrency: money?.currency,
                availability: `https://schema.org/${variant.unlimited || (variant.qtyInStock ?? 0) > 0 ? 'InStock' : 'OutOfStock'}` },
            };
          }),
        };
        for (const [key, field] of Object.entries(defaults)) {
          if (value[key] === undefined && field !== undefined) value[key] = field;
        }
        // Gallery order comes from Squarespace. Preserve authored image objects
        // and URLs while adding the missing gallery members.
        const authored = list(value.image);
        const imageUrl = (image: any): unknown => object(image) ? image.contentUrl ?? image.url : image;
        const gallery = [...new Set(item.items?.map(image => image.assetUrl).filter(Boolean) ?? [])];
        value.image = [...gallery.map(url => authored.find(image => imageUrl(image) === url) ?? url),
          ...authored.filter(image => !gallery.includes(imageUrl(image) as string))];
        return;
      }
      Object.values(value).forEach(visit);
    };
    const result = scripts.map(source => {
      try {
        const value: unknown = JSON.parse(source);
        visit(value);
        return JSON.stringify(value).replace(/</g, '\\u003c');
      } catch { return source; }
    });
    return changed && withinJsonLdLimits(result) ? result : scripts;
  } catch { return scripts; }
}

/** Keep failures entirely inert, including during repeated serialization. */
export async function preserveSquarespaceProductJsonLd(page: Page, context: LiberationContext): Promise<void> {
  try {
    if (new URL(page.url()).origin !== new URL(context.url).origin) return;
    const payload = await fetchSqsJson(context.url);
    if (!payload) return;
    const source = await page.evaluate(() => ({
      scripts: Array.from(document.querySelectorAll('script')).filter(node => /^application\/ld\+json(?:\s*;|\s*$)/i.test(node.type)).map(node => node.textContent ?? ''),
      canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href,
    }));
    const canonical = source.canonical && new URL(source.canonical).origin === new URL(context.url).origin ? source.canonical : context.url;
    const scripts = completeProductJsonLd(source.scripts, payload, canonical);
    if (scripts === source.scripts) return;
    await page.evaluate(scripts => {
      const nodes = Array.from(document.querySelectorAll('script')).filter(node => /^application\/ld\+json(?:\s*;|\s*$)/i.test(node.type));
      scripts.forEach((text, index) => { nodes[index].textContent = text; });
    }, scripts);
  } catch { /* JSON evidence is optional; preserve the authored document. */ }
}
