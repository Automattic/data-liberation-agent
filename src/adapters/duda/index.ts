import type { PlatformAdapter } from '../../types.js';
import { discoverDefault } from '../default/discover.js';
import { detection } from './detection.js';
import { markInertPagers } from './pagination.js';

// Duda sites publish a standard sitemap, so the generic discovery covers them.
export const dudaAdapter: PlatformAdapter = {
	id: 'duda',
	detection,
	discover: discoverDefault,
	liberation: {
		beforeSerialize: async ( page ) => { await markInertPagers( page ); },
	},
};
