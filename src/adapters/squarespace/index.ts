import type { PlatformAdapter } from '../../types.js';
import { blocks } from './blocks.js';
import { detection } from './detection.js';
import { discover } from './discover.js';
import { extract } from './extract.js';

export type { SquarespaceInventory, SquarespaceAdapterOpts } from './types.js';

export const squarespaceAdapter: PlatformAdapter = {
  id: 'squarespace',
  detection,
  discover,
  extract,
  blocks,
};
