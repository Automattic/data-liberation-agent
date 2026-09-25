import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeAdminDiscovery } from './admin.js';
import { discover } from './discover.js';

const siteUrl = 'https://walkabout.example.test/';
const homepageHtml = readFileSync(
  fileURLToPath(new URL('../../../test/fixtures/squarespace-homepage.html', import.meta.url)),
  'utf8',
);

function response(body: string, ok = true): Response {
  return new Response(body, { status: ok ? 200 : 503 });
}

afterEach(() => vi.unstubAllGlobals());

describe('Squarespace discovery', () => {
  it('discovers public primary navigation from homepage HTML', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('?format=json')) return response(JSON.stringify({ website: { siteTitle: 'Walkabout Chronicles' } }));
      if (url.endsWith('/sitemap.xml')) return response([
        '<urlset>',
        '<url><loc>https://walkabout.example.test/</loc></url>',
        '<url><loc>https://walkabout.example.test/journal</loc></url>',
        '<url><loc>https://walkabout.example.test/about</loc></url>',
        '<url><loc>https://walkabout.example.test/contact</loc></url>',
        '<url><loc>https://walkabout.example.test/archive</loc></url>',
        '</urlset>',
      ].join(''));
      return response(homepageHtml);
    }));

    const inventory = await discover(siteUrl, {});

    expect(inventory.navigation).toEqual([
      { text: 'Home', href: 'https://walkabout.example.test/' },
      { text: 'Journal', href: 'https://walkabout.example.test/journal' },
      { text: 'Store', href: 'https://store.example.test/collections' },
    ]);
    expect(inventory.navigation).not.toContainEqual({ text: 'Privacy', href: 'https://walkabout.example.test/privacy' });
  });

  it('queues homepage links the sitemap omits once, without doubling sitemap routes', async () => {
    const homepage = [
      '<header><nav>',
      '<a href="/">Home</a>',
      '<a href="/journal/">Journal</a>',
      '<a href="/about">About</a>',
      '<a href="/about#team">Team</a>',
      '<a href="#main">Skip</a>',
      '<a href="https://store.example.test/collections">Store</a>',
      '<a href="mailto:hello@walkabout.example.test">Email</a>',
      '<a href="/cart">Cart</a>',
      '<a href="/account">Account</a>',
      '</nav></header>',
      '<main><a href="/board">Board</a><a href="/journal?page=2">Older</a></main>',
    ].join('');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('?format=json')) return response('{}');
      if (url.endsWith('/sitemap.xml')) return response([
        '<urlset>',
        ...['/', '/journal', '/contact', '/services', '/privacy'].map((path) => `<url><loc>https://walkabout.example.test${path}</loc></url>`),
        '</urlset>',
      ].join(''));
      return response(homepage);
    }));

    const inventory = await discover(siteUrl, {});

    expect(inventory.urls).toEqual([
      { url: 'https://walkabout.example.test/', type: 'homepage' },
      { url: 'https://walkabout.example.test/journal', type: 'page' },
      { url: 'https://walkabout.example.test/contact', type: 'page' },
      { url: 'https://walkabout.example.test/services', type: 'page' },
      { url: 'https://walkabout.example.test/privacy', type: 'page' },
      { url: 'https://walkabout.example.test/about', type: 'page' },
      { url: 'https://walkabout.example.test/board', type: 'page' },
    ]);
    expect(inventory.counts).toEqual({ homepage: 1, page: 6 });
  });

  it('continues discovery when the public homepage cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('?format=json')) return response('{}');
      if (url.endsWith('/sitemap.xml')) return response('<urlset><url><loc>https://walkabout.example.test/about</loc></url></urlset>');
      return response('', false);
    }));

    await expect(discover(siteUrl, {})).resolves.toMatchObject({
      navigation: [],
      urls: [{ url: 'https://walkabout.example.test/about', type: 'page' }],
    });
  });

  it('keeps public navigation while adding unique published admin pages', () => {
    const inventory = mergeAdminDiscovery({
      siteUrl,
      discoveredAt: '2026-09-09T00:00:00.000Z',
      siteMeta: { title: 'Walkabout Chronicles', tagline: '', language: 'en-US' },
      navigation: [{ text: 'Journal', href: 'https://walkabout.example.test/journal' }],
      counts: { page: 1 },
      urls: [{ url: 'https://walkabout.example.test/journal', type: 'page' }],
    }, [
      { url: 'https://walkabout.example.test/journal', title: 'Journal', type: 'page', visibility: 'published', adminPageId: '1' },
      { url: 'https://walkabout.example.test/members', title: 'Members', type: 'page', visibility: 'published', adminPageId: '2' },
      { url: 'https://walkabout.example.test/draft', title: 'Draft', type: 'page', visibility: 'draft', adminPageId: '3' },
    ]);

    expect(inventory.navigation).toEqual([
      { text: 'Journal', href: 'https://walkabout.example.test/journal' },
      { text: 'Members', href: 'https://walkabout.example.test/members' },
    ]);
  });
});
