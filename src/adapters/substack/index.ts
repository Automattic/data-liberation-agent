import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from '../default/discover.js';
import { cleanupRules, neutralizePlatformLinks } from './capture.js';
import { detection } from './detection.js';

// Substack serves a flat sitemap of every post plus /archive and /about, so
// the generic discovery covers it.
export const substackAdapter: PlatformAdapter = {
	id: 'substack',
	detection,
	discover: discoverDefault,
	liberation: {
		cleanupRules,
		beforeSerialize: async ( page ) => { await neutralizePlatformLinks( page ); },
	},
};
