import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startStaticServer, type StaticServer } from './static-server.js';

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
});
