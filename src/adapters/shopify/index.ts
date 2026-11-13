import type { PlatformAdapter } from '../../types.js';
import { capture } from './capture.js';
import { detection } from './detection.js';
import { discover } from './discover.js';
import { shopifyAcquisition } from './acquisition.js';
import { shopifyStructuredContent } from './template-content.js';
import { shopifyTemplateIdentity } from './template-identity.js';

// ---------------------------------------------------------------------------
// Re-exports — public API surface (importers use shopify/index.js by name)
// ---------------------------------------------------------------------------

export { extractShopDomain, scorePageQuality, extractShopifyMediaUrls } from './content.js';
export type { QualitySignals } from './content.js';
export type { ShopifyProductJson } from './types.js';
export type { ShopifyAdapterOpts, ShopifyInventory } from './types.js';

// ---------------------------------------------------------------------------
// Adapter assembly
// ---------------------------------------------------------------------------

export const shopifyAdapter: PlatformAdapter = {
  sourceTelemetry: ['/.well-known/shopify/monorail/'],
  id: 'shopify',
  detection,
  liberation: capture,
  discover,
  acquisition: shopifyAcquisition,
  structuredContent: shopifyStructuredContent,
  templateIdentity: shopifyTemplateIdentity,
  inspection: [
    { capability: 'commerce', selector: 'shopify-payment-terms,shopify-buy-it-now-button,form[action*="/cart/add"]', evidence: 'Shopify purchasing surface; checkout backend requires migration' },
  ],
};
