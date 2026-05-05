import type { PlatformAdapter } from '../types.js';
import type { WxrBuilder } from '../lib/extraction/wxr-builder.js';
import type { ExtractionLog } from '../lib/extraction/extraction-log.js';
import { ImportSession } from '../lib/extraction/import-session.js';
import {
  ShopifyGraphqlClient,
  fetchAllProducts,
  type ShopifyGqlProduct,
} from '../lib/extraction/shopify-graphql.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { fetchSitemap, classifyUrl } from '../lib/extraction/sitemap.js';
import { slugify, runExtractionLoop, extractMeta, extractTitle, extractHeading, extractNavLinks, IMAGE_EXTENSIONS } from './shared.js';
import type { InventoryUrl, NavLink } from './shared.js';
import { WooProductCsvBuilder } from '../lib/import/woo-product-csv.js';
import type { WooProduct } from '../lib/import/woo-product-csv.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShopifyAdapterOpts extends Record<string, unknown> {
  delay?: number;
  resume?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  outputDir?: string;
  cdpPort?: number;
  /** Shopify shop domain, e.g. `my-store.myshopify.com` — required for GraphQL */
  shopDomain?: string;
  /** Shopify Admin API access token. When present, products are fetched via GraphQL. */
  adminToken?: string;
  limit?: number;
}

export interface ShopifyInventory {
  siteUrl: string;
  discoveredAt: string;
  siteMeta: {
    title: string;
    tagline: string;
    language: string;
  };
  navigation: NavLink[];
  counts: Record<string, number>;
  urls: InventoryUrl[];
  jsonApiAvailable: boolean;
  /**
   * The `*.myshopify.com` hostname, auto-detected from storefront HTML.
   * Populated even when the site is served on a custom domain — every
   * Shopify storefront exposes this via a `Shopify.shop = "..."` global.
   * Used for Admin GraphQL calls when `adminToken` is supplied.
   */
  shopDomain?: string;
}

/**
 * Extract the myshopify.com hostname from storefront HTML. Every Shopify
 * storefront sets `Shopify.shop = "name.myshopify.com"` as a global — it
 * powers the Shopify JS runtime, so it's reliably present on every page.
 * Falls back to matching the CDN pattern and `shop_id`/`shop_url` hints.
 */
