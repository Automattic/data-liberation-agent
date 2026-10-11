import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { inspectSource } from './inspect.js';
import { sourceComplexity, type RenderedInspection } from './inspect-rendered.js';
import { registerHost, unregisterHost } from '../platform/host.js';

let server: Server;
let posts = 0;
async function source(html: string) {
  posts = 0;
  server = createServer((req, res) => {
    if (req.method === 'POST') posts++;
    res.setHeader('content-type', req.url === '/sitemap.xml' ? 'application/xml' : 'text/html');
    res.end(req.url === '/sitemap.xml' ? '<urlset/>' : html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://localtest.me:${(server.address() as { port: number }).port}/`;
}
afterEach(async () => { server?.closeAllConnections(); if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

it('distinguishes a rendered simple source from a JS-created booking app', async () => {
  const url = await source('<!doctype html><title>Wix.com</title><main><h1>Welcome</h1></main>');
  const simple = await inspectSource(url, { sampleLimit: 1 });
  expect(simple.complexity.band).toBe('simple');
  expect(simple.rendered.samples[0].elements).toBeGreaterThan(3);
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    res.setHeader('x-wix-request-id', 'fixture');
    res.setHeader('content-type', req.url === '/sitemap.xml' ? 'application/xml' : 'text/html');
    res.end(req.url === '/sitemap.xml' ? '<urlset/>' : '<meta name="generator" content="Wix.com"><main></main><script>document.querySelector("main").innerHTML = `<div data-hook="booking-calendar"><form><input type="password"></form></div>`</script>');
  });
  const complex = await inspectSource(url, { sampleLimit: 1 });
  expect(complex.samples[0].observations.forms).toBe(0);
  expect(complex.rendered.samples[0].counts.forms).toBe(1);
  expect(complex.complexity.band).toBe('complex');
  expect(complex.rendered.samples[0].capabilities).toContainEqual(expect.objectContaining({ capability: 'booking' }));
}, 30_000);

it('reports where a capability was observed, and refuses to look decided when the sample was not', async () => {
  const url = await source('<main><h1>Contact</h1><form id="enquiry" class="contact-form stacked"><input name="email"></form><iframe id="map" src="about:blank"></iframe></main>');
  const result = await inspectSource(url, { sampleLimit: 1 });
  expect(result.capabilityVocabulary).toEqual({
    schema: 'data-liberation/source-capability-vocabulary/v1',
    capabilities: ['booking', 'commerce', 'dialogs', 'embeds', 'forms', 'media', 'membership', 'navigation'],
  });
  const sample = result.rendered.samples[0];
  expect(sample.url).toBe(url);
  const forms = sample.capabilities.find((finding) => finding.capability === 'forms');
  expect(forms).toMatchObject({ count: 1, selector: 'form' });
  expect(forms?.locators).toEqual(['form#enquiry.contact-form.stacked']);
  expect(sample.capabilities.find((finding) => finding.capability === 'embeds')?.locators).toEqual(['iframe#map']);
  // Every published capability name is one a destination can declare coverage against.
  for (const finding of sample.capabilities) expect(result.capabilityVocabulary.capabilities).toContain(finding.capability);
  expect(result.complexity.confidence).toBe('bounded-sample');
  expect(sample.unknowns).toEqual([]);

  // An incomplete sample is not a quiet 'simple': the band withholds instead.
  const truncated = await inspectSource(url, { rendered: false, sampleLimit: 1 });
  expect(truncated.complexity.band).toBe('unknown');
  expect(truncated.complexity.confidence).toBe('incomplete');
  expect(truncated.capabilityVocabulary.capabilities).toEqual(result.capabilityVocabulary.capabilities);
}, 45_000);

it('reports a bounded sample through the real inspection path', async () => {
  // Three routes discovered, one sampled: the bound is doing its job. The band
  // withholds because the view is partial; confidence stays because the sample
  // that was declared rendered cleanly.
  const url = await source('<main><h1>Shop</h1><p>One page of copy.</p></main><nav><a href="/about">About</a><a href="/contact">Contact</a></nav>');
  const result = await inspectSource(url, { sampleLimit: 1 });

  expect(result.coverage.discovery.routes).toBe(3);
  expect(result.coverage.sampling.truncated).toBe(true);
  expect(result.rendered.succeeded).toBe(1);
  expect(result.rendered.samples[0].unknowns).toEqual([]);
  expect(result.complexity.band).toBe('unknown');
  expect(result.complexity.confidence).toBe('bounded-sample');
}, 45_000);

it('never samples a declared media route, even with budget left after rendering', async () => {
  // The append after rendering walks the whole inventory to use up remaining
  // budget. A media URL the sitemap declared never enters that inventory, so it
  // is counted rather than appended; this loop is unreachable without rendering.
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname;
    const port = (server.address() as { port: number }).port;
    if (path === '/sitemap.xml') {
      res.setHeader('content-type', 'application/xml');
      res.end(`<urlset><url><loc>http://localtest.me:${port}/gallery/hero.jpg</loc></url></urlset>`);
      return;
    }
    if (path.endsWith('.jpg')) { res.setHeader('content-type', 'image/jpeg'); res.end(Buffer.from([0xff, 0xd8, 0xff])); return; }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Solo</title><main><p>One page.</p></main>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://localtest.me:${(server.address() as { port: number }).port}/`;

  // Budget far exceeds the one document route, so the append path runs.
  const result = await inspectSource(url, { discoveryLimit: 50, sampleLimit: 5 });

  expect(result.routes.types).toEqual({ homepage: 1 });
  expect(result.coverage.media).toMatchObject({ discovered: 1, truncated: false });
  expect(result.samples.some((sample) => sample.url.endsWith('.jpg'))).toBe(false);
  expect(result.issues.some((issue) => issue.code === 'sample-non-html')).toBe(false);
  expect(result.rendered.succeeded).toBe(1);
}, 45_000);

it('reports truncation from the inventory it ended with, not the one it started from', async () => {
  // Rendering reveals routes the HTTP lane never saw, so a document count taken
  // before that would report a capped selection as complete.
  const hidden = Array.from({ length: 9 }, (unused, index) => `<a href="/p${index}">p${index}</a>`).join('');
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname;
    if (path === '/sitemap.xml') { res.statusCode = 404; res.end('x'); return; }
    res.setHeader('content-type', 'text/html');
    // The links live outside <nav>, so only the rendered lane collects them.
    res.end(`<!doctype html><title>Hub</title><main><p>Body.</p>${path === '/' ? hidden : ''}</main>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://localtest.me:${(server.address() as { port: number }).port}/`;

  const result = await inspectSource(url, { discoveryLimit: 50, sampleLimit: 3 });

  expect(result.coverage.discovery.routes).toBeGreaterThan(3);
  expect(result.coverage.sampling.truncated).toBe(true);
  expect(result.coverage.sampling.complete).toBe(false);
}, 45_000);

it('spends the rendered navigation budget on pages, not on linked media', async () => {
  // The in-page inventory caps at 100 links. A gallery offers more media links
  // than that, so filtering after the cap would leave the real menu
  // undiscovered on exactly the sites this exists to read.
  const media = Array.from({ length: 120 }, (unused, index) => `<a href="/uploads/${index}.jpg">p${index}</a>`).join('');
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname;
    if (path === '/sitemap.xml') { res.statusCode = 404; res.end('x'); return; }
    if (path.endsWith('.jpg')) { res.setHeader('content-type', 'image/jpeg'); res.end(Buffer.from([0xff, 0xd8, 0xff])); return; }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>Gallery</title><main>${media}</main><footer><nav><a href="/about">About</a><a href="/pricing">Pricing</a><a href="/contact">Contact</a></nav></footer>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://localtest.me:${(server.address() as { port: number }).port}/`;

  const result = await inspectSource(url, { discoveryLimit: 50, sampleLimit: 10 });

  for (const page of ['/about', '/pricing', '/contact']) {
    expect(result.samples.some((sample) => sample.url.endsWith(page)), page).toBe(true);
  }
  expect(result.coverage.discovery.truncated).toBe(false);
  expect(result.coverage.sampling.complete).toBe(true);
  // The exclusion is counted, not silent: the entry page linked 120 media files.
  expect(result.rendered.samples[0].mediaLinks).toBe(120);
  expect(result.rendered.samples[0].navigation.some((href) => href.endsWith('.jpg'))).toBe(false);
  // Coverage sums the per-sample counts; every fixture page carries the gallery.
  expect(result.coverage.media.renderedLinks).toBe(120 * result.rendered.succeeded);
  expect(result.complexity.band).not.toBe('unknown');
  expect(result.complexity.confidence).toBe('bounded-sample');
}, 45_000);

it('withholds the band when sampling was bounded, without lowering confidence in the sample that completed', () => {
  // docs/inspection.md: `unknown` covers "truncated discovery/sampling", while
  // `bounded-sample` means "the declared sample completed" and lists unsampled
  // routes among the things that remain explicitly unknown. Sampling fewer
  // routes than were discovered is the bound working as declared.
  const sample = {
    url: 'https://example.test/', elements: 600, textCharacters: 1200,
    counts: { forms: 0, links: 4, images: 2, videos: 0, frames: 0, dialogs: 0 },
    capabilities: [], excluded: [], navigation: [], mediaLinks: 0, requests: 3, bytes: 4096,
    limited: false, unknowns: [],
  } as unknown as RenderedInspection;

  const bounded = sourceComplexity([sample], true, false);
  expect(bounded.band).toBe('unknown');
  expect(bounded.observedBand).toBe('moderate');
  expect(bounded.confidence).toBe('bounded-sample');

  // A sample that was declared and did not complete is still incomplete.
  expect(sourceComplexity([sample], true, true).confidence).toBe('incomplete');

  // So is one whose own resources were limited, or that reported unknowns.
  expect(sourceComplexity([{ ...sample, limited: true }], false, false).confidence).toBe('incomplete');
  expect(sourceComplexity([{ ...sample, unknowns: ['blocked'] } as unknown as RenderedInspection], false, false).confidence).toBe('incomplete');

  // Unchanged when nothing was bounded at all.
  const complete = sourceComplexity([sample], false, false);
  expect(complete.band).toBe('moderate');
  expect(complete.confidence).toBe('bounded-sample');
});

it('attributes a host badge to the host instead of to the site it is serving', async () => {
  const badge = '<main><h1>Brochure</h1><p>One page, no app.</p></main><script>const frame = document.createElement("iframe"); frame.id = "hud-badge"; frame.title = "Powered by Fixture Host"; frame.srcdoc = "<p>badge</p>"; frame.style.position = "fixed"; document.body.append(frame);</script>';
  posts = 0;
  server = createServer((req, res) => {
    res.setHeader('x-fixture-host-id', 'edge-1');
    res.setHeader('content-type', req.url === '/sitemap.xml' ? 'application/xml' : 'text/html');
    res.end(req.url === '/sitemap.xml' ? '<urlset/>' : badge);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://localtest.me:${(server.address() as { port: number }).port}/`;

  const unattributed = await inspectSource(url, { sampleLimit: 1 });
  expect(unattributed.source.hosts).toEqual([]);
  expect(unattributed.rendered.samples[0].counts.frames).toBe(1);
  expect(unattributed.complexity.factors.map((factor) => factor.code)).toContain('embeds');

  registerHost({
    id: 'fixture-host',
    detection: { httpSignals: [{ header: 'x-fixture-host-id', signal: 'fixture host request identifier' }] },
    residue: [{ selector: 'iframe#hud-badge', evidence: 'fixture host badge frame' }],
  });
  try {
    const attributed = await inspectSource(url, { sampleLimit: 1 });
    expect(attributed.source.hosts).toEqual([{ id: 'fixture-host', evidence: ['fixture host request identifier'] }]);
    expect(attributed.rendered.samples[0].counts.frames).toBe(0);
    expect(attributed.rendered.samples[0].excluded).toEqual([
      { host: 'fixture-host', selector: 'iframe#hud-badge', evidence: 'fixture host badge frame', matched: 1, elements: 1 },
    ]);
    expect(attributed.complexity.factors.map((factor) => factor.code)).not.toContain('embeds');
    expect(attributed.complexity.band).toBe('simple');
    expect(attributed.rendered.samples[0].elements).toBe(unattributed.rendered.samples[0].elements - 1);
    // Recognizing a host is not a statement that the rest of the page is host-owned.
    expect(attributed.rendered.samples[0].counts.links).toBe(unattributed.rendered.samples[0].counts.links);
    expect(attributed.rendered.samples[0].textCharacters).toBe(unattributed.rendered.samples[0].textCharacters);
  } finally {
    unregisterHost('fixture-host');
  }
}, 45_000);

it('keeps authored content when a host rule is registered but that host is not serving the page', async () => {
  const url = await source('<main><h1>Studio</h1><iframe id="hud-badge" title="Authored map" src="about:blank"></iframe><form><input name="q"></form></main>');
  registerHost({
    id: 'absent-host',
    detection: { httpSignals: [{ header: 'x-absent-host', signal: 'absent host header' }] },
    residue: [{ selector: 'iframe#hud-badge', evidence: 'absent host badge frame' }],
  });
  try {
    const result = await inspectSource(url, { sampleLimit: 1 });
    expect(result.source.hosts).toEqual([]);
    expect(result.rendered.samples[0].excluded).toEqual([]);
    expect(result.rendered.samples[0].counts.frames).toBe(1);
    expect(result.complexity.factors.map((factor) => factor.code)).toContain('embeds');
  } finally {
    unregisterHost('absent-host');
  }
}, 45_000);

it('samples JS-discovered navigation and reports backend requests as unknown, never easy', async () => {
  const url = await source('<main>Hello</main><script>document.body.insertAdjacentHTML("beforeend", `<nav><a href="/runtime">Runtime</a></nav>`); fetch("/submit", {method:"POST"});</script>');
  const result = await inspectSource(url, { sampleLimit: 2 });
  expect(result.samples.map((s) => s.url)).toContain(`${url}runtime`);
  expect(result.complexity.band).toBe('unknown');
  expect(result.rendered.samples[0].unknowns).toContain('Non-GET requests were blocked');
  expect(posts).toBe(0);
}, 30_000);

it('fetches a rendered sample\'s assets with browser-like connection concurrency per origin', async () => {
  // Every rendered request is fetched by Node, not by Chromium, so Chromium's
  // own per-host connection limit never applies. A page with many stylesheets
  // used to open one connection per stylesheet at once; servers with a
  // per-client connection limit reset them and then refuse the client for
  // minutes, which also failed the capture that runs after inspection.
  const stylesheets = 24;
  const links = Array.from({ length: stylesheets }, (_, index) => `<link rel="stylesheet" href="/style-${index}.css">`).join('');
  const url = await source(`<!doctype html><head>${links}</head><main><h1>Many stylesheets</h1></main>`);
  let open = 0;
  let peak = 0;
  let served = 0;
  server.on('connection', (socket) => {
    peak = Math.max(peak, ++open);
    socket.on('close', () => { open--; });
  });
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (req.url?.endsWith('.css')) {
      setTimeout(() => {
        served++;
        res.setHeader('content-type', 'text/css');
        res.end('main{color:#111}');
      }, 50);
      return;
    }
    res.setHeader('content-type', req.url === '/sitemap.xml' ? 'application/xml' : 'text/html');
    res.end(req.url === '/sitemap.xml' ? '<urlset/>' : `<!doctype html><head>${links}</head><main><h1>Many stylesheets</h1></main>`);
  });
  const result = await inspectSource(url, { sampleLimit: 1 });
  expect(result.rendered.succeeded).toBe(1);
  expect(served).toBe(stylesheets);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(6);
}, 30_000);

it('closes timed-out browser samples and keeps missing evidence unknown', async () => {
  const url = await source('<main>Visible</main>');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (req.url === '/slow.js') return;
    res.setHeader('content-type', req.url === '/sitemap.xml' ? 'application/xml' : 'text/html');
    res.end(req.url === '/sitemap.xml' ? '<urlset/>' : '<main>Visible</main><script src="/slow.js"></script>');
  });
  const result = await inspectSource(url, { overallTimeoutMs: 3000, requestTimeoutMs: 1000 });
  expect(result.complexity.band).toBe('unknown');
  expect(result.rendered.succeeded).toBe(0);
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'rendered-sample-failed' }));
  expect(result.timing.durationMs).toBeLessThan(4500);
}, 10_000);
