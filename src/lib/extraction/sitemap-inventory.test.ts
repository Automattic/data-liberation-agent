import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { fetchSitemapWithDiagnostics } from './sitemap.js';
import { inspectSource } from '../inspect.js';

it.each(['robots union', 'gzip download', 'gzip encoding', 'index', 'rss', 'atom', 'common feed'])(
  'unifies discovery and inspection: %s', async (scenario) => {
    let origin = '';
    const requests: string[] = [];
    const pages = ['/', '/one', '/two', '/three', '/four'];
    const urlset = (paths: string[]) => `<urlset>${paths.map(path => `<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`;
    const server = createServer((req, res) => {
      const path = req.url!;
      requests.push(path);
      if (path === '/robots.txt') {
        return void res.end(`Sitemap: ${origin}/primary\n${['robots union', 'index'].includes(scenario) ? `Sitemap: ${origin}/secondary\n` : ''}`);
      }
      if (path === '/primary') {
        if (scenario.startsWith('gzip')) {
          return void res.end(`<sitemapindex><sitemap><loc>${origin}/child.xml.gz</loc></sitemap><sitemap><loc>${origin}/attachment-sitemap.xml.gz</loc></sitemap></sitemapindex>`);
        }
        return void res.end(urlset(pages));
      }
      if (path === '/extensionless?part=1') return void res.end(urlset([...pages, '/extra']));
      if (path === '/child.xml.gz') {
        if (scenario === 'gzip encoding') res.setHeader('content-encoding', 'gzip');
        return void res.end(gzipSync(urlset([...pages, '/extra'])));
      }
      if (path === '/secondary') return void res.end(scenario === 'index'
        ? `<sitemapindex><sitemap><loc>${origin}/extensionless?part=1</loc></sitemap></sitemapindex>`
        : urlset(['/extra', '/one', '/?attachment_id=2']));
      if (path === '/news-feed' || (path === '/feed' && scenario === 'common feed')) {
        res.setHeader('content-type', 'application/xml');
        return void res.end(scenario === 'atom'
          ? `<feed xmlns="http://www.w3.org/2005/Atom"><entry><link rel="alternate" href="${origin}/extra"/><link rel="enclosure" href="${origin}/ignored"/></entry></feed>`
          : `<rss><channel><item><link>${origin}/extra</link></item><item><link>${origin}/extra</link></item><item><link>https://other.test/foreign</link></item><item><link>${origin}/?attachment_id=2</link></item></channel></rss>`);
      }
      if (pages.includes(path) || path === '/extra') {
        res.setHeader('content-type', 'text/html');
        return void res.end(`<title>Fixture</title><a href="/one">One</a>${path === '/' && ['rss', 'atom'].includes(scenario) ? `<link rel="alternate" type="application/${scenario}+xml" href="/news-feed">` : ''}`);
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://localtest.me:${(server.address() as { port: number }).port}`;
    try {
      const inventory = await fetchSitemapWithDiagnostics(origin + '/');
      expect(inventory.urls).toEqual([...pages, '/extra'].map(path => origin + path));
      expect(requests).not.toContain('/attachment-sitemap.xml.gz');
      if (['rss', 'atom', 'common feed'].includes(scenario)) {
        expect(inventory.diagnostics).toContainEqual(expect.objectContaining({ code: 'feed_discovered', reason: '1 new same-origin routes from feed' }));
      }
      const inspection = await inspectSource(origin + '/', { rendered: false, discoveryLimit: 50 });
      expect(inspection.coverage.discovery).toMatchObject({ routes: inventory.urls.length, truncated: false });
      expect(inspection.issues.some(issue => issue.code === 'nested-sitemap-unvisited')).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  },
);
