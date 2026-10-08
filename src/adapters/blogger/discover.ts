import * as cheerio from 'cheerio';
import { classifyUrl, routeKey } from '../../lib/extraction/sitemap.js';
import type { InventoryUrl } from '../shared.js';
import { discoverDefault } from '../default/discover.js';
import { BLOGGER_FEED_REQUESTED_RESULTS, enumerateBloggerPosts } from './feed.js';
import type { BloggerInventory } from './types.js';
import { safeFetch } from '../../lib/media-fetch/safe-fetch.js';

const UA = 'Mozilla/5.0 (compatible; DataLiberation/1.0)';

function addRoutes(urls: InventoryUrl[], additions: readonly string[]): InventoryUrl[] {
	const known = new Set(urls.map((entry) => {
		try {
			return routeKey(entry.url);
		} catch {
			return entry.url;
		}
	}));
	const next = [ ...urls ];
	for (const href of additions) {
		let key: string;
		try {
			key = routeKey(href);
		} catch {
			continue;
		}
		if (known.has(key)) continue;
		known.add(key);
		next.push({ url: href, type: classifyUrl(href) });
	}
	return next;
}

function recount(urls: InventoryUrl[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const entry of urls) counts[entry.type] = (counts[entry.type] ?? 0) + 1;
	return counts;
}

export function bloggerListingLinks(html: string, baseUrl: string): string[] {
	const $ = cheerio.load(html);
	const origin = new URL(baseUrl).origin;
	const urls: string[] = [];
	const seen = new Set<string>();
	$('a[href]').each((_, element) => {
		const href = $(element).attr('href')?.trim();
		if (!href || href.startsWith('#')) return;
		let resolved: URL;
		try {
			resolved = new URL(href, baseUrl);
		} catch {
			return;
		}
		if (resolved.origin !== origin || (resolved.protocol !== 'http:' && resolved.protocol !== 'https:')) return;
		const path = resolved.pathname;
		if (!/^\/search\/label\/[^/]+\/?$/i.test(path) && !/^\/\d{4}(?:\/\d{1,2})?\/?$/.test(path)) return;
		resolved.hash = '';
		resolved.search = '';
		const key = routeKey(resolved.href);
		if (seen.has(key)) return;
		seen.add(key);
		urls.push(resolved.href);
	});
	return urls;
}

async function fetchHomepage(url: string): Promise<string> {
	try {
		const response = await safeFetch(url, {
			timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024,
			headers: { 'User-Agent': UA },
		});
		if (response.status < 200 || response.status >= 300) return '';
		return response.body.toString('utf8');
	} catch {
		return '';
	}
}

export async function discover(url: string, opts: Record<string, unknown>): Promise<BloggerInventory> {
	const inventory = await discoverDefault(url, opts);
	const normalized = url.includes('://') ? url : `https://${url}`;
	const origin = new URL(normalized).origin;
	const sitemapMissing = inventory.diagnostics?.some((diagnostic) => diagnostic.code === 'sitemap_missing' || diagnostic.code === 'sitemap_absent') ?? false;
	const homepageHtml = await fetchHomepage(normalized);
	let urls = addRoutes(inventory.urls, bloggerListingLinks(homepageHtml, normalized));
	const diagnostics = [ ...(inventory.diagnostics ?? []) ];
	const feed = await enumerateBloggerPosts(origin, { sample: !sitemapMissing });
	diagnostics.push(...feed.rejected);
	if (sitemapMissing) urls = addRoutes(urls, feed.posts);
	const known = new Set(urls.map((entry) => {
		try {
			return routeKey(entry.url);
		} catch {
			return entry.url;
		}
	}));
	const absent = feed.posts.filter((post) => {
		try {
			return !known.has(routeKey(post));
		} catch {
			return true;
		}
	});
	if (!sitemapMissing && absent.length > 0) {
		diagnostics.push({
			code: 'feed_posts_not_in_routes',
			url: absent[0],
			reason: `${absent.length} enumerated feed posts are absent from sitemap and homepage discovery; sitemap routes were retained and feed URLs were not merged`,
		});
	}
	return {
		...inventory,
		urls,
		counts: recount(urls),
		diagnostics,
		feed: {
			requestedMaxResults: BLOGGER_FEED_REQUESTED_RESULTS,
			pageEntryCounts: feed.pageEntryCounts,
			declaredItemsPerPage: feed.declaredItemsPerPage,
			totalResults: feed.totalResults,
			enumeratedPosts: feed.posts.length,
			pagesFetched: feed.pagesFetched,
			routeSource: sitemapMissing ? 'feed-fallback' : 'sitemap',
			enumeration: feed.unavailable ? 'unavailable' : sitemapMissing ? (feed.bounded ? 'bounded' : 'paginated') : 'sampled',
			complete: feed.complete,
			bounded: sitemapMissing ? feed.bounded : false,
			postsAbsentFromRoutes: sitemapMissing ? 0 : absent.length,
		},
	};
}
