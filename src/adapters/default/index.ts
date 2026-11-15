import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from './discover.js';

export type { DefaultInventory } from './types.js';

// The generic fallback never positively identifies a platform — it is reached
// via the registry's fallback resolution when detection returns 'unknown' (or
// names a platform with no registration). It therefore declares no detection
// signals; see src/platform/builtins.ts for the fallback registration.
export const defaultAdapter: PlatformAdapter = {
  id: 'default',
  discover: discoverDefault,
  resolveImageOriginal(value) {
    const url = new URL(value);
    // Base44's public CDN encodes transformations after the original filename.
    if (url.hostname !== 'media.base44.com') return undefined;
    const original = /^(\/images\/public\/[^/]+\/[^/]+)\/v1\/(?:fill|fit|crop)\//i.exec(url.pathname)?.[1];
    if (!original) return undefined;
    url.pathname = original;
    return url.href;
  },
};
