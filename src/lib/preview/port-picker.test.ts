import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import { pickFreePort, DEFAULT_PORT_RANGE, PortRangeExhaustedError } from './port-picker.js';

function occupy(port: number): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(port, '::', () => resolve(() => srv.close()));
  });
}

describe('pickFreePort', () => {
  it('returns the first port in the range when all are free', async () => {
    const port = await pickFreePort({ start: 9400, end: 9410 });
    expect(port).toBe(9400);
  });

  it('skips occupied ports and returns the first free one', async () => {
    const close1 = await occupy(9400);
    const close2 = await occupy(9401);
    try {
      const port = await pickFreePort({ start: 9400, end: 9410 });
      expect(port).toBe(9402);
    } finally {
      close1();
      close2();
    }
  });

  it('throws PortRangeExhaustedError when every port is taken', async () => {
    const closers: Array<() => void> = [];
    for (let p = 9400; p <= 9402; p++) closers.push(await occupy(p));
    try {
      await expect(pickFreePort({ start: 9400, end: 9402 })).rejects.toBeInstanceOf(PortRangeExhaustedError);
    } finally {
      closers.forEach((c) => c());
    }
  });

  it('uses DEFAULT_PORT_RANGE when no range is passed', () => {
    expect(DEFAULT_PORT_RANGE.start).toBe(9400);
    expect(DEFAULT_PORT_RANGE.end).toBe(9499);
  });
});
