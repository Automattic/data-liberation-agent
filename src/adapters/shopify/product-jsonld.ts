import type { Page } from 'playwright';
import type { LiberationContext } from '../page-actions.js';
import { fetchShopifyJson } from './http.js';
import type { ShopifyProductJson, ShopifyProductVariant } from './types.js';

type Node = Record<string, any>;
// Match capture-export's inert JSON-LD retention contract without coupling the
// adapter to the exporter (which owns no Shopify knowledge).
const MAX_SCRIPT = 64 * 1024;
const MAX_TOTAL = 256 * 1024;
const MAX_SCRIPTS = 16;
const requests = new WeakMap<object, Map<string, Promise<ShopifyProductJson | null>>>();

function object(value: unknown): value is Node {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function list(value: unknown): any[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
function append(existing: unknown, additions: unknown[]): unknown[] {
  const result = list(existing).slice();
  for (const value of additions) {
    if (!result.some(item => JSON.stringify(item) === JSON.stringify(value))) result.push(value);
  }
  return result;
}
function image(src: string, pageUrl: string): string | undefined {
  try {
    const url = new URL(src, pageUrl);
    return /^https?:$/.test(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}
function variantId(node: Node, pageUrl: string): string | undefined {
  for (const source of [node['@id'], ...list(node.offers).map(offer => offer?.url)]) {
    if (typeof source !== 'string') continue;
    try {
      const id = new URL(source, pageUrl).searchParams.get('variant');
      if (id) return id;
    } catch { /* Unrecognised theme identifiers remain untouched. */ }
  }
  return undefined;
}
/** Only this page's product is completed; related-product nodes keep their own data. */
function describesPage(node: Node, pageUrl: string): boolean {
  const own = new URL(pageUrl).pathname.replace(/\/$/, '');
  const sources = [node.url, node['@id'], ...list(node.offers).map(offer => offer?.url)].filter((value): value is string => typeof value === 'string' && !value.startsWith('#'));
  if (!sources.length) return true;
  return sources.some(source => {
    try { return new URL(source, pageUrl).pathname.replace(/\/$/, '') === own; } catch { return false; }
  });
}
function completeVariant(node: Node, variant: ShopifyProductVariant, product: ShopifyProductJson, pageUrl: string): void {
  const properties = product.options.flatMap(option => {
    const value = variant[`option${option.position}` as keyof ShopifyProductVariant];
    return typeof value === 'string' ? [{ '@type': 'PropertyValue', name: option.name, value }] : [];
  });
  // An authored option value wins; other theme properties are retained as-is.
  const existing = list(node.additionalProperty);
  const missing = properties.filter(property => !existing.some(item => item?.name === property.name));
  if (missing.length) node.additionalProperty = append(node.additionalProperty, missing);
  if (variant.featured_image?.src) {
    const src = image(variant.featured_image.src, pageUrl);
    if (src) node.image = node.image === undefined ? src : append(node.image, [src]);
  }
  for (const offer of list(node.offers)) {
    if (!object(offer) || !Number.isSafeInteger(variant.compare_at_price) ||
        variant.compare_at_price! <= variant.price) continue;
    const price = (variant.compare_at_price! / 100).toFixed(2);
    const specification = {
      '@type': 'UnitPriceSpecification',
      priceType: 'https://schema.org/StrikethroughPrice',
      price: typeof offer.price === 'number' ? Number(price) : price,
      ...(offer.priceCurrency ? { priceCurrency: offer.priceCurrency } : {}),
    };
    if (offer.priceSpecification === undefined) offer.priceSpecification = specification;
    else if (!list(offer.priceSpecification).some(item => /(?:StrikethroughPrice|ListPrice)$/.test(item?.priceType ?? ''))) {
      offer.priceSpecification = append(offer.priceSpecification, [specification]);
    }
  }
}
function newVariant(variant: ShopifyProductVariant, product: ShopifyProductJson, pageUrl: string, currency?: string): Node {
  const url = new URL(pageUrl);
  url.search = '';
  url.hash = '';
  url.searchParams.set('variant', String(variant.id));
  const node: Node = {
    '@type': 'Product', '@id': url.href, name: variant.title,
    ...(variant.sku ? { sku: variant.sku } : {}),
    offers: { '@type': 'Offer', url: url.href, price: (variant.price / 100).toFixed(2),
      ...(currency ? { priceCurrency: currency } : {}),
      availability: `https://schema.org/${variant.available ? 'InStock' : 'OutOfStock'}` },
  };
  completeVariant(node, variant, product, pageUrl);
  return node;
}

/** All-or-nothing: never replace source JSON-LD with evidence the exporter drops. */
export function completeProductJsonLd(scripts: string[], product: ShopifyProductJson, pageUrl: string, currency?: string): { scripts: string[]; diagnostic?: string } {
  try {
    if (!Array.isArray(product.variants) || !Array.isArray(product.options) ||
        !Array.isArray(product.images) || !Array.isArray(product.tags)) return { scripts };
    let found = false;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!object(value)) return;
      const types = list(value['@type']);
      if ((types.includes('ProductGroup') || types.includes('Product')) && describesPage(value, pageUrl)) {
        found = true;
        const ownVariant = product.variants.find(v => String(v.id) === variantId(value, pageUrl));
        if (ownVariant && types.includes('Product')) completeVariant(value, ownVariant, product, pageUrl);
        else {
          const offerCurrency = list(value.offers).find(offer => typeof offer?.priceCurrency === 'string')?.priceCurrency ?? currency;
          if (value.hasVariant === undefined) value.hasVariant = product.variants.map(v => newVariant(v, product, pageUrl, offerCurrency));
          for (const child of list(value.hasVariant)) {
            if (!object(child)) continue;
            const match = product.variants.find(v => String(v.id) === variantId(child, pageUrl));
            if (match) completeVariant(child, match, product, pageUrl);
          }
          const images = product.images.map(src => image(src, pageUrl)).filter(Boolean);
          images.push(...list(value.hasVariant).flatMap(child => list(child?.image)));
          images.push(...product.variants.flatMap(variant => {
            const src = variant.featured_image?.src;
            return src ? [image(src, pageUrl)].filter(Boolean) : [];
          }));
          // The storefront serves one file from several hosts and renditions
          // (`/cdn/shop/files/NAME?width=…`, `cdn…/files/NAME?v=…`): the file name
          // identifies the image. Prefer the URL the page itself rendered, which
          // the capture downloaded, and keep the product's gallery order.
          const fileName = (item: unknown): string => {
            const src = typeof item === 'string' ? item : object(item) ? String(item.contentUrl ?? item.url ?? '') : '';
            try { return decodeURIComponent(new URL(src, pageUrl).pathname.split('/').pop() ?? '') || src; } catch { return src; }
          };
          const rendered = new Map<string, unknown>();
          for (const item of [...list(value.image), ...list(value.hasVariant).flatMap(child => list(child?.image))]) {
            if (!rendered.has(fileName(item))) rendered.set(fileName(item), item);
          }
          const seen = new Set<string>();
          value.image = [...images, ...list(value.image)].flatMap(item => {
            const key = fileName(item);
            if (seen.has(key)) return [];
            seen.add(key);
            return [rendered.get(key) ?? item];
          });
        }
        if (value.keywords === undefined) value.keywords = product.tags;
        else {
          const existingTags = typeof value.keywords === 'string' ? value.keywords.split(',').map((tag: string) => tag.trim()) : list(value.keywords);
          const missing = product.tags.filter(tag => !existingTags.includes(tag));
          if (missing.length) value.keywords = typeof value.keywords === 'string' ? [value.keywords, ...missing].join(', ') : append(value.keywords, missing);
        }
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
    if (!found) {
      const group = { '@context': 'https://schema.org', '@type': 'ProductGroup', '@id': `${pageUrl.split(/[?#]/, 1)[0]}#product`, name: product.title,
        description: product.description, productGroupID: String(product.id) };
      visit(group);
      result.push(JSON.stringify(group).replace(/</g, '\\u003c'));
    }
    if (result.length > MAX_SCRIPTS || result.some(source => Buffer.byteLength(source) > MAX_SCRIPT) ||
        result.reduce((sum, source) => sum + Buffer.byteLength(source), 0) > MAX_TOTAL) {
      return { scripts, diagnostic: 'shopify_product_jsonld_limit: enrichment exceeds JSON-LD export limits; original retained' };
    }
    return { scripts: result };
  } catch { return { scripts }; }
}

/** A browser is capture-owned: route/profile contexts share one bounded request. */
export async function preserveShopifyProductJsonLd(page: Page, context: LiberationContext): Promise<void> {
  const url = new URL(context.url);
  if (!/^\/products\/[^/]+\/?$/.test(url.pathname) || new URL(page.url()).origin !== url.origin) return;
  const endpoint = new URL(`${url.pathname.replace(/\/$/, '')}.js`, url.origin).href;
  const owner = page.context().browser() ?? page.context();
  let cache = requests.get(owner);
  if (!cache) { cache = new Map(); requests.set(owner, cache); }
  let request = cache.get(endpoint);
  if (!request) {
    request = fetchShopifyJson<ShopifyProductJson>(endpoint, { maxBytes: 1024 * 1024, sameOrigin: true });
    cache.set(endpoint, request);
  }
  const product = await request;
  if (!product) return;
  const source = await page.evaluate(() => ({
    scripts: Array.from(document.querySelectorAll('script')).filter(node => /^application\/ld\+json(?:\s*;|\s*$)/i.test(node.type)).map(node => node.textContent ?? ''),
    currency: document.querySelector('meta[property="product:price:currency"],meta[itemprop="priceCurrency"]')?.getAttribute('content') ?? undefined,
  }));
  const result = completeProductJsonLd(source.scripts, product, url.href, source.currency);
  if (result.diagnostic) { console.warn(`[shopify] ${url.href}: ${result.diagnostic}`); return; }
  if (result.scripts === source.scripts) return;
  await page.evaluate(scripts => {
    const nodes = Array.from(document.querySelectorAll('script')).filter(node => /^application\/ld\+json(?:\s*;|\s*$)/i.test(node.type));
    scripts.forEach((text, index) => {
      const node = nodes[index] ?? document.createElement('script');
      node.type = 'application/ld+json';
      node.textContent = text;
      if (!node.isConnected) (document.head ?? document.documentElement).append(node);
    });
  }, result.scripts);
}
