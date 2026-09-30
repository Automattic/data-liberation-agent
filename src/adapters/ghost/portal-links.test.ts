import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { neutralizePortalLinks } from './portal-links.js';

// Link shapes from live Ghost themes (2026-09): Casper nav (demo.ghost.io),
// Source's absolute Sign up link (platformer.news), and Casper's share button.
const HTML = `<!doctype html><html><body>
	<nav>
		<a id="signin" href="#/portal/signin" data-portal="signin">Sign in</a>
		<a id="signup" class="gh-head-button" href="#/portal/signup" data-portal="signup">Subscribe</a>
		<a id="absolute" href="https://ghost.example/#/portal/">Sign up</a>
		<a id="account" href="/#/portal/account">Account</a>
	</nav>
	<article>
		<a id="share" href="#/share">Share</a>
		<a id="toc" href="#comments">Jump to comments</a>
		<a id="post" href="/welcome/">Welcome</a>
		<a id="elsewhere" href="https://other.example/#/portal/signup">Another Ghost site</a>
		<a id="lookalike" href="#/portalish">Not a Portal route</a>
		<h2 id="comments">Comments</h2>
	</article>
</body></html>`;

describe.skipIf(process.env.SKIP_BROWSER_TESTS)('neutralizePortalLinks', () => {
	let browser: Browser;
	beforeAll(async () => { browser = await chromium.launch(); });
	afterAll(async () => { await browser.close(); });

	it('makes same-site Portal and Share links inert and leaves everything else', async () => {
		const page = await browser.newPage();
		try {
			await page.route('https://ghost.example/**', (route) => route.fulfill({ contentType: 'text/html', body: HTML }));
			await page.goto('https://ghost.example/');
			expect(await neutralizePortalLinks(page)).toBe(5);
			const href = (id: string) => page.locator(`#${id}`).getAttribute('href');
			for (const id of ['signin', 'signup', 'absolute', 'account', 'share']) expect(await href(id)).toBe('#');
			expect(await href('toc')).toBe('#comments');
			expect(await href('post')).toBe('/welcome/');
			expect(await href('elsewhere')).toBe('https://other.example/#/portal/signup');
			expect(await href('lookalike')).toBe('#/portalish');
			// The controls themselves stay: text, attributes and styling hooks.
			expect(await page.locator('#signup').innerText()).toBe('Subscribe');
			expect(await page.locator('#signup').getAttribute('class')).toBe('gh-head-button');
		} finally {
			await page.close();
		}
	});
});
