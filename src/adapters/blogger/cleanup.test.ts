import { describe, expect } from 'vitest';
import { it } from '../../../test/browser.js';
import { applySourceCleanup, cleanupPolicy } from '../../lib/source-cleanup.js';
import { bloggerAdapter } from './index.js';

const widget = (type: string, body: string) => `<div class="widget ${type}" id="${type}1"><h2 class="title">${type} title</h2><div class="widget-content">${body}</div></div>`;

describe.skipIf(process.env.SKIP_BROWSER_TESTS)('Blogger platform chrome cleanup', () => {
	it('removes Blogger-account widgets and the platform credit while keeping owner widgets and copyright', async ({ newPage }) => {
		const page = await newPage();
		try {
			await page.setContent(`<!doctype html><body><main><article class="post"><p>Post body links <a href="https://www.blogger.com/about">Blogger docs</a>.</p></article>
				<aside>${widget('Followers', '<div id="Followers1-wrapper">Follow this blog</div>')}${widget('FollowByEmail', '<form><input name="email"></form>')}
				${widget('Subscribe', '<a href="/feeds/posts/default">Posts</a>')}${widget('ReportAbuse', '<a href="#">Report Abuse</a>')}${widget('Navbar', '<iframe></iframe>')}
				${widget('AdSense', '<ins class="adsbygoogle"></ins>')}${widget('Attribution', 'Powered by <a href="https://www.blogger.com">Blogger</a>')}
				${widget('Label', '<a href="/search/label/Blog">Blog</a>')}${widget('PopularPosts', '<a href="/2023/11/post.html">Post</a>')}</aside></main>
				<footer><div class="widget HTML" id="HTML2"><div class="widget-content">Copyright © 2023. Powered by <a href="https://www.blogger.com" rel="nofollow">Blogger</a></div></div></footer></body>`);

			const report = await applySourceCleanup(page, cleanupPolicy(bloggerAdapter.liberation?.cleanupRules));

			expect(await page.locator('.widget').evaluateAll(nodes => nodes.map(node => node.id))).toEqual(['Label1', 'PopularPosts1', 'HTML2']);
			expect((await page.locator('footer').innerText()).trim()).toBe('Copyright © 2023.');
			expect(await page.locator('article a[href="https://www.blogger.com/about"]').count()).toBe(1);
			expect(report.records.map(record => record.rule)).toEqual(expect.arrayContaining(['blogger-adsense', 'blogger-attribution', 'blogger-credit', 'blogger-follow-by-email', 'blogger-followers', 'blogger-navbar', 'blogger-report-abuse', 'blogger-subscribe']));
			expect(report.failures).toEqual([]);
		} finally { await page.close(); }
	});
});
