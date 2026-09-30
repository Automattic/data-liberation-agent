import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySourceCleanup, cleanupPolicy } from '../../lib/source-cleanup.js';
import { neutralizePlatformLinks } from './capture.js';
import { substackAdapter } from './index.js';

// Markup as captured from derekthompson.org (2026-09); SVG icon omitted.
const FOOTER = `<div class="footer themed-background"><div class="container">
	<div class="footer-terms"><span>© 2026 Derek Thompson</span><span> · </span><a href="https://substack.com/privacy" target="_blank" rel="noopener">Privacy</a><span> ∙ </span><a href="https://substack.com/tos" target="_blank" rel="noopener">Terms</a><span> ∙ </span><a href="https://substack.com/ccpa#personal-data-collected" target="_blank" rel="noopener">Collection notice</a></div>
	<div class="pencraft pc-display-flex footerButtons-ap9Sk7"><a data-native="true" href="https://substack.com/signup?utm_source=substack&amp;utm_medium=web&amp;utm_content=footer" class="footerSubstackCta-v5HWfj">Start your Substack</a><a data-native="true" href="https://substack.com/app/app-store-redirect?utm_campaign=app-marketing&amp;utm_content=web-footer-button" class="footerSubstackCta-v5HWfj getTheApp-Yk3w1O">Get the app</a></div>
	<div translated="true" class="pencraft pc-reset footer-slogan-blurb"><a href="https://substack.com" data-native="true">Substack</a> is the home for great culture</div>
</div></div>`;

const HEADER = `<header>
	<button tabindex="0" data-native="true" type="button" data-href="https://substack.com/sign-in?redirect=%2Fabout&amp;for_pub=derekthompson" class="buttonBase-GK1x3M">Sign in</button>
	<a id="link-signin" href="https://substack.com/sign-in?redirect=%2F&amp;for_pub=astralcodexten">Sign in</a>
</header>`;

const POST = `<main><article>
	<a id="byline" href="https://substack.com/@derekthompson?utm_source=about-page">Derek Thompson</a>
	<p>I wrote about <a id="prose" href="https://substack.com/about">how Substack works</a> last year.</p>
</article></main>`;

describe.skipIf(process.env.SKIP_BROWSER_TESTS)('Substack capture cleanup', () => {
	let browser: Browser;
	beforeAll(async () => { browser = await chromium.launch(); });
	afterAll(async () => { await browser.close(); });

	it('removes Substack footer chrome and legal links, keeping the owner copyright', async () => {
		const page = await browser.newPage();
		try {
			await page.setContent(`<!doctype html><html><body>${POST}${FOOTER}</body></html>`);
			await applySourceCleanup(page, cleanupPolicy(substackAdapter.liberation?.cleanupRules));
			const footer = (await page.locator('.footer').innerText()).replace(/\s+/g, ' ').trim();
			expect(footer).toBe('© 2026 Derek Thompson');
			expect(await page.locator('.footer a').count()).toBe(0);
			// A post's own link to substack.com is owner content.
			expect(await page.locator('#prose').getAttribute('href')).toBe('https://substack.com/about');
		} finally {
			await page.close();
		}
	});

	it('points sign-in controls and byline profile links at #, keeping the controls', async () => {
		const page = await browser.newPage();
		try {
			await page.setContent(`<!doctype html><html><body>${HEADER}${POST}</body></html>`);
			expect(await neutralizePlatformLinks(page)).toBe(3);
			expect(await page.locator('button').getAttribute('data-href')).toBe('#');
			expect(await page.locator('button').innerText()).toBe('Sign in');
			expect(await page.locator('#link-signin').getAttribute('href')).toBe('#');
			expect(await page.locator('#byline').getAttribute('href')).toBe('#');
			expect(await page.locator('#byline').innerText()).toBe('Derek Thompson');
			expect(await page.locator('#prose').getAttribute('href')).toBe('https://substack.com/about');
		} finally {
			await page.close();
		}
	});
});
