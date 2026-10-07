import type { PlatformAdapter } from '../../types.js';
import { nextjsAdapter } from '../nextjs/index.js';
import { detection } from './detection.js';
import { discoverSoloist } from './discover.js';

export const soloistAdapter: PlatformAdapter = {
	id: 'soloist',
	detection,
	discover: discoverSoloist,
	liberation: nextjsAdapter.liberation,
};
