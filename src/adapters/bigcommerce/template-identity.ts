import * as cheerio from 'cheerio';
import type { TemplateIdentity } from '../../lib/template-groups.js';

const templates = ['default', 'category', 'product', 'page', 'blog', 'blog_post', 'brand', 'search'];

/** Stencil declares the template independently of product/card cardinality. */
export const bigcommerceTemplateIdentity: TemplateIdentity = (html, url) => {
	const $ = cheerio.load(html);
	const template = templates.find(name => $('body').hasClass(name));
	if (!template) return undefined;
	// Authored pages are site content, not interchangeable template members.
	return template === 'page' ? `bigcommerce:page:${new URL(url).pathname}` : `bigcommerce:${template}`;
};
