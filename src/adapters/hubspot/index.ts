import type { PlatformAdapter } from '../../types.js';
import { discover } from './discover.js';
import { extract } from './extract.js';

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

// HubSpot CMS sites use custom domains with no URL signal, so identification
// rests on the HubSpot generator meta tag registered in `detect-platform.ts`.
export const hubspotAdapter: PlatformAdapter = { id: 'hubspot', discover, extract };

export type { HubSpotAdapterOpts, HubSpotInventory } from './types.js';
