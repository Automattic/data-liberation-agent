import type { PlatformAdapter } from '../../types.js';
import { discoverWeebly } from './discover.js';
import { extractWeebly } from './extract.js';

export type { WeeblyInventory, WeeblyAdapterOpts } from './types.js';

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const weeblyAdapter: PlatformAdapter = {
  id: 'weebly',
  discover: discoverWeebly,
  extract: extractWeebly,
};
