import { load } from 'cheerio';
import type { LiberationHooks } from '../page-actions.js';
import { getSourceResponse } from '../../lib/browser-kit/source-traffic.js';

/** Framer's SSR variants already select layout through authored media queries.
 * Its hydration bundle deletes the inactive siblings, destroying that tree. */
export const loadFramerDocument: NonNullable<LiberationHooks['loadDocument']> = async (page, url, timeout) => {
	const response = await getSourceResponse(page.context(), url, { timeout, maxRedirects: 0 });
	try {
		if (!response.ok()) return undefined;
		const source = await response.text();
		const $ = load(source);
		if (!$('.ssr-variant[class*="hidden-"]').length) return undefined;
		const bundles = $('script[data-framer-bundle], script[type="module"][src]').filter((_index, element) => {
			if ($(element).is('[data-framer-bundle]')) return true;
			try { return new URL($(element).attr('src')!, url).hostname === 'framerusercontent.com'; }
			catch { return false; }
		});
		if (!bundles.length) return undefined;
		bundles.remove();
		return { html: $.html(), headers: response.headers() };
	} finally { await response.dispose(); }
};
