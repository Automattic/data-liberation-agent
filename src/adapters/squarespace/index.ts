import type { PlatformAdapter } from '../../types.js';
import { detection } from './detection.js';
import { discover } from './discover.js';
import { providerCreditRules } from '../../lib/source-cleanup.js';
import { capture } from './capture.js';

export type { SquarespaceInventory, SquarespaceAdapterOpts } from './types.js';

export const squarespaceAdapter: PlatformAdapter = { id: 'squarespace', detection, discover,
  liberation: { ...capture, cleanupRules: providerCreditRules('squarespace', ['squarespace.com'], 'Squarespace') },
};
