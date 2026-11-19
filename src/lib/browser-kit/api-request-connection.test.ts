import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer as httpsServer, type Server } from 'node:https';
import { TLSSocket } from 'node:tls';
import { chromium, type Browser } from 'playwright';
import { fetchSourceRoute, getSourceResponse } from './source-traffic.js';
import { closingConnection } from './api-request-connection.js';

const skipBrowser = Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath());

it('replaces any caller Connection header with close', () => {
  expect(closingConnection({ Connection: 'keep-alive', accept: 'text/html' })).toEqual({ accept: 'text/html', connection: 'close' });
  expect(closingConnection()).toEqual({ connection: 'close' });
});

/**
 * Playwright's APIRequestContext pools keep-alive TLS sockets in one
 * process-wide agent. A reused socket whose peer has gone reports an empty
 * peer certificate, and playwright-core < 1.63 throws reading `subject.CN`
 * inside a socket event handler: an uncaught TypeError that ended a
 * loremipsum.io liberation. The peer-gone state is simulated after the first
 * request; without `Connection: close` the second request reuses the socket.
 * One browser, about 1 s.
 */
describe.skipIf(skipBrowser)('source requests never reuse a pooled TLS socket', () => {
  let dir: string;
  let server: Server;
  let origin: string;
  let browser: Browser;

  beforeAll(async () => {
    const root = resolve('.tmp-test');
    mkdirSync(root, { recursive: true });
    dir = mkdtempSync(join(root, 'api-request-connection-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem', '-subj', '/CN=127.0.0.1', '-days', '2'], { cwd: dir, stdio: 'pipe' });
    server = httpsServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')), keepAlive: true }, (_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>ok</title>');
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>(done => server?.close(() => done()) ?? done());
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function withPeerGoneAfterFirst(run: (peerGone: () => void) => Promise<void>): Promise<string[]> {
    const uncaught: string[] = [];
    const onUncaught = (error: unknown) => uncaught.push(String(error));
    const original = TLSSocket.prototype.getPeerCertificate;
    // Only a socket that already carried a request — a reused one — loses its peer.
    const used = new WeakSet<TLSSocket>();
    let gone = false;
    TLSSocket.prototype.getPeerCertificate = function (this: TLSSocket, ...args: Parameters<TLSSocket['getPeerCertificate']>) {
      if (gone && used.has(this)) return {} as ReturnType<TLSSocket['getPeerCertificate']>;
      if (!gone) used.add(this);
      return original.apply(this, args);
    } as TLSSocket['getPeerCertificate'];
    process.prependListener('uncaughtException', onUncaught);
    try { await run(() => { gone = true; }); }
    finally {
      TLSSocket.prototype.getPeerCertificate = original;
      process.removeListener('uncaughtException', onUncaught);
    }
    return uncaught;
  }

  it('getSourceResponse', async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const uncaught = await withPeerGoneAfterFirst(async peerGone => {
        expect((await getSourceResponse(context, `${origin}/first`, { timeout: 5_000 })).status()).toBe(200);
        peerGone();
        expect((await getSourceResponse(context, `${origin}/second`, { timeout: 5_000 })).status()).toBe(200);
      });
      expect(uncaught).toEqual([]);
    } finally { await context.close(); }
  });

  it('fetchSourceRoute', async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await context.route('**/*', async route => route.fulfill({ response: await fetchSourceRoute(route, { timeout: 5_000 }) }));
      const page = await context.newPage();
      const uncaught = await withPeerGoneAfterFirst(async peerGone => {
        expect((await page.goto(`${origin}/first`))?.status()).toBe(200);
        peerGone();
        expect((await page.goto(`${origin}/second`))?.status()).toBe(200);
      });
      expect(uncaught).toEqual([]);
    } finally { await context.close(); }
  });
});
