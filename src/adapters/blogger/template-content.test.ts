import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bloggerLabel, bloggerStructuredContent, feedBodyEquivalent, feedMemberDocument } from './template-content.js';
import { structuredContentIndex } from '../../lib/content-index.js';
import type { BloggerFeedEntry } from './feed.js';
import { deriveTemplateClusterMembers, groupInventoryTemplates } from '../../lib/capture.js';
import { TEMPLATE_GROUPING_LIMITS, TEMPLATE_GROUPS_SCHEMA, templateFingerprint } from '../../lib/template-groups.js';
import { SourceRequestGovernors } from '../../lib/source-request-governor.js';
import * as fetching from '../../lib/media-fetch/safe-fetch.js';
import { exportWebsiteCapture } from '../../lib/capture-export.js';
import { readMediaQueue } from '../../lib/media-queue.js';
import { bloggerImageOriginal } from './media.js';
import { bloggerAcquisition } from './acquisition.js';

const entries: BloggerFeedEntry[] = Array.from({ length: 8 }, (_, i) => ({
	permalink: `https://fixture.blogspot.com/2025/01/post-${i}.html`, slug: `post-${i}`, kind: 'post',
	title: `Post ${i}`, contentHtml: `<p>Feed body ${i} <a href="https://example.org/">link</a></p><a href="https://blogger.googleusercontent.com/img/b/R29vZ2xl${i}/s1600/photo-${i}.jpg"><img src="https://blogger.googleusercontent.com/img/b/R29vZ2xl${i}/s320/photo-${i}.jpg" srcset="https://blogger.googleusercontent.com/img/b/R29vZ2xl${i}/s640/photo-${i}.jpg 2x"></a><img src="https://blogger.googleusercontent.com/img/a/AVvXsE${i}=w400-h300">`,
	published: '2025-01-01T00:00:00Z', updated: '2025-01-02T00:00:00Z', author: 'Writer', terms: ['Board games', '日本語'],
}));
const document = (entry: BloggerFeedEntry) => `<html><head><title>${entry.title}</title></head><body><article id="post"><h1 class="post-title">${entry.title}</h1><div class="post-body" id="body">${entry.contentHtml}</div></article></body></html>`;

describe('Blogger image originals', () => {
	it.each([
		['https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEh/s1600/photo.jpg', 'https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEh/s0/photo.jpg'],
		['https://blogger.googleusercontent.com/img/b/R29vZ2xl/w640-h480-p-k-no-nu/photo.png', 'https://blogger.googleusercontent.com/img/b/R29vZ2xl/s0/photo.png'],
		['https://1.bp.blogspot.com/-abc/XYZ/AAAA/def/s320/IMG_1.JPG', 'https://1.bp.blogspot.com/-abc/XYZ/AAAA/def/s0/IMG_1.JPG'],
		['https://blogger.googleusercontent.com/img/a/AVvXsEgToken=s1600', 'https://blogger.googleusercontent.com/img/a/AVvXsEgToken=s0'],
		['https://blogger.googleusercontent.com/img/a/AVvXsEgToken=w400-h300', 'https://blogger.googleusercontent.com/img/a/AVvXsEgToken=s0'],
		['https://lh3.googleusercontent.com/blogger_img_proxy/AEn0k=s72-c', 'https://lh3.googleusercontent.com/blogger_img_proxy/AEn0k=s0'],
		['https://blogger.googleusercontent.com/img/b/R29vZ2xl/s0/photo.jpg', undefined],
		['https://blogger.googleusercontent.com/img/a/AVvXsEgToken', undefined],
		['https://example.com/s1600/photo.jpg', undefined],
	])('%s', (url, original) => {
		expect(bloggerImageOriginal(url)).toBe(original);
	});
});

