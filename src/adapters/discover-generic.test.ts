import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { discoverWebflow } from './webflow/discover.js';
import { discoverWeebly } from './weebly/discover.js';
import { discover as discoverGoDaddy } from './godaddy-wm/discover.js';
import { discoverGeneric } from './discover-generic.js';
import { SHIFT_JIS_TITLE } from '../lib/shift-jis-fixture.js';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()) ?? resolve());
  server = undefined;
});

async function listen(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

// One browser pass covers both regressions inherited by all former copies.
it('gives Webflow charset decoding and rendered SPA route discovery', async () => {
  const origin = await listen((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(Buffer.concat([
      Buffer.from('<meta charset="Shift_JIS"><title>'), SHIFT_JIS_TITLE,
      Buffer.from('</title><div id="root"></div><script>document.getElementById("root").innerHTML = \'<nav><a href="/rendered">Rendered</a></nav>\';</script>'),
    ]));
  });
  const inventory = await discoverWebflow(origin, {});
  expect(inventory.siteMeta).toEqual({ title: 'キューティー★コンプレックス' });
  expect(inventory.urls).toContainEqual({ url: `${origin}/rendered` });
  expect(Object.keys(inventory).sort()).toEqual(['diagnostics', 'siteMeta', 'urls']);
});

it.each([
  ['Weebly', discoverWeebly, '/sitemap.xml'],
  ['GoDaddy', discoverGoDaddy, '/sitemap.website.xml'],
] as const)('preserves %s sitemap routes and adds chrome links', async (_name, discover, sitemapPath) => {
  const paths = ['/', '/about', '/services', '/contact', '/news'];
  const origin = await listen((request, response) => {
    const base = `http://${request.headers.host}`;
    if (request.url === sitemapPath || request.url === '/sitemap.blog.xml') {
      response.setHeader('content-type', 'application/xml');
      const routes = request.url === '/sitemap.blog.xml' ? ['/news/f/story'] : paths;
      response.end(`<urlset>${routes.map(path => `<url><loc>${base}${path}</loc></url>`).join('')}</urlset>`);
    } else if (request.url === '/') {
      response.end('<title>Fixture</title><div class="chrome"><a href="/legal">Legal</a></div>');
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  const inventory = await discover(`${origin}/`, {});
  // The old copies returned exactly the sitemap leaves (GoDaddy: both maps).
  const previous = [...paths, ...(_name === 'GoDaddy' ? ['/news/f/story'] : [])];
  expect(inventory.urls.map(entry => entry.url)).toEqual([...previous, '/legal'].map(path => `${origin}${path}`));
});

it('bounds platform seeds to same-origin page links and normalizes duplicates', async () => {
  const origin = await listen((request, response) => {
    const base = `http://${request.headers.host}`;
    response.end(request.url === '/sitemap.xml'
      ? `<urlset>${['/', '/a', '/b', '/c', '/d'].map(path => `<url><loc>${base}${path}</loc></url>`).join('')}</urlset>`
      : '<title>Seeds</title>');
  });
  const inventory = await discoverGeneric(origin, {}, {
    seeds: html => html.includes('Seeds') ? ['/extra', '/extra/', 'https://elsewhere.test/no', '/asset.pdf'] : [],
  });
  expect(inventory.urls.map(entry => entry.url)).toEqual(['/', '/a', '/b', '/c', '/d', '/extra'].map(path => `${origin}${path}`));
});
