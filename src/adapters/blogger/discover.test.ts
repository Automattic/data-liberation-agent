import { afterEach, describe, expect, it, vi } from 'vitest';
import { enumerateBloggerPosts, parseBloggerFeed } from './feed.js';
import { discover } from './discover.js';

vi.mock('../../lib/browser-kit/browser-kit.js', () => ({
	getPlaywright: async () => {
		throw new Error('browser discovery is not used by these fixtures');
	},
	sourceContextOptions: async () => ({}),
}));

const origin = 'https://journal.example.test';

afterEach(() => vi.unstubAllGlobals());

function atomFeed(options: {
	total: number;
	start: number;
	posts: number[];
	declaredItemsPerPage?: number;
	extraEntry?: string;
}): string {
	const entries = options.posts.map((id) => `<entry>
		<id>tag:blogger.com,1999:blog-1.post-${id}</id>
		<published>2026-01-01T00:00:00.000Z</published>
		<title type="text">Post ${id}</title>
		<content type="html">&lt;p&gt;secret-body-${id}&lt;/p&gt;</content>
		<link rel="replies" type="application/atom+xml" href="${origin}/feeds/${id}/comments/default"/>
		<link rel="alternate" type="text/html" href="${origin}/2026/01/post-${id}.html"/>
		<category term="Invented"/>
	</entry>`);
	return `<?xml version="1.0" encoding="UTF-8"?>
		<feed xmlns="http://www.w3.org/2005/Atom" xmlns:openSearch="http://a9.com/-/spec/opensearchrss/1.0/">
			<title>Journal</title>
			<link rel="alternate" type="text/html" href="${origin}/"/>
			<category term="Invented"/>
			<openSearch:totalResults>${options.total}</openSearch:totalResults>
			<openSearch:startIndex>${options.start}</openSearch:startIndex>
			<openSearch:itemsPerPage>${options.declaredItemsPerPage ?? 500}</openSearch:itemsPerPage>
			${entries.join('')}
			${options.extraEntry ?? ''}
		</feed>`;
}

function response(body: string, status = 200, contentType = 'text/html'): Response {
	return new Response(body, { status, headers: { 'content-type': contentType } });
}

describe('Blogger feed accounting', () => {
	it('pages by the 150 entries returned when 500 were requested', async () => {
		const fetched: string[] = [];
		const result = await enumerateBloggerPosts(origin, {
			fetch: async (input) => {
				const url = new URL(String(input));
				fetched.push(url.href);
				const start = Number(url.searchParams.get('start-index'));
				expect(url.searchParams.get('max-results')).toBe('500');
				if (start === 1) return response(atomFeed({ total: 300, start, posts: Array.from({ length: 150 }, (_, index) => index + 1) }), 200, 'application/atom+xml');
				if (start === 151) return response(atomFeed({ total: 300, start, posts: Array.from({ length: 150 }, (_, index) => index + 151) }), 200, 'application/atom+xml');
				return response(atomFeed({ total: 300, start, posts: [] }), 200, 'application/atom+xml');
			},
		});

		expect(fetched.map((url) => new URL(url).searchParams.get('start-index'))).toEqual(['1', '151']);
		expect(result.pageEntryCounts).toEqual([150, 150]);
		expect(result.declaredItemsPerPage).toBe(500);
		expect(result.posts).toHaveLength(300);
		expect(result.posts[0]).toBe(`${origin}/2026/01/post-1.html`);
		expect(result.posts[149]).toBe(`${origin}/2026/01/post-150.html`);
		expect(result.posts[150]).toBe(`${origin}/2026/01/post-151.html`);
		expect(result.complete).toBe(true);
		expect(result.bounded).toBe(false);
		expect(JSON.stringify(result)).not.toContain('secret-body-1');
		expect(result.posts.some((url) => url.includes('/search/label/'))).toBe(false);
	});

	it('does not advance by the declared page size', async () => {
		const fetched: string[] = [];
		const result = await enumerateBloggerPosts(origin, {
			fetch: async (input) => {
				const url = new URL(String(input));
				fetched.push(url.href);
				const start = Number(url.searchParams.get('start-index'));
				if (start === 1) return response(atomFeed({ total: 4, start, posts: [1, 2], declaredItemsPerPage: 500 }), 200, 'application/atom+xml');
				if (start === 3) return response(atomFeed({ total: 4, start, posts: [3, 4], declaredItemsPerPage: 500 }), 200, 'application/atom+xml');
				return response(atomFeed({ total: 4, start, posts: [] }), 200, 'application/atom+xml');
			},
		});

		expect(fetched.map((url) => new URL(url).searchParams.get('start-index'))).toEqual(['1', '3']);
		expect(result.pageEntryCounts).toEqual([2, 2]);
		expect(result.posts.map((url) => url.endsWith('.html'))).toEqual([true, true, true, true]);
		expect(result.complete).toBe(true);
	});

	it('records a bounded stop instead of pretending the remainder was empty', async () => {
		const result = await enumerateBloggerPosts(origin, {
			maxPages: 1,
			fetch: async () => response(atomFeed({ total: 300, start: 1, posts: [1, 2] }), 200, 'application/atom+xml'),
		});

		expect(result.bounded).toBe(true);
		expect(result.complete).toBe(false);
		expect(result.posts).toHaveLength(2);
		expect(result.rejected).toContainEqual(expect.objectContaining({ code: 'feed_bounded' }));
	});

	it('stops on a repeated page and rejects off-origin links', async () => {
		const repeated = await enumerateBloggerPosts(origin, {
			fetch: async () => response(atomFeed({ total: 10, start: 1, posts: [1] }), 200, 'application/atom+xml'),
		});
		expect(repeated.pagesFetched).toBe(2);
		expect(repeated.posts).toEqual([`${origin}/2026/01/post-1.html`]);
		expect(repeated.rejected).toContainEqual(expect.objectContaining({ code: 'feed_page_repeated' }));

		const parsed = parseBloggerFeed(atomFeed({
			total: 1,
			start: 1,
			posts: [],
			extraEntry: `<entry><id>tag:off</id><link rel="alternate" type="text/html" href="https://elsewhere.example/post.html"/></entry>`,
		}), origin);
		expect(parsed.posts).toEqual([]);
		expect(parsed.entryCount).toBe(1);
		expect(parsed.rejected).toContainEqual(expect.objectContaining({
			code: 'feed_link_rejected',
			url: 'https://elsewhere.example/post.html',
		}));
	});
});

