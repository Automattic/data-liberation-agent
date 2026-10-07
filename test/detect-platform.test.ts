import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { findAdapter } from '../src/adapters/index.js';
import { detectFromDocument, detectFromUrl, detectFromHttp } from '../src/lib/detect-platform/index.js';

describe('detectFromUrl (heuristics)', () => {
  // Every URL pattern the table claims, asserted against the one detector that
  // owns them. Adapters used to carry a duplicate copy of these regexes behind
  // an uncalled `PlatformAdapter.detect`; this is where that coverage lives now.
  it.each([
    ['https://mysite.wixsite.com/blog', 'wix'],
    ['https://www.wix.com/mysite', 'wix'],
    ['https://mysite.squarespace.com', 'squarespace'],
    ['https://www.squarespace.com/mysite', 'squarespace'],
    ['https://mysite.webflow.io', 'webflow'],
    ['https://example.webflow.io/blog', 'webflow'],
    ['https://webflow.com', 'webflow'],
    ['https://www.webflow.com/made-in-webflow', 'webflow'],
    ['https://mystore.myshopify.com', 'shopify'],
    ['https://mystore.myshopify.com/blogs/news', 'shopify'],
    ['https://shopify.com', 'shopify'],
    ['https://www.shopify.com/something', 'shopify'],
    ['https://mysite.weebly.com', 'weebly'],
    ['https://eloisacalvinato.lovable.app/', 'lovable'],
    ['https://eloisacalvinato.lovable.app', 'lovable'],
    ['https://lovable.dev/projects/abc', 'lovable'],
    ['https://demo.ghost.io/', 'ghost'],
    ['https://codinghorror.ghost.io/ghost/', 'ghost'],
    ['https://heathercoxrichardson.substack.com/', 'substack'],
    ['https://on.substack.com/p/some-post', 'substack'],
  ])('detects %s as %s', (url, platform) => {
    const detected = detectFromUrl(url);
    expect(detected).toBe(platform);
    expect(findAdapter(detected!)).toMatchObject({ id: platform });
  });

  // Platforms that serve custom domains carry no URL signal at all, so the URL
  // tier must decline rather than guess. GoDaddy W+M is the sharp case: these
  // are real W+M sites, identified later by header and source signals.
  it.each([
    'https://www.mybusiness.com',
    'https://skywaydiner.com',
    'https://cruisewarehouse.com',
  ])('returns null for the custom domain %s', (url) => {
    expect(detectFromUrl(url)).toBeNull();
    expect(findAdapter('unknown')).toMatchObject({ id: 'default' });
  });

  it('handles URLs without protocol', () => {
    expect(detectFromUrl('mysite.wixsite.com/blog')).toBe('wix');
  });
});

