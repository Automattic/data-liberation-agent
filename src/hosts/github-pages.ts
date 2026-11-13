import { tenantHandleRouteScope } from '../adapters/tenant-handle.js';
import type { SiteRouteScope } from '../platform/types.js';

/** Project sites share an origin, but own only their first path segment. */
export function githubPagesRouteScope(sourceUrl: string): SiteRouteScope | undefined {
	const entry = new URL(sourceUrl);
	if (!/^[^.]+\.github\.io$/.test(entry.hostname) || entry.pathname === '/') return undefined;
	return tenantHandleRouteScope(sourceUrl);
}
