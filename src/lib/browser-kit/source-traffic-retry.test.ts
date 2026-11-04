import { EventEmitter } from 'node:events';
import type { BrowserContext, Route } from 'playwright';
import { expect, it, vi } from 'vitest';
import { SourceRequestGovernors } from '../source-request-governor.js';
import { continueSourceRoute, governSourceContext } from './source-traffic.js';

it('retries a reset stylesheet before fulfilling it, without changing identity headers', async () => {
  const context = new EventEmitter() as EventEmitter & BrowserContext;
  const governors = new SourceRequestGovernors({ fallbackRetryAfterMs: 0 });
  governSourceContext(context, governors, 'https://source.test');
  const response = { status: () => 200, headersArray: () => [], dispose: vi.fn() };
  const route = {
    request: () => ({ url: () => 'https://source.test/a.css', resourceType: () => 'stylesheet' }),
    fetch: vi.fn().mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET')).mockResolvedValue(response),
    fulfill: vi.fn(), continue: vi.fn(),
  };
  await continueSourceRoute(route as unknown as Route, context, { headers: { 'user-agent': 'capture' } });
  expect(route.fetch).toHaveBeenCalledTimes(2);
  expect(route.fetch).toHaveBeenLastCalledWith({ headers: { 'user-agent': 'capture' }, maxRetries: 0, maxRedirects: 0 });
  expect(route.fulfill).toHaveBeenCalledWith({ response });
  expect(response.dispose).toHaveBeenCalledOnce();
  expect(route.continue).not.toHaveBeenCalled();
  expect(governors.forOrigin('https://source.test').throttleEvents).toBe(1);
});
