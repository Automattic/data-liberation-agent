import { EventEmitter } from 'node:events';
import type { BrowserContext, Route } from 'playwright';
import { expect, it, vi } from 'vitest';
import { installSourceIdentity } from './source-identity.js';
import { governSourceContext } from './source-traffic.js';
import { SourceRequestGovernors } from '../source-request-governor.js';

it('aborts only governed fetch transport refusals, falling back for other handler errors', async () => {
  for (const kind of ['headers', 'fetch-other', 'fetch-reset', 'fulfill-reset']) {
    let handler!: (route: Route) => Promise<void>;
    const context = Object.assign(new EventEmitter(), {
      newPage: vi.fn(),
      route: vi.fn(async (_pattern, callback) => { handler = callback; }),
    }) as unknown as BrowserContext;
    governSourceContext(context, new SourceRequestGovernors({ fallbackRetryAfterMs: 0 }), 'https://source.test');
    await installSourceIdentity(context, { userAgent: 'Chrome/130.0.0.0' });
    const response = { status: () => 200, headers: () => ({}), dispose: vi.fn() };
    const route = {
      request: () => ({
        url: () => 'https://source.test/', frame: () => { throw new Error('no popup frame'); },
        allHeaders: async () => { if (kind === 'headers') throw new Error('ECONNRESET'); return {}; },
      }),
      fetch: vi.fn(async () => {
        if (kind === 'fetch-reset') throw new Error('ECONNRESET');
        if (kind === 'fetch-other') throw new Error('handler failure');
        return response;
      }),
      fulfill: vi.fn(async () => { if (kind === 'fulfill-reset') throw new Error('ECONNRESET'); }),
      abort: vi.fn().mockResolvedValue(undefined), fallback: vi.fn().mockResolvedValue(undefined),
    };
    await handler(route as unknown as Route);
    if (kind === 'fetch-reset') {
      expect(route.abort).toHaveBeenCalledWith('connectionreset');
      expect(route.fallback).not.toHaveBeenCalled();
    } else {
      expect(route.abort).not.toHaveBeenCalled();
      expect(route.fallback).toHaveBeenCalledOnce();
    }
  }
});
