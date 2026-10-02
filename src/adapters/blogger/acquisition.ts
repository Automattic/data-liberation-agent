import * as cheerio from 'cheerio';
import type { HttpAcquisitionProfile, HttpDocumentContext, PreparedHttpDocument } from '../../platform/acquisition.js';

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const EXECUTABLE_TYPES = new Set([
	'',
	'text/javascript',
	'application/javascript',
	'application/ecmascript',
	'text/ecmascript',
	'text/jscript',
	'text/x-javascript',
	'application/x-javascript',
	'module',
]);

function scriptType(value: string | undefined): string {
	return (value ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

function isJsonLd(type: string): boolean {
	return /^application\/ld\+json(?:\s*;|$)/i.test(type);
}

function isExecutable(type: string): boolean {
	return EXECUTABLE_TYPES.has(type);
}

function hasBloggerGenerator(html: string): boolean {
	const source = html.replace(/<!--[\s\S]*?-->/g, '');
	return /<meta\b(?=[^>]*\bname\s*=\s*['"]generator['"])(?=[^>]*\bcontent\s*=\s*['"]\s*blogger\s*['"])[^>]*>/i.test(source);
}

function classTokens(value: string | undefined): string[] {
	return (value ?? '').split(/\s+/).filter(Boolean);
}

export function prepareBloggerDocument(html: string, context: HttpDocumentContext): PreparedHttpDocument | undefined {
	if (!hasBloggerGenerator(html)) return undefined;
	const $ = cheerio.load(html);
	if ($('canvas').length > 0) return undefined;
	const widget = $('div, section, article').filter((_, element) => {
		const tokens = classTokens($(element).attr('class'));
		return (tokens.includes('widget') && tokens.includes('Blog')) || $(element).attr('id') === 'Blog1';
	}).first();
	if (!widget.length) return undefined;
	const editorial = widget.find('.post-body, .entry-content');
	const hasEditorial = editorial.toArray().some((element) => {
		const node = $(element);
		const text = node.clone().find('script, style').remove().end().text().replace(/\s+/g, '');
		return text.length > 0 || node.find('img[src], img[data-src]').length > 0;
	});
	if (!hasEditorial) return undefined;

	$('script').each((_, element) => {
		const node = $(element);
		const type = scriptType(node.attr('type'));
		if (isJsonLd(type) && !node.attr('src')) {
			try {
				const value: unknown = JSON.parse(node.text());
				if (value === null || typeof value !== 'object') {
					node.remove();
					return;
				}
				const inert = JSON.stringify(value).replace(/<\/script(?=[\t\n\f\r />])/gi, '<\\/script');
				node.replaceWith(`<script type="application/ld+json">${inert}</script>`);
			} catch {
				node.remove();
			}
			return;
		}
		if (isExecutable(type)) node.remove();
	});

	$('details').each((_, element) => {
		const details = $(element);
		if (details.attr('open') !== undefined) return;
		if (details.find('[role="dialog"], [aria-modal="true"]').length > 0) return;
		details.attr('open', '');
	});

	return {
		html: $.html(),
		browserRegions: [
			...($('#comment-editor[src=""]').length ? [{ selector: '#comment-editor', reason: 'Blogger initializes the comment editor URL and height from its runtime.' }] : []),
			...($('.widget.Followers').length ? [{ selector: '.widget.Followers', reason: 'Blogger mounts its follower surface at runtime.' }] : []),
			...($('.sharing-button').length ? [{ selector: '.sharing-button', reason: 'Share controls require observed interaction projection.' }] : []),
		],
		metadata: {
			kind: /^\/\d{4}\/\d{2}\/[^/]+\.html$/.test(new URL(context.url).pathname) ? 'post'
				: /^\/(?:\d{4}(?:\/\d{1,2})?\/?|search\/label\/[^/]+)?$/.test(new URL(context.url).pathname) ? 'listing' : 'page',
			title: $('title').first().text().trim(),
			canonical: $('link[rel="canonical"]').first().attr('href') ?? context.url,
			document: 'blogger-server-rendered',
			preparation: 'executable-scripts-removed,json-ld-retained,native-details-opened',
			rendering: 'unverified',
			assets: 'not-localized',
			interactions: 'unverified',
			variant: context.variant,
		},
	};
}

export const bloggerAcquisition: HttpAcquisitionProfile = {
	id: 'blogger',
	variants: [
		{ id: 'desktop', headers: { 'User-Agent': DESKTOP_UA } },
		{ id: 'mobile', headers: { 'User-Agent': MOBILE_UA } },
	],
	prepare: prepareBloggerDocument,
};
