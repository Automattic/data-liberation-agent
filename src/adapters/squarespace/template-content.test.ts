import { afterEach, describe, expect, it, vi } from 'vitest';
import { squarespaceAdapter } from './index.js';
import { squarespaceStructuredContent as source, squarespaceTermArchiveUrl, squarespaceTermName } from './template-content.js';
import { SourceRequestGovernors } from '../../lib/source-request-governor.js';
import * as fetching from '../../lib/media-fetch/safe-fetch.js';
import type { StructuredContentEntry } from '../../platform/types.js';

const origin = 'https://fixture.squarespace.com';
const post = (id: string) => ({ fullUrl: `/journal/${id}`, title: `Post ${id}`, body: `<p>Body ${id} <a href="/about">About</a><img src="/photo.jpg" srcset="/photo.jpg 1x"></p>`, publishOn: 1704067200000, updatedOn: 1704153600000, author: { displayName: 'Writer' }, categories: ['Real Estate'], tags: ['Local', 'Real Estate'], assetUrl: `${origin}/featured.jpg` });
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
			body: Buffer.from(String(url).includes('format=json') ? JSON.stringify({ collection: { typeName: 'blog', fullUrl: '/journal' }, items: [post('one'), null, { ...post('bad-date'), publishOn: null }], pagination: { nextPageOffset: 1 } }) : '<html></html>'),
			status: 200, finalUrl: String(url), headers: new Headers(),
		}));
		const result = await source.enumerate(`${origin}/journal`, { governors: new SourceRequestGovernors() });
		expect(result.entries).toEqual([entry('one')]);
		expect(result.diagnostics.map(d => d.code)).toContain('collection_page_repeated');
		expect(result.diagnostics.filter(d => d.code === 'collection_item_rejected')).toHaveLength(4);
	});

	it.each(['blog-item-content', 'blog-list-article-content-body'])('verifies one %s slot and round-trips a member', slot => {
		const rep = entry('one'), member = entry('two'), html = document(rep, slot);
		expect(source.bodyEquivalent(html, rep)).toBe(true);
		expect(source.bodyEquivalent(html.replace('/about', `${origin}/about`), rep)).toBe(true);
		for (const contentHtml of ['', '<p>Summary</p>', rep.contentHtml.replace('/about', '/other'), rep.contentHtml.replace('/photo.jpg', '/other.jpg'), rep.contentHtml.replace('1x', '2x')]) {
			expect(source.bodyEquivalent(html, { ...rep, contentHtml })).toBe(false);
		}
		expect(source.bodyEquivalent('<p>No slot</p>', rep)).toBe(false);
		expect(source.bodyEquivalent(html + `<div class="${slot}">Duplicate</div>`, rep)).toBe(false);
		expect(source.bodyEquivalent(html, member)).toBe(false);
		expect(source.memberDocument(html, member, rep)).toBeUndefined();
		expect(source.memberDocument(html, rep, { ...member, kind: 'page' })).toBeUndefined();
		const synthesized = source.memberDocument(html, rep, member)!;
		expect(source.bodyEquivalent(synthesized, member)).toBe(true);
		expect(synthesized).toContain('<nav>Keep me</nav>');
		expect(synthesized).toContain('<title>Post two | Site</title>');
		expect(synthesized).toContain(`href="${member.permalink}"`);
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
