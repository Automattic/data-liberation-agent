import { documentRequestUrl } from '../../lib/url/route-key.js';
import { mediumRouteScope } from './route-scope.js';
import type { DefaultInventory } from '../default/types.js';

/** Medium's origin sitemap lists every story on Medium, and its HTML answers
 * plain HTTP clients with a bot challenge. Discovery therefore starts at the
 * owner's root only; capture follows the owner's in-scope links from there. */
export async function discoverMedium(url: string, _opts: Record<string, unknown>): Promise<DefaultInventory> {
	const entry = new URL(url.includes('://') ? url : `https://${url}`);
	const root = mediumRouteScope(entry.href).pathPrefixes[0]!;
	// Keep the caller's spelling of the owner root so capture sees one homepage route.
	const homepage = documentRequestUrl(entry.pathname.replace(/\/$/, '') === root ? entry.href : new URL(root, entry.origin).href);
	return {
		siteUrl: homepage,
		discoveredAt: new Date().toISOString(),
		siteMeta: { title: root.slice(1), tagline: '', language: 'en-US' },
		navigation: [],
		counts: { homepage: 1 },
		urls: [{ url: homepage, type: 'homepage' }],
	};
}
