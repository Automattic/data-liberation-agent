import type { PlatformAdapter } from '../../types.js';
import { discover } from './discover.js';
import { extract } from './extract.js';
import { blocks } from './blocks.js';

export type { SquarespaceInventory, SquarespaceAdapterOpts } from './types.js';

export const squarespaceAdapter: PlatformAdapter = { id: 'squarespace', discover, extract, blocks };
