import { afterEach, describe, expect, it, vi } from 'vitest';
import { squarespaceAdapter } from './index.js';
import { squarespaceStructuredContent as source, squarespaceTermArchiveUrl, squarespaceTermName } from './template-content.js';
import { SourceRequestGovernors } from '../../lib/source-request-governor.js';
import * as fetching from '../../lib/media-fetch/safe-fetch.js';
import * as cheerio from 'cheerio';
import { deriveMemberDocument, compareDerivedWithCapture } from '../../lib/template-clusters.js';
import type { StructuredContentEntry } from '../../platform/types.js';

const origin = 'https://fixture.squarespace.com';
const post = (id: string) => ({ id: `id-${id}`, fullUrl: `/journal/${id}`, title: `Post ${id}`, body: `<p>Body ${id} <a href="/about">About</a><img src="/photo.jpg" srcset="/photo.jpg 1x"></p>`, publishOn: 1704067200000, updatedOn: 1704153600000, author: { displayName: 'Writer' }, categories: ['Real Estate'], tags: ['Local', 'Real Estate'], assetUrl: `${origin}/featured.jpg` });
const entry = (id: string): StructuredContentEntry => ({ permalink: `${origin}/journal/${id}`, slug: id, kind: 'post', title: `Post ${id}`, contentHtml: post(id).body, published: '2024-01-01T00:00:00.000Z', updated: '2024-01-02T00:00:00.000Z', author: 'Writer', terms: ['Real Estate', 'Local'] });
const document = (e: StructuredContentEntry, slot = 'blog-item-content') => `<html><head><title>${e.title} | Site</title><link rel="canonical" href="${e.permalink}"></head><body><nav>Keep me</nav><h1 class="blog-item-title">${e.title}</h1><time datetime="${e.published}"></time><div class="${slot}">${e.contentHtml}</div></body></html>`;

afterEach(() => vi.restoreAllMocks());

