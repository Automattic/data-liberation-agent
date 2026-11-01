import { discoverTenantHandle } from '../tenant-handle.js';
import type { DefaultInventory } from '../default/types.js';

export async function discoverSoloist(url: string, _opts: Record<string, unknown>): Promise<DefaultInventory> {
	return discoverTenantHandle(url, ($, root, origin) => {
		const candidates: string[] = [];
		// Only the published site's page paths are routes. Do not recursively mine
		// arbitrary strings from section settings, images, or framework metadata.
		try {
			const props = JSON.parse($('#__NEXT_DATA__').text()).props?.pageProps;
			if (props?.handle === root.slice(1) && Array.isArray(props.data?.websiteSettings?.pages)) {
				for (const page of props.data.websiteSettings.pages) {
					if (typeof page?.path === 'string' && page.path.startsWith('/') && !page.path.startsWith('//')) {
						candidates.push(new URL(`${root}${page.path}`, origin).href);
					}
				}
			}
		} catch {
			// Authored HTML links remain usable without Next metadata.
		}
		return candidates;
	});
}