describe('detectFromHttp (fingerprinting)', () => {
  it('shares document evidence precedence with HTTP detection', async () => {
    const headers = new Headers([['x-wix-request-id', 'abc123']]);
    const html = '<meta name="generator" content="GoDaddy Website Builder">';
    global.fetch = vi.fn().mockResolvedValue({ headers, text: () => Promise.resolve(html) });
    expect(detectFromDocument('https://example.com', headers, html)).toEqual(await detectFromHttp('https://example.com'));
  });

  it('detects Wix from X-Wix-Request-Id header', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['x-wix-request-id', 'abc123']]),
      text: () => Promise.resolve('<html></html>'),
    });
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('wix');
    expect(result.confidence).toBe('high');
    expect(result.signals).toContain('X-Wix-Request-Id header');
  });

  it('detects Squarespace from X-ServedBy header', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['x-servedby', 'squarespace']]),
      text: () => Promise.resolve('<html></html>'),
    });
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('squarespace');
  });

  it('detects a CDN-served Squarespace site from its own page markers', () => {
    // Custom domain behind Cloudflare: no Squarespace URL or header, and the
    // source uses static1./assets. hosts, never static.squarespace.com.
    const headers = new Headers([['server', 'cloudflare']]);
    const html = [
      '<link rel="image_src" href="https://static1.squarespace.com/static/68afdbc8e59974578907e909/t/1/logo.png?format=1500w">',
      '<script crossorigin="anonymous" src="//assets.squarespace.com/universal/scripts-compressed/common-13f7d35f7cb81498-min.en-US.js"></script>',
      '<link rel="stylesheet" type="text/css" href="https://static1.squarespace.com/static/versioned-site-css/68afdbc8e59974578907e909/64/site.css?nocustom=true">',
      '<script>Static.SQUARESPACE_CONTEXT = {"website":{"id":"68afdbc8e59974578907e909"}};</script>',
    ].join('\n');
    const result = detectFromDocument('https://investors.example.com.au/', headers, html);
    expect(result.platform).toBe('squarespace');
    expect(result.confidence).toBe('medium');
    expect(findAdapter(result.platform)).toMatchObject({ id: 'squarespace' });
  });

  it('does not detect Squarespace on a page that only embeds a Squarespace-hosted image', () => {
    const html = '<html><body><h1>Our partners</h1>'
      + '<img src="https://images.squarespace-cdn.com/content/v1/5f1/abc/photo.jpg?format=750w" alt="">'
      + '<a href="https://static1.squarespace.com/static/5f1/t/6a/1/brochure.pdf">Brochure</a>'
      + '</body></html>';
    const result = detectFromDocument('https://example.com', new Headers([['server', 'cloudflare']]), html);
    expect(result.platform).toBe('unknown');
  });

  it('detects Lovable from #lovable-badge on a custom domain', () => {
    const html = '<aside id="lovable-badge" aria-label="Made with Lovable"><a href="https://lovable.dev/projects/x?utm_source=lovable-badge">Made with Lovable</a></aside>';
    const result = detectFromDocument('https://example.com', new Headers(), html);
    expect(result.platform).toBe('lovable');
    expect(findAdapter(result.platform)).toMatchObject({ id: 'lovable' });
  });

  // EmDash signal values are from live sites (2026-09): q-lu.co, espritlabs.ai,
  // blog.cloudflare.com, farra.media, studioproaudio.com.
  it('detects EmDash from its Server-Timing runtime phases', () => {
    const headers = new Headers([['server-timing', 'setup;dur=191;desc="Setup probe", rt.seedcheck;dur=184;desc="Auto-seed gate", render;dur=855']]);
    const result = detectFromDocument('https://q-lu.co/', headers, '<html></html>');
    expect(result.platform).toBe('emdash');
    expect(result.confidence).toBe('high');
    expect(findAdapter(result.platform)).toMatchObject({ id: 'emdash' });
  });

  it('does not detect EmDash from an unrelated Server-Timing header', () => {
    const headers = new Headers([['server-timing', 'processing;dur=62, db;dur=17']]);
    const result = detectFromDocument('https://example.com', headers, '<html></html>');
    expect(result.platform).not.toBe('emdash');
  });

  it.each([
    ['a relative media URL', '<img src="/_emdash/api/media/file/01M1VN7ZNKV36VQGDVS9R0BW92.png" alt="">'],
    ['a media URL inside Astro\'s encoded image proxy', '<img src="/_image?href=https%3A%2F%2Fblog.example%2F_emdash%2Fapi%2Fmedia%2Ffile%2F01KW497YX7768BEJGS24P0FMX8.png&amp;w=64">'],
    ['an emdash-* component class', '<img src="/logo.png" class="emdash-image-media astro-6depetnu">'],
    ['an <emdash-*> custom element', '<emdash-live-search data-config="{}" class="search-live"></emdash-live-search>'],
  ])('detects EmDash from %s in page source', (_label, html) => {
    const result = detectFromDocument('https://example.com', new Headers(), html);
    expect(result.platform).toBe('emdash');
    expect(result.confidence).toBe('medium');
  });

  it('does not detect EmDash from the word "EmDash" in body copy', () => {
    const html = '<p>We build sites with EmDash. <a href="/posts/emdash-build">Read more</a></p>';
    const result = detectFromDocument('https://agency.example', new Headers(), html);
    expect(result.platform).toBe('unknown');
  });

  it('detects a fully themed EmDash site from the /_emdash/admin login redirect', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, headers: new Map(), text: () => Promise.resolve('<html><body>Themed</body></html>') })
      .mockImplementation(async (u: string) => ({
        status: String(u).endsWith('/_emdash/admin') ? 302 : 404,
        headers: new Map([['location', 'https://q-lu.co/_emdash/admin/login?redirect=%2F_emdash%2Fadmin']]),
      }));
    const result = await detectFromHttp('https://q-lu.co');
    expect(result.platform).toBe('emdash');
    expect(result.signals).toContain('/_emdash/admin redirects to /_emdash/admin/login');
  });

  it('does not detect EmDash from a Cloudflare Access redirect on /_emdash/admin', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, headers: new Map(), text: () => Promise.resolve('<html></html>') })
      .mockResolvedValue({
        status: 302,
        headers: new Map([['location', 'https://team.cloudflareaccess.com/cdn-cgi/access/login/example.com?redirect_url=%2F_emdash%2Fadmin']]),
      });
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('unknown');
  });

  // Ghost signal values are from live sites (2026-09): platformer.news,
  // citationneeded.news (self-hosted), demo.ghost.io, aftermath.site.
  it('does not treat a host merely containing "ghost.io" as Ghost(Pro)', () => {
    expect(detectFromUrl('https://ghost.io.example.com/')).toBeNull();
    expect(detectFromUrl('https://example.com/ghost.io/')).toBeNull();
  });

  it('detects Ghost(Pro) from its ghost-fastly header', () => {
    const headers = new Headers([['ghost-fastly', 'true;production'], ['server', 'openresty']]);
    const result = detectFromDocument('https://www.platformer.news/', headers, '<html></html>');
    expect(result.platform).toBe('ghost');
    expect(result.confidence).toBe('high');
    expect(findAdapter(result.platform)).toMatchObject({ id: 'ghost' });
  });

  it.each([
    ['its generator meta', '<meta name="generator" content="Ghost 6.56">'],
    ['its Portal script', '<script defer src="https://cdn.jsdelivr.net/ghost/portal@~2.71/umd/portal.min.js" data-i18n="true" data-ghost="https://www.citationneeded.news/" crossorigin="anonymous"></script>'],
    ['its Search script', '<script defer src="https://cdn.jsdelivr.net/ghost/sodo-search@~1.8/umd/sodo-search.min.js" data-sodo-search="https://example.com/"></script>'],
  ])('detects self-hosted Ghost from %s', (_label, html) => {
    const result = detectFromDocument('https://www.citationneeded.news/', new Headers([['x-powered-by', 'Express']]), html);
    expect(result.platform).toBe('ghost');
    expect(result.confidence).toBe('medium');
  });

  it('does not detect Ghost on a headless front end that only renders Ghost content', () => {
    // buffer.com/resources: Next.js pages reading Ghost's Content API.
    const html = '<figure class="kg-card kg-image-card"><img src="https://buffer.com/resources/content/images/2026/09/a.png"></figure><p>Published with Ghost as a backend.</p>';
    const result = detectFromDocument('https://buffer.com/resources/', new Headers([['x-powered-by', 'Next.js']]), html);
    expect(result.platform).toBe('nextjs');
    expect(findAdapter(result.platform)).toMatchObject({ id: 'nextjs' });
    expect(detectFromDocument('https://buffer.com/resources/', new Headers(), html).platform).toBe('unknown');
  });

  it('detects a Ghost(Pro) custom domain from its /ghost/ admin redirect', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, headers: new Map(), text: () => Promise.resolve('<html><body>Stripped theme</body></html>') })
      .mockImplementation(async (u: string) => (String(u).endsWith('/ghost/')
        ? { status: 302, headers: new Map([['location', 'https://aftermath.ghost.io/ghost/']]) }
        : { status: 404, headers: new Map() }));
    const result = await detectFromHttp('https://aftermath.site');
    expect(result.platform).toBe('ghost');
    expect(result.signals).toContain('/ghost/ redirects to the Ghost(Pro) admin');
  });

  // Substack signal values are from live custom-domain publications (2026-09):
  // derekthompson.org, astralcodexten.com, slowboring.com.
  it('does not treat a host merely containing "substack.com" as Substack', () => {
    expect(detectFromUrl('https://substack.com.example.org/')).toBeNull();
    expect(detectFromUrl('https://example.com/substack.com/')).toBeNull();
  });

  it.each([
    ['x-served-by', 'Substack'],
    ['x-cluster', 'substack'],
  ])('detects a Substack custom domain from its %s header', (header, value) => {
    const headers = new Headers([[header, value], ['server', 'cloudflare']]);
    const result = detectFromDocument('https://www.derekthompson.org/', headers, '<html></html>');
    expect(result.platform).toBe('substack');
    expect(result.confidence).toBe('high');
    expect(findAdapter(result.platform)).toMatchObject({ id: 'substack' });
  });

  it('detects Substack from its app bundle in page source', () => {
    const html = '<script src="https://substackcdn.com/bundle/static/js/lib-router.3f2a9c1b.js" charset="utf-8"></script>';
    const result = detectFromDocument('https://www.slowboring.com/', new Headers(), html);
    expect(result.platform).toBe('substack');
    expect(result.confidence).toBe('medium');
  });

  it('does not detect Substack on a page that only hotlinks a Substack image or embeds a post', () => {
    const html = '<img src="https://substackcdn.com/image/fetch/w_1456,c_limit/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fa.png">'
      + '<iframe src="https://www.astralcodexten.com/embed" width="480" height="320"></iframe>';
    const result = detectFromDocument('https://example.com', new Headers(), html);
    expect(result.platform).toBe('unknown');
  });

  it('returns unknown for unrecognized sites', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map(),
      text: () => Promise.resolve('<html><body>Hello</body></html>'),
    });
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('unknown');
    expect(result.confidence).toBe('low');
  });

  it('handles fetch failure gracefully', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('unknown');
    expect(result.confidence).toBe('low');
  });

  it('detects GoDaddy Websites & Marketing from generator meta in page source', async () => {
    const html = readFileSync('test/fixtures/godaddy-wm-blog-post.html', 'utf8');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map(),
      text: () => Promise.resolve(html),
    });
    const result = await detectFromHttp('https://cruisewarehouse.com');
    expect(result.platform).toBe('godaddy-wm');
    expect(result.signals.some((s) => /generator meta|isteam/i.test(s))).toBe(true);
  });

  it('detects GoDaddy Websites & Marketing from X-SiteId header', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['x-siteid', 'us-west-2']]),
      text: () => Promise.resolve('<html></html>'),
    });
    const result = await detectFromHttp('https://skywaydiner.com');
    expect(result.platform).toBe('godaddy-wm');
    expect(result.confidence).toBe('high');
  });
});

