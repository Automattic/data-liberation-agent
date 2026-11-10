import type { PlatformAdapter } from '../../types.js';
import { detection } from './detection.js';
import { discoverWeebly } from './discover.js';
import { providerCreditRules } from '../../lib/source-cleanup.js';

export type { WeeblyInventory, WeeblyAdapterOpts } from './types.js';

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const weeblyAdapter: PlatformAdapter = {
  id: 'weebly',
  detection,
  discover: discoverWeebly,
  liberation: {
    cleanupRules: [
      ...providerCreditRules('weebly', ['weebly.com'], 'Weebly'),
      {
        id: 'square-checkout-flyover', category: 'provider-service',
        selector: '.cko.cko--flyover',
        evidence: 'Square Online checkout drawer: closed at rest, opened only by the Square commerce runtime',
      },
      {
        id: 'square-messages-chat', category: 'provider-service', selector: 'messages-plugin',
        evidence: 'Square conversations chat requires the Square messaging backend',
      },
    ],
  },
};
