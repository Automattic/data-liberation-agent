import { load, type CheerioAPI } from 'cheerio';
import { classifyUrl, extractSameOriginLinks } from '../lib/extraction/sitemap.js';
import { documentRequestUrl } from '../lib/url/route-key.js';
import { routeInScope } from '../lib/url/route-scope.js';
import type { SiteRouteScope } from '../platform/types.js';
import { extractMeta, extractNavLinks, extractTitle } from '../lib/html-extract/index.js';
import type { DefaultInventory } from './default/types.js';

/** A shared-origin customer owns exactly its first path segment. */
export function tenantHandleRouteScope(sourceUrl: string): SiteRouteScope {
	const entry = new URL(sourceUrl);
	const handle = entry.pathname.split('/')[1];
	if (!handle) {
		// failure-class: integrity
		throw new Error('Tenant discovery requires a customer handle URL');
	}
	return { origin: entry.origin, pathPrefixes: [`/${handle}`] };
}

/** One homepage supplies tenant links and metadata; never request the platform sitemap. */
export async function discoverTenantHandle(
	url: string,
	extraCandidates?: ($: CheerioAPI, root: string, origin: string) => string[],
): Promise<DefaultInventory> {
	const entry = new URL(url.includes('://') ? url : `https://${url}`);
	const scope = tenantHandleRouteScope(entry.href);
	const root = scope.pathPrefixes[0]!;
	const inTenant = (candidate: URL): boolean => routeInScope(candidate.href, scope);
	// Edge bot protection on shared hosts refuses runtime-default agents such as `node`.
	const response = await fetch(new URL(`${root}/`, entry.origin), {
		signal: AbortSignal.timeout(15000),
		headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)' },
	});
	if (!response.ok || !inTenant(new URL(response.url))) {
		await response.body?.cancel();
		// failure-class: operational
		throw new Error(`Tenant homepage unavailable or redirected outside the tenant: ${response.status} ${response.url}`);
	}
	const html = await response.text();
	const homepage = documentRequestUrl(response.url);
	const $ = load(html);
	const candidates = extractSameOriginLinks(html, homepage);
	candidates.push(...(extraCandidates?.($, root, entry.origin) ?? []));
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
