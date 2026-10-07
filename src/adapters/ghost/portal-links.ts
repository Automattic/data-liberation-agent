import type { Page } from 'playwright';

/**
 * Collapse links into Ghost Portal's hash routes to `href="#"`.
 *
 * Theme Sign in / Subscribe / Share controls link to Portal routes
 * (`#/portal/signup`, `#/portal/signin`, `#/share`), which only resolve while
 * Portal runs against Ghost's members API. In a static copy they point at
 * anchors that don't exist. The control keeps its place and styling; only the
 * dead action goes — the same treatment the pipeline gives `javascript:` links.
 * Only same-site links are touched (themes spell them relative or absolute,
 * e.g. platformer.news uses `https://www.platformer.news/#/portal/`).
 */
export async function neutralizePortalLinks(page: Page): Promise<number> {
	return page.evaluate(() => {
		let changed = 0;
		for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href*="#/"]')) {
			let url: URL;
			try {
				url = new URL(link.getAttribute('href')!, location.href);
			} catch {
				continue;
			}
			if (url.origin !== location.origin) continue;
			if (!/^#\/(?:portal|share)(?:[/?]|$)/.test(url.hash)) continue;
			link.setAttribute('href', '#');
			changed++;
		}
		return changed;
	});
}
