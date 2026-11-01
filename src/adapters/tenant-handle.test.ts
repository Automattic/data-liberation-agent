import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectFromDocument } from '../lib/detect-platform/detect-platform.js';
import { resolvePlatform } from '../index.js';
import type { DefaultInventory } from './default/types.js';

const html = `<!doctype html><html lang="pt"><head><title>Tenant</title>
	<meta name="description" content="Profile description"></head><body>
	<header><nav><a href="/pricing">Pricing</a><a href="/tenant">Home</a></nav></header>
	<main><a href="/tenant#contact">Contact</a><a href="/tenant-two">Another profile</a></main>
	<footer><a href="/">Platform</a><a href="/signup">Sign up</a></footer></body></html>`;

function response(body: string, url: string): Response {
	const result = new Response(body);
	Object.defineProperty(result, 'url', { value: url });
	return result;
}

afterEach(() => vi.unstubAllGlobals());

describe.each(['soloist.ai', 'www.atom.bio', 'atom.bio'])('shared-origin tenant on %s', (host) => {
	it('discovers only the tenant, never fetching the platform sitemap', async () => {
		const origin = `https://${host}`;
		const requests: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
			const url = String(input);
			requests.push(url);
			if (url.includes('sitemap')) {
				return response(`<urlset>${['/', '/pricing', '/signup', '/help', '/tenant-two'].map(
					(path) => `<url><loc>${origin}${path}</loc></url>`,
				).join('')}</urlset>`, url);
			}
			// The slash entry redirects to the canonical slashless profile.
			return response(html, `${origin}/tenant`);
		}));
		const detected = detectFromDocument(`${origin}/tenant/`, new Headers(), '');
		const adapter = resolvePlatform(detected.platform)!;
		const inventory = await adapter.discover(`${origin}/tenant/`, {}) as DefaultInventory;
		expect(inventory.urls).toEqual([{ url: `${origin}/tenant`, type: 'homepage' }]);
		expect(requests).toEqual([`${origin}/tenant/`]);
		expect(inventory.siteMeta).toMatchObject({ title: 'Tenant', tagline: 'Profile description', language: 'pt' });
		expect(inventory.navigation).toEqual([{ text: 'Home', href: `${origin}/tenant` }]);
		expect(adapter.routeScope?.(`${origin}/tenant/`)).toEqual({ origin, pathPrefixes: ['/tenant'] });
	});

	it.each(['/tenant-two', '/pricing', 'https://elsewhere.test/tenant'])(
		'rejects a homepage redirected outside the tenant: %s', async (destination) => {
			const origin = `https://${host}`;
			vi.stubGlobal('fetch', vi.fn(async () => response(html, new URL(destination, origin).href)));
			const adapter = resolvePlatform(detectFromDocument(`${origin}/tenant/`, new Headers(), '').platform)!;
			await expect(adapter.discover(`${origin}/tenant/`, {})).rejects.toThrow('redirected outside the tenant');
		},
	);
});

it('does not assign tenant ownership to ordinary subpath sites or lookalike hosts', () => {
	for (const url of ['https://example.com/tenant/', 'https://atom.bio.evil.test/tenant/', 'https://elsewhere.test/atom.bio/']) {
		const adapter = resolvePlatform(detectFromDocument(url, new Headers(), '').platform)!;
		expect(adapter.id).toBe('default');
		expect(adapter.routeScope).toBeUndefined();
	}
});
