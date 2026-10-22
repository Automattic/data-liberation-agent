import type { LiberationHooks } from '../page-actions.js';
import { providerCreditRules } from '../../lib/source-cleanup.js';

/**
 * Shopify storefronts inject third-party app chrome that isn't store content:
 * upCart's cart drawer + sticky button, and Klaviyo teaser popups (kl-teaser-*).
 * Shopify Inbox chat and Shop Pay cart-sync are provider-service UI: they need
 * Shopify's Inbox backend and Shop Pay iframe, so a portable copy ships them broken.
 * Remove them on the live page before capture so they pollute neither the
 * screenshots nor the carried HTML/SectionSpec. Product content comes from the
 * Admin GraphQL/JSON API, so the WXR body is unaffected regardless — this is
 * purely a rendered-capture concern.
 */
export const capture: LiberationHooks = {
  cleanupRules: [
    ...providerCreditRules('shopify', ['shopify.com'], 'Shopify'),
    { id: 'shopify-chat', category: 'provider-service', selector: 'shopify-chat' },
    { id: 'shop-cart-sync', category: 'provider-service', selector: 'shop-cart-sync' },
    {
      id: 'shopify-shipping-estimator', category: 'provider-service',
      // Remove the disclosure only for a dedicated estimator body, never a
      // mixed-content row. Ancestors match before descendants, so a dedicated
      // row produces one cleanup record; elsewhere only the dead form leaves.
      selector: 'details:has(> summary:first-child + shipping-estimator:last-child),details:has(> summary:first-child + .accordion__content:last-child > shipping-estimator:only-child),shipping-estimator',
    },
  ],
  removeSelectors: ['#upCart', '#upCartStickyButton', '[class*="kl-teaser"]'],
};
