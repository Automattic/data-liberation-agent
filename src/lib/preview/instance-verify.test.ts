import { describe, it, expect, afterEach } from 'vitest';
import { createServer, Server } from 'node:http';
import { verifyInstance } from './instance-verify.js';

let srv: Server | null = null;

afterEach(async () => {
  if (srv) await new Promise((r) => srv!.close(() => r(null)));
  srv = null;
});

function listen(handler: (req: any, res: any) => void): Promise<number> {
  return new Promise((resolve) => {
    srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve((srv!.address() as any).port));
  });
}

describe('verifyInstance', () => {
  it('returns true when the instance id matches', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('abc-123');
    });
    expect(await verifyInstance(port, 'abc-123', { timeoutMs: 500 })).toBe(true);
  });

  it('returns false when the instance id mismatches', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200);
      res.end('other-id');
    });
    expect(await verifyInstance(port, 'abc-123', { timeoutMs: 500 })).toBe(false);
  });

  it('returns false when the server is unreachable', async () => {
    expect(await verifyInstance(1, 'abc-123', { timeoutMs: 200 })).toBe(false);
  });

  it('returns false when the endpoint responds with non-200', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(404);
      res.end('no');
    });
    expect(await verifyInstance(port, 'abc-123', { timeoutMs: 500 })).toBe(false);
  });
});
