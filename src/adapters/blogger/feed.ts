import { routeKey } from '../../lib/extraction/sitemap.js';
import { XMLParser } from 'fast-xml-parser';
import { safeFetch } from '../../lib/media-fetch/safe-fetch.js';

export const BLOGGER_FEED_REQUESTED_RESULTS = 500;
export const BLOGGER_FEED_PAGE_CAP = 40;

import { SOURCE_USER_AGENT } from '../../lib/browser-kit/source-identity.js';

export interface FeedDiagnostic {
	code: string;
	url: string;
	reason: string;
}

export interface BloggerFeedEntry {
	permalink: string;
	slug: string;
	kind: 'post' | 'page';
	title: string;
	contentHtml: string;
	published: string;
	updated: string;
	author: string;
	labels: string[];
}

export interface ParsedBloggerFeed {
	entries: BloggerFeedEntry[];
	totalResults: number | null;
	declaredItemsPerPage: number | null;
	entryCount: number;
	posts: string[];
	rejected: FeedDiagnostic[];
}

export interface BloggerFeedEnumeration {
	entries: BloggerFeedEntry[];
	posts: string[];
	pageEntryCounts: number[];
	declaredItemsPerPage: number | null;
	totalResults: number | null;
	pagesFetched: number;
	complete: boolean;
	bounded: boolean;
	unavailable: boolean;
	rejected: FeedDiagnostic[];
	fetchedUrls: string[];
}

export interface EnumerateBloggerPostsOptions {
	fetch?: typeof fetch;
	maxPages?: number;
	/** Static pages use the same pagination and accounting as posts. */
	kind?: 'post' | 'page';
	governors?: import('../../lib/source-request-governor.js').SourceRequestGovernors;
	/** One accounting page. Does not treat the unpaged remainder as a safety-cap stop. */
	sample?: boolean;
}

export function parseBloggerFeed(xml: string, origin: string, kind: 'post' | 'page' = 'post'): ParsedBloggerFeed {
	const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true, parseTagValue: false, isArray: name => name === 'entry' || name === 'link' || name === 'category' || name === 'author' });
	const parsedFeed = parser.parse(xml).feed;
	if (parsedFeed === undefined) throw new Error('Response contains no Atom feed');
	const feed = typeof parsedFeed === 'object' && parsedFeed !== null ? parsedFeed as Record<string, unknown> : {};
	const entries = Array.isArray(feed.entry) ? feed.entry as Array<Record<string, unknown>> : [];
	const number = (value: unknown) => typeof value === 'string' && /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
	const posts: string[] = [];
	const retainedEntries: BloggerFeedEntry[] = [];
	const text = (value: unknown): string => typeof value === 'string' ? value
		: value && typeof value === 'object' && '#text' in value ? String(value['#text']) : '';
	const rejected: FeedDiagnostic[] = [];
	for (const entry of entries) {
		const id = typeof entry.id === 'string' ? entry.id : origin;
		const links = Array.isArray(entry.link) ? entry.link as Array<Record<string,string>> : [];
		let href: string | undefined;
		for (const link of links) {
			const attrs = link;
			if ((attrs.rel ?? '').toLowerCase() !== 'alternate') continue;
			const type = (attrs.type ?? '').toLowerCase();
			if (type && !type.includes('text/html')) continue;
			if (!attrs.href) continue;
			href = attrs.href;
			if (type.includes('text/html')) break;
		}
		if (!href) {
			rejected.push({ code: 'feed_link_rejected', url: id, reason: 'entry has no alternate HTML link' });
			continue;
		}
		let parsed: URL;
		try {
			parsed = new URL(href, origin);
		} catch {
			rejected.push({ code: 'feed_link_rejected', url: href, reason: 'invalid URL' });
			continue;
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			rejected.push({ code: 'feed_link_rejected', url: href, reason: 'unsupported protocol' });
			continue;
		}
		if (parsed.origin !== origin) {
			rejected.push({ code: 'feed_link_rejected', url: parsed.href, reason: 'origin differs from the entry URL' });
			continue;
		}
		parsed.hash = '';
		posts.push(parsed.href);
		const categories = Array.isArray(entry.category) ? entry.category as Array<Record<string, unknown>> : [];
		const authors = Array.isArray(entry.author) ? entry.author as Array<Record<string, unknown>> : [];
		const encodedSlug = parsed.pathname.split('/').at(-1)!.replace(/\.html$/, '');
		let slug = encodedSlug;
		try { slug = decodeURIComponent(encodedSlug); } catch { /* Preserve malformed source escapes. */ }
		retainedEntries.push({
			permalink: parsed.href,
			slug,
			kind,
			title: text(entry.title),
			contentHtml: text(entry.content),
			published: text(entry.published),
			updated: text(entry.updated),
			author: text(authors[0]?.name),
			labels: [...new Set(categories.map(category => text(category.term)).filter(Boolean))],
		});
	}
	return {
		entries: retainedEntries,
		totalResults: number(feed.totalResults),
		declaredItemsPerPage: number(feed.itemsPerPage),
		entryCount: entries.length,
		posts,
		rejected,
	};
}