describe('Blogger feed template content', () => {
	it('groups the feed inventory from bounded samples, choosing the majority cohort when the newest post differs', async () => {
		const variant = (entry: BloggerFeedEntry) => document(entry).replace('<article id="post">', '<section><aside><nav><ul><li>variant</li></ul></nav></aside></section><article id="post">');
		const fetch = vi.spyOn(fetching, 'safeFetch').mockImplementation(async url => {
			const entry = entries.find(entry => entry.permalink === String(url))!;
			return { body: Buffer.from(entry === entries[0] ? variant(entry) : document(entry)), status: 200, finalUrl: String(url), headers: new Headers({ 'content-type': 'text/html' }) };
		});
		try {
			const result = await groupInventoryTemplates({ contentEntries: entries, sourceUrl: entries[0]!.permalink, urls: entries.map(entry => entry.permalink), outputDir: '.', wholeInventory: true, governors: new SourceRequestGovernors() });
			const cohort = result.report!.groups.find(group => group.members.length > 1)!;
			expect(cohort.members).toEqual(expect.arrayContaining(entries.slice(1).map(entry => entry.permalink)));
			expect(cohort.representative).not.toBe(entries[0]!.permalink);
			expect(fetch).toHaveBeenCalledTimes(6);
		} finally { fetch.mockRestore(); }
	});
	it('verifies text, links and images, rejecting summaries and ambiguous slots', () => {
		const entry = entries[0]!;
		expect(feedBodyEquivalent(document(entry), entry)).toBe(true);
		for (const contentHtml of ['<p>summary</p>', entry.contentHtml.replace('example.org', 'elsewhere.org'), `${entry.contentHtml}<img src="/extra.png">`]) {
			expect(feedBodyEquivalent(document(entry), { ...entry, contentHtml })).toBe(false);
		}
		expect(feedBodyEquivalent(document(entry).replace('</article>', '<div class="post-body">duplicate</div></article>'), entry)).toBe(false);
		expect(feedMemberDocument(document(entry), entry, entries[1]!)).toContain('Feed body 1');
	});

	it.each([false, true])('derives posts beyond the browser budget; mismatched feed falls back to HTTP (%s)', async mismatch => {
		const parent = join(process.cwd(), '.tmp-test');
		mkdirSync(parent, { recursive: true });
		const outputDir = mkdtempSync(join(parent, 'blogger-feed-'));
		mkdirSync(join(outputDir, 'screenshots'));
		const manifestEntries = Object.fromEntries(entries.slice(0, 2).map((entry, i) => {
			writeFileSync(join(outputDir, `screenshots/${i}.html`), document(entry));
			return [entry.permalink, { slug: entry.slug, html: `screenshots/${i}.html`, capturedAt: new Date().toISOString() }];
		}));
		writeFileSync(join(outputDir, 'screenshots/manifest.json'), JSON.stringify({ version: 1, entries: manifestEntries }));
		const fetch = vi.spyOn(fetching, 'safeFetch').mockImplementation(async url => {
			if (!mismatch) expect(String(url)).toBe(entries[0]!.permalink);
			expect(String(url)).not.toContain('googleusercontent'); // derivation makes no media requests
			const entry = entries.find(entry => entry.permalink === String(url))!;
			return { body: Buffer.from(document(entry)), status: 200, finalUrl: String(url), headers: new Headers() };
		});
		const fingerprint = templateFingerprint(document(entries[0]!), entries[0]!.permalink);
		try {
			const result = await deriveTemplateClusterMembers({
				sourceUrl: entries[0]!.permalink, outputDir, contentSource: bloggerStructuredContent, resolveImageOriginal: bloggerImageOriginal, contentEntries: mismatch ? entries.map((entry, i) => i === 1 ? { ...entry, contentHtml: '<p>truncated feed</p>' } : entry) : entries, frontierUrls: [], governors: new SourceRequestGovernors(),
				report: {
					schema: TEMPLATE_GROUPS_SCHEMA, sourceUrl: entries[0]!.permalink,
					fingerprint: { version: 1, maxSkeletonDepth: 8 }, limits: { ...TEMPLATE_GROUPING_LIMITS }, throttle: { events: 0 },
					coverage: { routes: 8, fingerprinted: 8, unfingerprinted: 0, groups: 1, singletons: 0 }, unfingerprinted: [],
					groups: [{ id: 't1', ...fingerprint, representative: entries[0]!.permalink, size: entries.length, members: entries.map(entry => entry.permalink) }],
				},
			});
			expect(result.summary.derived).toBe(6);
			expect(result.receipt.clusters[0]!.verification?.equal).toBe(true);
			expect(result.receipt.clusters[0]!.verification?.checks?.feedBody).toBe(!mismatch);
			expect(fetch).toHaveBeenCalledTimes(mismatch ? 10 : 2); // two rounds; fallback verifies again
			const manifest = JSON.parse(readFileSync(join(outputDir, 'screenshots/manifest.json'), 'utf8'));
			for (const entry of entries.slice(2)) {
				const saved = manifest.entries[entry.permalink];
				expect(saved.slug).toBe(entry.slug);
				expect(readFileSync(join(outputDir, saved.html), 'utf8')).toContain(entry.contentHtml);
			}
			const queue = readMediaQueue(outputDir);
			for (const entry of entries.slice(2)) {
				const i = entry.slug.split('-')[1];
				expect(queue.entries.filter(item => item.url.includes(`R29vZ2xl${i}/`)).map(item => item.originalUrl)).toEqual(Array(3).fill(`https://blogger.googleusercontent.com/img/b/R29vZ2xl${i}/s0/photo-${i}.jpg`));
				expect(queue.entries.find(item => item.url.endsWith(`AVvXsE${i}=w400-h300`))).toMatchObject({ originalUrl: `https://blogger.googleusercontent.com/img/a/AVvXsE${i}=s0`, status: 'pending' });
			}
			exportWebsiteCapture({ outputDir, sourceUrl: entries[0]!.permalink, platform: 'blogger', summary: {}, failures: [], structuredContent: { source: bloggerStructuredContent, entries } });
			const index = JSON.parse(readFileSync(join(outputDir, 'website/content-index.json'), 'utf8'));
			expect(index.posts).toHaveLength(entries.length);
			expect(index.terms).toHaveLength(2);
			for (const term of index.terms) {
				expect(readFileSync(join(outputDir, 'website', term.path), 'utf8')).toContain('Post 7');
				expect(readFileSync(join(outputDir, 'website/_redirects'), 'utf8')).toContain(new URL(term.sourceUrl).pathname);
			}
			for (const entry of entries) {
				const post = index.posts.find((post: { permalink: string }) => post.permalink === entry.permalink);
				expect(post).toMatchObject({ slug: entry.slug, terms: entry.terms, published: entry.published, updated: entry.updated, author: entry.author });
				expect(post).not.toHaveProperty('contentHtml');
				const i = entry.slug.split('-')[1];
				const html = readFileSync(join(outputDir, 'website', post.path), 'utf8');
				expect(html).toContain(`Feed body ${i}`);
				// Derived posts reference queued media at its deterministic local path.
				if (entries.indexOf(entry) >= 2) {
					expect(html).toContain(`/${queue.entries.find(item => item.url.includes(`R29vZ2xl${i}/s320/`))!.path}`);
					expect(html).toContain(`/${queue.entries.find(item => item.url.includes(`AVvXsE${i}=`))!.path}`);
				}
				expect(index.redirects).toContainEqual({ from: entry.permalink, to: post.path });
			}
		} finally { fetch.mockRestore(); rmSync(outputDir, { recursive: true, force: true }); }
	});

	it.each([
		{ name: 'structurally different feed body derives', body: '<details><summary>Rules</summary><table><tbody><tr><td><div><ul><li>Feed body 3</li></ul></div></td></tr></tbody></table></details>', derived: 6, acquired: 0 },
		{ name: 'unobserved embed escalates and is HTTP-acquired', body: '<p>Feed body 3</p><iframe src="https://www.youtube.com/embed/fixture"></iframe>', derived: 5, acquired: 1 },
	])('$name', async ({ body, derived, acquired }) => {
		const parent = join(process.cwd(), '.tmp-test');
		mkdirSync(parent, { recursive: true });
		const outputDir = mkdtempSync(join(parent, 'blogger-escalation-'));
		mkdirSync(join(outputDir, 'screenshots'));
		const feed = entries.map((entry, i) => i === 3 ? { ...entry, contentHtml: body } : entry);
		const page = (entry: BloggerFeedEntry) => `<html><head><meta name="generator" content="blogger"><title>${entry.title}</title></head><body><div class="widget Blog" id="Blog1"><article id="post"><h1 class="post-title">${entry.title}</h1><div class="post-body" id="body">${entry.contentHtml}</div></article></div></body></html>`;
		const manifestEntries = Object.fromEntries(feed.slice(0, 2).map((entry, i) => {
			writeFileSync(join(outputDir, `screenshots/${i}.html`), page(entry));
			return [entry.permalink, { slug: entry.slug, html: `screenshots/${i}.html`, capturedAt: new Date().toISOString() }];
		}));
		writeFileSync(join(outputDir, 'screenshots/manifest.json'), JSON.stringify({ version: 1, entries: manifestEntries }));
		const fetch = vi.spyOn(fetching, 'safeFetch').mockImplementation(async url => {
			const entry = feed.find(entry => entry.permalink === String(url))!;
			return { body: Buffer.from(page(entry)), status: 200, finalUrl: String(url), headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }) };
		});
		const fingerprint = templateFingerprint(page(feed[0]!), feed[0]!.permalink);
		try {
			const result = await deriveTemplateClusterMembers({
				sourceUrl: feed[0]!.permalink, outputDir, contentSource: bloggerStructuredContent, contentEntries: feed, frontierUrls: [], governors: new SourceRequestGovernors(), acquisition: bloggerAcquisition,
				report: {
					schema: TEMPLATE_GROUPS_SCHEMA, sourceUrl: feed[0]!.permalink,
					fingerprint: { version: 1, maxSkeletonDepth: 8 }, limits: { ...TEMPLATE_GROUPING_LIMITS }, throttle: { events: 0 },
					coverage: { routes: 8, fingerprinted: 8, unfingerprinted: 0, groups: 1, singletons: 0 }, unfingerprinted: [],
					groups: [{ id: 't1', ...fingerprint, representative: feed[0]!.permalink, size: feed.length, members: feed.map(entry => entry.permalink) }],
				},
			});
			expect(result.summary).toMatchObject({ derived, escalated: acquired, httpAcquired: acquired });
			// Two derivation rounds fetch the representative; only an escalation fetches its own page.
			expect(fetch).toHaveBeenCalledTimes(2 + acquired);
			expect(fetch.mock.calls.filter(([url]) => String(url) === feed[3]!.permalink)).toHaveLength(acquired);
			const escalation = result.receipt.clusters[0]!.escalated;
			expect(escalation.map(row => [row.url, row.gate, row.fallback?.acquired])).toEqual(acquired ? [[feed[3]!.permalink, 'runtime_slot_content', true]] : []);
			if (acquired) expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'route_template_escalated', url: feed[3]!.permalink, reason: expect.stringMatching(/runtime_slot_content.*HTTP acquisition/) }));
			const manifest = JSON.parse(readFileSync(join(outputDir, 'screenshots/manifest.json'), 'utf8'));
			const member = manifest.entries[feed[3]!.permalink];
			expect(member.html).toMatch(acquired ? /^screenshots\/http\// : /^screenshots\/derived\//);
			expect(readFileSync(join(outputDir, member.html), 'utf8')).toContain('Feed body 3');
			exportWebsiteCapture({ outputDir, sourceUrl: feed[0]!.permalink, platform: 'blogger', summary: {}, failures: [], structuredContent: { source: bloggerStructuredContent, entries: feed } });
			const index = JSON.parse(readFileSync(join(outputDir, 'website/content-index.json'), 'utf8'));
			expect(index.posts).toHaveLength(feed.length);
			const post = index.posts.find((post: { permalink: string }) => post.permalink === feed[3]!.permalink);
			expect(post).toMatchObject({ slug: 'post-3' });
			expect(readFileSync(join(outputDir, 'website', post.path), 'utf8')).toContain('Feed body 3');
		} finally { fetch.mockRestore(); rmSync(outputDir, { recursive: true, force: true }); }
	});

	it('exports feed dates, labels as terms, permalink slugs and redirect coverage', () => {
		const labelUrl = 'https://fixture.blogspot.com/search/label/Board%20games';
		const routes = [...entries.map(entry => ({ url: entry.permalink, path: `website/2025/01/${entry.slug}.html` })), { url: labelUrl, path: 'website/search/label/Board%20games/index.html' }];
		const index = structuredContentIndex(entries, routes, bloggerStructuredContent, entries[0]!.permalink);
		expect(index.posts).toHaveLength(entries.length);
		expect(index.posts[0]).toMatchObject({ slug: 'post-0', published: entries[0]!.published, updated: entries[0]!.updated, terms: ['Board games', '日本語'] });
		expect(index.terms).toContainEqual({ name: 'Board games', kind: 'term-archive', sourceUrl: labelUrl, path: '/search/label/Board%20games/index.html' });
		expect(index.redirects).toHaveLength(entries.length + 2);
		expect(bloggerLabel('https://fixture.blogspot.com/2025/01/post.html')).toBeUndefined();
	});
});