export function extractShopDomain(html: string): string | undefined {
  // Most reliable: the Shopify JS runtime global
  const shopGlobal = html.match(/Shopify\.shop\s*=\s*["']([^"']+\.myshopify\.com)["']/i);
  if (shopGlobal?.[1]) return shopGlobal[1];

  // Analytics bootstrap (trekkie) carries the same value
  const trekkie = html.match(/shopId["']?\s*[:,]\s*\d+[^}]*shop["']?\s*[:,]\s*["']([^"']+\.myshopify\.com)["']/i);
  if (trekkie?.[1]) return trekkie[1];

  // Monorail "shop" payload
  const monorail = html.match(/"shop"\s*:\s*"([^"]+\.myshopify\.com)"/i);
  if (monorail?.[1]) return monorail[1];

  return undefined;
}

// ---------------------------------------------------------------------------
// Shopify JSON API helpers
// ---------------------------------------------------------------------------

interface ShopifyPage {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  published_at?: string;
  author?: string;
}

interface ShopifyBlog {
  id: number;
  title: string;
  handle: string;
}

interface ShopifyArticle {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  summary_html?: string;
  author?: string;
  tags?: string;
  published_at?: string;
  blog_id?: number;
  image?: { src: string };
}

interface ShopifyProductVariant {
  id?: number;
  title: string;
  price: string;
  compare_at_price?: string | null;
  sku: string;
  option1?: string;
  option2?: string;
  option3?: string;
  weight?: number;
  weight_unit?: string;
  inventory_quantity?: number;
  available?: boolean;
  image_id?: number | null;
  featured_image?: { src: string } | null;
}

interface ShopifyProductOption {
  name: string;
  values: string[];
}

interface ShopifyProductImage {
  id?: number;
  src: string;
  variant_ids?: number[];
}

export interface ShopifyProductJson {
  title: string;
  body_html: string;
  handle: string;
  product_type?: string;
  tags?: string;
  vendor?: string;
  image?: { src: string };
  variants?: ShopifyProductVariant[];
  options?: ShopifyProductOption[];
  images?: ShopifyProductImage[];
}

/**
 * Normalize a Shopify weight+unit pair to kilograms. Shopify variant objects
 * expose `weight` in the unit named by `weight_unit` — to feed WooCommerce a
 * single consistent unit we convert everything to kg. Returns undefined for
 * zero/missing weights so we don't emit `"0"` rows.
 */
export function normalizeWeightToKg(weight: number | undefined, unit: string | undefined): string | undefined {
  if (weight == null || weight === 0) return undefined;
  const u = (unit || 'kg').toLowerCase();
  let kg: number;
  switch (u) {
    case 'kg': kg = weight; break;
    case 'g':  kg = weight / 1000; break;
    case 'lb': kg = weight * 0.453592; break;
    case 'oz': kg = weight * 0.0283495; break;
    default:   kg = weight; // unknown unit — pass through
  }
  // Trim to 4 decimals, drop trailing zeros
  return Number(kg.toFixed(4)).toString();
}

/**
 * Convert a Shopify product JSON payload into a WooProduct parent + variation rows.
 *
 * `sourceUrl` is stamped on the parent so the import pipeline can link the
 * WooCommerce product back to its Shopify storefront URL. Variations inherit
 * the parent's page on the storefront, so they don't get their own sourceUrl.
 */
export function shopifyProductToWoo(
  product: ShopifyProductJson,
  sourceUrl?: string,
): { parent: WooProduct; variations: WooProduct[] } {
  const variants = product.variants || [];
  const options = product.options || [];

  const isVariable = variants.length > 1 || (options.length > 0 && options[0]?.name !== 'Title');

  // Collect images from 3 sources: featured image, images array, inline body HTML
  const imageSet = new Set<string>();
  if (product.image?.src) imageSet.add(product.image.src);
  for (const img of product.images || []) {
    imageSet.add(img.src);
  }
  // Extract inline images from body_html
  const inlineImgRegex = /src="(https?:\/\/[^"']+\.(jpg|jpeg|png|gif|webp)[^"']*)"/gi;
  let inlineMatch;
  while ((inlineMatch = inlineImgRegex.exec(product.body_html || '')) !== null) {
    imageSet.add(inlineMatch[1]);
  }
  const images = [...imageSet];

  const firstVariant = variants[0];
  const tags = product.tags
    ? product.tags.split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  const categories = product.product_type ? [product.product_type] : [];

  // Simple-product sale price: when compareAtPrice > price, Shopify treats
  // the compareAtPrice as the original and price as the current (sale) price.
  // Mirror this in WooCommerce so discounts survive the import. Guard both
  // values through Number.isFinite so empty-string prices can't false-positive.
  const jsonPriceNum = firstVariant?.price ? Number(firstVariant.price) : NaN;
  const jsonCompareNum = firstVariant?.compare_at_price ? Number(firstVariant.compare_at_price) : NaN;
  const simpleHasSale =
    !isVariable &&
    Number.isFinite(jsonPriceNum) &&
    Number.isFinite(jsonCompareNum) &&
    jsonCompareNum > jsonPriceNum;

  const parent: WooProduct = {
    name: product.title,
    type: isVariable ? 'variable' : 'simple',
    // Variable products need a SKU so variations can reference them via parent_id.
    // Use the product handle as a stable identifier if no explicit SKU exists.
    sku: isVariable ? (product.handle || product.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')) : (firstVariant?.sku || ''),
    published: true,
    description: product.body_html || '',
    regularPrice: isVariable
      ? ''
      : (simpleHasSale ? String(firstVariant!.compare_at_price) : (firstVariant?.price || '')),
    salePrice: simpleHasSale ? (firstVariant?.price || undefined) : undefined,
    categories,
    tags,
    images,
    inStock: firstVariant?.available !== false,
    stock: firstVariant?.inventory_quantity != null ? firstVariant.inventory_quantity : undefined,
    sourceUrl,
  };

  if (options.length > 0) {
    parent.attributes = options.map((opt) => ({
      name: opt.name,
      values: opt.values,
      visible: true,
      global: false,
    }));
  }

  const parentWeight = normalizeWeightToKg(firstVariant?.weight, firstVariant?.weight_unit);
  if (parentWeight) parent.weight = parentWeight;

  // Build image lookup: image ID → src, and variant ID → image src
  const imageById = new Map<number, string>();
  const imageByVariantId = new Map<number, string>();
  for (const img of product.images || []) {
    if (img.id) imageById.set(img.id, img.src);
    for (const vid of img.variant_ids || []) {
      imageByVariantId.set(vid, img.src);
    }
  }

  // Build variation rows for variable products
  const variations: WooProduct[] = [];
  if (isVariable) {
    for (const variant of variants) {
      const hasCompareAtPrice = variant.compare_at_price != null && variant.compare_at_price !== '';

      // Resolve variant image: featured_image > image_id lookup > variant_id lookup
      let variantImage: string | undefined;
      if (variant.featured_image?.src) {
        variantImage = variant.featured_image.src;
      } else if (variant.image_id && imageById.has(variant.image_id)) {
        variantImage = imageById.get(variant.image_id);
      } else if (variant.id && imageByVariantId.has(variant.id)) {
        variantImage = imageByVariantId.get(variant.id);
      }

      const variation: WooProduct = {
        name: product.title,
        type: 'variation',
        sku: variant.sku || '',
        parentSku: parent.sku,
        published: true,
        description: '',
        regularPrice: hasCompareAtPrice ? String(variant.compare_at_price) : variant.price || '',
        salePrice: hasCompareAtPrice ? variant.price || undefined : undefined,
        inStock: variant.available !== false,
        stock: variant.inventory_quantity != null ? variant.inventory_quantity : undefined,
        ...(variantImage ? { images: [variantImage] } : {}),
      };

      const variationWeight = normalizeWeightToKg(variant.weight, variant.weight_unit);
      if (variationWeight) variation.weight = variationWeight;

      // Single-value attributes for this variant
      const variantAttributes: WooProduct['attributes'] = [];
      if (variant.option1 != null && options[0]) {
        variantAttributes.push({ name: options[0].name, values: [variant.option1], visible: true, global: false });
      }
      if (variant.option2 != null && options[1]) {
        variantAttributes.push({ name: options[1].name, values: [variant.option2], visible: true, global: false });
      }
      if (variant.option3 != null && options[2]) {
        variantAttributes.push({ name: options[2].name, values: [variant.option3], visible: true, global: false });
      }
      if (variantAttributes.length > 0) {
        variation.attributes = variantAttributes;
      }

      variations.push(variation);
    }
  }

  return { parent, variations };
}

// Narrow stockable-variant shape shared by `computeStock` — defined before
// the mapper that uses it so readers can trace types top-down.
type ShopifyGqlVariantLike = {
  inventoryPolicy: 'DENY' | 'CONTINUE';
  inventoryQuantity: number | null;
  inventoryItem?: { tracked: boolean } | null | undefined;
};

/**
 * Map a Shopify GraphQL product node to WooProduct parent + variations.
 *
 * Exploits data the public JSON API does not expose:
 *   - compareAtPrice → sale-price semantics (on simple AND variable products)
 *   - inventoryPolicy + inventoryItem.tracked → real stock status
 *   - inventoryItem.unitCost → cost-of-goods meta
 *   - inventoryItem.measurement.weight → normalized kg weight
 *   - collections → category hierarchy candidates
 *   - metafields namespace:global + seo{} → SEO title/description
 *   - variant media → per-variation image
 */
export function shopifyGraphqlProductToWoo(
  product: ShopifyGqlProduct,
  sourceUrl?: string,
): { parent: WooProduct; variations: WooProduct[] } {
  const variantEdges = product.variants?.edges || [];
  const variants = variantEdges.map((e) => e.node);
  const options = product.options || [];

  const isVariable =
    variants.length > 1 || (options.length > 0 && options[0]?.name !== 'Title');

  // Collect images: featured + media edges + inline body HTML
  const imageSet = new Set<string>();
  if (product.featuredMedia?.image?.url) imageSet.add(product.featuredMedia.image.url);
  for (const m of product.media?.edges || []) {
    if (m.node.image?.url) imageSet.add(m.node.image.url);
  }
  const inlineImgRegex = /src="(https?:\/\/[^"']+\.(jpg|jpeg|png|gif|webp)[^"']*)"/gi;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlineImgRegex.exec(product.descriptionHtml || '')) !== null) {
    imageSet.add(inlineMatch[1]);
  }
  const images = [...imageSet];

  const firstVariant = variants[0];
  const tags = product.tags || [];

  // Category mapping: prefer collection titles (with product_type as fallback)
  // for richer taxonomy. Collections become flat categories — WooCommerce
  // doesn't have a native concept of Shopify collection hierarchy.
  const categorySet = new Set<string>();
  for (const edge of product.collections?.edges || []) {
    if (edge.node.title) categorySet.add(edge.node.title);
  }
  if (categorySet.size === 0 && product.productType) {
    categorySet.add(product.productType);
  }
  const categories = [...categorySet];

  // Real stock status: tracked + policy + quantity
  const computeStock = (v: ShopifyGqlVariantLike): { inStock: boolean; stock?: number } => {
    const tracked = v.inventoryItem?.tracked;
    const policy = v.inventoryPolicy;
    const qty = v.inventoryQuantity;
    // Untracked variants are always in stock in Shopify's model
    if (!tracked) return { inStock: true };
    // Tracked: depend on qty and oversell policy
    if (qty == null) return { inStock: true, stock: undefined };
    if (qty > 0) return { inStock: true, stock: qty };
    // qty <= 0 and tracked
    return { inStock: policy === 'CONTINUE', stock: qty };
  };

  const firstStock = firstVariant ? computeStock(firstVariant) : { inStock: true };

  // Only treat as a sale when BOTH prices are non-empty positive numbers.
  // Guards against empty-string price coercing to 0 (would spuriously mark
  // a free product as discounted).
  const priceNum = firstVariant?.price ? Number(firstVariant.price) : NaN;
  const compareNum = firstVariant?.compareAtPrice ? Number(firstVariant.compareAtPrice) : NaN;
  const simpleHasSale =
    !isVariable &&
    Number.isFinite(priceNum) &&
    Number.isFinite(compareNum) &&
    compareNum > priceNum;

  const parent: WooProduct = {
    name: product.title,
    type: isVariable ? 'variable' : 'simple',
    sku: isVariable
      ? (product.handle || product.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
      : (firstVariant?.sku || ''),
    published: product.status === 'ACTIVE',
    description: product.descriptionHtml || '',
    regularPrice: isVariable
      ? ''
      : (simpleHasSale ? String(firstVariant!.compareAtPrice) : (firstVariant?.price || '')),
    salePrice: simpleHasSale ? (firstVariant?.price || undefined) : undefined,
    categories,
    tags,
    images,
    inStock: firstStock.inStock,
    stock: firstStock.stock,
    sourceUrl,
  };

  // SEO: prefer product.seo, fall back to global metafields for title/description.
  // Shopify has been known to return metafields: null on stores without any —
  // optional-chain all the way to find() so we don't crash on empty shops.
  const seoTitle = product.seo?.title
    || product.metafields?.edges?.find((e) => e.node.key === 'title_tag')?.node.value
    || '';
  const seoDesc = product.seo?.description
    || product.metafields?.edges?.find((e) => e.node.key === 'description_tag')?.node.value
    || '';
  if (seoTitle) parent.seoTitle = seoTitle;
  if (seoDesc) parent.seoDescription = seoDesc;

  // Cost of goods from Shopify's unitCost — only set when we have a numeric
  // amount, since Woo's CSV importer treats the meta column as a price-typed
  // field. Currency code is dropped (Woo uses a single store-wide currency).
  const firstCost = firstVariant?.inventoryItem?.unitCost?.amount;
  if (firstCost && Number.isFinite(Number(firstCost))) {
    parent.costOfGoods = firstCost;
  }

  if (options.length > 0) {
    parent.attributes = options.map((opt) => ({
      name: opt.name,
      values: opt.values,
      visible: true,
      global: false,
    }));
  }

  const parentWeightKg = normalizeWeightToKg(
    firstVariant?.inventoryItem?.measurement?.weight?.value,
    firstVariant?.inventoryItem?.measurement?.weight?.unit,
  );
  if (parentWeightKg) parent.weight = parentWeightKg;

  const variations: WooProduct[] = [];
  if (isVariable) {
    for (const variant of variants) {
      const vPriceNum = variant.price ? Number(variant.price) : NaN;
      const vCompareNum = variant.compareAtPrice ? Number(variant.compareAtPrice) : NaN;
      const hasSale =
        Number.isFinite(vPriceNum) &&
        Number.isFinite(vCompareNum) &&
        vCompareNum > vPriceNum;

      const variantImage = variant.media?.edges?.[0]?.node?.image?.url;
      const variantStock = computeStock(variant);

      const variation: WooProduct = {
        name: product.title,
        type: 'variation',
        sku: variant.sku || '',
        parentSku: parent.sku,
        published: true,
        description: '',
        regularPrice: hasSale ? String(variant.compareAtPrice) : variant.price || '',
        salePrice: hasSale ? variant.price || undefined : undefined,
        inStock: variantStock.inStock,
        stock: variantStock.stock,
        ...(variantImage ? { images: [variantImage] } : {}),
      };

      const variationWeight = normalizeWeightToKg(
        variant.inventoryItem?.measurement?.weight?.value,
        variant.inventoryItem?.measurement?.weight?.unit,
      );
      if (variationWeight) variation.weight = variationWeight;

      const variantCost = variant.inventoryItem?.unitCost?.amount;
      if (variantCost && Number.isFinite(Number(variantCost))) {
        variation.costOfGoods = variantCost;
      }

      const variantAttributes: WooProduct['attributes'] = [];
      for (const selected of variant.selectedOptions || []) {
        variantAttributes.push({
          name: selected.name,
          values: [selected.value],
          visible: true,
          global: false,
        });
      }
      if (variantAttributes.length > 0) variation.attributes = variantAttributes;

      variations.push(variation);
    }
  }

  return { parent, variations };
}