export function bloggerFeedUrl(origin: string, startIndex: number, kind: 'post' | 'page' = 'post'): string {
	const url = new URL(`/feeds/${kind === 'page' ? 'pages' : 'posts'}/default`, origin);
	url.searchParams.set('max-results', String(BLOGGER_FEED_REQUESTED_RESULTS));
	url.searchParams.set('start-index', String(startIndex));
	return url.href;
}

export async function enumerateBloggerPosts(
	origin: string,
	options: EnumerateBloggerPostsOptions = {},
): Promise<BloggerFeedEnumeration> {
	const fetchImpl = options.fetch ?? fetch;
	const maxPages = options.sample ? 1 : options.maxPages ?? BLOGGER_FEED_PAGE_CAP;
	const posts: string[] = [];
	const entries: BloggerFeedEntry[] = [];
	const seen = new Set<string>();
	const pageEntryCounts: number[] = [];
	const rejected: FeedDiagnostic[] = [];
	const fetchedUrls: string[] = [];
	let totalResults: number | null = null;
	let declaredItemsPerPage: number | null = null;
	let startIndex = 1;
	let pagesFetched = 0;
	let unavailable = false;
	let reachedCap = false;

	for (let page = 0; page < maxPages; page++) {
		const pageUrl = bloggerFeedUrl(origin, startIndex, options.kind);
		fetchedUrls.push(pageUrl);
		let parsed: ParsedBloggerFeed;
		try {
			const response = await safeFetch(pageUrl, {
				fetchImpl, governors: options.governors, timeoutMs: 15_000, maxBytes: 32 * 1024 * 1024,
				headers: { 'User-Agent': SOURCE_USER_AGENT, Accept: 'application/atom+xml, application/xml, text/xml' },
			});
			if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
			parsed = parseBloggerFeed(response.body.toString('utf8'), origin, options.kind);
		} catch (error) {
			unavailable = pagesFetched === 0;
			rejected.push({
				code: 'feed_page_failed',
				url: pageUrl,
				reason: error instanceof Error ? error.message : 'feed fetch failed',
			});
			break;
		}
		pagesFetched++;
		if (totalResults == null) totalResults = parsed.totalResults;
		if (declaredItemsPerPage == null) declaredItemsPerPage = parsed.declaredItemsPerPage;
		pageEntryCounts.push(parsed.entryCount);
		rejected.push(...parsed.rejected);
		if (parsed.entryCount === 0) {
			if (totalResults != null && posts.length < totalResults) {
				rejected.push({
					code: 'feed_ended_early',
					url: pageUrl,
					reason: `Feed ended after ${posts.length} posts; totalResults is ${totalResults}`,
				});
			}
			break;
		}
		let fresh = 0;
		const pageEntries = new Map(parsed.entries.map(entry => [entry.permalink, entry]));
		for (const post of parsed.posts) {
			let key: string;
			try {
				key = routeKey(post);
			} catch {
				rejected.push({ code: 'feed_link_rejected', url: post, reason: 'invalid URL' });
				continue;
			}
			if (seen.has(key)) continue;
			seen.add(key);
			posts.push(post);
			const entry = pageEntries.get(post);
			if (entry) entries.push(entry);
			fresh++;
		}
		if (fresh === 0) {
			rejected.push({
				code: 'feed_page_repeated',
				url: pageUrl,
				reason: 'Feed page repeated posts already enumerated; pagination stopped',
			});
			break;
		}
		startIndex += parsed.entryCount;
		if (totalResults != null && posts.length >= totalResults) break;
		if (page === maxPages - 1) reachedCap = true;
	}

	const complete = totalResults != null && posts.length >= totalResults;
	const bounded = !options.sample && reachedCap && !complete;
	if (bounded) {
		rejected.push({
			code: 'feed_bounded',
			url: fetchedUrls.at(-1) ?? origin,
			reason: `Stopped after ${maxPages} feed pages with ${posts.length} posts; totalResults is ${totalResults ?? 'unknown'}`,
		});
	}
	return {
		entries,
		posts,
		pageEntryCounts,
		declaredItemsPerPage,
		totalResults,
		pagesFetched,
		complete,
		bounded,
		unavailable,
		rejected,
		fetchedUrls,
	};
}
