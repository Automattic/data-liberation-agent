import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { detectFromDocument } from '../../lib/detect-platform/detect-platform.js';
import { resolvePlatform } from '../../index.js';
import { discoverSoloist } from './discover.js';

let server: Server | undefined;
afterEach(async () => {
	await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()) ?? resolve());
	server = undefined;
});

async function serve(html: string): Promise<{ origin: string; requests: string[] }> {
	const requests: string[] = [];
	server = createServer((request, response) => {
		requests.push(request.url!);
		response.setHeader('content-type', 'text/html');
		response.end(html);
	});
	await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
	return { origin: `http://127.0.0.1:${address.port}`, requests };
}

describe('Soloist tenant discovery', () => {
	it('detects and resolves Soloist before its underlying Next.js framework', () => {
		expect(detectFromDocument('https://soloist.ai/bethstuqui/', new Headers({ 'x-powered-by': 'Next.js' }), '')).toMatchObject({
			platform: 'soloist', confidence: 'high',
		});
		expect(resolvePlatform('soloist')?.discover).toBe(discoverSoloist);
		for (const url of ['https://soloist.ai.evil.test/bethstuqui/', 'https://elsewhere.test/soloist.ai/']) {
			expect(detectFromDocument(url, new Headers(), '').platform).toBe('unknown');
		}
	});

	it('merges authored child routes and published metadata within the exact tenant boundary', async () => {
		const metadata = { props: { pageProps: { handle: 'gallery-artist', data: { websiteSettings: {
			pages: [{ path: '/' }, { path: '/about' }, { path: '/about/?ref=nav' }, { path: '/blog/first' },
				{ path: '/../other-tenant' }, { path: '//elsewhere.test/' }],
		} } } } };
		const { origin, requests } = await serve(`<!doctype html><html lang="pt"><title>Artist</title>
			<nav><a href="/gallery-artist/">Home</a><a href="/gallery-artist/#contact">Contact</a>
			<a href="/gallery-artist/about?ref=nav">About</a><a href="/gallery-artist-two/">Other</a></nav>
			<a href="/gallery-artist/contact">Contact page</a><a href="/other-tenant/">Other tenant</a>
			<a href="https://elsewhere.test/gallery-artist/foreign">Foreign</a>
			<a href="/gallery-artist/image.jpg">Image</a><footer><a href="/?utm_content=footer_badge">Soloist</a></footer>
			<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(metadata)}</script></html>`);
		const inventory = await discoverSoloist(`${origin}/gallery-artist/about`, {});
		expect(inventory.urls).toEqual([
			{ url: `${origin}/gallery-artist/`, type: 'homepage' },
			{ url: `${origin}/gallery-artist/about`, type: 'page' },
			{ url: `${origin}/gallery-artist/contact`, type: 'page' },
			{ url: `${origin}/gallery-artist/blog/first`, type: 'post' },
		]);
		expect(inventory.counts).toEqual({ homepage: 1, page: 2, post: 1 });
		expect(inventory.siteMeta).toMatchObject({ title: 'Artist', language: 'pt' });
		expect(inventory.navigation.every((link) => new URL(link.href).pathname.startsWith('/gallery-artist/'))).toBe(true);
		expect(requests).toEqual(['/gallery-artist/']);
	});

	it.each(['{bad json', JSON.stringify({ props: { pageProps: { handle: 'other', data: { websiteSettings: { pages: [{ path: '/foreign' }] } } } } })])(
		'retains the tenant homepage and links when metadata is missing or unrelated: %s', async (metadata) => {
			const { origin, requests } = await serve(`<title>Tenant</title><a href="/tenant/#gallery">Gallery</a>
				<a href="/tenant/about/">About</a><script id="__NEXT_DATA__">${metadata}</script>`);
			const inventory = await discoverSoloist(`${origin}/tenant/`, {});
			expect(inventory.urls).toEqual([
				{ url: `${origin}/tenant/`, type: 'homepage' }, { url: `${origin}/tenant/about`, type: 'page' },
			]);
			expect(requests).toEqual(['/tenant/']);
		},
	);

	it('requires a tenant rather than treating the platform homepage as a customer site', async () => {
		await expect(discoverSoloist('https://soloist.ai/', {})).rejects.toThrow('customer handle');
	});
});
