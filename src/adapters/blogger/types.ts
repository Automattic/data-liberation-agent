import type { DefaultInventory } from '../default/types.js';

export interface BloggerFeedAccounting {
	requestedMaxResults: number;
	/** Actual `<entry>` counts. Never the requested max-results. */
	pageEntryCounts: number[];
	/** Value the feed declared, which may repeat the request rather than the page size. */
	declaredItemsPerPage: number | null;
	totalResults: number | null;
	enumeratedPosts: number;
	pagesFetched: number;
	/** Sitemap routes stay authoritative. Feed URLs are merged only when no sitemap exists. */
	routeSource: 'sitemap' | 'feed-fallback';
	enumeration: 'sampled' | 'paginated' | 'bounded' | 'unavailable';
	/** Enumerated alternate links cover `totalResults`. Not a rendering or completeness claim for the sitemap. */
	complete: boolean;
	bounded: boolean;
	/** Enumerated feed posts that were not already discovered and were not merged. */
	postsAbsentFromRoutes: number;
}

export interface BloggerInventory extends DefaultInventory {
	feed: BloggerFeedAccounting;
}
