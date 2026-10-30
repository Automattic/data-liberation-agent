import type { PlatformAdapter } from '../../types.js';
import { detection } from './detection.js';
import { discoverMedium } from './discover.js';
import { mediumRouteScope } from './route-scope.js';

export const mediumAdapter: PlatformAdapter = {
	id: 'medium',
	routeScope: mediumRouteScope,
	detection,
	discover: discoverMedium,
};
