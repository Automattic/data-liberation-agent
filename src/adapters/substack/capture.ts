import type { Page } from 'playwright';
import type { CleanupRule } from '../../lib/source-cleanup.js';

// Substack's footer, as rendered on custom-domain publications (2026-09):
//   <div class="footer-terms"><span>© 2026 Owner</span><span> · </span>
//     <a href="https://substack.com/privacy">Privacy</a><span> ∙ </span>
//     <a href="https://substack.com/tos">Terms</a><span> ∙ </span>
//     <a href="https://substack.com/ccpa#…">Collection notice</a></div>
//   <div class="… footerButtons-ap9Sk7">Start your Substack · Get the app</div>
//   <div class="… footer-slogan-blurb"><a>Substack</a> is the home for great culture</div>
// Class suffixes are build hashes, so rules key on stable prefixes and link
// targets. Substack's legal pages don't apply to a copy that has left
// Substack; the owner's © line is kept.
export const cleanupRules: CleanupRule[] = [
	{
		id: 'substack-footer-cta',
		category: 'source-attribution',
		selector: '[class*="footerButtons-"], a[href^="https://substack.com/signup"], a[href^="https://substack.com/app/"]',
	},
	{ id: 'substack-footer-slogan', category: 'source-attribution', selector: '.footer-slogan-blurb' },
	{
		id: 'substack-footer-legal',
		category: 'source-attribution',
		selector: '.footer-terms > a[href^="https://substack.com/"], .footer-terms > span:not(:first-child)',
	},
];

// Links that only work inside Substack: sign-in, and author bylines, which
// point at substack.com/@<handle> profiles rather than a page of the
// publication.
const PLATFORM_ONLY = [ 'https://substack.com/sign-in', 'https://substack.com/@' ];

/**
 * Point Substack sign-in controls and byline profile links at `#`. Themes
 * render "Sign in" either as a link or as a button whose `data-href`
 * Substack's runtime follows; neither can work once the copy has left
 * Substack. Each control keeps its place and text.
 */
export async function neutralizePlatformLinks(page: Page): Promise<number> {
	return page.evaluate((prefixes) => {
		const selector = prefixes.map((p) => `a[href^="${p}"], [data-href^="${p}"]`).join(', ');
		let changed = 0;
		for (const element of document.querySelectorAll(selector)) {
			element.setAttribute(element.hasAttribute('data-href') ? 'data-href' : 'href', '#');
			changed++;
		}
		return changed;
	}, PLATFORM_ONLY);
}
