import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fetching from '../../lib/media-fetch/safe-fetch.js';
import { discover } from './discover.js';
import { squarespaceStructuredContent } from './template-content.js';
import { SourceRequestGovernors } from '../../lib/source-request-governor.js';

const servers: Server[] = [];

async function squarespaceServer(
  archive: (request: URL) => { status?: number; body: string },
  paths = ['/blog', '/about', '/contact', '/services', '/privacy'],
  homepage = '<html></html>',
): Promise<{ url: string; archiveRequests: URL[] }> {
  const archiveRequests: URL[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    if (url.pathname === '/sitemap.xml') {
      const origin = url.origin;
      response.end(`<urlset>${paths.map((path) => `<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`);
      return;
    }
    if (url.pathname === '/' && url.searchParams.get('format') === 'json') {
      response.end(JSON.stringify({ website: { siteTitle: 'Test Site' } }));
      return;
    }
    if (url.searchParams.get('format') === 'json') {
      archiveRequests.push(url);
      const result = archive(url);
      response.statusCode = result.status || 200;
      // Real collection responses identify themselves; malformed shapes remain
      // untouched so the failure-path tests still exercise invalid JSON.
      let body = result.body;
      try {
        const data = JSON.parse(body);
        if (url.pathname === '/blog' && data && Array.isArray(data.items)) body = JSON.stringify({ collection: { type: 1, typeName: 'blog' }, ...data });
      } catch { /* Return the malformed fixture verbatim. */ }
      response.end(body);
      return;
    }
    response.end(homepage);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to a port');
  return { url: `http://127.0.0.1:${address.port}`, archiveRequests };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

describe('Squarespace archive discovery', () => {
  it('enumerates sitemap-only blog collections and reuses probes without discovery pagination', async () => {
    const { url, archiveRequests } = await squarespaceServer(request => {
      if (!['/blog', '/people'].includes(request.pathname)) return { body: '{}' };
      const second = request.searchParams.has('offset');
      const slug = second ? 'two' : 'one';
      return { body: JSON.stringify({
        collection: { type: 1, fullUrl: request.pathname },
        items: [{ urlId: slug, fullUrl: `${request.pathname}/${slug}`, title: slug,
          body: `<p>${slug}</p>`, publishOn: 1704067200000, updatedOn: 1704067200000 }],
        pagination: second ? {} : { nextPageOffset: 'next' },
      }) };
    }, ['/blog', '/blog/one', '/blog/two', '/people', '/people/one', '/people/two'], '<a href="/blog">Blog</a>');

    // Production safeFetch rejects loopback addresses; keep this fixture local.
    vi.spyOn(fetching, 'safeFetch').mockImplementation(async (target) => {
      const response = await globalThis.fetch(target);
      return { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: response.headers, finalUrl: response.url };
    });
    const inventory = await discover(url, {});
    expect(inventory.collections).toEqual([
      { url: `${url}/blog`, type: 1, typeName: undefined, itemCount: 2 },
      { url: `${url}/people`, type: 1, typeName: undefined, itemCount: 2 },
    ]);
    expect(archiveRequests.map(request => request.searchParams.get('offset'))).toEqual([null, null]);
    const result = await squarespaceStructuredContent.enumerate(url, { governors: new SourceRequestGovernors(), inventory });
    expect(result.entries.map(entry => entry.permalink).sort()).toEqual([
      `${url}/blog/one`, `${url}/blog/two`, `${url}/people/one`, `${url}/people/two`,
    ]);
    expect(result.diagnostics).toEqual([]);
    for (const root of ['/blog', '/people']) {
      expect(archiveRequests.filter(request => request.pathname === root).map(request => request.searchParams.get('offset'))).toEqual([null, 'next']);
    }
  });
  it('discovers neutral collections across pagination and probes non-collections only once', async () => {
    const { url, archiveRequests } = await squarespaceServer((request) => {
      if (request.pathname !== '/people' && request.pathname !== '/library') {
        // Neither half of the collection contract alone admits any items.
        return { body: JSON.stringify(request.pathname === '/about'
          ? { items: [{ urlId: 'fake', fullUrl: '/fake' }] }
          : { collection: { type: 10 } }) };
      }
      const second = request.searchParams.get('offset') === 'next';
      return { body: JSON.stringify({
        collection: { type: request.pathname === '/people' ? 7 : 12, typeName: 'collection' },
        items: [{ urlId: second ? 'two' : 'one', fullUrl: `${request.pathname}/${second ? 'two' : 'one'}` }],
        pagination: second ? {} : { nextPageOffset: 'next' },
      }) };
    }, ['/people', '/library', '/about', '/contact']);

    const inventory = await discover(url, {});
    for (const root of ['/people', '/library']) {
      expect(inventory.urls.map(({ url }) => url)).toEqual(expect.arrayContaining([
        `${url}${root}/one`, `${url}${root}/two`,
      ]));
      expect(archiveRequests.filter((request) => request.pathname === root).map((request) => request.searchParams.get('offset'))).toEqual([null, 'next']);
    }
    expect(inventory.collections).toEqual([
      { url: `${url}/people`, type: 7, typeName: 'collection', itemCount: 2 },
      { url: `${url}/library`, type: 12, typeName: 'collection', itemCount: 2 },
    ]);
    expect(inventory.urls.some(({ url }) => url.endsWith('/fake'))).toBe(false);
    for (const root of ['/about', '/contact']) {
      expect(archiveRequests.filter((request) => request.pathname === root)).toHaveLength(1);
    }
  });

  it('finds roots from navigation and item parents without expanding the feed frontier', async () => {
    const { url, archiveRequests } = await squarespaceServer((request) => ({
      body: JSON.stringify({
        collection: { type: 7 },
        items: [{ urlId: 'new', fullUrl: '/unprobed/new' }],
      }),
    }), ['/directory/people/known']);
    const inventory = await discover(url, {
      entryHtml: '<nav><a href="/library">Library</a><a href="/directory/people/known">People</a><a href="https://other.example/foreign">External</a></nav>',
    });
    expect(archiveRequests.map((request) => request.pathname)).toEqual(['/directory', '/directory/people', '/library']);
    expect(inventory.urls.filter(({ url: itemUrl }) => itemUrl === `${url}/unprobed/new`)).toHaveLength(1);
  });

  it('recovers paginated posts the sitemap omitted', async () => {
    const { url, archiveRequests } = await squarespaceServer((request) => {
      if (request.searchParams.get('offset') === '100') {
        return { body: JSON.stringify({ items: [{ urlId: 'two', fullUrl: '/blog/two' }] }) };
      }
      return { body: JSON.stringify({ items: [{ urlId: 'one', fullUrl: '/blog/one' }], pagination: { nextPageOffset: 100 } }) };
    });

    const inventory = await discover(url, {});

    expect(inventory.urls).toContainEqual({ url: `${url}/blog/one`, type: 'post' });
    expect(inventory.urls).toContainEqual({ url: `${url}/blog/two`, type: 'post' });
    expect(inventory.counts.post).toBe(2);
    expect(archiveRequests.filter((request) => request.pathname === '/blog').map((request) => request.searchParams.get('offset'))).toEqual([null, '100']);
  });

  it('deduplicates urlIds and terminates a non-advancing offset', async () => {
    const { url, archiveRequests } = await squarespaceServer(() => ({
      body: JSON.stringify({
        items: [{ urlId: 'one', fullUrl: '/blog/one' }],
        pagination: { nextPageOffset: 100 },
      }),
    }));

    const inventory = await discover(url, {});

    expect(inventory.urls.filter(({ url: discoveredUrl }) => discoveredUrl === `${url}/blog/one`)).toHaveLength(1);
    expect(archiveRequests.filter((request) => request.pathname === '/blog')).toHaveLength(2);
  });

  it('keeps sitemap discovery when the archive response is malformed or fails', async () => {
    const malformed = await squarespaceServer(() => ({ body: '{not json' }));
    const malformedInventory = await discover(malformed.url, {});
    expect(malformedInventory.urls).toContainEqual({ url: `${malformed.url}/blog`, type: 'page' });

    const failed = await squarespaceServer(() => ({ status: 503, body: 'unavailable' }));
    const failedInventory = await discover(failed.url, {});
    expect(failedInventory.urls).toContainEqual({ url: `${failed.url}/blog`, type: 'page' });
  });

  it('caps an archive walk at 200 pages', async () => {
    const { url, archiveRequests } = await squarespaceServer((request) => {
      const page = Number(request.searchParams.get('offset') || 0);
      return {
        body: JSON.stringify({
          items: [{ urlId: `post-${page}`, fullUrl: `/blog/${page}` }],
          pagination: { nextPageOffset: page + 1 },
        }),
      };
    });

    const inventory = await discover(url, {});

    expect(archiveRequests.filter((request) => request.pathname === '/blog')).toHaveLength(200);
    expect(inventory.urls.filter(({ type }) => type === 'post')).toHaveLength(200);
  });

  it('ignores invalid JSON shapes and invalid archive entries without losing sitemap routes', async () => {
    const empty = await squarespaceServer(() => ({ body: 'null' }));
    await expect(discover(empty.url, {})).resolves.toMatchObject({
      urls: expect.arrayContaining([{ url: `${empty.url}/about`, type: 'page' }]),
    });

    const mixed = await squarespaceServer(() => ({
      body: JSON.stringify({
        items: [null, 42, { urlId: 1, fullUrl: '/blog/bad' }, { urlId: 'valid', fullUrl: '/blog/valid' }],
        pagination: { nextPageOffset: {} },
      }),
    }));
    const inventory = await discover(mixed.url, {});
    expect(inventory.urls.filter(({ type }) => type === 'post')).toEqual([
      { url: `${mixed.url}/blog/valid`, type: 'post' },
    ]);
    expect(mixed.archiveRequests.filter((request) => request.pathname === '/blog')).toHaveLength(1);
  });
});
