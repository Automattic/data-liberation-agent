import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import type { BloggerFeedEntry } from './feed.js';

const BODY = '.post-body, [itemprop="articleBody"]';

/** Fail closed when Blogger's feed is a summary or the template is ambiguous. */
export function feedBodyEquivalent(html: string, entry: BloggerFeedEntry): boolean {
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

/** Construct the member input to the ordinary slot mapper, never a second renderer. */
export function feedMemberDocument(representativeHtml: string, representative: BloggerFeedEntry, member: BloggerFeedEntry): string | undefined {
	if (!feedBodyEquivalent(representativeHtml, representative) || member.kind !== 'post' || !member.contentHtml.trim()) return undefined;
	const $ = cheerio.load(representativeHtml);
	$(BODY).html(member.contentHtml);
	$('.post-title, [itemprop="headline"]').each((_, node) => {
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

export function bloggerLabel(url: string): string | undefined {
	try {
		const path = new URL(url).pathname;
		const match = /^\/search\/label\/([^/]+)\/?$/.exec(path);
		return match ? decodeURIComponent(match[1]!) : undefined;
	} catch { return undefined; }
}

/** Portable semantic index; paths are allocated by the HTML exporter, not guessed. */
export function bloggerContentIndex(entries: BloggerFeedEntry[], routes: Array<{ url: string; path: string }>) {
	const paths = new Map(routes.map(route => [route.url, `/${route.path.replace(/^website\//, '')}`]));
	const terms = routes.flatMap(route => {
		const name = bloggerLabel(route.url);
		return name === undefined ? [] : [{ name, kind: 'term-archive' as const, sourceUrl: route.url, path: paths.get(route.url)! }];
	});
	for (const name of new Set(entries.flatMap(entry => entry.labels))) {
		if (terms.some(term => term.name === name)) continue;
		terms.push({ name, kind: 'term-archive', sourceUrl: new URL(`/search/label/${encodeURIComponent(name)}`, entries[0]!.permalink).href, path: `/terms/${createHash('sha256').update(name).digest('hex')}.html` });
	}
	const posts = entries.filter(entry => paths.has(entry.permalink)).map(entry => ({
		...entry, terms: entry.labels, path: paths.get(entry.permalink)!,
	}));
	return {
		schema: 'data-liberation-agent/blogger-content/v1', posts, terms,
		redirects: [...posts.map(post => ({ from: post.permalink, to: post.path })), ...terms.map(term => ({ from: term.sourceUrl, to: term.path }))],
	};
}
