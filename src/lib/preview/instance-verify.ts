import { request } from 'node:http';

type VerifyOpts = { timeoutMs?: number };

export async function verifyInstance(
  port: number,
  expectedId: string,
  opts: VerifyOpts = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 1000;
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/liberation-preview-id',
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(false);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').trim();
          resolve(body === expectedId);
        });
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}