// Path probes are declared by the platform that owns them (Platform.detection.
// pathProbes) and consumed by the shared detection engine — these tests
// register probe-carrying platforms exactly the way a third-party consumer
// would, without editing any core table. Each test gets a FRESH module registry
// (the moral equivalent of the old `PATH_PROBES.length = 0` afterEach) so
// one test's probe platform can never cross-match another's probe mocks.
describe('platform-owned path probes', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const freshRegistry = async () => {
    const { registerPlatform } = await import('../src/platform/registry.js');
    return registerPlatform;
  };
  const freshDetect = async () => {
    const { detectFromHttp } = await import('../src/lib/detect-platform/index.js');
    return detectFromHttp;
  };

  const probePlatform = async (
    id: string,
    probe: { path: string; expectedStatus: number[]; locationContains?: string; signal: string },
  ) => {
    const registerPlatform = await freshRegistry();
    registerPlatform({
      id,
      discover: async () => ({}),
      detection: { pathProbes: [probe] },
    });
  };

  it('matches a path probe when source signals fail (status only)', async () => {
    await probePlatform('probe-status-only', {
      path: '/_test/admin',
      expectedStatus: [302, 401],
      signal: '/_test/admin probe',
    });

    // Mock chain: first fetch (homepage) returns generic HTML (forces probe),
    // second fetch (probe HEAD) returns 302.
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
        text: () => Promise.resolve('<html><body>Generic</body></html>'),
      })
      .mockResolvedValueOnce({
        status: 302,
        headers: new Map([['location', 'https://example.com/_test/admin/login']]),
      });

    const detectFromHttp = await freshDetect();
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('probe-status-only');
    expect(result.confidence).toBe('high');
    expect(result.signals).toContain('/_test/admin probe');
  });

  it('does NOT match when probe returns wrong status', async () => {
    await probePlatform('probe-wrong-status', {
      path: '/_test/admin',
      expectedStatus: [302, 401],
      signal: '/_test/admin probe',
    });

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
        text: () => Promise.resolve('<html></html>'),
      })
      .mockResolvedValueOnce({
        status: 404,  // Wrong status
        headers: new Map(),
      });

    const detectFromHttp = await freshDetect();
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('unknown');
  });

  it('matches when Location header contains expected substring', async () => {
    await probePlatform('probe-location-match', {
      path: '/_test/admin',
      expectedStatus: [302],
      locationContains: '/_test/admin/login',
      signal: '/_test/admin probe with location check',
    });

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
        text: () => Promise.resolve('<html></html>'),
      })
      .mockResolvedValueOnce({
        status: 302,
        headers: new Map([['location', 'https://example.com/_test/admin/login?redirect=%2F_test%2Fadmin']]),
      });

    const detectFromHttp = await freshDetect();
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('probe-location-match');
  });

  it('does NOT match when Location header lacks expected substring', async () => {
    await probePlatform('probe-location-mismatch', {
      path: '/_test/admin',
      expectedStatus: [302],
      locationContains: '/_test/admin/login',
      signal: '/_test/admin probe with location check',
    });

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
        text: () => Promise.resolve('<html></html>'),
      })
      .mockResolvedValueOnce({
        status: 302,
        headers: new Map([['location', 'https://example.com/somewhere-else']]),  // Wrong location
      });

    const detectFromHttp = await freshDetect();
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('unknown');  // Status matched but Location didn't
  });

  it('does NOT match when Location header is missing entirely', async () => {
    await probePlatform('probe-location-missing', {
      path: '/_test/admin',
      expectedStatus: [302],
      locationContains: '/_test/admin/login',
      signal: '/_test/admin probe with location check',
    });

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
        text: () => Promise.resolve('<html></html>'),
      })
      .mockResolvedValueOnce({
        status: 302,
        headers: new Map(),  // No Location header
      });

    const detectFromHttp = await freshDetect();
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('unknown');
  });

  it('skips probes when source signals already identified the platform', async () => {
    await probePlatform('probe-gated-by-source', {
      path: '/_test/admin',
      expectedStatus: [302],
      signal: '/_test/admin probe',
    });

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Map(),
      // HTML matches Wix's source signal (wixstatic.com). Wix wins on tier 3,
      // so the probe should never fire.
      text: () => Promise.resolve('<html><img src="https://static.wixstatic.com/media/x.jpg"></html>'),
    });
    global.fetch = fetchMock;

    const detectFromHttp = await freshDetect();
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('wix');
    // Critical: only ONE fetch call (the homepage). Probe never fired.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips probes when HTTP signals already identified the platform', async () => {
    await probePlatform('probe-gated-by-header', {
      path: '/_test/admin',
      expectedStatus: [302],
      signal: '/_test/admin probe',
    });

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Map([['x-wix-request-id', 'abc123']]),  // Header-signal match
      text: () => Promise.resolve('<html></html>'),
    });
    global.fetch = fetchMock;

    const detectFromHttp = await freshDetect();
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('wix');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips probe when path resolves to a different origin', async () => {
    await probePlatform('probe-cross-origin', {
      path: '//attacker.example/admin',  // Protocol-relative — would resolve to attacker.example
      expectedStatus: [302],
      signal: '/_test/admin probe',
    });

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Map(),
      text: () => Promise.resolve('<html></html>'),
    });
    global.fetch = fetchMock;

    const detectFromHttp = await freshDetect();
    const result = await detectFromHttp('https://example.com');
    expect(result.platform).toBe('unknown');
    // Critical: the cross-origin probe never fired. (Built-in platforms'
    // same-origin probes may still run.)
    const fetched = fetchMock.mock.calls.map(([u]) => String(u));
    expect(fetched.some((u) => u.includes('attacker.example'))).toBe(false);
  });

  it('still runs probe tier when homepage body read throws', async () => {
    await probePlatform('probe-body-read-failure', {
      path: '/_test/admin',
      expectedStatus: [302],
      signal: '/_test/admin probe',
    });

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
        // Body read throws (e.g. truncated stream)
        text: () => Promise.reject(new Error('truncated')),
      })
      .mockResolvedValueOnce({
        status: 302,
        headers: new Map([['location', 'https://example.com/_test/admin/login']]),
      });

    const detectFromHttp = await freshDetect();
    const result = await detectFromHttp('https://example.com');
    // Probe tier runs despite body read failure, identifies platform
    expect(result.platform).toBe('probe-body-read-failure');
    expect(result.confidence).toBe('high');
  });
});
