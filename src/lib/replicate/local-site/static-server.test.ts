import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { startStaticServer, resolveRequestPath, type StaticServer } from './static-server.js';
import { extractSharedChrome } from '../../shared-chrome.js';
import { includeReferences, readResolvedPage, SITE_INCLUDE_LIMITS } from '../../site-includes.js';
import { checkSelfConsistency } from '../../fidelity/self-consistency.js';
import { createZipArchive } from '../../publish/zip.js';

const FIXTURE_TMP = join(process.cwd(), '.tmp-test');

let server: StaticServer | null = null;
afterEach(async () => {
  if (server) await server.close();
  server = null;
});

function makeSite(): string {
  mkdirSync(FIXTURE_TMP, { recursive: true });
  const dir = mkdtempSync(join(FIXTURE_TMP, 'serve-'));
  writeFileSync(join(dir, 'index.html'), '<h1>home</h1>');
  writeFileSync(join(dir, 'about.html'), '<h1>about</h1>');
  writeFileSync(join(dir, 'styles.css'), 'body{color:red}');
  mkdirSync(join(dir, 'blog'), { recursive: true });
  writeFileSync(join(dir, 'blog', 'post.html'), '<h1>post</h1>');
  return dir;
}

describe('startStaticServer', () => {
  it('stores both landmarks once, preserves expanded bytes, and propagates one edit to two HTTP routes', async () => {
    const dir = makeSite();
    try {
      // Nontrivial unique authored markup makes the ZIP assertion meaningful even
      // with compression and the additional directory entries for parts.
      const content = Array.from({ length: 300 }, (_, i) => `<span data-key="${createHash('sha256').update(String(i)).digest('hex')}">Item ${i}</span>`).join('');
      const header = `<header id="brand"><style>#brand{color:red}</style><nav><a href="#end">End</a></nav>${content}<script type="application/json">{"text":"literal <!--#include virtual=\"/parts/not-real.html\" -->"}</script></header>`;
      const footer = `<footer id="end">Copyright – ${content}</footer>`;
      const pages = ['index.html', 'about.html'];
      const before = pages.map((path, i) => `<!doctype html><html><body><div class="root">${header}<main><h1>${i}</h1><article><header>Article chrome</header></article></main>${footer}</div></body></html>`);
      for (const [i, path] of pages.entries()) {
        writeFileSync(join(dir, path), before[i]);
      }
      extractSharedChrome(dir, pages);
      const parts = readdirSync(join(dir, 'parts'));
      expect(parts).toHaveLength(2);
      expect(parts.filter(path => path.startsWith('header-'))).toHaveLength(1);
      expect(parts.filter(path => path.startsWith('footer-'))).toHaveLength(1);
      for (const [i, path] of pages.entries()) {
        const compact = readFileSync(join(dir, path), 'utf8');
        expect(includeReferences(compact)).toHaveLength(2);
        expect(compact).toContain('<header>Article chrome</header>');
        expect(readResolvedPage(dir, join(dir, path))).toBe(before[i]);
      }
      const beforeBytes = before.reduce((sum, html) => sum + Buffer.byteLength(html), 0);
      const afterBytes = [...pages, ...parts.map(path => `parts/${path}`)].reduce((sum, path) => sum + statSync(join(dir, path)).size, 0);
      expect(afterBytes).toBeLessThan(beforeBytes);
      const beforeZip = createZipArchive(pages.map((path, i) => ({ path, contents: Buffer.from(before[i]) })));
      const afterZip = createZipArchive([...pages, ...parts.map(path => `parts/${path}`)].map(path => ({ path, contents: readFileSync(join(dir, path)) })));
      expect(afterZip.length).toBeLessThan(beforeZip.length);
      expect(checkSelfConsistency(dir, new Map([['/', 'index.html'], ['/about/', 'about.html']])).findings).toEqual([]);
      server = await startStaticServer(dir);
      for (const [i, route] of ['/', '/about/'].entries()) expect(await (await fetch(server.url + route)).text()).toBe(before[i]);
      const sharedHeader = parts.find(path => path.startsWith('header-'))!;
      writeFileSync(join(dir, 'parts', sharedHeader), header.replace('Item 0', 'Edited brand'));
      for (const route of ['/', '/about/']) expect(await (await fetch(server.url + route)).text()).toContain('Edited brand');
      rmSync(join(dir, 'parts', sharedHeader));
      expect((await fetch(server.url + '/')).status).toBe(500);
      expect(checkSelfConsistency(dir, new Map([['/', 'index.html']])).findings[0].kind).toBe('include-unresolved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps route/nav/mobile variants and excludes content-local landmarks', () => {
    const dir = makeSite();
    try {
      const landmark = (label: string) => `<header id="${label}">${label.repeat(300)}</header>`;
      const desktop = landmark('desktop');
      const mobile = landmark('mobile');
      const local = `<main>${landmark('main')}</main><section>${landmark('section')}</section><article><footer>${'local'.repeat(300)}</footer></article>`;
      const pages = ['index.html', 'about.html', 'different.html'];
      const before = [
        `<div class="desktop">${desktop}</div><div class="mobile">${mobile}</div>${local}`,
        `<div class="desktop">${desktop}</div><div class="mobile">${mobile}</div>${local}`,
        `<div>${landmark('active-nav')}</div>${local}`,
      ];
      pages.forEach((path, i) => writeFileSync(join(dir, path), before[i]));
      extractSharedChrome(dir, pages);
      expect(readdirSync(join(dir, 'parts'))).toHaveLength(2);
      pages.forEach((path, i) => {
        expect(readResolvedPage(dir, join(dir, path))).toBe(before[i]);
        expect(readFileSync(join(dir, path), 'utf8')).toContain(local);
      });
      expect(readFileSync(join(dir, pages[2]), 'utf8')).toBe(before[2]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('extracts only net-positive sharing and never overwrites a pre-existing part', () => {
    const dir = makeSite();
    try {
      const header = `<header>${'large'.repeat(300)}</header>`;
      const id = createHash('sha256').update(header).digest('hex');
      mkdirSync(join(dir, 'parts'));
      const part = join(dir, 'parts', `header-${id}.html`);
      writeFileSync(part, 'User resource');
      const before = `${header}<footer>Small</footer>`;
      for (const path of ['index.html', 'about.html']) writeFileSync(join(dir, path), before);
      extractSharedChrome(dir, ['index.html', 'about.html']);
      expect(readFileSync(part, 'utf8')).toBe('User resource');
      expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe(before);
      rmSync(join(dir, 'parts'), { recursive: true });
      writeFileSync(join(dir, 'parts'), 'Existing resource named parts');
      extractSharedChrome(dir, ['index.html', 'about.html']);
      expect(readFileSync(join(dir, 'parts'), 'utf8')).toBe('Existing resource named parts');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fails visibly for malformed, missing, cyclic, escaping, symlinked and oversized includes', async () => {
    const dir = makeSite();
    try {
      mkdirSync(join(dir, 'parts'));
      const include = '<!--#include virtual="/parts/header-test.html" -->';
      const page = join(dir, 'index.html');
      for (const malformed of ['<!--#include -->', '<!--#include virtual="../outside.html" -->', '<!--#include virtual="/parts/../outside.html" -->', '<!--#include virtual="/parts/header-test.html"', '<!-- #include virtual="/parts/header-test.html" -->']) {
        writeFileSync(page, malformed);
        expect(() => readResolvedPage(dir, page)).toThrow(/Malformed/);
      }
      writeFileSync(page, include);
      expect(() => readResolvedPage(dir, page)).toThrow();
      const part = join(dir, 'parts/header-test.html');
      writeFileSync(part, include);
      expect(() => readResolvedPage(dir, page)).toThrow(/cycle/);
      writeFileSync(part, '<!--#include virtual="/parts/nested.html" -->');
      writeFileSync(join(dir, 'parts/nested.html'), 'Nested');
      expect(() => readResolvedPage(dir, page, { ...SITE_INCLUDE_LIMITS, depth: 2 })).toThrow(/limit/);
      rmSync(part);
      symlinkSync(join(dir, 'about.html'), part);
      expect(() => readResolvedPage(dir, page)).toThrow(/symlink/);
      rmSync(part);
      rmSync(join(dir, 'parts'), { recursive: true });
      mkdirSync(join(dir, 'actual-parts'));
      writeFileSync(join(dir, 'actual-parts/header-test.html'), 'Symlink directory target');
      symlinkSync(join(dir, 'actual-parts'), join(dir, 'parts'));
      expect(() => readResolvedPage(dir, page)).toThrow(/symlink/);
      rmSync(join(dir, 'parts'));
      mkdirSync(join(dir, 'parts'));
      writeFileSync(part, 'x'.repeat(100));
      expect(() => readResolvedPage(dir, page, { ...SITE_INCLUDE_LIMITS, fileBytes: 80 })).toThrow(/size/);
      writeFileSync(page, include.repeat(3));
      expect(() => readResolvedPage(dir, page, { ...SITE_INCLUDE_LIMITS, expandedBytes: 200 })).toThrow(/byte/);
      expect(() => readResolvedPage(dir, page, { ...SITE_INCLUDE_LIMITS, reads: 1 })).toThrow(/limit/);
      expect(() => readResolvedPage(dir, join(dir, '../outside.html'))).toThrow(/escapes/);
      server = await startStaticServer(dir);
      writeFileSync(page, '<!--#include -->');
      const response = await fetch(server.url);
      expect(response.status).toBe(500);
      expect(await response.text()).toContain('Malformed site include');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('serves clean URLs aligned with WP permalinks', async () => {
    const dir = makeSite();
    try {
      server = await startStaticServer(dir);
      const get = async (p: string) => {
        const res = await fetch(server!.url + p);
        return { status: res.status, body: await res.text(), type: res.headers.get('content-type') ?? '' };
      };
      expect((await get('/')).body).toContain('home');
      expect((await get('/about/')).body).toContain('about');     // clean URL → about.html
      expect((await get('/about.html')).body).toContain('about'); // raw path still works
      expect((await get('/blog/post/')).body).toContain('post');  // nested clean URL
      const css = await get('/styles.css');
      expect(css.body).toContain('color:red');
      expect(css.type).toContain('text/css');
      expect((await get('/missing/')).status).toBe(404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects path traversal', async () => {
    const dir = makeSite();
    try {
      server = await startStaticServer(dir);
      const res = await fetch(server.url + '/../../etc/passwd');
      expect([403, 404]).toContain(res.status); // fetch may normalize; raw socket below is the real probe
      // raw request bypassing fetch normalization:
      const { request } = await import('node:http');
      const status = await new Promise<number>((resolve) => {
        const req = request({ host: '127.0.0.1', port: server!.port, path: '/..%2f..%2fetc%2fpasswd' }, (r) => resolve(r.statusCode ?? 0));
        req.end();
      });
      expect([403, 404]).toContain(status);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps slugs to clean URLs via pageUrl', async () => {
    const dir = makeSite();
    try {
      server = await startStaticServer(dir);
      expect(server.pageUrl('home')).toBe(`${server.url}/`);
      expect(server.pageUrl('about')).toBe(`${server.url}/about/`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps relPaths to clean URLs via urlForPage (nested pages resolve)', async () => {
    const dir = makeSite();
    try {
      server = await startStaticServer(dir);
      expect(server.urlForPage('index.html')).toBe(`${server.url}/`);
      expect(server.urlForPage('about.html')).toBe(`${server.url}/about/`);
      expect(server.urlForPage('blog/post.html')).toBe(`${server.url}/blog/post/`);
      expect(server.urlForPage('blog/index.html')).toBe(`${server.url}/blog/`);
      // the nested URL it emits actually serves the right file
      const res = await fetch(server.urlForPage('blog/post.html'));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('post');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives malformed percent-encoding with a 404', async () => {
    const dir = makeSite();
    try {
      server = await startStaticServer(dir);
      const { request } = await import('node:http');
      const rawGet = (path: string) =>
        new Promise<number>((resolve) => {
          const req = request({ host: '127.0.0.1', port: server!.port, path }, (r) => resolve(r.statusCode ?? 0));
          req.end();
        });
      expect(await rawGet('/%zz')).toBe(404); // malformed → 404, no crash
      const after = await fetch(`${server.url}/about/`); // server still alive
      expect(after.status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves captured percent-encoded Unicode directories without losing decoded routes', async () => {
    const dir = makeSite();
    try {
      const encoded = 'team%E2%80%99s-work';
      mkdirSync(join(dir, encoded));
      writeFileSync(join(dir, encoded, 'index.html'), '<h1>encoded route</h1>');
      server = await startStaticServer(dir);
      const encodedResponse = await fetch(`${server.url}/${encoded}/index.html`);
      expect(encodedResponse.status).toBe(200);
      expect(await encodedResponse.text()).toContain('encoded route');

      mkdirSync(join(dir, 'team’s-work'));
      writeFileSync(join(dir, 'team’s-work', 'index.html'), '<h1>decoded route</h1>');
      const decodedResponse = await fetch(`${server.url}/${encoded}/`);
      expect(await decodedResponse.text()).toContain('decoded route');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveRequestPath', () => {
  it('returns null on malformed percent-encoding', () => {
    const dir = makeSite();
    try {
      expect(resolveRequestPath(dir, '/%zz')).toBe(null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('relative-asset fallback under clean URLs', () => {
  it('resolves /about/styles.css to the root styles.css (relative href from a clean URL)', async () => {
    const dir = makeSite();
    try {
      server = await startStaticServer(dir);
      const res = await fetch(`${server.url}/about/styles.css`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('color:red');
      // nested page asset: /blog/post/styles.css → root styles.css too
      const nested = await fetch(`${server.url}/blog/post/styles.css`);
      expect(nested.status).toBe(200);
      // html paths never use the fallback (clean-URL semantics preserved)
      const html = await fetch(`${server.url}/about/index.html`);
      expect(html.status).toBe(404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