describe('Squarespace structured blog content', () => {
	it('discovers typed collections, exhausts pagination and maps entries through governed requests', async () => {
		const governors = new SourceRequestGovernors();
		const collection = { type: 1, typeName: 'blog', fullUrl: '/journal' };
		const pages: Record<string, unknown> = {
			'/?format=json': { collection: { type: 10, typeName: 'page' } },
			'/journal?format=json': { collection, items: [post('one'), { ...post('external'), fullUrl: 'https://elsewhere.com/post' }], pagination: { nextPageOffset: 123 } },
			'/journal?offset=123&format=json': { collection, items: [post('one'), post('two')], pagination: { nextPageOffset: 456 } },
			'/journal?offset=456&format=json': { collection, items: [], pagination: {} },
			'/shop?format=json': { collection: { type: 13 }, items: [post('not-a-blog')] },
		};
		const fetch = vi.spyOn(fetching, 'safeFetch').mockImplementation(async (url, options) => {
			expect(options?.governors).toBe(governors);
			const path = String(url).replace(origin, '');
			const body = path === '/' ? '<nav><a href="/journal">Journal</a><a href="/shop">Shop</a><a href="https://elsewhere.com/">External</a></nav>' : JSON.stringify(pages[path]);
			expect(body).toBeDefined();
			return { body: Buffer.from(body), status: 200, finalUrl: String(url), headers: new Headers() };
		});
		expect(squarespaceAdapter.structuredContent).toBe(source);
		const result = await source.enumerate(`${origin}/`, { governors });
		expect(result.entries).toEqual([entry('one'), entry('two')]);
		expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'collection_item_rejected', url: 'https://elsewhere.com/post' })]);
		expect(fetch).toHaveBeenCalledTimes(6);
	});

	it('starts from an entry collection JSON and stops a repeated offset visibly', async () => {
		vi.spyOn(fetching, 'safeFetch').mockImplementation(async url => ({
			body: Buffer.from(String(url).includes('format=json') ? JSON.stringify({ website: { timeZone: 'UTC' }, collection: { typeName: 'blog', fullUrl: '/journal' }, items: [post('one'), null, { ...post('bad-date'), publishOn: null }], pagination: { nextPageOffset: 1 } }) : '<html></html>'),
			status: 200, finalUrl: String(url), headers: new Headers(),
		}));
		const result = await source.enumerate(`${origin}/journal`, { governors: new SourceRequestGovernors() });
		expect(result.entries).toEqual([entry('one')]);
		expect(result.diagnostics.map(d => d.code)).toContain('collection_page_repeated');
		expect(result.diagnostics.filter(d => d.code === 'collection_item_rejected')).toHaveLength(4);
	});

	it.each(['blog-item-content', 'blog-list-article-content-body'])('verifies one %s slot and round-trips a member', async slot => {
		const rep = entry('one'), member = entry('two'), html = document(rep, slot);
		expect(source.bodyEquivalent(html, rep)).toBe(true);
		expect(source.bodyEquivalent(html.replace('/about', `${origin}/about`), rep)).toBe(true);
		for (const contentHtml of ['', '<p>Summary</p>', rep.contentHtml.replace('/about', '/other'), rep.contentHtml.replace('/photo.jpg', '/other.jpg'), rep.contentHtml.replace('1x', '2x')]) {
			expect(source.bodyEquivalent(html, { ...rep, contentHtml })).toBe(false);
		}
		expect(source.bodyEquivalent('<p>No slot</p>', rep)).toBe(false);
		expect(source.bodyEquivalent(html + `<div class="${slot}">Duplicate</div>`, rep)).toBe(false);
		expect(source.bodyEquivalent(html, member)).toBe(false);
		expect(await source.memberDocument(html, member, rep)).toBeUndefined();
		expect(await source.memberDocument(html, rep, { ...member, kind: 'page' })).toBeUndefined();
		const synthesized = (await source.memberDocument(html, rep, member))!;
		expect(source.bodyEquivalent(synthesized, member)).toBe(true);
		expect(synthesized).toContain('<nav>Keep me</nav>');
		expect(synthesized).toContain('<title>Post two | Site</title>');
		expect(synthesized).toContain(`href="${member.permalink}"`);
	});

	it('rewrites the full banner title as text without touching member content or scripts', async () => {
		const rep = entry('one'), member = entry('two');
		const html = document(rep).replace('<nav>', `<h1 class="blog-list-banner-title">${rep.title} — Site</h1><script>const title = "${rep.title}"</script><nav>`);
		const result = cheerio.load((await source.memberDocument(html, rep, member))!);
		expect(result('.blog-list-banner-title').text()).toBe('Post two — Site');
		expect(result('script').text()).toContain('Post one');
	});

	it('uses published neighbors within a collection, including missing end neighbors', async () => {
		const governors = new SourceRequestGovernors();
		vi.spyOn(fetching, 'safeFetch').mockImplementation(async url => ({
			body: Buffer.from(String(url).includes('format=json') ? JSON.stringify({ website: { timeZone: 'UTC' }, collection: { typeName: 'blog', fullUrl: '/journal' }, items: [post('old'), { ...post('new'), publishOn: 1704240000000 }, { ...post('middle'), publishOn: 1704153600000 }] }) : '<html></html>'),
			status: 200, finalUrl: String(url), headers: new Headers(),
		}));
		const { entries } = await source.enumerate(`${origin}/journal`, { governors });
		const rep = entries[0]!, member = entries[2]!;
		const nav = '<nav class="pagination"><div class="pagination-direction"><div class="newer">Newer Post</div><div class="older">Older Post</div></div><div class="pagination-content"><a class="newer" rel="prev" href="/stale"><div class="pagination-img"></div><span>Stale</span></a><a class="older" rel="next" href="/stale"><span>Stale</span></a></div><a class="pagination-home" href="/journal">Back to Blog Home</a></nav>';
		const meta = '<article id="article-id-old" data-item-id="id-old"><div class="blog-list-article-content-categories"><span>Stale</span><span>Stale</span></div><div class="blog-list-article-content-date">Stale</div></article>';
		const html = document(rep).replace('</body>', meta + nav + '</body>');
		const $ = cheerio.load((await source.memberDocument(html, rep, member))!);
		expect($('article').attr('id')).toBe('article-id-middle');
		expect($('article').attr('data-item-id')).toBe('id-middle');
		expect($('.blog-list-article-content-categories').html()).toBe('<span>Real Estate</span>');
		expect($('.blog-list-article-content-date').text()).toBe('January 2, 2024');
		expect($('.pagination a.newer').attr('href')).toBe('/journal/new');
		expect($('.pagination a.older').text()).toBe('Post old');
		expect($('.pagination-img').attr('style')).toBe(`background-image:url(${origin}/featured.jpg?format=150w);`);
		const end = cheerio.load((await source.memberDocument(html, rep, entries[1]!))!);
		expect(end('.newer')).toHaveLength(0);
		expect(end('.pagination-home').text()).toBe('Back to Blog Home');
	});

	it('fetches and transplants only the member font slot through the governed contract', async () => {
		const rep = entry('one'), member = entry('two'), governors = new SourceRequestGovernors();
		const font = (name: string) => `<style data-sqsp-font-ids="${name}">@font-face{font-family:${name};src:url(/${name}.woff)}</style>`;
		const html = document(rep).replace('</head>', font('rep') + '</head>');
		vi.spyOn(fetching, 'safeFetch').mockImplementation(async (url, options) => {
			expect(url).toBe(member.permalink);
			expect(options?.governors).toBe(governors);
			return { body: Buffer.from(document(member).replace('</head>', font('member') + '</head>')), status: 200, finalUrl: String(url), headers: new Headers() };
		});
		expect(await source.memberDocument(html, rep, member)).toBeUndefined();
		const synthesized = (await source.memberDocument(html, rep, member, { governors }))!;
		const derived = deriveMemberDocument({ repServerHtml: html, repProcessedHtml: html, memberServerHtml: synthesized, baseUrl: rep.permalink, styleNormalization: squarespaceAdapter.templateStyleNormalization, contentSlotSelector: source.contentSlotSelector, memberHeadSlotSelector: source.memberHeadSlotSelector });
		expect(derived.ok, JSON.stringify(derived)).toBe(true);
		if (derived.ok) expect(compareDerivedWithCapture({ derivedHtml: derived.html, realHtml: document(member).replace('</head>', font('member') + '</head>'), baseUrl: member.permalink }).equal).toBe(true);
	});

	it('recognizes tag and category archives with either Squarespace space spelling', () => {
		for (const kind of ['tag', 'category']) for (const term of ['Real+Estate', 'Real%20Estate']) {
			expect(squarespaceTermName(`${origin}/journal/${kind}/${term}`)).toBe('Real Estate');
		}
		expect(squarespaceTermArchiveUrl('Real Estate', `${origin}/journal`)).toBe(`${origin}/journal/tag/Real+Estate`);
		expect(squarespaceTermName(`${origin}/journal/post`)).toBeUndefined();
		expect(squarespaceTermName(`${origin}/journal/tag/%bad`)).toBeUndefined();
	});
});
