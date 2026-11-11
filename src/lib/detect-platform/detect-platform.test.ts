import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { detect, detectFromDocument, detectFromUrl } from './detect-platform.js';
import { registerPlatform } from '../../platform/registry.js';
import { discoverWebflow } from '../../adapters/webflow/discover.js';

// Host-positive corpus for every built-in that declares host evidence; platforms
// that fingerprint custom domains only are covered by their source/header tests.
const hosts: [string, string][] = [
  ['squarespace.com', 'squarespace'], ['wix.com', 'wix'], ['alice.wixsite.com', 'wix'],
  ['shopify.com', 'shopify'], ['store.myshopify.com', 'shopify'], ['site.weebly.com', 'weebly'],
  ['webflow.com', 'webflow'], ['site.webflow.io', 'webflow'],
  ['site.ghost.io', 'ghost'], ['site.gamma.site', 'gamma'],
  ['site.substack.com', 'substack'], ['site.framer.website', 'framer'],
  ['site.framer.app', 'framer'], ['site.framer.ai', 'framer'],
  ['site.lovable.app', 'lovable'], ['site.lovable.dev', 'lovable'],
  ['medium.com', 'medium'], ['soloist.ai', 'soloist'], ['atom.bio', 'atombio'],
  ['site.carrd.co', 'carrd'], ['sites.google.com', 'google-sites'],
  ['alice.blogspot.com', 'blogger'], ['alice.blogspot.co.uk', 'blogger'],
];

describe('host-only platform detection', () => {
  it.each([
    ...hosts.map(([host, platform]) => [`https://${host}/page?ref=other`, platform]),
    ...hosts.map(([host, platform]) => [`https://${host.toUpperCase()}.:443/`, platform]),
    ...hosts.map(([host]) => [`https://acme.com/?ref=${host}`, null]),
    ...hosts.map(([host]) => [`https://acme.com/${host}/`, null]),
    ...hosts.map(([host]) => [`https://${host}.evil.test/`, null]),
    ...['notwix.com', 'notshopify.com', 'notweebly.com', 'notsquarespace.com',
      'notwebflow.com', 'notlovable.app'].map(host => [`https://${host}/`, null]),
  ])('%s → %s', (url, platform) => {
    expect(detectFromUrl(url!)).toBe(platform);
  });
});

const ids = ['detection-first', 'detection-second'];

it('breaks equal-confidence ties by registration order across all evidence tiers', async () => {
  for (const id of ids) registerPlatform({
    id,
    discover: async () => ({}),
    detection: {
      hosts: [id === ids[0] ? 'first.test' : 'second.test'],
      httpSignals: [{ header: 'x-tie', value: 'yes', signal: id }],
      sourceSignals: [{ pattern: /tie-marker/g, signal: id }],
    },
  });
  expect(detectFromDocument('https://second.test', new Headers({ 'x-tie': 'yes' }), '').platform).toBe(ids[0]);
  expect(detectFromDocument('https://custom.test', new Headers({ 'x-tie': 'yes' }), '').platform).toBe(ids[0]);
  for (let i = 0; i < 2; i++) {
    expect(detectFromDocument('https://custom.test', new Headers(), 'tie-marker').platform).toBe(ids[0]);
  }
  expect(detectFromDocument('https://second.test', new Headers(), 'tie-marker').platform).toBe(ids[1]);
  expect((await detect('https://second.test', { headers: new Headers({ 'x-tie': 'yes' }), html: '' })).platform).toBe(ids[0]);
});

it('requests the entry document once for acquisition + detection + discovery', async () => {
  let entryRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/') {
      entryRequests++;
      response.setHeader('content-type', 'text/html');
      response.end('<html><head><title>Fixture</title><meta name="generator" content="Webflow"></head><body data-wf-domain="fixture.test"></body></html>');
    } else if (request.url === '/_emdash/admin') {
      response.writeHead(302, { location: '/_emdash/admin/login' }).end();
    } else if (request.url === '/sitemap.xml') {
      // Five routes keep discovery off its rendered SPA pass, which navigates
      // a browser rather than reusing the fetched entry document.
      response.setHeader('content-type', 'application/xml');
      response.end(`<urlset>${['a', 'b', 'c', 'd', 'e'].map(path => `<url><loc>http://${request.headers.host}/${path}</loc></url>`).join('')}</urlset>`);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/`;
    const response = await fetch(url);
    const entryHtml = await response.text();
    expect((await detect(url, { headers: response.headers, html: entryHtml })).platform).toBe('webflow');
    const inventory = await discoverWebflow(url, { entryHtml });
    expect(inventory.siteMeta.title).toBe('Fixture');
    expect(entryRequests).toBe(1);
    expect((await detect(url, { headers: new Headers(), html: '' })).platform).toBe('emdash');
    expect(entryRequests).toBe(1); // fallback probes must not refetch the document
    await discoverWebflow(url, { entryHtml: '' });
    expect(entryRequests).toBe(1); // an explicitly empty entry is still reusable
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
