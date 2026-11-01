import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { downloadMedia } from './media.js';
import { runWithTrustedOrigins } from './safe-fetch.js';

it('downloads media through redirects from a server that refuses runtime-default agents', async () => {
  const requests: { path: string; userAgent: string }[] = [];
  const bytes = Buffer.from('image-bytes');
  const server = createServer((req, res) => {
    const userAgent = req.headers['user-agent'] ?? '';
    requests.push({ path: req.url!, userAgent });
    if (!userAgent.startsWith('Mozilla/')) {
      res.writeHead(403).end();
    } else if (req.url === '/redirect.png') {
      res.writeHead(302, { Location: '/image.png' }).end();
    } else {
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(bytes);
    }
  });
  const dir = mkdtempSync(join(process.cwd(), '.tmp-media-identity-'));
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('node:net').AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const result = await runWithTrustedOrigins([origin], () =>
      downloadMedia(`${origin}/redirect.png`, dir, new Map()),
    );
    expect(result.error).toBeNull();
    expect(readFileSync(result.localPath!)).toEqual(bytes);
    expect(requests.map(({ path }) => path)).toEqual(['/redirect.png', '/image.png']);
    expect(requests[0].userAgent).toMatch(/^Mozilla\//);
    expect(requests[1].userAgent).toBe(requests[0].userAgent);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