describe('Blogger discovery', () => {
	it('keeps sitemap archives and labels and does not merge or invent feed routes', async () => {
		const fetched: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
			const url = String(input);
			fetched.push(url);
			if (url.endsWith('/robots.txt') || url.endsWith('/sitemap-index.xml')) return response('', 404);
			if (url.endsWith('/sitemap.xml')) {
				return response([
					'<urlset>',
					...['/', '/2026/08/one.html', '/2024/01/older.html', '/2026/08/', '/search/label/Kept', '/p/about.html']
						.map((path) => `<url><loc>${origin}${path}</loc></url>`),
					'</urlset>',
				].join(''), 200, 'application/xml');
			}
			if (url.includes('/feeds/posts/default')) {
				return response(atomFeed({
					total: 400,
					start: 1,
					posts: [],
					extraEntry: `<entry><id>tag:feed-only</id><link rel="alternate" type="text/html" href="${origin}/2020/01/feed-only.html"/><category term="Invented"/></entry>
						<entry><id>tag:one</id><link rel="alternate" type="text/html" href="${origin}/2026/08/one.html"/></entry>`,
				}), 200, 'application/atom+xml');
			}
			return response(`<!doctype html><title>Journal</title><nav>
				<a href="/2026/08/">August</a>
				<a href="/search/label/FromHome">From home</a>
			</nav>`);
		}));

		const inventory = await discover(`${origin}/`, {});
		const urls = inventory.urls.map((entry) => entry.url);

		expect(urls).toEqual(expect.arrayContaining([
			`${origin}/`,
			`${origin}/2026/08/`,
			`${origin}/search/label/Kept`,
			`${origin}/search/label/FromHome`,
			`${origin}/p/about.html`,
		]));
		expect(urls).not.toContain(`${origin}/2020/01/feed-only.html`);
		expect(urls.some((url) => url.includes('/search/label/Invented'))).toBe(false);
		expect(fetched.filter((url) => url.includes('/feeds/posts/default'))).toHaveLength(1);
		expect(inventory.feed).toMatchObject({
			requestedMaxResults: 500,
			pageEntryCounts: [2],
			declaredItemsPerPage: 500,
			totalResults: 400,
			routeSource: 'sitemap',
			enumeration: 'sampled',
			complete: false,
			bounded: false,
			postsAbsentFromRoutes: 1,
		});
		expect(inventory.diagnostics).toContainEqual(expect.objectContaining({
			code: 'feed_posts_not_in_routes',
			url: `${origin}/2020/01/feed-only.html`,
		}));
	});

	it('uses a bounded feed fallback only when the sitemap is missing and retains linked archives and labels', async () => {
		const fetched: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
			const url = String(input);
			fetched.push(url);
			if (url.endsWith('/robots.txt') || url.endsWith('/sitemap-index.xml') || url.endsWith('/sitemap.xml')) return response('', 404);
			if (url.includes('/feeds/posts/default')) {
				const start = Number(new URL(url).searchParams.get('start-index'));
				const posts = start === 1
					? Array.from({ length: 150 }, (_, index) => index + 1)
					: start === 151
						? Array.from({ length: 150 }, (_, index) => index + 151)
						: [];
				return response(atomFeed({ total: 300, start, posts }), 200, 'application/atom+xml');
			}
			return response('<!doctype html><title>Journal</title><a href="/">Home</a><a href="/2026/08/">August</a><a href="/search/label/Notes">Notes</a>');
		}));

		const inventory = await discover(`${origin}/`, {});
		const urls = inventory.urls.map((entry) => entry.url);

		expect(new URL(fetched.find((url) => url.includes('start-index=151')) ?? '').searchParams.get('max-results')).toBe('500');
		expect(urls).toContain(`${origin}/2026/08/`);
		expect(urls).toContain(`${origin}/search/label/Notes`);
		expect(urls).toContain(`${origin}/2026/01/post-1.html`);
		expect(urls).toContain(`${origin}/2026/01/post-150.html`);
		expect(urls).toContain(`${origin}/2026/01/post-151.html`);
		expect(urls).toContain(`${origin}/2026/01/post-300.html`);
		expect(urls.filter((url) => url.includes('/2026/01/post-'))).toHaveLength(300);
		expect(urls.some((url) => url.includes('/search/label/Invented'))).toBe(false);
		expect(inventory.feed).toMatchObject({
			pageEntryCounts: [150, 150],
			declaredItemsPerPage: 500,
			totalResults: 300,
			enumeratedPosts: 300,
			routeSource: 'feed-fallback',
			enumeration: 'paginated',
			complete: true,
			bounded: false,
			postsAbsentFromRoutes: 0,
		});
		expect(inventory.counts.homepage).toBe(1);
		expect(inventory.diagnostics?.some((diagnostic) => diagnostic.code === 'sitemap_missing')).toBe(true);
	});
});