/**
 * Extract product data from page HTML via JSON-LD or embedded product JSON.
 */
function extractProductFromHtml(html: string, sourceUrl: string): WooProduct | null {
  // Try JSON-LD Product schema
  const ldMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of ldMatches) {
    const jsonStr = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
    try {
      const ld = JSON.parse(jsonStr);
      if (ld['@type'] === 'Product' && ld.name) {
        const offers = Array.isArray(ld.offers) ? ld.offers : ld.offers ? [ld.offers] : [];
        const price = offers[0]?.price ? String(offers[0].price) : '';
        const images: string[] = [];
        if (typeof ld.image === 'string') images.push(ld.image);
        else if (Array.isArray(ld.image)) {
          for (const img of ld.image) {
            if (typeof img === 'string') images.push(img);
            else if (img?.url) images.push(img.url);
          }
        }
        return {
          name: ld.name,
          description: ld.description || '',
          regularPrice: price,
          sku: ld.sku || '',
          images,
          inStock: offers[0]?.availability?.includes('InStock') ?? true,
          sourceUrl,
        };
      }
    } catch {
      // invalid JSON-LD
    }
  }

  // Try [data-product-json] or similar embedded product data
  const productJsonMatch = html.match(/data-product-json[^>]*>([\s\S]*?)<\/script>/i);
  if (productJsonMatch?.[1]) {
    try {
      const pData = JSON.parse(productJsonMatch[1]);
      if (pData.title) {
        return shopifyProductToWoo(pData as ShopifyProductJson, sourceUrl).parent;
      }
    } catch {
      // invalid JSON
    }
  }

  return null;
}

