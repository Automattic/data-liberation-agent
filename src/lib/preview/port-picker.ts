import { createServer } from 'node:net';

export const DEFAULT_PORT_RANGE = { start: 9400, end: 9499 } as const;

export class PortRangeExhaustedError extends Error {
  constructor(range: { start: number; end: number }) {
    super(`No free port in ${range.start}-${range.end}. Pass a --port override.`);
    this.name = 'PortRangeExhaustedError';
  }
}

/**
 * Playground CLI binds to `::` (IPv6 unspecified). On macOS with the default
 * IPV6_V6ONLY=true, `[::]:port` coexists with `127.0.0.1:port` — so probing
 * IPv4-only reports a port as free while IPv6 is already taken. Match
 * Playground's binding pattern by probing the IPv6 unspecified address; if
 * it binds, Playground can too.
 */
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    try {
      srv.listen(port, '::');
    } catch {
      resolve(false);
    }
  });
}

export async function pickFreePort(
  range: { start: number; end: number } = DEFAULT_PORT_RANGE,
): Promise<number> {
  for (let port = range.start; port <= range.end; port++) {
    if (await isFree(port)) return port;
  }
  throw new PortRangeExhaustedError(range);
}
