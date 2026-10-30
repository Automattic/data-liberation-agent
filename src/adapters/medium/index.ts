import type { PlatformAdapter } from '../../types.js';
import { cleanupRules, probeExclusions, removeFollowButtons } from './capture.js';
import { detection } from './detection.js';
import { discoverMedium } from './discover.js';
import { mediumRouteScope } from './route-scope.js';

export const mediumAdapter: PlatformAdapter = {
	id: 'medium',
	routeScope: mediumRouteScope,
	detection,
	discover: discoverMedium,
	liberation: {
		cleanupRules,
		probeExclusions,
		prepare: async ( page ) => { await removeFollowButtons( page ); },
		beforeSerialize: async ( page ) => { await removeFollowButtons( page ); },
	},
};
