import { EventEmitter } from 'node:events';
import type { BrowserContext, Request, Route } from 'playwright';
import { expect, it, vi } from 'vitest';
import { SourceRequestGovernors } from '../source-request-governor.js';
import { continueSourceRoute, governSourceContext } from './source-traffic.js';

it('observes native outcomes, admits only recovery traffic and releases failures', async () => {
  const context = new EventEmitter() as EventEmitter & BrowserContext;
  const governors = new SourceRequestGovernors({ concurrency: 2, recoveryStep: 1, fallbackRetryAfterMs: 0 });
  const governor = governors.forOrigin('https://source.test');
  governSourceContext(context, governors, 'https://source.test');
  const acquire = vi.spyOn(governor, 'acquire');
  const release = vi.spyOn(governor, 'release');
  const routeFor = (url = 'https://source.test/image') => {
    const request = { url: () => url, frame: () => ({ url: () => 'https://source.test/page' }), failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }) } as Request;
    const route = { request: () => request, continue: vi.fn().mockResolvedValue(undefined), fetch: vi.fn() };
    return { request, route: route as unknown as Route, native: route };
  };
  const healthy = routeFor();
  await continueSourceRoute(healthy.route, context, {});
  expect(acquire).not.toHaveBeenCalled();
  expect(healthy.native.continue).toHaveBeenCalledOnce();
  expect(healthy.native.fetch).not.toHaveBeenCalled();
  context.emit('requestfailed', healthy.request);
  expect(governor.throttleEvents).toBe(1);
  const recovery = routeFor();
  await continueSourceRoute(recovery.route, context, {});
  expect(acquire).toHaveBeenCalledOnce();
  context.emit('response', { request: () => recovery.request, status: () => 200, headers: () => ({}) });
  context.emit('requestfinished', recovery.request);
  expect(release).toHaveBeenCalledOnce();
  expect(governor.isBrowserThrottled).toBe(false);

  const throttled = routeFor();
  await continueSourceRoute(throttled.route, context, {});
  context.emit('response', { request: () => throttled.request, status: () => 429, headers: () => ({ 'retry-after': '0' }) });
  context.emit('requestfinished', throttled.request);
  expect(governor.throttleEvents).toBe(2);
  expect(governor.isBrowserThrottled).toBe(true);
  const failed = routeFor();
  await continueSourceRoute(failed.route, context, {});
  context.emit('requestfailed', failed.request);
  expect(release).toHaveBeenCalledTimes(2);
  expect(governor.throttleEvents).toBe(3);

  const thirdParty = routeFor('https://other.test/image');
  await continueSourceRoute(thirdParty.route, context, {});
  context.emit('requestfailed', thirdParty.request);
  expect(governor.throttleEvents).toBe(3);
  expect(acquire).toHaveBeenCalledTimes(2);
});
