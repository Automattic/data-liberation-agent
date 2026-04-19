import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStaticFileServer } from './static-file-server.js';

describe('startStaticFileServer', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'static-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('serves a file from the root dir', async () => {
    writeFileSync(join(dir, 'hello.txt'), 'hi there');
    const srv = await startStaticFileServer(dir);
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/hello.txt`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hi there');
    } finally {
      await srv.close();
    }
  });

  it('ignores query strings', async () => {
    writeFileSync(join(dir, 'foo.jpg'), 'jpgbytes');
    const srv = await startStaticFileServer(dir);
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/foo.jpg?v=123&w=820`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('jpgbytes');
    } finally {
      await srv.close();
    }
  });

  it('404s for missing files', async () => {
    const srv = await startStaticFileServer(dir);
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/nope`);
      expect(res.status).toBe(404);
    } finally {
      await srv.close();
    }
  });

  it('404s when the path resolves to a directory', async () => {
    mkdirSync(join(dir, 'sub'));
    const srv = await startStaticFileServer(dir);
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/sub`);
      expect(res.status).toBe(404);
    } finally {
      await srv.close();
    }
  });

  it('403s on path-traversal attempts', async () => {
    const srv = await startStaticFileServer(dir);
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/../../etc/passwd`);
      expect([403, 404]).toContain(res.status);
    } finally {
      await srv.close();
    }
  });
});
