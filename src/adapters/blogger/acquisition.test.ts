import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { bloggerAcquisition } from './acquisition.js';

const context = {
	url: 'https://journal.example.test/2026/08/one.html',
	finalUrl: 'https://journal.example.test/2026/08/one.html',
	variant: 'desktop',
};

function document(body: string, head = ''): string {
	return `<!doctype html><html><head><meta content='blogger' name='generator'/>${head}</head><body>${body}</body></html>`;
}

const rendered = document(
	`<div class='widget Blog' id='Blog1'>
		<div class='blog-posts hfeed'>
			<article class='post-outer-container'>
				<div class='post-outer'>
					<h3 class='post-title'>One</h3>
					<div class='post-body entry-content' id='post-body-1'>
						<p style='color:#654321'>Readable body</p>
						<img src='https://journal.example.test/photo.jpg' srcset='https://journal.example.test/photo.jpg 800w' alt=''>
					</div>
				</div>
			</article>
		</div>
		<div id='Blog1_comments-block-wrapper'><a href='/2026/08/one.html#comments'>Comments</a></div>
	</div>
	<details class='collapsible'><summary>Archive</summary><a href='/2026/08/'>August</a></details>
	<details open><summary>Already open</summary><p>Visible</p></details>
	<details><summary>Menu</summary><div role='dialog'><a href='/secret'>Secret</a></div></details>
	<iframe src='https://www.blogger.com/followers.g'></iframe>`,
	`<title>One</title>
	<meta property='og:title' content='One'>
	<link rel='stylesheet' href='/author.css'>
	<style>.post-body{color:#123456}</style>
	<script type='application/ld+json'>{"@type":"BlogPosting","headline":"\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e"}</script>
	<script type='application/json'>{"route":"one"}</script>
	<script src='https://www.blogger.com/static/runtime.js'></script>
	<script>window.executed = true</script>`,
);

describe('Blogger HTTP preparation', () => {
	it('declares runtime-owned regions without fabricating their URL or geometry', () => {
		const input = rendered.replace('</body>', '<iframe id="comment-editor" src="" height="410px" width="100%"></iframe><div class="widget Followers"></div><button class="sharing-button">Share</button></body>');
		const prepared = bloggerAcquisition.prepare(input, context);
		if (!prepared || prepared instanceof Promise) throw new Error('Expected a prepared document');
		expect(prepared.browserRegions?.map(region => region.selector)).toEqual(['#comment-editor', '.widget.Followers', '.sharing-button']);
		const $ = cheerio.load(prepared.html);
		expect($('#comment-editor').attr('src')).toBe('');
		expect($('#comment-editor').attr('height')).toBe('410px');
		expect(prepared.metadata?.rendering).toBe('unverified');
	});
	it('prepares a fingerprinted server-rendered document without claiming a portable site', () => {
		const prepared = bloggerAcquisition.prepare(rendered, context);
		if (!prepared || prepared instanceof Promise) throw new Error('Expected a prepared document');
		const $ = cheerio.load(prepared.html);
		expect(prepared.metadata).toEqual({
			kind: 'post', title: 'One', canonical: 'https://journal.example.test/2026/08/one.html',
			document: 'blogger-server-rendered',
			preparation: 'executable-scripts-removed,json-ld-retained,native-details-opened',
			rendering: 'unverified',
			assets: 'not-localized',
			interactions: 'unverified',
			variant: 'desktop',
		});
		expect($('script[src], script:not([type])').length).toBe(0);
		expect($('script').toArray().every((element) => /^(application\/ld\+json|application\/json)$/i.test($(element).attr('type') ?? ''))).toBe(true);
		expect(prepared.html).not.toContain('window.executed');
		expect(prepared.html).not.toContain('www.blogger.com/static/runtime.js');
		const jsonLd = JSON.parse($('script[type="application/ld+json"]').text()) as { headline: string };
		expect(jsonLd.headline).toContain('alert(1)');
		expect(prepared.html).not.toMatch(/<script type="application\/ld\+json">[\s\S]*<\/script><script>alert\(1\)/);
		expect($('script[type="application/json"]').text()).toContain('"route":"one"');
		expect($('style').text()).toContain('#123456');
		expect($('link[rel="stylesheet"]').attr('href')).toBe('/author.css');
		expect($('meta[property="og:title"]').attr('content')).toBe('One');
		expect($('#post-body-1').text()).toContain('Readable body');
		expect($('#post-body-1 p').attr('style')).toContain('#654321');
		expect($('img').attr('src')).toBe('https://journal.example.test/photo.jpg');
		expect($('img').attr('srcset')).toContain('800w');
		expect($('#Blog1_comments-block-wrapper a').attr('href')).toBe('/2026/08/one.html#comments');
		expect($('details').eq(0).attr('open')).toBeDefined();
		expect($('details').eq(1).attr('open')).toBeDefined();
		expect($('details').eq(2).attr('open')).toBeUndefined();
		const iframe = $('iframe');
		expect(iframe.attr('src')).toBe('https://www.blogger.com/followers.g');
		expect(iframe.attr('width')).toBeUndefined();
		expect(iframe.attr('height')).toBeUndefined();
		expect(prepared.html).not.toContain('data-dla-visual-iframe');
	});

	it('accepts an image-only post body', () => {
		const prepared = bloggerAcquisition.prepare(
			document('<div class="widget Blog" id="Blog1"><div class="post-body"><img src="/photo.jpg" alt=""></div></div>'),
			context,
		);
		expect(prepared).toMatchObject({ metadata: { document: 'blogger-server-rendered', rendering: 'unverified' } });
	});

	it.each([
		['canvas app', document('<canvas id="app"></canvas><div class="widget Blog" id="Blog1"><div class="post-body">Readable</div></div>')],
		['script-only editorial', document('<div class="widget Blog" id="Blog1"><div class="blog-posts"></div></div><script>window.__article = { body: "Only in script" };</script>')],
		['unknown body', document('<div id="root"></div>')],
		['widget shell without a post body', document('<div class="widget Blog" id="Blog1"><div class="blog-posts">Loading</div></div><script>window.__article = { body: "Only in script" };</script>')],
		['missing generator', '<html><body><div class="widget Blog"><div class="post-body">Readable</div></div></body></html>'],
	])('returns undefined for %s', (_label, html) => {
		expect(bloggerAcquisition.prepare(html, context)).toBeUndefined();
	});
});
