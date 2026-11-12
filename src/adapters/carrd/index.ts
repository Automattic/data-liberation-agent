import * as cheerio from 'cheerio';
import type { PlatformAdapter } from '../../types.js';
import { sourceFetch } from '../../lib/media-fetch/capture-requests.js';
import { extractSiteMetadata } from '../site-metadata.js';
import type { LiberationHooks } from '../page-actions.js';
import { getSourceResponse } from '../../lib/browser-kit/source-traffic.js';

const sectionSelector = 'section[id$="-section"]';
const sectionName = (id: string): string => id.slice(0, -'-section'.length);

/** Carrd's section router owns sibling sections, not arbitrary fragment targets. */
function sections(html: string): Array<{ name: string; title: string }> {
	const $ = cheerio.load(html);
	const first = $(sectionSelector).first();
	return first.parent().children(sectionSelector).toArray().map(element => ({
		name: sectionName($(element).attr('id')!),
		title: $(element).attr('data-title') || $('title').text(),
	}));
}

const prepare: NonNullable<LiberationHooks['prepare']> = async (page, ctx) => {
	await page.evaluate(({ url, selector }) => {
		const all = Array.from(document.querySelectorAll<HTMLElement>(selector));
		const first = all[0];
		if (!first) return;
		const siblings = all.filter(section => section.parentElement === first.parentElement);
		const names = siblings.map(section => section.id.replace(/-section$/, ''));
		const requested = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
		const selected = siblings[names.indexOf(requested)] || first;
		for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
			const href = link.getAttribute('href')!;
			if (!href.startsWith('#')) continue;
			const name = href.slice(1) || names[0];
			if (!names.includes(name)) {
				// Carrd scroll points can live inside another section. Unknown
				// hashes fall back to home in Carrd's router, not a missing anchor.
				const point = Array.from(document.querySelectorAll<HTMLElement>('[data-scroll-id]')).find(node => node.dataset.scrollId === name);
				if (point) {
					const owner = point.closest('section');
					if (!owner || !siblings.includes(owner)) continue;
					if (!point.id) point.id = name;
					const ownerName = owner.id.replace(/-section$/, '');
					link.href = new URL(`${owner === first ? '/' : `/${encodeURIComponent(ownerName)}/`}#${encodeURIComponent(point.id)}`, url).href;
				} else if (!document.getElementById(name)) {
					link.href = new URL('/', url).href;
				}
				continue;
			}
			link.href = new URL(name === names[0] ? '/' : `/${encodeURIComponent(name)}/`, url).href;
		}
		for (const section of siblings) {
			if (section !== selected) { section.remove(); continue; }
			section.classList.remove('inactive');
			section.classList.add('active');
			section.hidden = false;
			section.style.setProperty('display', 'block', 'important');
			section.style.setProperty('opacity', '1', 'important');
			section.style.setProperty('visibility', 'visible', 'important');
		}
		if (selected.dataset.title) document.title = selected.dataset.title;
		// Carrd's router follows every section switch with a resize so its
		// scroll events re-measure the shown section and play its on-visible
		// effects; without it they keep their rewound state.
		dispatchEvent(new Event('resize'));
	}, { url: ctx.url, selector: sectionSelector });
};

export const carrdAdapter: PlatformAdapter = {
	id: 'carrd',
	detection: {
		hosts: ['carrd.co'],
		sourceSignals: [
			{ pattern: /<meta\s+name=["']generator["']\s+content=["']Carrd\b/i, signal: 'Carrd generator' },
			{ pattern: /indexedDB\.open\(['"]carrd['"]\)/, signal: 'Carrd runtime' },
		],
	},
	async discover(url) {
		const root = new URL('/', url).href;
		const response = await sourceFetch(root, { signal: AbortSignal.timeout(15000) });
		const html = await response.text();
		const routes = sections(html);
		return {
			siteUrl: root,
			siteMeta: extractSiteMetadata(html),
			urls: routes.length ? routes.map((section, index) => ({
				url: new URL(index === 0 ? '/' : `/${encodeURIComponent(section.name)}/`, root).href,
				title: section.title,
				type: index === 0 ? 'homepage' : 'page',
			})) : [{ url: root, type: 'homepage' }],
		};
	},
	liberation: {
		// Virtual paths have no server document. Fulfil only declared section
		// navigations from Carrd's root document; keep its asset base at the root.
		async loadDocument(page, url, timeout) {
			const target = new URL(url);
			if (target.pathname === '/') return undefined;
			const root = new URL('/', target).href;
			const response = await getSourceResponse(page.context(), root, { timeout, maxRedirects: 0 });
			try {
				if (!response.ok()) return undefined;
				const html = await response.text();
				const name = decodeURIComponent(target.pathname.replace(/^\/|\/$/g, ''));
				if (!sections(html).slice(1).some(section => section.name === name)) return undefined;
				// The section is this route's own page, not an alias of the root
				// document it is served from: name it as its own canonical.
				const page = html.replace(/<link\b[^>]*\brel=["']canonical["'][^>]*>/gi, `<link rel="canonical" href="${target.href}">`);
				return { headers: response.headers(), html: page.replace(/<head([^>]*)>/i, `<head$1><base href="${root}">`) };
			} finally { await response.dispose(); }
		},
		prepare,
	},
};
