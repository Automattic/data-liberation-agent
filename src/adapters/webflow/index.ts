import type { PlatformAdapter } from '../../types.js';
import { discoverWebflow } from './discover.js';
import { extractWebflow } from './extract.js';

export type { WebflowInventory, WebflowAdapterOpts } from './discover.js';

export const webflowAdapter: PlatformAdapter = {
  id: 'webflow',
  discover: discoverWebflow,
  extract: extractWebflow,
};
