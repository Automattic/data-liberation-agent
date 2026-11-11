import type { PlatformAdapter } from '../../types.js';
import { defaultAdapter } from '../default/index.js';
import { discoverTenantHandle, tenantHandleRouteScope } from '../tenant-handle.js';

export const atombioAdapter: PlatformAdapter = {
	id: 'atombio',
	detection: {
		hosts: ['atom.bio'],
	},
	routeScope: tenantHandleRouteScope,
	discover: (url) => discoverTenantHandle(url),
	liberation: defaultAdapter.liberation,
};
