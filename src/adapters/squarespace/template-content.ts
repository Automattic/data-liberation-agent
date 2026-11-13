import * as cheerio from 'cheerio';
import type { StructuredContentEntry, StructuredContentSource, StructuredContentEnumeration } from '../../platform/types.js';
import { safeFetch } from '../../lib/media-fetch/safe-fetch.js';
import { SOURCE_USER_AGENT } from '../../lib/browser-kit/source-identity.js';
import { extractSameOriginLinks } from '../../lib/extraction/sitemap.js';
import { fetchSqsJson } from './content.js';

// 7.1 and 7.0 blog item templates respectively (never the listing excerpt).
const BODY = '.blog-item-content, .blog-list-article-content-body';

/** Fail closed on summaries, missing slots and ambiguous templates. */
export function squarespaceBodyEquivalent(html: string, entry: StructuredContentEntry): boolean {
	const $ = cheerio.load(html);
	const bodies = $(BODY);
	if (bodies.length !== 1 || !entry.contentHtml.trim()) return false;
	const signature = (html: string) => {
		const doc = cheerio.load(html);
		doc('script, style').remove();
		const urls = (selector: string, attribute: string) => doc(selector).toArray().map(node => {
			const value = doc(node).attr(attribute) ?? '';
			try { return new URL(value, entry.permalink).href; } catch { return value; }
		}).sort();
		return JSON.stringify([doc('body').text().replace(/\s+/g, ' ').trim(), urls('a[href]', 'href'), urls('img[src]', 'src'), urls('[srcset]', 'srcset')]);
	};
	return signature(bodies.html() ?? '') === signature(entry.contentHtml);
}

export function squarespaceMemberDocument(html: string, representative: StructuredContentEntry, member: StructuredContentEntry): string | undefined {
	if (!squarespaceBodyEquivalent(html, representative) || member.kind !== 'post' || !member.contentHtml.trim()) return undefined;
	const $ = cheerio.load(html);
	$(BODY).html(member.contentHtml);
	$('.blog-item-title, .blog-list-article-title, .post-title').each((_, node) => {
		const link = $(node).find('a');
		if (link.length === 1) link.text(member.title).attr('href', member.permalink);
		else $(node).text(member.title);
	});
	$('title').text($('title').text().replace(representative.title, member.title));
	$('a[href], link[href]').each((_, node) => {
		if ($(node).attr('href') === representative.permalink) $(node).attr('href', member.permalink);
	});
	$('[datetime]').each((_, node) => {
		const date = $(node).attr('datetime');
		if (date === representative.published) $(node).attr('datetime', member.published);
		if (date === representative.updated) $(node).attr('datetime', member.updated);
	});
	return $.html();
}

export function squarespaceTermName(url: string): string | undefined {
	try {
		const match = /\/(?:tag|category)\/([^/]+)\/?$/.exec(new URL(url).pathname);
		return match ? decodeURIComponent(match[1]!.replace(/\+/g, ' ')) : undefined;
	} catch { return undefined; }
}

/** Preserve an archive's taxonomy kind; otherwise tags are the canonical archive. */
export function squarespaceTermArchiveUrl(term: string, sourceUrl: string): string {
	const url = new URL(sourceUrl);
	const kind = /\/category\//.test(url.pathname) ? 'category' : 'tag';
	const collection = url.pathname.replace(/\/(?:tag|category)\/.*$/, '').replace(/\/$/, '') || '/blog';
	return new URL(`${collection}/${kind}/${encodeURIComponent(term).replace(/%20/g, '+')}`, url.origin).href;
}

