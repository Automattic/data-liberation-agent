import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep, join } from 'node:path';

export interface StaticFileServer {
  /** The port the server is listening on. */
  port: number;
  /** Shut the server down. Safe to call multiple times. */
  close: () => Promise<void>;
}

/**
 * Spin up a tiny read-only HTTP server over `rootDir` on an ephemeral localhost
 * port. Used to serve staged media back into Studio's `wp import` without going
 * through Studio's own WP server — Studio's SinglePHPInstanceManager can only
 * run one PHP at a time per site, so having the WXR importer fetch from the
 * same Studio site it's running in deadlocks.
 *
 * Only serves files (404s on directories, missing paths, and anything that
 * would escape `rootDir` via `..` segments). Ignores query strings.
 */
export async function startStaticFileServer(rootDir: string): Promise<StaticFileServer> {
  const absRoot = resolve(rootDir);
  const rootWithSep = absRoot.endsWith(sep) ? absRoot : absRoot + sep;

  const server: Server = createServer((req, res) => {
    const rawUrl = req.url || '/';
    const pathPart = rawUrl.split('?')[0];
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const filePath = resolve(join(absRoot, decoded));
    if (!(filePath === absRoot || filePath.startsWith(rootWithSep))) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Length': statSync(filePath).size });
    createReadStream(filePath).pipe(res);
  });

  await new Promise<void>((r, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => r());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('static-file-server: could not determine listen port');
  }

  let closed = false;
  return {
    port: addr.port,
    close: () => new Promise<void>((r) => {
      if (closed) return r();
      closed = true;
      server.close(() => r());
    }),
  };
}
