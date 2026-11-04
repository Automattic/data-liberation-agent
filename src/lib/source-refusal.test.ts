import { expect, it, vi } from 'vitest';
import { SourceRequestGovernor, isSourceTransportThrottle } from './source-request-governor.js';

it('uses one classifier with a narrower refusal predicate', () => {
 expect(isSourceTransportThrottle({ cause: { code: 'ECONNRESET' } }, true)).toBe(true);
 expect(isSourceTransportThrottle(new Error('CONTENT_LENGTH_MISMATCH'))).toBe(true);
 expect(isSourceTransportThrottle(new Error('CONTENT_LENGTH_MISMATCH'), true)).toBe(false);
 expect(isSourceTransportThrottle(new Error('Timeout'), true)).toBe(false);
});

it('requires earlier responses, consecutive refusals and distinct document paths', () => {
 const governor = new SourceRequestGovernor('http://example.test');
 const fail = (routeUrl: string) => governor.observeBrowserOutcome(undefined, undefined, new Error('ECONNRESET'), routeUrl);
 for (let i = 0; i < 4; i++) fail(`http://example.test/${i}`);
 governor.observeBrowserOutcome(200);
 for (let i = 0; i < 4; i++) fail('http://example.test/a');
 governor.observeBrowserOutcome(503);
 fail('http://example.test/b');
 expect(governor.blockedClient).toBeUndefined();
});

it('shares escalating confirmation and rejects queued admission only after the entire window', async () => {
 vi.useFakeTimers();
 const probe = vi.spyOn(globalThis, 'fetch').mockRejectedValue({ cause: { code: 'ECONNRESET' } });
 try {
  const governor = new SourceRequestGovernor('http://example.test');
  governor.observeBrowserOutcome(200);
  for (const path of ['a', 'a', 'b']) governor.observeBrowserOutcome(undefined, undefined, new Error('ECONNRESET'), `http://example.test/${path}`);
  const admission = expect(governor.admitSourceRequest()).rejects.toMatchObject({ code: 'source_blocked_client' });
  await vi.advanceTimersByTimeAsync(20000);
  expect(governor.blockedClient).toBeUndefined();
  expect(probe).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(40000);
  await admission;
  expect(probe).toHaveBeenCalledTimes(4);
  expect(governor.blockedClient?.evidence.requestsBeforeFirstRefusal).toBe(1);
 } finally { probe.mockRestore(); vi.useRealTimers(); }
});

it('resumes on any HTTP answer during confirmation', async () => {
 vi.useFakeTimers();
 const probe = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce({ code: 'ECONNRESET' }).mockResolvedValue(new Response(null, { status: 503 }));
 try {
  const governor = new SourceRequestGovernor('http://example.test');
  governor.observeBrowserOutcome(200);
  for (const path of ['a', 'a', 'b']) governor.observeBrowserOutcome(undefined, undefined, new Error('ECONNRESET'), `http://example.test/${path}`);
  const admission = governor.admitSourceRequest();
  await vi.advanceTimersByTimeAsync(8000);
  await admission;
  expect(governor.blockedClient).toBeUndefined();
  expect(probe).toHaveBeenCalledTimes(2);
 } finally { probe.mockRestore(); vi.useRealTimers(); }
});