export const squarespaceStructuredContent: StructuredContentSource = {
	async enumerate(sourceUrl, { governors }) {
		const result: StructuredContentEnumeration = { entries: [], diagnostics: [] };
		const origin = new URL(sourceUrl).origin;
		const candidates = new Set([sourceUrl]);
		const seenEntries = new Set<string>();
		const collections = new Set<string>();
		const diagnostic = (code: string, url: string, reason: string) => result.diagnostics.push({ code, url, reason });
		// The same public links used by discovery, without invoking sitemap or
		// browser discovery (and without any ungoverned source requests).
		try {
			const response = await safeFetch(sourceUrl, { governors, timeoutMs: 15_000, maxBytes: 32 * 1024 * 1024, headers: { 'User-Agent': SOURCE_USER_AGENT } });
			if (response.status >= 200 && response.status < 300) {
				for (const link of extractSameOriginLinks(response.body.toString('utf8'), sourceUrl)) {
					const url = new URL(link);
					url.search = ''; url.hash = '';
					candidates.add(url.href);
				}
			} else diagnostic('collection_discovery_failed', sourceUrl, `HTTP ${response.status}`);
		} catch (error) {
			diagnostic('collection_discovery_failed', sourceUrl, String(error));
		}
		for (const candidate of candidates) {
			let json = await fetchSqsJson(candidate, governors);
			if (!json) { diagnostic('collection_json_failed', candidate, 'Collection JSON unavailable'); continue; }
			if (json.collection?.type !== 1 && json.collection?.typeName !== 'blog') continue;
			let collection: URL;
			try { collection = new URL(json.collection.fullUrl ?? candidate, origin); } catch { continue; }
			if (collection.origin !== origin || collections.has(collection.href)) continue;
			collections.add(collection.href);
			// A post's JSON can name its collection but contain only `item`.
			if (new URL(candidate).pathname !== collection.pathname) json = await fetchSqsJson(collection.href, governors);
			const offsets = new Set<string>();
			for (let page = 0; page < 200; page++) {
				if (!json || !Array.isArray(json.items)) {
					diagnostic('collection_page_failed', collection.href, 'Missing collection items'); break;
				}
				for (const item of json.items) {
					let permalink: URL;
					try { permalink = new URL(item?.fullUrl ?? '', origin); } catch {
						diagnostic('collection_item_rejected', collection.href, 'Invalid permalink'); continue;
					}
					const iso = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString() : '';
					const published = iso(item?.publishOn), updated = iso(item?.updatedOn);
					if (!item?.fullUrl || permalink.origin !== origin || permalink.username || permalink.password || !item.title || !item.body?.trim() || !published || !updated) {
						diagnostic('collection_item_rejected', permalink.href, 'Missing post fields or off-origin permalink'); continue;
					}
					permalink.hash = '';
					if (seenEntries.has(permalink.href)) continue;
					seenEntries.add(permalink.href);
					let slug = permalink.pathname.split('/').filter(Boolean).at(-1) ?? '';
					try { slug = decodeURIComponent(slug); } catch { /* Preserve source escapes. */ }
					result.entries.push({ permalink: permalink.href, slug, kind: 'post', title: item.title, contentHtml: item.body, published, updated, author: item.author?.displayName ?? '', terms: [...new Set([...(item.categories ?? []), ...(item.tags ?? [])].filter(term => typeof term === 'string' && term.trim()))] });
				}
				if (json.items.length === 0) break;
				const next = json.pagination?.nextPageOffset;
				if (next === undefined || next === null || next === '') break;
				if (offsets.has(String(next))) { diagnostic('collection_page_repeated', collection.href, 'Repeated pagination offset'); break; }
				if (page === 199) { diagnostic('collection_bounded', collection.href, 'Stopped after 200 pages'); break; }
				offsets.add(String(next));
				const url = new URL(collection);
				url.searchParams.set('offset', String(next));
				json = await fetchSqsJson(url.href, governors);
			}
		}
		return result;
	},
	contentSlotSelector: BODY,
	bodyEquivalent: squarespaceBodyEquivalent,
	memberDocument: squarespaceMemberDocument,
	termName: squarespaceTermName,
	termArchiveUrl: squarespaceTermArchiveUrl,
};
