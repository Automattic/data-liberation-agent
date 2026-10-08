import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSitemapWithDiagnostics } from './sitemap.js';
import { discoverWebflow } from '../../adapters/webflow/discover.js';

// Transport real bodies/statuses locally without disabling the URL guard.
const origin = 'http://fixture.test';
async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not start');
  const transport = globalThis.fetch;
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== origin) throw new Error(`Unexpected network request: ${url}`);
    requests.push(url.pathname + url.search);
    url.hostname = '127.0.0.1';
    url.port = String(address.port);
    return transport(url, init);
  }));
  return { requests, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('bounded linked-page fallback', () => {
  it('closes deeper raw HTML links, cycles and aliases without folding genuine routes', async () => {
    const documents: Record<string, string[]> = {
      '/': ['/blog', '/group//entry', '/group/entry', '/edition?lang=en', '/edition?lang=fr', '/blog/#top', 'https://external.test/page', '/logo.png', '/cart', 'mailto:a@b.test'],
      '/blog': ['/legal', '/post/deep', '/'],
      '/legal': ['/blog/', '/blog#again'],
      '/post/deep': ['/post/deeper'],
      '/post/deeper': ['/legal'],
      '/group//entry': [], '/group/entry': [], '/edition?lang=en': [], '/edition?lang=fr': [], '/cart': [],
    };
    const f = await fixture((req, res) => {
      const links = documents[req.url ?? ''];
      res.statusCode = links ? 200 : 404;
      res.setHeader('content-type', 'text/html');
      res.end(links?.map(href => `<a href="${href}">link</a>`).join('') ?? 'missing');
    });
    try {
      const result = await fetchSitemapWithDiagnostics(`${origin}/`);
      // Platform-looking path names are candidates; responses decide their outcome.
      expect(result.urls).toEqual(['/blog', '/group//entry', '/group/entry', '/edition?lang=en', '/edition?lang=fr', '/cart', '/legal', '/post/deep', '/', '/post/deeper'].map(path => origin + path));
      expect(f.requests.slice(3)).toEqual(['/', '/blog', '/group//entry', '/group/entry', '/edition?lang=en', '/edition?lang=fr', '/cart', '/legal', '/post/deep', '/post/deeper']);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'sitemap_absent', reason: expect.stringContaining('HTTP 404') }),
        expect.objectContaining({ code: 'fallback_link_closure', reason: expect.stringContaining('10/100 HTTP requests') }),
      ]);
    } finally { await f.close(); }
  });

  it('traverses thin sitemap seeds even when they are not linked from the entry', async () => {
    const f = await fixture((req, res) => {
      if (req.url === '/sitemap.xml') return void res.end(`<urlset><url><loc>${origin}/seed</loc></url></urlset>`);
      const links: Record<string, string> = { '/': '<a href="/home-link">home</a>', '/seed': '<a href="/seed-child">child</a>', '/home-link': '', '/seed-child': '' };
      if (!(req.url! in links)) res.statusCode = 404;
      res.end(links[req.url!] ?? 'missing');
    });
    try { expect((await fetchSitemapWithDiagnostics(origin)).urls).toEqual(['/seed', '/home-link', '/seed-child'].map(path => origin + path)); }
    finally { await f.close(); }
  });

  it('retains advertised error routes and reports HTTP, non-page, body and redirect omissions', async () => {
    const f = await fixture((req, res) => {
      if (req.url === '/') return void res.end('<a href="/missing">missing</a><a href="/data">data</a><a href="/large">large</a><a href="/escape">escape</a><a href="/private">private</a><a href="/alias">alias</a><a href="/target/">target</a><a href="/second-alias">second alias</a>');
      if (req.url === '/data') { res.setHeader('content-type', 'application/json'); return void res.end('{"a":"/invented"}'); }
      if (req.url === '/large') { res.setHeader('content-length', 3 * 1024 * 1024); return void res.end(); }
      if (['/escape', '/private', '/alias', '/second-alias'].includes(req.url ?? '')) {
        res.statusCode = 302;
        res.setHeader('location', req.url === '/escape' ? 'http://external.test/page' : req.url === '/private' ? 'http://127.0.0.1/private' : '/target/');
        return void res.end();
      }
      if (req.url === '/target/') return void res.end('<a href="child">child</a>');
      if (req.url === '/target/child') return void res.end('<p>child</p>');
      res.statusCode = 404; res.end('missing');
    });
    try {
      const inventory = await discoverWebflow(origin, {});
      expect(inventory.urls.map(row => row.url)).toContain(`${origin}/missing`);
      expect(inventory.urls.map(row => row.url)).toContain(`${origin}/target/child`);
      expect(inventory.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'fallback_fetch_omitted', url: `${origin}/missing`, reason: 'HTTP 404' }),
        expect.objectContaining({ url: `${origin}/data`, reason: 'non-HTML response (application/json)' }),
        expect.objectContaining({ url: `${origin}/large`, reason: expect.stringContaining('exceeds max') }),
        expect.objectContaining({ url: `${origin}/escape`, reason: 'redirect leaves the entry origin' }),
        expect.objectContaining({ url: `${origin}/private`, reason: expect.stringContaining('not allowed') }),
        expect.objectContaining({ code: 'fallback_link_coverage' }),
      ]));
      expect(f.requests.filter(path => path === '/target/')).toHaveLength(1);
      expect(inventory.diagnostics?.some(row => row.url === `${origin}/second-alias`)).toBe(false);
    } finally { await f.close(); }
  });

  it('deterministically names the retained frontier omitted by the request budget', async () => {
    const f = await fixture((req, res) => {
      if (req.url === '/') return void res.end(Array.from({ length: 102 }, (_, i) => `<a href="/page-${i}">p</a>`).join(''));
      if (req.url?.startsWith('/page-')) return void res.end('<a href="/">cycle</a>');
      res.statusCode = 404; res.end('missing');
    });
    try {
      const result = await fetchSitemapWithDiagnostics(origin);
      expect(result.urls).toHaveLength(103);
      expect(f.requests.slice(3)).toHaveLength(100);
      expect(result.diagnostics.filter(row => row.code === 'fallback_budget_omitted')).toEqual([99, 100, 101].map(i => ({ code: 'fallback_budget_omitted', url: `${origin}/page-${i}`, reason: 'request budget exhausted (100)' })));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'fallback_link_coverage', reason: expect.stringContaining('3 queued documents unvisited') }));
    } finally { await f.close(); }
  });

  it('caps frontier retention separately from fetches', async () => {
    const f = await fixture((req, res) => {
      if (req.url === '/') return void res.end(Array.from({ length: 1002 }, (_, i) => `<a href="/page-${i}">p</a>`).join(''));
      if (req.url?.startsWith('/page-')) return void res.end('page');
      res.statusCode = 404; res.end();
    });
    try {
      const result = await fetchSitemapWithDiagnostics(origin);
      expect(result.urls).toHaveLength(1000);
      expect(result.diagnostics).toContainEqual({ code: 'fallback_route_budget_omitted', url: `${origin}/page-1000`, reason: '2 link occurrences not retained; route limit 1000' });
      expect(result.diagnostics.filter(row => row.code === 'fallback_budget_omitted')).toHaveLength(901);
    } finally { await f.close(); }
  });

  it('caps streamed bodies without Content-Length and never parses their links', async () => {
    const f = await fixture((req, res) => {
      if (req.url === '/') return void res.end('<a href="/stream">stream</a>');
      if (req.url === '/stream') {
        res.setHeader('content-type', 'text/html');
        res.write('<a href="/unread">unread</a>');
        for (let i = 0; i < 33; i++) res.write('x'.repeat(65536));
        return void res.end();
      }
      res.statusCode = 404; res.end();
    });
    try {
      const result = await fetchSitemapWithDiagnostics(origin);
      expect(result.urls).toEqual([`${origin}/stream`]);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'fallback_fetch_omitted', url: `${origin}/stream`, reason: expect.stringContaining('(streamed)') }));
      expect(f.requests).not.toContain('/unread');
    } finally { await f.close(); }
  });

  it('names unvisited documents when the shared deadline aborts a fetch', async () => {
    const deadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 60_000 ? deadline.signal : timeout(ms));
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input); requests.push(url);
      if (url === `${origin}/`) return new Response('<a href="/slow">slow</a><a href="/next">next</a>', { headers: { 'content-type': 'text/html' } });
      if (url === `${origin}/slow`) { deadline.abort(new Error('fixture deadline')); throw deadline.signal.reason; }
      return new Response('', { status: 404 });
    }));
    const result = await fetchSitemapWithDiagnostics(origin);
    expect(requests).not.toContain(`${origin}/next`);
    expect(result.diagnostics).toContainEqual({ code: 'fallback_budget_omitted', url: `${origin}/next`, reason: 'time budget exhausted (60000 ms)' });
    expect(result.diagnostics).toContainEqual({ code: 'fallback_fetch_omitted', url: `${origin}/slow`, reason: 'fixture deadline' });
    expect(result.diagnostics.some(row => row.code === 'fallback_link_closure')).toBe(false);
  });

  it.each([404, 200])('does not render an unsuccessful or non-HTML entry (%s)', async status => {
    const launch = vi.spyOn(chromium, 'launch').mockRejectedValue(new Error('Rejected entry must not render'));
    const f = await fixture((_req, res) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end('<a href="/not-a-document">not a document</a>');
    });
    try {
      const result = await fetchSitemapWithDiagnostics(origin);
      expect(launch).not.toHaveBeenCalled();
      expect(result.urls).toEqual([]);
      expect(result.diagnostics.some(row => row.code === 'fallback_fetch_omitted')).toBe(true);
    } finally { await f.close(); }
  });

  it('retains rendered shell links while blocking private browser dependencies', async () => {
    let port = 0;
    let privateRequests = 0;
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      if (req.url === '/private-image') {
        privateRequests++;
        res.end('private');
      } else if (req.url === '/') {
        res.end(`<div id="root"></div><img src="http://127.0.0.1:${port}/private-image"><script>document.querySelector('#root').innerHTML='<a href="/child">Child</a>';</script>`);
      } else if (req.url === '/child') res.end('<p>Child</p>');
      else { res.statusCode = 404; res.end('missing'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    const publicOrigin = `http://localtest.me:${port}`;
    try {
      const result = await fetchSitemapWithDiagnostics(publicOrigin);
      expect(result.urls).toEqual([`${publicOrigin}/child`]);
      expect(privateRequests).toBe(0);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'fallback_link_closure', reason: expect.stringContaining('entry rendering attempted: true') }));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
