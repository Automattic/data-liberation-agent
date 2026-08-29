import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from './discover.js';
import { extractDefault } from './extract.js';

export type { DefaultInventory, DefaultAdapterOpts } from './types.js';

// The fallback adapter never positively identifies a platform — it is reached
// via resolveAdapter()'s fallback when detection returns 'unknown' (or names an
// unregistered platform).
export const defaultAdapter: PlatformAdapter = {
  id: 'default',
  discover: discoverDefault,
  extract: extractDefault,
};
