import * as cheerio from 'cheerio';
import type { TemplateIdentity } from '../../lib/template-groups.js';

/** Shopify declares product templates independently of gallery and variant cardinality. */
export const shopifyTemplateIdentity: TemplateIdentity = (html, url) => {
	if (!/^\/products\/[^/]+\/?$/.test(new URL(url).pathname)) return undefined;
	const $ = cheerio.load(html);
	if ($('body').hasClass('template-product')) return 'shopify:product';
	try {
		const analytics = JSON.parse($('#shop-js-analytics[type="application/json"]').text() || 'null');
		if (analytics?.pageType === 'product') return 'shopify:product';
	} catch { /* Malformed declarations do not establish template identity. */ }
	const declared = $('script:not([src])').toArray().some(node => /(?:window\.)?ShopifyAnalytics\.meta\s*=\s*\{[\s\S]*?"page"\s*:\s*\{\s*"pageType"\s*:\s*"product"/.test($(node).text()));
	if (declared) return 'shopify:product';
	return undefined;
};
