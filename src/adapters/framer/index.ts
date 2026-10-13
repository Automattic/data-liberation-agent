import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from '../default/discover.js';
import { providerCreditRules } from '../../lib/source-cleanup.js';
import { detection } from './detection.js';

export const framerAdapter: PlatformAdapter = {
	id: 'framer',
	detection,
	discover: discoverDefault,
	liberation: {
		cleanupRules: [
			// The "Made in Framer" badge is a fixed overlay the host appends to
			// every page of a site on a free plan; it is not owner content.
			{ id: 'framer-badge', category: 'source-attribution', selector: '#__framer-badge-container' },
			...providerCreditRules( 'framer', [ 'framer.com' ], 'Framer' ),
		],
	},
};