/**
 * Attempt to fetch a Shopify JSON endpoint. Returns null if the store blocks it.
 */
async function fetchShopifyJson<T>(url: string): Promise<T | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)',
        Accept: 'application/json',
      },
    });
    if (!resp.ok) {
      await resp.body?.cancel();
      return null;
    }
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Paginate through a Shopify JSON list endpoint (?limit=250&page=N).
 */
async function fetchShopifyPaginated<T>(baseUrl: string, key: string): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  const maxPages = 20; // safety limit
  while (page <= maxPages) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${sep}limit=250&page=${page}`;
    const data = await fetchShopifyJson<Record<string, T[]>>(url);
    if (!data || !data[key] || data[key].length === 0) break;
    items.push(...data[key]);
    if (data[key].length < 250) break;
    page++;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Quality scoring
// ---------------------------------------------------------------------------

export interface QualitySignals {
  title: string;
  content: string;
  images: string[];
  date: string;
  hasStructuredData: boolean;
  hasPriceSku: boolean;
}

export function scorePageQuality(signals: QualitySignals): 'high' | 'medium' | 'low' {
  let score = 0;
  if (signals.title.length > 0) score += 20;
  if (signals.content.length > 200) score += 25;
  else if (signals.content.length > 50) score += 10;
  if (signals.images.length > 0) score += 15;
  if (signals.hasStructuredData) score += 10;
  if (signals.hasPriceSku) score += 10;
  if (signals.date.length > 0) score += 10;

  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// HTML helpers (regex-based, no DOM parser dependency)
// ---------------------------------------------------------------------------


/**
 * Extract content from Shopify page HTML.
 * Tries multiple strategies and picks the richest result. Narrow selectors
 * (Replo, .rte) are preferred when they return substantial content (>=100
 * chars of text); otherwise we fall through to broader selectors (<article>,
 * <main>) which capture section-based page builders.
 */
function extractShopifyContent(html: string): string {
  const textLen = (h: string) => h.replace(/<[^>]*>/g, '').trim().length;
  const MIN_CONTENT = 100; // chars of stripped text to accept a narrow strategy

  // Strategy 1: Replo page builder
  const reploMatch = html.match(/<div[^>]*id="replo-fullpage-element"[^>]*>([\s\S]*?)<\/main>/i);
  if (reploMatch?.[1] && textLen(reploMatch[1]) >= MIN_CONTENT) {
    return reploMatch[1].trim();
  }

  // Strategy 2: .rte content block (standard Shopify rich text)
  const rteStart = html.match(/<div[^>]*class="[^"]*\brte\b[^"]*"[^>]*>/i);
  if (rteStart) {
    const startIdx = html.indexOf(rteStart[0]);
    const afterTag = startIdx + rteStart[0].length;
    let depth = 1;
    let i = afterTag;
    while (i < html.length && depth > 0) {
      const nextOpen = html.indexOf('<div', i);
      const nextClose = html.indexOf('</div>', i);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        i = nextOpen + 4;
      } else {
        depth--;
        if (depth === 0) {
          const rteContent = html.slice(afterTag, nextClose).trim();
          if (textLen(rteContent) >= MIN_CONTENT) return rteContent;
          break; // thin .rte — fall through to broader strategies
        }
        i = nextClose + 6;
      }
    }
  }

  // Strategy 3: .alchemy-rte (another common page builder pattern)
  const alchemyMatch = html.match(/<div[^>]*class="[^"]*alchemy-rte[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (alchemyMatch?.[1] && textLen(alchemyMatch[1]) >= MIN_CONTENT) return alchemyMatch[1].trim();

  // Strategy 4: <article> tag content
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch?.[1] && textLen(articleMatch[1]) >= MIN_CONTENT) return articleMatch[1].trim();

  // Strategy 5: <main> tag (broadest — captures all section content)
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch?.[1]?.trim()) return mainMatch[1].trim();

  return '';
}

/**
 * Extract media URLs from content. Looks for cdn.shopify.com image URLs.
 */
function extractShopifyMediaUrls(html: string): string[] {
  const urls = new Set<string>();

  // Shopify CDN URLs
  const cdnPattern = /https?:\/\/cdn\.shopify\.com\/s\/files\/[^\s"'<>)]+/g;
  const cdnMatches = html.match(cdnPattern) || [];
  for (const m of cdnMatches) urls.add(m);

  // Standard <img> tags
  const imgSrcMatches = html.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
  for (const match of imgSrcMatches) {
    const src = match.match(/src=["']([^"']+)["']/i);
    if (src?.[1] && src[1].startsWith('http')) {
      urls.add(src[1]);
    }
  }

  // Filter to actual image URLs
  const imageExtensions = IMAGE_EXTENSIONS;
  const nonImageExtensions = /\.(css|js|json|xml|txt|map|woff2?|ttf|eot|pdf)$/i;
  return [...urls].filter((u) => {
    try {
      const parsed = new URL(u);
      if (nonImageExtensions.test(parsed.pathname)) return false;
      return imageExtensions.test(parsed.pathname);
    } catch {
      return false;
    }
  });
}

/**
 * Extract date from HTML — tries schema.org, <time>, and meta tags.
 */
function extractDate(html: string): string {
  // Schema.org datePublished
  const schemaDate = html.match(/datePublished["']?\s*[:=]\s*["']([^"']+)["']/i)?.[1];
  if (schemaDate) return schemaDate;

  // <time datetime="...">
  const timeEl = html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];
  if (timeEl) return timeEl;

  // meta article:published_time
  const metaDate = extractMeta(html, 'article:published_time');
  if (metaDate) return metaDate;

  return '';
}

// ---------------------------------------------------------------------------
// CDP-based admin GraphQL discovery
// ---------------------------------------------------------------------------

async function discoverProductsViaCdp(cdpPort: number, origin: string): Promise<string[]> {
  const { launchBrowser } = await import('./shared.js');
  const { page, close } = await launchBrowser({ cdpPort });

  const handles: string[] = [];
  const seen = new Set<string>();

  try {
    const pw = page as import('playwright').Page;

    pw.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('admin.shopify.com/api/operations/')) return;
      if (!url.includes('ProductIndex') && !url.includes('ProductList')) return;

      try {
        const json = await response.json() as Record<string, unknown>;
        const data = json.data as Record<string, unknown> | undefined;
        if (!data) return;

        const products = data.filteredProducts as Record<string, unknown> | undefined;
        const edges = (products?.edges || []) as Array<{ node: { handle?: string } }>;

        for (const edge of edges) {
          const handle = edge.node?.handle;
          if (handle && !seen.has(handle)) {
            seen.add(handle);
            handles.push(handle);
          }
        }
      } catch {
        // Response parsing failed
      }
    });

    try {
      await pw.goto(`${origin}/admin/products`, { waitUntil: 'networkidle', timeout: 30000 });
    } catch {
      // Navigation may timeout but we still capture intercepted responses
    }

    // Scroll to trigger lazy loading
    for (let i = 0; i < 5; i++) {
      await pw.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise((r) => setTimeout(r, 2000));
      if (handles.length > 200) break;
    }

    await new Promise((r) => setTimeout(r, 1000));
  } finally {
    await close();
  }

  return handles;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const shopifyAdapter: PlatformAdapter = {
  id: 'shopify',

  detect(url: string): boolean {
    return /myshopify\.com|shopify\.com/i.test(url);
  },

  async discover(url: string, _opts: Record<string, unknown>): Promise<ShopifyInventory> {
    const normalized = url.includes('://') ? url : `https://${url}`;
    const origin = new URL(normalized).origin;

    // 1. Try JSON API — check if pages.json is accessible
    let jsonApiAvailable = false;
    const jsonPages = await fetchShopifyPaginated<ShopifyPage>(`${origin}/pages.json`, 'pages');
    if (jsonPages.length > 0) {
      jsonApiAvailable = true;
    }

    // 2. Fetch homepage HTML for metadata
    let homepageHtml = '';
    try {
      const resp = await fetch(normalized, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)' },
      });
      if (resp.ok) {
        homepageHtml = await resp.text();
      } else {
        await resp.body?.cancel();
      }
    } catch {
      // Network error
    }

    // Extract site metadata
    const ogTitle = extractMeta(homepageHtml, 'og:title');
    const ogDescription = extractMeta(homepageHtml, 'og:description');
    const siteTitle = ogTitle || extractTitle(homepageHtml) || 'Imported Site';
    const siteTagline = ogDescription || extractMeta(homepageHtml, 'description') || '';
    const langMatch = homepageHtml.match(/<html[^>]+lang=["']([^"']+)["']/i);
    const siteLanguage = langMatch?.[1] || 'en-US';

    // Extract navigation
    const navigation = extractNavLinks(homepageHtml, origin);

    // 3. Collect URLs from JSON API if available
    const inventoryUrls: InventoryUrl[] = [];
    const counts: Record<string, number> = {};

    if (jsonApiAvailable) {
      // Add pages from JSON API
      for (const page of jsonPages) {
        const pageUrl = `${origin}/pages/${page.handle}`;
        inventoryUrls.push({ url: pageUrl, type: 'page' });
        counts['page'] = (counts['page'] || 0) + 1;
      }

      // Discover blogs and articles
      const blogs = await fetchShopifyPaginated<ShopifyBlog>(`${origin}/blogs.json`, 'blogs');
      for (const blog of blogs) {
        const articles = await fetchShopifyPaginated<ShopifyArticle>(
          `${origin}/blogs/${blog.handle}/articles.json`,
          'articles'
        );
        for (const article of articles) {
          const articleUrl = `${origin}/blogs/${blog.handle}/${article.handle}`;
          inventoryUrls.push({ url: articleUrl, type: 'post' });
          counts['post'] = (counts['post'] || 0) + 1;
        }
      }
    }

    // 4. Fetch sitemap (Shopify sitemaps are index files with sub-sitemaps)
    const sitemapUrls = await fetchSitemap(normalized);
    for (const u of sitemapUrls) {
      // Skip if already found via JSON API
      if (inventoryUrls.some((inv) => inv.url === u)) continue;
      const type = classifyUrl(u);
      inventoryUrls.push({ url: u, type });
      counts[type] = (counts[type] || 0) + 1;
    }

    // 5. CDP-based admin discovery (if cdpPort provided)
    const shopifyOpts = _opts as ShopifyAdapterOpts;
    if (shopifyOpts.cdpPort) {
      try {
        const cdpHandles = await discoverProductsViaCdp(shopifyOpts.cdpPort, origin);
        for (const handle of cdpHandles) {
          const productUrl = `${origin}/products/${handle}`;
          if (inventoryUrls.some((inv) => inv.url === productUrl)) continue;
          inventoryUrls.push({ url: productUrl, type: 'product' });
          counts['product'] = (counts['product'] || 0) + 1;
        }
      } catch {
        // CDP discovery failed — continue with existing results
      }
    }

    // If we still have nothing, add the homepage
    if (inventoryUrls.length === 0) {
      inventoryUrls.push({ url: normalized, type: 'homepage' });
      counts['homepage'] = 1;
    }

    // Auto-detect the *.myshopify.com admin hostname from the storefront
    // HTML. Works regardless of whether the site is served on a custom
    // domain, so callers can supply `adminToken` without also computing
    // `shopDomain` themselves. Falls back to the URL hostname only when
    // the URL already points at myshopify.com.
    let shopDomain = extractShopDomain(homepageHtml);
    if (!shopDomain) {
      const host = new URL(normalized).hostname;
      if (host.endsWith('.myshopify.com')) shopDomain = host;
    }

    return {
      siteUrl: url,
      discoveredAt: new Date().toISOString(),
      shopDomain,
      siteMeta: {
        title: siteTitle,
        tagline: siteTagline,
        language: siteLanguage,
      },
      navigation,
      counts,
      urls: inventoryUrls,
      jsonApiAvailable,
    };
  },

  async extract(
    inventory: unknown,
    wxr: WxrBuilder,
    opts: Record<string, unknown>,
    context: { log: ExtractionLog; server: Server }
  ): Promise<{
    pagesExtracted: number;
    postsExtracted: number;
    failed: number;
    mediaCollected: number;
  }> {
    const inv = inventory as ShopifyInventory;
    const shopifyOpts = opts as ShopifyAdapterOpts;
    const delayMs = shopifyOpts.delay != null ? shopifyOpts.delay : 300;
    const outputDir = shopifyOpts.outputDir || '';

    // Higher-level resume state (stage, args, per-entity progress, cursors).
    // Lives alongside extraction-log.jsonl; session.json captures original
    // args so a future `resume` run doesn't need them re-passed.
    const session = outputDir
      ? ImportSession.loadOrCreate(outputDir, 'shopify', shopifyOpts, { resume: !!shopifyOpts.resume })
      : undefined;

    // Product CSV builder — streams products as JSONL, builds CSV at the end
    const csvBuilder = new WooProductCsvBuilder();
    let hasProducts = false;
    if (outputDir && !shopifyOpts.dryRun) {
      csvBuilder.openStream(outputDir, { resume: !!shopifyOpts.resume });
    }

    // GraphQL fast-path: when an Admin API token is available, fetch all
    // products up-front via GraphQL. This gives us compareAtPrice, unitCost,
    // inventoryPolicy, tracked, variant media, collections, and SEO
    // metafields — data the public JSON API doesn't expose. We then strip
    // product URLs from the inventory so the URL loop doesn't reprocess them.
    const graphqlProductHandles = new Set<string>();
    if (shopifyOpts.adminToken && !shopifyOpts.dryRun) {
      // Resolve the admin hostname. Shopify Admin API only accepts the
      // myshopify.com subdomain; custom storefront domains (e.g.
      // shop.brand.com) will silently fail authentication. Preference:
      //   1. explicit shopDomain opt (user override)
      //   2. inventory.shopDomain auto-detected during discover()
      //   3. siteUrl hostname (only if it's already *.myshopify.com)
      let shopDomain = shopifyOpts.shopDomain || inv.shopDomain;
      if (!shopDomain) {
        const derived = new URL(
          inv.siteUrl.includes('://') ? inv.siteUrl : `https://${inv.siteUrl}`
        ).hostname;
        if (derived.endsWith('.myshopify.com')) {
          shopDomain = derived;
        } else {
          throw new Error(
            `Shopify GraphQL requires a *.myshopify.com host, but auto-detection ` +
            `failed and siteUrl "${derived}" is a custom domain. Pass --shop-domain ` +
            `explicitly, or re-run discover() to refresh inventory.shopDomain.`
          );
        }
      } else if (!shopDomain.endsWith('.myshopify.com')) {
        throw new Error(`shopDomain "${shopDomain}" must end in .myshopify.com`);
      }
      // Resume-idempotency: remember which handles we've already emitted
      // to the CSV across runs. Without this, a crash mid-pagination means
      // the next resume replays all prior pages as duplicate CSV rows.
      const emittedHandles: string[] = session?.getCursor<string[]>('shopify:products:emittedHandles') ?? [];
      for (const h of emittedHandles) graphqlProductHandles.add(h);

      // Compute the storefront origin for sourceUrl on emitted products.
      // Prefer inv.siteUrl (user-facing, possibly a custom domain) so the
      // stamped URL matches what the JSON-API URL-loop path would emit.
      // Fall back to the admin myshopify.com host if parsing fails.
      let storefrontOrigin: string;
      try {
        storefrontOrigin = new URL(
          inv.siteUrl.includes('://') ? inv.siteUrl : `https://${inv.siteUrl}`
        ).origin;
      } catch {
        storefrontOrigin = `https://${shopDomain}`;
      }

      try {
        const client = new ShopifyGraphqlClient({ shopDomain, accessToken: shopifyOpts.adminToken });
        await fetchAllProducts(client, {
          session,
          onBatch: (batch: ShopifyGqlProduct[]) => {
            for (const node of batch) {
              if (node.handle && graphqlProductHandles.has(node.handle)) continue;
              const productSourceUrl = node.handle
                ? `${storefrontOrigin}/products/${node.handle}`
                : undefined;
              const { parent, variations } = shopifyGraphqlProductToWoo(node, productSourceUrl);
              csvBuilder.addProduct(parent);
              for (const v of variations) csvBuilder.addProduct(v);
              hasProducts = true;
              if (node.handle) graphqlProductHandles.add(node.handle);
              if (session) session.bumpProgress('product', 'extracted');
            }
            if (session) {
              // Persist the running set so a crash doesn't re-emit.
              session.setCursor('shopify:products:emittedHandles', [...graphqlProductHandles]);
              session.save();
            }
          },
        });
        // Successful completion — clear the emitted-handles cursor so a
        // subsequent fresh run doesn't inherit stale state.
        if (session) session.setCursor('shopify:products:emittedHandles', null);
      } catch (err) {
        // GraphQL path failed — fall back to JSON API via the URL loop below.
        const msg = err instanceof Error ? err.message : String(err);
        context.server?.sendLoggingMessage?.({
          level: 'warning',
          data: `Shopify GraphQL fetch failed, falling back to JSON API: ${msg}`,
        });
      }
    }

    // Strip products already handled by GraphQL so the URL loop doesn't
    // reprocess them. We mutate the inventory in-place for this run.
    if (graphqlProductHandles.size > 0) {
      inv.urls = inv.urls.filter((u) => {
        if (u.type !== 'product') return true;
        const handle = u.url.match(/\/products\/([^/?#]+)/)?.[1];
        return !handle || !graphqlProductHandles.has(handle);
      });
    }

    // Build a set of product URLs for quick lookup
    const productUrls = new Set(
      inv.urls.filter((u) => u.type === 'product').map((u) => u.url)
    );

    // Lazy-init browser session for CDP/headed fallback on 403s
    let browserSession: { page: unknown; close: () => Promise<void> } | null = null;
    async function getBrowserPage(): Promise<unknown> {
      if (!browserSession) {
        const { launchBrowser } = await import('./shared.js');
        // Prefer user-provided CDP port; otherwise auto-launch headed Chromium
        // (headed bypasses Cloudflare bot detection that blocks headless)
        const session = await launchBrowser(
          shopifyOpts.cdpPort ? { cdpPort: shopifyOpts.cdpPort } : { headed: true }
        );
        browserSession = { page: session.page, close: () => session.close() };
      }
      return browserSession.page;
    }

    let result;
    try {
    result = await runExtractionLoop({
      urls: inv.urls,
      navigation: inv.navigation,
      wxr,
      log: context.log,
      outputDir,
      delay: delayMs,
      dryRun: !!shopifyOpts.dryRun,
      resume: !!shopifyOpts.resume,
      verbose: shopifyOpts.verbose,
      limit: shopifyOpts.limit,
      server: context.server,
      csvBuilder,
      session,
      onPageExtracted: shopifyOpts.onPageExtracted as never,
      extractPage: async (url: string) => {
        // Tier 1: Try JSON API — append .json to URL
        let title = '';
        let content = '';
        let excerpt = '';
        let date = '';
        let tags: string[] = [];
        let categories: string[] = [];
        let mediaUrls: string[] = [];
        let jsonSuccess = false;
        let productHandled = false; // tracks whether CSV builder already has this product
        let detectedType: 'product' | 'post' | 'page' | undefined;
        let author: string | undefined;

        // Check if this URL is a product
        const isProduct = productUrls.has(url) || /\/products\//.test(url);

        try {
          const jsonUrl = url.replace(/\/?$/, '') + '.json';
          const jsonResp = await fetchShopifyJson<Record<string, unknown>>(jsonUrl);

          if (jsonResp) {
            const article = jsonResp.article as ShopifyArticle | undefined;
            const page = jsonResp.page as ShopifyPage | undefined;
            const product = jsonResp.product as ShopifyProductJson | undefined;

            if (product?.title) {
              // Product JSON found — add to CSV builder for WooCommerce export
              detectedType = 'product';
              const { parent, variations } = shopifyProductToWoo(product, url);
              csvBuilder.addProduct(parent);
              for (const variation of variations) {
                csvBuilder.addProduct(variation);
              }
              hasProducts = true;
              productHandled = true;

              // Collect JSON metadata — but DON'T set jsonSuccess so we
              // fall through to HTML for richer page content (product pages
              // typically have section-based content far beyond body_html).
              title = product.title;
              content = product.body_html || '';
              tags = product.tags
                ? product.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
                : [];
              categories = product.product_type ? [product.product_type] : [];
              mediaUrls = parent.images ? [...parent.images] : [];
              mediaUrls.push(...extractShopifyMediaUrls(content));
            } else if (article?.body_html) {
              title = article.title;
              content = article.body_html;
              excerpt = article.summary_html || article.body_html.replace(/<[^>]*>/g, '').slice(0, 200);
              date = article.published_at || '';
              author = article.author || undefined;
              tags = article.tags ? article.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [];
              if (article.image?.src) {
                mediaUrls.push(article.image.src);
              }
              mediaUrls.push(...extractShopifyMediaUrls(content));
              jsonSuccess = true;
            } else if (page?.body_html) {
              title = page.title;
              content = page.body_html;
              date = page.published_at || '';
              author = page.author || undefined;
              mediaUrls.push(...extractShopifyMediaUrls(content));
              jsonSuccess = true;
            }

            // Thin-content gate: if JSON returned very little actual text,
            // mark as not successful so we fall through to HTML extraction.
            // Keep JSON metadata (title, date, tags, author) but replace content.
            if (jsonSuccess) {
              const strippedText = content.replace(/<[^>]*>/g, '').trim();
              if (strippedText.length < 100) {
                jsonSuccess = false;
              }
            }
          }
        } catch {
          // JSON failed — fall through to HTML
        }

        // Tier 2: Fall back to HTML parsing, or supplement thin JSON content
        const isBlogPost = /\/blogs\//.test(url);
        const needsHtml = !jsonSuccess || isBlogPost;
        if (needsHtml) {
          let html = '';
          let needsBrowser = false;
          try {
            const resp = await fetch(url, {
              signal: AbortSignal.timeout(15000),
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)' },
            });
            if (resp.ok) {
              html = await resp.text();
              // Detect Cloudflare challenge pages served with 200 status
              if (html.includes('Just a moment...') && html.includes('cf_chl_opt')) {
                html = '';
                needsBrowser = true;
              }
            } else {
              await resp.body?.cancel();
              if (resp.status === 403) needsBrowser = true;
            }
          } catch {
            // Network error
          }

          // Tier 3: browser fallback for blocked pages (Cloudflare, bot protection)
          // Uses CDP if cdpPort provided, otherwise auto-launches headed Chromium
          if (needsBrowser && !html) {
            try {
              const page = await getBrowserPage() as import('playwright').Page;
              await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
              html = await page.content();
            } catch {
              // Browser extraction failed — continue with empty html
            }
          }

          if (!jsonSuccess) {
            // Full HTML fallback — replace all content from HTML
            // Try to extract product data from HTML structured data (JSON-LD, microdata)
            // Skip if we already handled the product via JSON API
            if (!productHandled) {
              const wooProduct = extractProductFromHtml(html, url);
              if (wooProduct) {
                detectedType = 'product';
                csvBuilder.addProduct(wooProduct);
                hasProducts = true;
              }
            }

            const htmlContent = extractShopifyContent(html);
            // Only replace content if HTML actually has more
            if (htmlContent.replace(/<[^>]*>/g, '').trim().length > content.replace(/<[^>]*>/g, '').trim().length) {
              content = htmlContent;
            }
            // Only replace metadata if we didn't get it from JSON
            if (!title) title = extractHeading(html) || '';
            if (!excerpt) excerpt = extractMeta(html, 'og:description') || extractMeta(html, 'description') || '';
            if (!date) date = extractDate(html);
            // Merge HTML media with any JSON media already collected
            const htmlMedia = extractShopifyMediaUrls(html);
            for (const m of htmlMedia) {
              if (!mediaUrls.includes(m)) mediaUrls.push(m);
            }
          }

          // Always extract OG image (covers blog featured images and general cases)
          if (html) {
            const ogImage = extractMeta(html, 'og:image');
            if (ogImage && ogImage.startsWith('http') && !mediaUrls.includes(ogImage)) {
              try {
                if (IMAGE_EXTENSIONS.test(new URL(ogImage).pathname)) {
                  // Prepend OG image so it becomes the featured image
                  mediaUrls.unshift(ogImage);
                }
              } catch { /* invalid URL */ }
            }
          }
        }

        if (!title) title = slugify(url);

        const seoTitle = title;
        const seoDescription = excerpt;

        // Deduplicate media
        mediaUrls = [...new Set(mediaUrls)];

        // Quality score
        const qualityScore = scorePageQuality({
          title,
          content,
          images: mediaUrls,
          date,
          hasStructuredData: jsonSuccess,
          hasPriceSku: detectedType === 'product',
        });

        return {
          title,
          slug: slugify(url),
          content,
          excerpt,
          date,
          seoTitle,
          seoDescription,
          mediaUrls,
          qualityScore,
          categories,
          tags,
          detectedType,
          author,
        };
      },
    });

    // Finalize product CSV — reads JSONL and writes CSV
    if (hasProducts && outputDir && !shopifyOpts.dryRun) {
      if (csvBuilder.isStreaming) {
        csvBuilder.closeStream();
      } else {
        csvBuilder.serialize(`${outputDir}/products.csv`);
      }
    }

    if (session) session.complete();
    return result;
    } catch (err) {
      // Swallow any secondary error from persisting the failure state so the
      // original exception reaches the caller unmasked.
      if (session) {
        try {
          session.setStage('error', err instanceof Error ? err.message : String(err));
        } catch { /* disk full, etc. — don't shadow the real error */ }
      }
      throw err;
    } finally {
      if (browserSession) await (browserSession as { close: () => Promise<void> }).close();
    }
  },
};
