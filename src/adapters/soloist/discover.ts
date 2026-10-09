import { load } from 'cheerio';
import { classifyUrl, extractSameOriginLinks } from '../../lib/extraction/sitemap.js';
import { documentRequestUrl } from '../../lib/url/route-key.js';
import { routeInScope } from '../../lib/url/route-scope.js';
import { soloistRouteScope } from './route-scope.js';
import { extractMeta, extractNavLinks, extractTitle } from '../../lib/html-extract/index.js';
import type { DefaultInventory } from '../default/types.js';

/** Soloist's first path segment is a customer handle, not an origin-wide site.
 * One homepage response supplies authored links and the Next page inventory;
 * the shared platform sitemap is deliberately never requested. */
export async function discoverSoloist(url: string, _opts: Record<string, unknown>): Promise<DefaultInventory> {
	const entry = new URL(url.includes('://') ? url : `https://${url}`);
	const scope = soloistRouteScope(entry.href);
	const root = scope.pathPrefixes[0]!;
	const handle = root.slice(1);
	const inTenant = (candidate: URL): boolean => routeInScope(candidate.href, scope);
	const response = await fetch(new URL(`${root}/`, entry.origin), { signal: AbortSignal.timeout(15000) });
	if (!response.ok || !inTenant(new URL(response.url))) {
		await response.body?.cancel();
		throw new Error(`Soloist homepage unavailable or redirected outside the tenant: ${response.status} ${response.url}`);
	}
	const html = await response.text();
	const homepage = documentRequestUrl(response.url);
	const $ = load(html);
	const candidates = extractSameOriginLinks(html, homepage);
	// Only the published site's page paths are routes. Do not recursively mine
	// arbitrary strings from section settings, images, or framework metadata.
	try {
		const props = JSON.parse($('#__NEXT_DATA__').text()).props?.pageProps;
		if (props?.handle === handle && Array.isArray(props.data?.websiteSettings?.pages)) {
			for (const page of props.data.websiteSettings.pages) {
				if (typeof page?.path === 'string' && page.path.startsWith('/') && !page.path.startsWith('//')) {
					candidates.push(new URL(`${root}${page.path}`, entry.origin).href);
				}
			}
		}
	} catch {
		// Authored HTML links remain usable without Next metadata.
	}
	const urls = [{ url: homepage, type: 'homepage' }];
	const seen = new Set([documentRequestUrl(homepage)]);
	for (const candidate of candidates) {
		const parsed = new URL(candidate);
		if (!inTenant(parsed)) continue;
		const key = documentRequestUrl(candidate);
		if (seen.has(key)) continue;
		seen.add(key);
		// Classify relative to the tenant so its handle cannot imply a content type.
		urls.push({ url: key, type: classifyUrl(new URL(parsed.pathname.slice(root.length) || '/', entry.origin).href) });
	}
	const counts: Record<string, number> = {};
	for (const route of urls) counts[route.type] = (counts[route.type] || 0) + 1;
	return {
		siteUrl: homepage,
		discoveredAt: new Date().toISOString(),
		siteMeta: {
			title: extractMeta(html, 'og:title') || extractTitle(html) || 'Imported Site',
			tagline: extractMeta(html, 'og:description') || extractMeta(html, 'description') || '',
			language: $('html').attr('lang') || 'en-US',
		},
		navigation: extractNavLinks(html, homepage).filter((link) => inTenant(new URL(link.href))),
		counts,
		urls,
	};
}
