import type { InventoryUrl } from '../shared.js';
import type { NavLink } from '../../lib/html-extract/index.js';

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
  diagnostics?: import('../../lib/extraction/sitemap.js').SitemapDiagnostic[];
  jsonApiAvailable: boolean;
  /**
   * The `*.myshopify.com` hostname, auto-detected from storefront HTML.
   * Populated even when the site is served on a custom domain — every
   * Shopify storefront exposes this via a `Shopify.shop = "..."` global.
   * Used for Admin GraphQL calls when `adminToken` is supplied.
   */
  shopDomain?: string;
}

export interface ShopifyPage {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  published_at?: string;
  author?: string;
}

export interface ShopifyBlog {
  id: number;
  title: string;
  handle: string;
}

export interface ShopifyArticle {
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

export interface ShopifyProductVariant {
  id: number;
  title: string;
  price: number;
  compare_at_price?: number | null;
  sku: string;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  available?: boolean;
  featured_image?: { src: string } | null;
}

export interface ShopifyProductOption {
  name: string;
  position: number;
  values: string[];
}

export interface ShopifyProductJson {
  id: number;
  title: string;
  description: string;
  handle: string;
  tags: string[];
  variants: ShopifyProductVariant[];
  options: ShopifyProductOption[];
  images: string[];
}

// Narrow stockable-variant shape shared by `computeStock`.
export type ShopifyGqlVariantLike = {
  inventoryPolicy: 'DENY' | 'CONTINUE';
  inventoryQuantity: number | null;
  inventoryItem?: { tracked: boolean } | null | undefined;
};
