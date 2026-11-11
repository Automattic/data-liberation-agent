import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bloggerContentIndex, bloggerLabel, feedBodyEquivalent, feedMemberDocument } from './template-content.js';
import type { BloggerFeedEntry } from './feed.js';
import { deriveTemplateClusterMembers, groupInventoryTemplates } from '../../lib/capture.js';
import { TEMPLATE_GROUPING_LIMITS, TEMPLATE_GROUPS_SCHEMA, templateFingerprint } from '../../lib/template-groups.js';
import { SourceRequestGovernors } from '../../lib/source-request-governor.js';
import * as fetching from '../../lib/media-fetch/safe-fetch.js';
import { exportWebsiteCapture } from '../../lib/capture-export.js';

const entries: BloggerFeedEntry[] = Array.from({ length: 8 }, (_, i) => ({
	permalink: `https://fixture.blogspot.com/2025/01/post-${i}.html`, slug: `post-${i}`, kind: 'post',
	title: `Post ${i}`, contentHtml: `<p>Feed body ${i} <a href="https://example.org/">link</a></p>`,
	published: '2025-01-01T00:00:00Z', updated: '2025-01-02T00:00:00Z', author: 'Writer', labels: ['Board games', '日本語'],
}));
const document = (entry: BloggerFeedEntry) => `<html><head><title>${entry.title}</title></head><body><article id="post"><h1 class="post-title">${entry.title}</h1><div class="post-body" id="body">${entry.contentHtml}</div></article></body></html>`;

describe('Blogger feed template content', () => {
	it('groups the feed inventory with only two sample page requests', async () => {
		const fetch = vi.spyOn(fetching, 'safeFetch').mockImplementation(async url => {
			const entry = entries.find(entry => entry.permalink === String(url))!;
			return { body: Buffer.from(document(entry)), status: 200, finalUrl: String(url), headers: new Headers({ 'content-type': 'text/html' }) };
		});
		try {
			const result = await groupInventoryTemplates({ bloggerEntries: entries, sourceUrl: entries[0]!.permalink, urls: entries.map(entry => entry.permalink), outputDir: '.', wholeInventory: true, governors: new SourceRequestGovernors() });
			expect(result.report?.groups[0]?.members).toEqual(entries.map(entry => entry.permalink));
			expect(fetch).toHaveBeenCalledTimes(2);
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
			const entry = entries.find(entry => entry.permalink === String(url))!;
			return { body: Buffer.from(document(entry)), status: 200, finalUrl: String(url), headers: new Headers() };
		});
		const fingerprint = templateFingerprint(document(entries[0]!), entries[0]!.permalink);
		try {
			const result = await deriveTemplateClusterMembers({
				sourceUrl: entries[0]!.permalink, outputDir, bloggerEntries: mismatch ? entries.map((entry, i) => i === 1 ? { ...entry, contentHtml: '<p>truncated feed</p>' } : entry) : entries, frontierUrls: [], governors: new SourceRequestGovernors(),
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
			exportWebsiteCapture({ outputDir, sourceUrl: entries[0]!.permalink, platform: 'blogger', summary: {}, failures: [], bloggerEntries: entries });
			const index = JSON.parse(readFileSync(join(outputDir, 'website/blogger-content.json'), 'utf8'));
			expect(index.posts).toHaveLength(entries.length);
			expect(index.terms).toHaveLength(2);
			for (const term of index.terms) {
				expect(readFileSync(join(outputDir, 'website', term.path), 'utf8')).toContain('Post 7');
				expect(readFileSync(join(outputDir, 'website/_redirects'), 'utf8')).toContain(new URL(term.sourceUrl).pathname);
			}
			for (const entry of entries) {
				const post = index.posts.find((post: { permalink: string }) => post.permalink === entry.permalink);
				expect(post).toMatchObject({ slug: entry.slug, terms: entry.labels, published: entry.published, updated: entry.updated, author: entry.author });
				expect(readFileSync(join(outputDir, 'website', post.path), 'utf8')).toContain(`Feed body ${entry.slug.split('-')[1]}`);
				expect(index.redirects).toContainEqual({ from: entry.permalink, to: post.path });
			}
		} finally { fetch.mockRestore(); rmSync(outputDir, { recursive: true, force: true }); }
	});

	it('exports feed dates, labels as terms, permalink slugs and redirect coverage', () => {
		const labelUrl = 'https://fixture.blogspot.com/search/label/Board%20games';
		const routes = [...entries.map(entry => ({ url: entry.permalink, path: `website/2025/01/${entry.slug}.html` })), { url: labelUrl, path: 'website/search/label/Board%20games/index.html' }];
		const index = bloggerContentIndex(entries, routes);
		expect(index.posts).toHaveLength(entries.length);
		expect(index.posts[0]).toMatchObject({ slug: 'post-0', published: entries[0]!.published, updated: entries[0]!.updated, terms: ['Board games', '日本語'] });
		expect(index.terms).toContainEqual({ name: 'Board games', kind: 'term-archive', sourceUrl: labelUrl, path: '/search/label/Board%20games/index.html' });
		expect(index.redirects).toHaveLength(entries.length + 2);
		expect(bloggerLabel('https://fixture.blogspot.com/2025/01/post.html')).toBeUndefined();
	});
});
