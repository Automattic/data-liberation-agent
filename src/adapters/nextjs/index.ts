import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from '../default/discover.js';
import { detection } from './detection.js';

export const nextjsAdapter: PlatformAdapter = {
	id: 'nextjs',
	detection,
	discover: discoverDefault,
	liberation: {
		// App Router shadow host and Pages Router's reserved announcer id.
		// Never remove authored live regions by ARIA role or visual appearance.
		removeSelectors: ['next-route-announcer', '#__next-route-announcer__'],
	},
};
