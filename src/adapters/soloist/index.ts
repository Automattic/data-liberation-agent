import type { PlatformAdapter } from '../../types.js';
import { nextjsAdapter } from '../nextjs/index.js';
import { detection } from './detection.js';
import { discoverSoloist } from './discover.js';
import { tenantHandleRouteScope } from '../tenant-handle.js';

export const soloistAdapter: PlatformAdapter = {
	id: 'soloist',
	routeScope: tenantHandleRouteScope,
	detection,
	discover: discoverSoloist,
	liberation: nextjsAdapter.liberation,
};
