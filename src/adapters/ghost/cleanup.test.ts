import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySourceCleanup, cleanupPolicy } from '../../lib/source-cleanup.js';
import { ghostAdapter } from './index.js';

// Footer credits as published by live Ghost themes (2026-09).
const FOOTERS: Array<[string, string, string]> = [
	[
		'Casper (demo.ghost.io)',
		'<div class="gh-powered-by"><a href="https://ghost.org/" target="_blank" rel="noopener">Powered by Ghost</a></div><p class="copy">© 2026 Demo</p>',
		'© 2026 Demo',
	],
	[
		'Source (platformer.news)',
		'<p class="copy">© 2026 Platformer</p><div class="gh-footer-copyright"> Powered by <a href="https://ghost.org/" target="_blank" rel="noopener">Ghost</a> </div>',
		'© 2026 Platformer',
	],
	[
		'theme credit alongside (blog.codinghorror.com)',
		'<div class="gh-footer-copyright"> Powered by <a href="https://ghost.org/" target="_blank" rel="noopener">Ghost</a> &middot; Themed by <a href="https://oboxthemes.com">Obox</a> </div>',
		'Themed by Obox',
	],
	[
		'"Published with" (aftermath.site)',
		'<div class="text-sm"><span data-footer-date>©2026 <a href="https://aftermath.site">Aftermath</a>.</span> <span data-footer-ghost>Published with <a href="https://ghost.org">Ghost</a></span></div>',
		'©2026 Aftermath.',
	],
];

describe.skipIf(process.env.SKIP_BROWSER_TESTS)('Ghost footer credit cleanup', () => {
	let browser: Browser;
	beforeAll(async () => { browser = await chromium.launch(); });
	afterAll(async () => { await browser.close(); });

	it.each(FOOTERS)('removes the Ghost credit and keeps owner text: %s', async (_label, footer, kept) => {
		const page = await browser.newPage();
		try {
			// The body sentence is real (demo.ghost.io/design/): "Ghost" is an ordinary
			// word, so credit phrasing in prose must survive.
			await page.setContent(`<!doctype html><html><body><main><h1>Owner post</h1><p>By default, new sites are created with Ghost's friendly publication theme, called Casper.</p></main><footer>${footer}</footer></body></html>`);
			await applySourceCleanup(page, cleanupPolicy(ghostAdapter.liberation?.cleanupRules));
			const footerText = (await page.locator('footer').innerText()).replace(/\s+/g, ' ');
			expect(footerText).not.toMatch(/Ghost/);
			expect(await page.locator('footer a[href*="ghost.org"]').count()).toBe(0);
			expect(footerText).toContain(kept);
			// Body copy mentioning Ghost is the owner's content, never a credit.
			expect(await page.locator('main').innerText()).toContain("new sites are created with Ghost's friendly publication theme");
		} finally {
			await page.close();
		}
	});
});
