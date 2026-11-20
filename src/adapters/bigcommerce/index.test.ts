import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import * as cheerio from 'cheerio';
import { expect, it } from 'vitest';
import { findAdapter } from '../index.js';
import { detectFromResponse } from '../../lib/detect-platform/index.js';
import { routeInScope, scopedRouteKey } from '../../lib/url/route-scope.js';
import { buildTemplateGroups, templateRepresentatives } from '../../lib/template-groups.js';
import { runWithTrustedOrigins } from '../../lib/media-fetch/safe-fetch.js';
import { selectRouteBudget } from '../../lib/route-budget.js';
import { bigcommerceAdapter as adapter } from './index.js';
import { discover } from './discover.js';

const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8')) as {
	documents: Record<string, string>; sitemaps: Record<string, string>;
};
const origin = 'https://example.com';

it.each([
	[fixture.documents['/']!, 'bigcommerce'],
	['<script>var BCData = {}; window.stencil = {};</script>', 'bigcommerce'],
	['<body class="product"><main data-content-region="product"></main>', 'bigcommerce'],
	['<body class="product"><main>Generic product</main>', 'unknown'],
	['<div data-content-region="generic">Content</div>', 'unknown'],
])('detects Stencil evidence without matching generic markup (%#)', (html, platform) => {
	expect(detectFromResponse(new Headers(), html).platform).toBe(platform);
	expect(findAdapter('bigcommerce')).toBe(adapter);
});

it.each(['default', 'category', 'product', 'page', 'blog', 'blog_post', 'brand', 'search', 'unknown'])(
	'identifies body template %s', template => {
		const identity = adapter.templateIdentity!(`<body class="extra ${template}">`, `${origin}/about/`);
		expect(identity).toBe(template === 'unknown' ? undefined : `bigcommerce:${template}${template === 'page' ? ':/about/' : ''}`);
	},
);

it.each(['cart.php', 'login.php', 'account.php', 'checkout.php', 'finishorder.php', 'orderstatus.php', 'search.php', 'wishlist.php', 'compare', 'remote.php'])(
	'excludes system endpoint %s, including query variants', path => {
		const scope = adapter.routeScope!(origin);
		for (const query of ['', '?action=login']) expect(routeInScope(`${origin}/${path}${query}`, scope)).toBe(false);
		expect(routeInScope(`${origin}/${path}-guide/`, scope)).toBe(true);
	},
);

it('reports purchasing controls as commerce needing a checkout backend', () => {
	const rule = adapter.inspection![0]!;
	const $ = cheerio.load(fixture.documents['/sample/']! + fixture.documents['/another/']!);
	expect($(rule.selector)).toHaveLength(2);
	expect(rule.capability).toBe('commerce');
	expect(rule.evidence).toContain('checkout backend');
});

it('collapses sort and faceting variants to the site document', () => {
	const scope = adapter.routeScope!(origin);
	expect(scopedRouteKey(`${origin}/catalog/?sort=priceasc&_bc_fsnf=1`, scope)).toBe(`${origin}/catalog/`);
});

it('discovers typed index leaves and budgets content plus category/product representatives before more members', async () => {
	const server = createServer((request, response) => {
		const base = `http://${request.headers.host}`;
		const xml = fixture.sitemaps[request.url!];
		const html = fixture.documents[request.url!];
		response.statusCode = xml || html ? 200 : 404;
		response.setHeader('content-type', xml ? 'application/xml' : 'text/html');
		response.end((xml ?? html ?? '').replaceAll(origin, base));
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		const inventory = await discover(`${base}/`, { entryHtml: fixture.documents['/'] });
		const scope = adapter.routeScope!(base);
		const urls = [`${base}/`, ...inventory.urls.map(entry => entry.url).filter(url => url !== `${base}/`)].filter(url => routeInScope(url, scope));
		expect(urls).toHaveLength(6);
		expect(urls).toContain(`${base}/about/`);
		const report = await runWithTrustedOrigins([base], () => buildTemplateGroups({ sourceUrl: base, urls, routeScope: scope, templateIdentity: adapter.templateIdentity }));
		expect(report.groups.map(group => group.size).sort()).toEqual([1, 1, 2, 2]);
		// Same navigation-first, then template-representative contract as capture's count budget.
		const selected = selectRouteBudget(urls, 4, [`${base}/about/`, ...templateRepresentatives(report)]).selected;
		expect(selected).toEqual(expect.arrayContaining([`${base}/`, `${base}/about/`]));
		for (const paths of [['/catalog/', '/more/'], ['/sample/', '/another/']]) {
			expect(selected.filter(url => paths.some(path => url === `${base}${path}`))).toHaveLength(1);
		}
		expect(selected.some(url => /cart\.php|login\.php/.test(url))).toBe(false);
	} finally {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});
