import type { PlatformAdapter } from '../../types.js';
import { discover } from './discover.js';
import { extract } from './extract.js';

export type { HostingerAdapterOpts, HostingerInventory } from './types.js';

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

// Hostinger sites are on custom domains with no reliable URL pattern. Detection
// relies entirely on HTTP fingerprinting (see detect-platform.ts SOURCE_SIGNALS
// for zyrosite.com and the Hostinger generator meta tag).
export const hostingerAdapter: PlatformAdapter = { id: 'hostinger', discover, extract };
